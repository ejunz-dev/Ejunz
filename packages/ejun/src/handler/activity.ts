import path from 'path';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import yaml from 'js-yaml';
import { pick } from 'lodash';
import { Binary, ObjectId } from 'mongodb';
import { Context } from '../context';
import {
    AuthOperationError, BlacklistedError, DomainAlreadyExistsError, InvalidTokenError,
    NotFoundError, PermissionError, UserAlreadyExistError,
    UserNotFoundError, ValidationError, VerifyPasswordError,
} from '../error';
import { DomainDoc, MessageDoc, Setting } from '../interface';
import avatar, { validate } from '../lib/avatar';
import * as mail from '../lib/mail';
import * as useragent from '../lib/useragent';
import { verifyTFA } from '../lib/verifyTFA';
// import BlackListModel from '../model/blacklist';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import domain from '../model/domain';
import message from '../model/message';
import ProblemModel from '../model/problem';
import * as setting from '../model/setting';
import storage from '../model/storage';
import * as system from '../model/system';
import token from '../model/token';
import * as training from '../model/training';
import user from '../model/user';
import {
    ConnectionHandler, Handler, param, query, requireSudo, subscribe, Types,
} from '../service/server';
import { camelCase, md5 } from '../utils';


class UserActivityHandler extends Handler {
    uids = new Set<number>();

    collectUser(uids: number[]) {
        for (const uid of uids) this.uids.add(uid);
    }

    async getUserDomainIds() {
        const userDomains = await domain.getDictUserByDomainId(this.user._id);
        const domainArray = Object.values(userDomains);
        if (!Array.isArray(domainArray)) {
            throw new Error('domainArray is not an array');
        }
        return domainArray.map((d) => d.domainId);
    }
    async getDiscussion(domainId: string, limit = 20) {
        const domainIds = await this.getUserDomainIds();
        console.log('DOMAINID',domainIds);

        const allDdocs = [];
        const allVndict = {};

        for (const domainId of domainIds) {
            const ddocs = await discussion.getMulti(domainId).limit(limit).toArray();
            const vndict = await discussion.getListVnodes(domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group);
            this.collectUser(ddocs.map((ddoc) => ddoc.owner));
            allDdocs.push(...ddocs);
            Object.assign(allVndict, vndict);
        }
        return [allDdocs, allVndict];
    }
    async get({ domainId }) {
        const homepageConfig = [
            {
                width: 9,
                discussion: 20,
            },
        ];
        console.log('homepageConfig',homepageConfig);
        const info = homepageConfig;
        const contents = [];
    
        for (const column of info) {
            const tasks = [];
    
            for (const name in column) {
                if (name === 'width') continue;
                const func = `get${camelCase(name).replace(/^[a-z]/, (i) => i.toUpperCase())}`;

                if (!this[func]) {
                    tasks.push([name, column[name]]);
                } else {
                    tasks.push(
                        this[func](domainId, column[name])
                            .then((res) => [name, res])
                            .catch((err) => ['error', err.message]),
                    );
                }
            }
    
            const sections = await Promise.all(tasks);
            
            contents.push({
                width: column.width,
                sections,
            });
        }
    
        const udict = await user.getList(domainId, Array.from(this.uids));
        this.response.template = 'activity_main.html';
        this.response.body = {
            contents,
            udict,
            domain: this.domain,
        };
        
    }
}    


export async function apply(ctx: Context) {
    ctx.Route('user_activity', '/user/:uid(-?\\d+)/activity', UserActivityHandler);
}
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

class UserTaskHandler extends Handler {
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
    

    async getHomework(limit = 5) {
        const domainIds = await this.getUserDomainIds();
        console.log(domainIds);
        if (!this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK)) return [[], {}];

        const allTdocs = [];
        const allTsdict = {};

        const limitInt = parseInt(limit as any, 10);

        for (const domainId of domainIds) {
            const groups = (await user.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) ? undefined : this.user._id))
                .map((i) => i.name);
            const tdocs = await contest.getMulti(domainId, {
                rule: 'homework',
                ...this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)
                    ? {}
                    : {
                        $or: [
                            { maintainer: this.user._id },
                            { owner: this.user._id },
                            { assign: { $in: groups } },
                            { assign: { $size: 0 } },
                        ],
                    },
            }).sort({
                penaltySince: -1, endAt: -1, beginAt: -1, _id: -1,
            }).limit(limitInt).toArray();

            const tsdict = await contest.getListStatus(
                domainId, this.user._id, tdocs.map((tdoc) => tdoc.docId),
            );

            allTdocs.push(...tdocs);
            Object.assign(allTsdict, tsdict);
        }
        console.log(allTdocs);
        console.log(allTsdict);
        return [allTdocs, allTsdict];
    }

    async get({ domainId }) {
        const homepageConfig = this.ctx.setting.get('ejun.homepage');
        const info = yaml.load(homepageConfig) as any;
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
        this.response.template = 'task_main.html';
        this.response.body = {
            contents,
            udict,
            domain: this.domain,
        };
        console.log(this.response.body);
        
    }
}    


export async function apply(ctx: Context) {
    ctx.Route('user_task', '/user/:uid(-?\\d+)/task', UserTaskHandler);
}
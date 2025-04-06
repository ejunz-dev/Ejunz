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



export class ProductionBaseHandler extends Handler {
    async after(domainId: string) {
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: 'Back to homepage',
                checker: () => true,
            },
        ];
    }
}
export class ProductionHandler extends ProductionBaseHandler {
    async get() {
        this.response.template = 'production_main.html';
    }
}


export class ProcessingBaseHandler extends Handler {
    async after(domainId: string) {
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: 'Back to homepage',
                checker: () => true,
            },
        ];
    }
}
export class ProcessingHandler extends ProcessingBaseHandler {
    async get() {
        this.response.template = 'processing_main.html';
    }
}


export class TeamspaceBaseHandler extends Handler {
    async after(domainId: string) {
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: 'Back to homepage',
                checker: () => true,
            },
        ];
    }
}
export class TeamspaceHandler extends TeamspaceBaseHandler {
    async get() {
        this.response.template = 'teamspace_main.html';
    }
}


export class FilespaceBaseHandler extends Handler {
    async after(domainId: string) {
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: 'Back to homepage',
                checker: () => true,
            },
        ];
    }
}
export class FilespaceHandler extends FilespaceBaseHandler {
    async get() {
        this.response.template = 'filespace_main.html';
    }
}


export class TalkspaceBaseHandler extends Handler {
    async after(domainId: string) {
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: 'Back to homepage',
                checker: () => true,
            },
        ];
    }
}
export class TalkspaceHandler extends TalkspaceBaseHandler {
    async get() {
        this.response.template = 'talkspace_main.html';
    }
}

export class WorkspaceBaseHandler extends Handler {
    async after(domainId: string) {
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: 'Back to homepage',
                checker: () => true,
            },
        ];
    }
}
export class WorkspaceHandler extends WorkspaceBaseHandler {
    uids = new Set<number>();

    collectUser(uids: number[]) {
        for (const uid of uids) this.uids.add(uid);
    }

    async getHomework(domainId: string, limit = 5) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK)) return [[], {}];
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
        }).limit(limit).toArray();
        const tsdict = await contest.getListStatus(
            domainId, this.user._id, tdocs.map((tdoc) => tdoc.docId),
        );
        return [tdocs, tsdict];
    }

    async getContest(domainId: string, limit = 10) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_CONTEST)) return [[], {}];
        const rules = Object.keys(contest.RULES).filter((i) => !contest.RULES[i].hidden);
        const groups = (await user.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) ? undefined : this.user._id))
            .map((i) => i.name);
        const q = {
            rule: { $in: rules },
            ...this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)
                ? {}
                : {
                    $or: [
                        { maintainer: this.user._id },
                        { owner: this.user._id },
                        { assign: { $in: groups } },
                        { assign: { $size: 0 } },
                    ],
                },
        };
        const tdocs = await contest.getMulti(domainId, q).sort({ endAt: -1, beginAt: -1, _id: -1 })
            .limit(limit).toArray();
        const tsdict = await contest.getListStatus(
            domainId, this.user._id, tdocs.map((tdoc) => tdoc.docId),
        );
        return [tdocs, tsdict];
    }

    async getTraining(domainId: string, limit = 10) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_TRAINING)) return [[], {}];
        const tdocs = await training.getMulti(domainId)
            .sort({ pin: -1, _id: 1 }).limit(limit).toArray();
        const tsdict = await training.getListStatus(
            domainId, this.user._id, tdocs.map((tdoc) => tdoc.docId),
        );
        return [tdocs, tsdict];
    }

    async getDiscussion(domainId: string, limit = 20) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_DISCUSSION)) return [[], {}];
        const ddocs = await discussion.getMulti(domainId).limit(limit).toArray();
        const vndict = await discussion.getListVnodes(domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group);
        this.collectUser(ddocs.map((ddoc) => ddoc.owner));
        return [ddocs, vndict];
    }

    async getRanking(domainId: string, limit = 50) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_RANKING)) return [];
        const dudocs = await domain.getMultiUserInDomain(domainId, { uid: { $gt: 1 }, rp: { $gt: 0 } })
            .sort({ rp: -1 }).project({ uid: 1 }).limit(limit).toArray();
        const uids = dudocs.map((dudoc) => dudoc.uid);
        this.collectUser(uids);
        return uids;
    }

    async getStarredProblems(domainId: string, limit = 50) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM)) return [[], {}];
        const psdocs = await ProblemModel.getMultiStatus(domainId, { uid: this.user._id, star: true })
            .sort('_id', 1).limit(limit).toArray();
        const psdict = {};
        for (const psdoc of psdocs) psdict[psdoc.docId] = psdoc;
        const pdict = await ProblemModel.getList(
            domainId, psdocs.map((pdoc) => pdoc.docId),
            this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, false,
        );
        const pdocs = Object.keys(pdict).filter((i) => +i).map((i) => pdict[i]);
        return [pdocs, psdict];
    }

    async getRecentProblems(domainId: string, limit = 10) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM)) return [[], {}];
        const pdocs = await ProblemModel.getMulti(domainId, { hidden: false })
            .sort({ _id: -1 }).limit(limit).toArray();
        const psdict = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await ProblemModel.getListStatus(domainId, this.user._id, pdocs.map((pdoc) => pdoc.docId))
            : {};
        return [pdocs, psdict];
    }

    getDiscussionNodes(domainId: string) {
        return discussion.getNodes(domainId);
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
    
            // 等待所有任务完成
            const sections = await Promise.all(tasks);
            
            contents.push({
                width: column.width,
                sections,
            });
        }
    
        const udict = await user.getList(domainId, Array.from(this.uids));
        this.response.template = 'workspace_main.html';
        this.response.body = {
            contents,
            udict,
            domain: this.domain,
        };
        
    }
}    

export async function apply(ctx: Context) {
    ctx.Route('production_main', '/production', ProductionHandler);
    ctx.Route('processing_main', '/processing', ProcessingHandler);
    ctx.Route('teamspace_main', '/teamspace', TeamspaceHandler);
    ctx.Route('filespace_main', '/filespace', FilespaceHandler);
    ctx.Route('talkspace_main', '/talkspace', TalkspaceHandler);
    ctx.Route('workspace_main', '/workspace', WorkspaceHandler);

    // Workspace
    ctx.on('handler/after', async (h) => {
        const paths = ['/p','/problem', '/contest', '/training','/record', '/training', '/homework'];
        if (paths.includes(h.request.path)) {
            if (!h.response.body.overrideNav) {
                h.response.body.overrideNav = [];
            }//DONT DELETE THIS
            h.response.body.overrideNav.push(
                {
                    name: 'problem_main',
                    args: {},
                    displayName: 'problem_main',
                    checker: () => true,
                },
                {
                    name: 'training_main',
                    args: {},
                    displayName: 'training_main',
                    checker: () => true,
                },
                {
                    name: 'contest_main',
                    args: {},
                    displayName: 'contest_main',
                    checker: () => true,
                },
                {
                    name: 'homework_main',
                    args: {},
                    displayName: 'homework_main',
                    checker: () => true,
                },
                {
                    name: 'record_main',
                    args: {},
                    displayName: 'record_main',
                    checker: () => true,
                },
                {
                    name: 'ranking',
                    args: {},
                    displayName: 'ranking',
                    checker: () => true,
                },
            );
        }
    });

    // For Core
    ctx.on('handler/after', async (h) => {
        const homePaths = ['/','/home'];
        const workspacePaths = ['/workspace', '/problem', '/p', '/training', '/contest', '/homework', '/record', '/ranking'];
        const productionPaths = ['/production', '/questgen'];
        const processingPaths = ['/processing', '/docs', '/repo'];
        const teamspacePaths = ['/teamspace', '/hub'];
        const filespacePaths = ['/filespace', '/domainfile'];
        const talkspacePaths = ['/talkspace', '/discussion'];

        if (homePaths.some(path => h.request.path.includes(path))) {
            h.UiContext.spacename = 'homepage';
        }
        if (workspacePaths.some(path => h.request.path.includes(path))) {
            h.UiContext.spacename = 'workspace';
        }
        if (productionPaths.some(path => h.request.path.includes(path))) {
            h.UiContext.spacename = 'production';
        }
        if (processingPaths.some(path => h.request.path.includes(path))) {
            h.UiContext.spacename = 'processing';
            if (!h.response.body.overrideNav) {
                h.response.body.overrideNav = [];
            }
            h.response.body.overrideNav.push(
                { name: 'docs_domain', args: {}, checker: () => true },
                { name: 'repo_domain', args: {}, checker: () => true },
            );
        }
        if (teamspacePaths.some(path => h.request.path.includes(path))) {
            h.UiContext.spacename = 'teamspace';
        }
        if (filespacePaths.some(path => h.request.path.includes(path))) {
            h.UiContext.spacename = 'filespace';
        }
        if (talkspacePaths.some(path => h.request.path.includes(path))) {
            h.UiContext.spacename = 'talkspace';
        }

    });

}
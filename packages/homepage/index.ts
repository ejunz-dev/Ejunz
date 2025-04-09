import { load } from 'js-yaml';
import { Dictionary } from 'lodash';
import moment from 'moment-timezone';
import {
    CannotDeleteSystemDomainError, DomainJoinAlreadyMemberError, DomainJoinForbiddenError, ForbiddenError,
    InvalidJoinInvitationCodeError, OnlyOwnerCanDeleteDomainError, PermissionError, RoleAlreadyExistError, ValidationError,
} from 'ejun';
import type { DomainDoc } from 'ejun';
import { PERM, PERMS_BY_FAMILY, PRIV,SettingModel } from 'ejun';
import * as discussion from 'ejun';
import {
    Handler, param, post, query, requireSudo, Types,domain,Context,DomainModel,OplogModel,SystemModel,
    UserModel,ContestModel,TrainingModel,DiscussionModel,ProblemModel,camelCase, md5 
} from 'ejun';
import { log2 } from 'ejun'
import yaml from 'js-yaml';
import _ from 'lodash';


export class HomeBaseHandler extends Handler {
    async after(domainId: string) {
        this.response.body.overrideNav = [

        ];
    }
}


export class HomeHandler extends HomeBaseHandler {
    uids = new Set<number>();

    collectUser(uids: number[]) {
        for (const uid of uids) this.uids.add(uid);
    }

    async getHomework(domainId: string, limit = 5) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK)) return [[], {}];
        const groups = (await UserModel.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) ? undefined : this.user._id))
            .map((i) => i.name);
        const tdocs = await ContestModel.getMulti(domainId, {
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
        const tsdict = await ContestModel.getListStatus(
            domainId, this.user._id, tdocs.map((tdoc) => tdoc.docId),
        );
        return [tdocs, tsdict];
    }

    async getContest(domainId: string, limit = 10) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_CONTEST)) return [[], {}];
        const rules = Object.keys(ContestModel.RULES).filter((i) => !ContestModel.RULES[i].hidden);
        const groups = (await UserModel.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) ? undefined : this.user._id))
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
        const tdocs = await ContestModel.getMulti(domainId, q).sort({ endAt: -1, beginAt: -1, _id: -1 })
            .limit(limit).toArray();
        const tsdict = await ContestModel.getListStatus(
            domainId, this.user._id, tdocs.map((tdoc) => tdoc.docId),
        );
        return [tdocs, tsdict];
    }

    async getTraining(domainId: string, limit = 10) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_TRAINING)) return [[], {}];
        const tdocs = await TrainingModel.getMulti(domainId)
            .sort({ pin: -1, _id: 1 }).limit(limit).toArray();
        const tsdict = await TrainingModel.getListStatus(
            domainId, this.user._id, tdocs.map((tdoc) => tdoc.docId),
        );
        return [tdocs, tsdict];
    }

    async getDiscussion(domainId: string, limit = 20) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_DISCUSSION)) return [[], {}];
        const ddocs = await DiscussionModel.getMulti(domainId).limit(limit).toArray();
        const vndict = await DiscussionModel.getListVnodes(domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group);
        this.collectUser(ddocs.map((ddoc) => ddoc.owner));
        return [ddocs, vndict];
    }

    async getRanking(domainId: string, limit = 50) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_RANKING)) return [];
        const dudocs = await DomainModel.getMultiUserInDomain(domainId, { uid: { $gt: 1 }, rp: { $gt: 0 } })
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
        return DiscussionModel.getNodes(domainId);
    }

    async get({ domainId }) {
        const homepageConfig = this.domain.homepage_config;
        console.log('homepageConfig', homepageConfig);

        // 检查 processingConfig 是否为 undefined
        if (!homepageConfig) {
            this.response.body = {
                contents: [{ message: '需要进行配置 homepage' }],
                udict: {},
                domain: this.domain,
            };
            return;
        }

        console.log('homepageConfig', homepageConfig);
        const info = yaml.load(homepageConfig) as any;
        console.log('info', info);
        
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
            console.log('column', column);
    
            // 等待所有任务完成
            const sections = await Promise.all(tasks);
            console.log('sections', sections);
            
            contents.push({
                width: column.width,
                sections,
            });
        }
    
        const udict = await UserModel.getList(domainId, Array.from(this.uids));
        this.response.template = 'homepage_main.html';
        this.response.body = {
            contents,
            udict,
            domain: this.domain,
        };
        console.log('this.response.body.contents', this.response.body.contents);
    }

}    

export async function apply(ctx: Context) {
    SettingModel.DomainSpaceConfigSetting(
        SettingModel.Setting
        (   
            'spaces', 
            'homepage_config', 
            [], 
            'yaml', 
            'homepage_front'
        ),
    );
    SettingModel.DomainSpacePluginSetting(
        SettingModel.Setting
        (   
            'spaces', 
            'homepage_plugin', 
            [], 
            'yaml',
            'homepage_plugins'
        ),
    );

    const CheckSpaceStore = (h) => {
        const availableSpaces = new Set(yaml.load(h.domain.spaces) as string[]);
        if (availableSpaces.has('homepage')) {
            console.log('Homepage Domain pass');
            return true;
        }
        console.log('Homepage Domain fail');
        return false;
    }

    const CheckSystemConfig = (h) => {
        const systemspaces = SettingModel.SYSTEM_SETTINGS.filter(s => s.family === 'system_spaces');
        for (const s of systemspaces) {
            if (s.name == 'homepage') {
                const beforeSystemSpace = SystemModel.get(s.key);
                const parsedBeforeSystemSpace = yaml.load(beforeSystemSpace) as any[];
                console.log('Homepage SystemConfig', parsedBeforeSystemSpace);
                if (parsedBeforeSystemSpace.includes(h.domain._id)) {
                    console.log('Homepage SystemConfig pass');
                    return true;
                }else{
                    console.log('Homepage SystemConfig fail');
                    return false;
                }
            }
        }
       
    }

    const CheckAll = (h) => {
        return CheckSpaceStore(h) && CheckSystemConfig(h);
    }

   ctx.injectUI('NavMainDropdown', 'homepage', { prefix: 'homepage' }, CheckAll);


    ctx.Route('homepage', '/', HomeHandler);


}
import {
    escapeRegExp,
} from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import type { Context } from '../context';
import {
    BadRequestError, ContestNotAttendedError, ContestNotEndedError, ContestNotFoundError, ContestNotLiveError,
    FileLimitExceededError, HackFailedError, NoProblemError, NotFoundError,
    PermissionError, ProblemAlreadyExistError, ProblemAlreadyUsedByContestError, ProblemConfigError,
    ProblemIsReferencedError, ProblemNotAllowLanguageError, ProblemNotAllowPretestError, ProblemNotFoundError,
    RecordNotFoundError, SolutionNotFoundError, ValidationError,DiscussionNotFoundError
} from '../error';
import {
    Handler, param, post, query, route, Types,
} from '../service/server';
// removed file-related storage usage
import Agent from '../model/agent';
import { PERM, PRIV, STATUS } from '../model/builtin';
// removed mime and storage helpers (file features removed)
import { AgentDoc } from '../interface';
import domain from '../model/domain';
import { User } from '../model/user';
import * as system from '../model/system';
import parser from '@ejunz/utils/lib/search';
import { RepoSearchOptions } from '../interface';
import user from '../model/user';
export const parseCategory = (value: string) => value.replace(/，/g, ',').split(',').map((e) => e.trim());

function buildQuery(udoc: User) {
    const q: Filter<AgentDoc> = {};
    if (!udoc.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) {
        q.$or = [
            { hidden: false },
            { owner: udoc._id },
            { maintainer: udoc._id },
        ];
    }
    return q;
}

const defaultSearch = async (domainId: string, q: string, options?: RepoSearchOptions) => {
    const escaped = escapeRegExp(q.toLowerCase());
    const projection: (keyof AgentDoc)[] = ['domainId', 'docId', 'aid'];
    const $regex = new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gmi');
    const filter = { $or: [{ aid: { $regex } }, { title: { $regex } }, { tag: q }] };
    const adocs = await Agent.getMulti(domainId, filter, projection)
        .skip(options.skip || 0).limit(options.limit || system.get('pagination.problem')).toArray();
    if (!options.skip) {
        let adoc = await Agent.get(domainId, Number.isSafeInteger(+q) ? +q : q, projection);
        if (adoc) adocs.unshift(adoc);
        else if (/^R\d+$/.test(q)) {
            adoc = await Agent.get(domainId, +q.substring(1), projection);
            if (adoc) adocs.unshift(adoc);
        }
    }
    return {
        hits: Array.from(new Set(adocs.map((i) => `${i.domainId}/${i.docId}`))),
        total: Math.max(adocs.length, await Agent.count(domainId, filter)),
        countRelation: 'eq',
    };
};

export interface QueryContext {
    query: Filter<AgentDoc>;
    sort: string[];
    pcountRelation: string;
    parsed: ReturnType<typeof parser.parse>;
    category: string[];
    text: string;
    total: number;
    fail: boolean;
}

export class AgentMainHandler extends Handler {
    queryContext: QueryContext = {
        query: {},
        sort: [],
        pcountRelation: 'eq',
        parsed: null,
        category: [],
        text: '',
        total: 0,
        fail: false,
    };

    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('limit', Types.PositiveInt, true)
    @param('pjax', Types.Boolean)
    @param('quick', Types.Boolean)
    async get(domainId: string, page = 1, q = '', limit: number, pjax = false, quick = false) {
        this.response.template = 'agent_domain.html';
        if (!limit || limit > this.ctx.setting.get('pagination.problem') || page > 1) limit = this.ctx.setting.get('pagination.problem');
        

        this.queryContext.query = buildQuery(this.user);

        const query = this.queryContext.query;
        const psdict = {};
        const search = defaultSearch;
        const parsed = parser.parse(q, {
            keywords: ['category', 'difficulty'],
            offsets: false,
            alwaysArray: true,
            tokenize: true,
        });

        const category = parsed.category || [];
        const text = (parsed.text || []).join(' ');

        if (parsed.difficulty?.every((i) => Number.isSafeInteger(+i))) {
            query.difficulty = { $in: parsed.difficulty.map(Number) };
        }
        if (category.length) query.$and = category.map((tag) => ({ tag }));
        if (text) category.push(text);
        if (category.length) this.UiContext.extraTitleContent = category.join(',');

        let total = 0;
        if (text) {
            const result = await search(domainId, q, { skip: (page - 1) * limit, limit });
            total = result.total;
            this.queryContext.pcountRelation = result.countRelation;
            if (!result.hits.length) this.queryContext.fail = true;
            query.$and ||= [];
            query.$and.push({
                $or: result.hits.map((i) => {
                    const [did, docId] = i.split('/');
                    return { domainId: did, docId: +docId };
                }),
            });
            this.queryContext.sort = result.hits;
        }


        const sort = this.queryContext.sort;
        await (this.ctx as any).parallel('agent/list', query, this, sort);

        let [adocs, ppcount, pcount] = this.queryContext.fail
            ? [[], 0, 0]
            : await Agent.list(
                domainId, query, sort.length ? 1 : page, limit,
                quick ? ['title', 'aid', 'domainId', 'docId'] : undefined,
                this.user._id,
            );

        


        if (total) {
            pcount = total;
            ppcount = Math.ceil(total / limit);
        }
        if (sort.length) adocs = adocs.sort((a, b) => sort.indexOf(`${a.domainId}/${a.docId}`) - sort.indexOf(`${b.domainId}/${b.docId}`));
        if (text && pcount > adocs.length) pcount = adocs.length;

       

        if (pjax) {
            this.response.body = {
                title: this.renderTitle(this.translate('repo_domain')),
                fragments: (await Promise.all([
                    this.renderHTML('partials/repo_list.html', {
                        page, ppcount, pcount, adocs, psdict, qs: q,
                    }),
                    this.renderHTML('partials/repo_stat.html', { pcount, pcountRelation: this.queryContext.pcountRelation }),
                    this.renderHTML('partials/repo_lucky.html', { qs: q }),
                ])).map((i) => ({ html: i })),
            };
        } else {
            this.response.body = {
                page,
                pcount,
                ppcount,
                pcountRelation: this.queryContext.pcountRelation,
                adocs,
                psdict,
                qs: q,
            };
        }
    }
}   



export class AgentDetailHandler extends Handler {
    adoc?: AgentDoc;

    @param('aid', Types.String)
    async _prepare(domainId: string, aid: string) {
        if (!aid) return;

        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;

        this.adoc = await Agent.get(domainId, normalizedId);
        if (!this.adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }
        this.UiContext.extraTitleContent = this.adoc.title;
    }

    @param('aid', Types.String)
    async get(domainId: string, aid: string) {
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;


        const adoc = await Agent.get(domainId, normalizedId);
        if (!adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }

        const udoc = await user.getById(domainId, adoc.owner);

        this.response.template = 'agent_detail.html';
        this.response.body = {
            domainId,
            aid: adoc.aid, 
            adoc,
            udoc,
        };

    }
}

export class AgentEditHandler extends Handler {


    adoc: AgentDoc | null = null; 
    
    @param('aid', Types.String, true)
    async get(domainId: string, aid: string) {
        const agent = await Agent.get(domainId, aid);

        if (!agent) {
            console.warn(`[AgentEditHandler.get] No adoc found, skipping agent_edit.`);
            this.response.template = 'agent_edit.html';
            this.response.body = { adoc: null };
            return;
        }
        const udoc = await user.getById(domainId, agent.owner);

        this.response.template = 'agent_edit.html';
        this.response.body = {
            adoc: agent,
            tag: agent.tag,
            udoc,
        };
        this.UiContext.extraTitleContent = agent.title;
    }
    

    @param('title', Types.Title)
    @param('content', Types.Content)
    @post('tag', Types.Content, true, null, parseCategory)
    async postCreate(
        domainId: string,
        title: string,
        content: string,
        tag: string[] = [],
    ) {
        await this.limitRate('add_agent', 3600, 60);

        const domainInfo = await domain.get(domainId);
        if (!domainInfo) {
            throw new NotFoundError('Domain not found.');
        }

        const docId = await Agent.generateNextDocId(domainId);

        const aid = await Agent.addWithId(
            domainId,
            docId,
            this.user._id,
            title,
            content,
            this.request.ip,
            { tag: tag ?? [] }
        );
        
        this.response.body = { aid };
        this.response.redirect = this.url('agent_detail', { uid: this.user._id, aid });
    }
    
    @param('aid', Types.String)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @post('tag', Types.Content, true, null, parseCategory)
    async postUpdate(domainId: string, aid: string, title: string, content: string, tag: string[] = []) {
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
    
    
        const agent = await Agent.get(domainId, normalizedId);
        if (!agent) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}=${normalizedId}`);
        }
    
        const agentAid = agent.aid;
        const updatedAgent = await Agent.edit(domainId, agentAid, { title, content, tag: tag ?? [] });
    
    
        this.response.body = { aid: agentAid };
        this.response.redirect = this.url('agent_detail', { uid: this.user._id, aid: agentAid });
    }
    

}



export async function apply(ctx: Context) {
    ctx.Route('agent_domain', '/agent', AgentMainHandler);
    ctx.Route('agent_create', '/agent/create', AgentEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('agent_detail', '/agent/:aid', AgentDetailHandler);
    ctx.Route('agent_edit', '/agent/:aid/edit', AgentEditHandler, PRIV.PRIV_USER_PROFILE);

    // ctx.inject(['api'], ({ api }) => {
    //     api.value('Repo', [
    //         ['docId', 'Int!'],
    //         ['rid', 'String!'],
    //         ['title', 'String!'],
    //         ['content', 'String!'],
    //         ['owner', 'Int!'],
    //         ['updateAt', 'String!'],
    //         ['views', 'Int!'],
    //         ['nReply', 'Int!'],
    //         ['files', '[File!]'],
    //     ]);

    //     api.value('File', [
    //         ['filename', 'String!'],
    //         ['version', 'String!'],
    //         ['path', 'String!'],
    //         ['size', 'Int!'],
    //         ['lastModified', 'String!'],
    //         ['etag', 'String!'],
    //     ]);

    //     api.resolver(
    //         'Query', 'repo(id: Int, title: String)', 'Repo',
    //         async (arg, c) => {
    //             c.checkPerm(PERM.PERM_VIEW);
    //             const adoc = await Repo.get(c.args.domainId, arg.title || arg.id);
    //             if (!adoc) return null;
    //             c.adoc = adoc;
    //             return adoc;
    //         },
    //     );
    //     api.resolver('Query', 'repos(ids: [Int])', '[Repo]', async (arg, c) => {
    //         c.checkPerm(PERM.PERM_VIEW);
    //         const res = await Repo.getList(c.args.domainId, arg.ids, undefined);
    //         return Object.keys(res)
    //             .map((id) => res[+id])
    //             .filter((repo) => repo !== null && repo !== undefined); 
    //     }, 'Get a list of docs by ids');
        

    // });
}
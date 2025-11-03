import AdmZip from 'adm-zip';
import { readFile, statSync } from 'fs-extra';
import {
    escapeRegExp, flattenDeep, intersection, pick,
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
import storage from '../model/storage';
import Repo from '../model/repo';
import { PERM, PRIV, STATUS } from '../model/builtin';
import { lookup } from 'mime-types';
import { encodeRFC5987ValueChars } from '../service/storage';
import { RepoDoc } from '../interface';
import domain from '../model/domain';
import { User } from '../model/user';
import * as system from '../model/system';
import parser from '@ejunz/utils/lib/search';
import { RepoSearchOptions } from '../interface';
import user from '../model/user';
export const parseCategory = (value: string) => value.replace(/，/g, ',').split(',').map((e) => e.trim());

function buildQuery(udoc: User) {
    const q: Filter<RepoDoc> = {};
    if (!udoc.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) {
        q.$or = [
            { hidden: false },
            { owner: udoc._id },
            { maintainer: udoc._id },
        ];
    }
    return q;
}

export const defaultSearch = async (domainId: string, q: string, options?: RepoSearchOptions) => {
    const escaped = escapeRegExp(q.toLowerCase());
    const projection: (keyof RepoDoc)[] = ['domainId', 'docId', 'rid'];
    const $regex = new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gmi');
    const filter = { $or: [{ rid: { $regex } }, { title: { $regex } }, { tag: q }] };
    const rdocs = await Repo.getMulti(domainId, filter, projection)
        .skip(options.skip || 0).limit(options.limit || system.get('pagination.problem')).toArray();
    if (!options.skip) {
        let rdoc = await Repo.get(domainId, Number.isSafeInteger(+q) ? +q : q, projection);
        if (rdoc) rdocs.unshift(rdoc);
        else if (/^R\d+$/.test(q)) {
            rdoc = await Repo.get(domainId, +q.substring(1), projection);
            if (rdoc) rdocs.unshift(rdoc);
        }
    }
    return {
        hits: Array.from(new Set(rdocs.map((i) => `${i.domainId}/${i.docId}`))),
        total: Math.max(rdocs.length, await Repo.count(domainId, filter)),
        countRelation: 'eq',
    };
};

/**
 * MCP工具使用的repo搜索函数
 * 返回包含完整内容的搜索结果
 */
export async function searchRepoForMcp(domainId: string, query: string, limit: number = 10): Promise<any> {
    // 使用defaultSearch获取匹配的repo
    const searchResult = await defaultSearch(domainId, query, { limit, skip: 0 });
    
    if (searchResult.hits.length === 0) {
        return {
            query,
            domainId,
            total: 0,
            message: `No results found for "${query}" in knowledge base`,
            results: [],
        };
    }
    
    // 获取完整的repo文档内容
    const rdocs: any[] = [];
    for (const hit of searchResult.hits.slice(0, limit)) {
        const [did, docId] = hit.split('/');
        const rdoc = await Repo.get(did, Number(docId), Repo.PROJECTION_DETAIL);
        if (rdoc) {
            rdocs.push({
                rid: rdoc.rid,
                title: rdoc.title,
                content: rdoc.content?.substring(0, 1000) + (rdoc.content && rdoc.content.length > 1000 ? '...' : ''),
                tags: rdoc.tag || [],
                updateAt: rdoc.updateAt ? new Date(rdoc.updateAt).toISOString() : null,
                docId: rdoc.docId,
                domainId: rdoc.domainId,
                url: `/d/${rdoc.domainId}/repo/${rdoc.rid}`,
            });
        }
    }
    
    return {
        query,
        domainId,
        total: searchResult.total,
        message: `Found ${rdocs.length} result(s) for "${query}"`,
        results: rdocs,
    };
}

export interface QueryContext {
    query: Filter<RepoDoc>;
    sort: string[];
    pcountRelation: string;
    parsed: ReturnType<typeof parser.parse>;
    category: string[];
    text: string;
    total: number;
    fail: boolean;
}

export class RepoMainHandler extends Handler {
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
        this.response.template = 'repo_domain.html';
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
        await this.ctx.parallel('repo/list', query, this, sort);

        let [rdocs, ppcount, pcount] = this.queryContext.fail
            ? [[], 0, 0]
            : await Repo.list(
                domainId, query, sort.length ? 1 : page, limit,
                quick ? ['title', 'rid', 'domainId', 'docId'] : undefined,
                this.user._id,
            );

        


        if (total) {
            pcount = total;
            ppcount = Math.ceil(total / limit);
        }
        if (sort.length) rdocs = rdocs.sort((a, b) => sort.indexOf(`${a.domainId}/${a.docId}`) - sort.indexOf(`${b.domainId}/${b.docId}`));
        if (text && pcount > rdocs.length) pcount = rdocs.length;

       

        if (pjax) {
            this.response.body = {
                title: this.renderTitle(this.translate('repo_domain')),
                fragments: (await Promise.all([
                    this.renderHTML('partials/repo_list.html', {
                        page, ppcount, pcount, rdocs, psdict, qs: q,
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
                rdocs,
                psdict,
                qs: q,
            };
        }
    }
}   



export class RepoDetailHandler extends Handler {
    ddoc?: RepoDoc;

    @param('rid', Types.RepoId)
    async _prepare(domainId: string, rid: string) {
        if (!rid) return;

        const normalizedId: number | string = /^\d+$/.test(rid) ? Number(rid) : rid;

        this.ddoc = await Repo.get(domainId, normalizedId);
        if (!this.ddoc) {
            throw new NotFoundError(`Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}: ${normalizedId}`);
        }
        this.UiContext.extraTitleContent = this.ddoc.title;
    }

    @param('rid', Types.RepoId)
    async get(domainId: string, rid: string) {
        const normalizedId: number | string = /^\d+$/.test(rid) ? Number(rid) : rid;


        const ddoc = await Repo.get(domainId, normalizedId);
        if (!ddoc) {
            throw new NotFoundError(`Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}: ${normalizedId}`);
        }

        if (!Array.isArray(ddoc.files)) {
            console.warn(`[RepoDetailHandler] Warning: ddoc.files is not an array, resetting to empty array.`);
            ddoc.files = [];
        }
        const udoc = await user.getById(domainId, ddoc.owner);

        this.response.template = 'repo_detail.html';
        this.response.body = {
            domainId,
            rid: ddoc.rid, 
            ddoc,
            files: ddoc.files, 
            udoc,
        };

    }
}

export class RepoEditHandler extends Handler {


    ddoc: RepoDoc | null = null; 
    
    @param('rid', Types.RepoId, true)
    async get(domainId: string, rid: string) {
        const repo = await Repo.get(domainId, rid);

        if (!repo) {
            console.warn(`[RepoEditHandler.get] No ddoc found, skipping repo_edit.`);
            this.response.template = 'repo_edit.html';
            this.response.body = { ddoc: null, files: [], urlForFile: null };
            return;
        }
        const udoc = await user.getById(domainId, repo.owner);

    
        const files = await storage.list(`repo/${domainId}/${repo.docId}`);
        const urlForFile = (filename: string) => `/d/${domainId}/${repo.docId}/${filename}`;

        this.response.template = 'repo_edit.html';
        this.response.body = {
            ddoc: repo,
            files,
            urlForFile,
            tag: repo.tag,
            isFileMode: repo.isFileMode,
            isIterative: repo.isIterative,
            udoc,
        };
        this.UiContext.extraTitleContent = repo.title;
    }
    

    @param('title', Types.Title)
    @param('content', Types.Content)
    @post('tag', Types.Content, true, null, parseCategory)
    async postCreate(
        domainId: string,
        title: string,
        content: string,
        tag: string[] = []
    ) {
        await this.limitRate('add_repo', 3600, 60);
    
        const domainInfo = await domain.get(domainId);
        if (!domainInfo) {
            throw new NotFoundError('Domain not found.');
        }
    
        const docId = await Repo.generateNextDocId(domainId);
    
        const rid = await Repo.addWithId(
            domainId,
            docId,
            this.user._id,
            title,
            content,
            this.request.ip,
            { tag: tag ?? [] }
        );
        
        this.response.body = { rid };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, rid });
    }
    
    @param('rid', Types.RepoId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @post('tag', Types.Content, true, null, parseCategory)
    async postUpdate(domainId: string, rid: string, title: string, content: string, tag: string[] = []) {
        const normalizedId: number | string = /^\d+$/.test(rid) ? Number(rid) : rid;
    
    
        const repo = await Repo.get(domainId, normalizedId);
        if (!repo) {
            throw new NotFoundError(`Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);
        }
    
        const repoRid = repo.rid;
        const updatedRepo = await Repo.edit(domainId, repoRid, { title, content, tag: tag ?? [] });
    
    
        this.response.body = { rid: repoRid };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, rid: repoRid });
    }
    

}



export async function apply(ctx: Context) {
    ctx.Route('repo_domain', '/repo', RepoMainHandler);
    ctx.Route('repo_create', '/repo/create', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_detail', '/repo/:rid', RepoDetailHandler);
    ctx.Route('repo_edit', '/repo/:rid/edit', RepoEditHandler, PRIV.PRIV_USER_PROFILE);

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
    //             const rdoc = await Repo.get(c.args.domainId, arg.title || arg.id);
    //             if (!rdoc) return null;
    //             c.rdoc = rdoc;
    //             return rdoc;
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
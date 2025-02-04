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
import { ContestDetailBaseHandler } from './contest';
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

const defaultSearch = async (domainId: string, q: string, options?: RepoSearchOptions) => {
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
        
        console.log('Initial Query Context:', this.queryContext);

        this.queryContext.query = buildQuery(this.user);
        console.log('Query after buildQuery:', this.queryContext.query);

        const query = this.queryContext.query;
        const psdict = {};
        const search = global.Ejunz.lib.problemSearch || defaultSearch;
        const parsed = parser.parse(q, {
            keywords: ['category', 'difficulty'],
            offsets: false,
            alwaysArray: true,
            tokenize: true,
        });

        const category = parsed.category || [];
        const text = (parsed.text || []).join(' ');
        console.log('Parsed Query:', { category, text });

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

        console.log('Final Query Context:', this.queryContext);

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
            console.log('Response Body:', this.response.body);
        }
    }
}   

export class RepoDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId;

        try {
            const domainInfo = await domain.get(domainId);
            if (!domainInfo) throw new NotFoundError(`Domain not found for ID: ${domainId}`);

            const allRepos = await Repo.getMulti(domainId, {}).toArray();

            const totalCount = allRepos.length;
            const totalPages = Math.ceil(totalCount / pageSize);
            const currentPage = Math.max(1, Math.min(page, totalPages));
            const startIndex = (currentPage - 1) * pageSize;
            const paginatedRepos = allRepos.slice(startIndex, startIndex + pageSize);

            this.response.template = 'repo_domain.html';
            this.response.body = {
                domainId,
                rdocs: paginatedRepos,
                page: currentPage,
                totalPages,
                totalCount,
            };
            console.log(`rdocs`, paginatedRepos);
        
            
        } catch (error) {
            console.error('Error in fetching Repos:', error);
            this.response.template = 'error.html';
            this.response.body = { error: 'Failed to fetch repositories.' };
        }
    }
}

export class RepoDetailHandler extends Handler {
    ddoc?: RepoDoc;

    @param('rid', Types.RepoId)
    async _prepare(domainId: string, rid: string) {
        if (!rid) return;

        const normalizedId: number | string = /^\d+$/.test(rid) ? Number(rid) : rid;
        console.log(`[RepoDetailHandler] Querying document with ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);

        this.ddoc = await Repo.get(domainId, normalizedId);
        if (!this.ddoc) {
            console.error(`[RepoDetailHandler] Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);
            throw new NotFoundError(`Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}: ${normalizedId}`);
        }
    }

    @param('rid', Types.RepoId)
    async get(domainId: string, rid: string) {
        const normalizedId: number | string = /^\d+$/.test(rid) ? Number(rid) : rid;

        console.log(`[RepoDetailHandler] Querying document with ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);

        const ddoc = await Repo.get(domainId, normalizedId);
        if (!ddoc) {
            throw new NotFoundError(`Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}: ${normalizedId}`);
        }

        if (!Array.isArray(ddoc.files)) {
            console.warn(`[RepoDetailHandler] Warning: ddoc.files is not an array, resetting to empty array.`);
            ddoc.files = [];
        }
        console.log(`[RepoDetailHandler] Retrieved files:`, JSON.stringify(ddoc.files, null, 2));

        this.response.template = 'repo_detail.html';
        this.response.body = {
            domainId,
            rid: ddoc.rid, 
            ddoc,
            files: ddoc.files, 
        };
        console.log('tag', ddoc.files.map(file => ({
            ...file,
            tag: file.tag || []
        })));
    }
}

export class RepoEditHandler extends RepoMainHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';

        if (!this.ddoc) {
            console.warn(`[RepoEditHandler.get] No ddoc found, skipping repo_edit.`);
            this.response.template = 'repo_edit.html';
            this.response.body = { ddoc: null, files: [], urlForFile: null };
            return;
        }
    
        const docId = this.ddoc?.docId;
        if (!docId) {
            throw new ValidationError('Missing docId');
        }
    
        const files = await storage.list(`repo/${domainId}/${docId}`);
        const urlForFile = (filename: string) => `/d/${domainId}/${docId}/${filename}`;
    
        this.response.template = 'repo_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            files,
            urlForFile,
        };
    }
    

    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('filename', Types.String)
    @param('version', Types.String, true)
    @param('isIterative', Types.Boolean)
    async postCreate(
        domainId: string,
        title: string,
        content: string,
        filename: string,
        version: string,
        isIterative: boolean = false
    ) {
        await this.limitRate('add_repo', 3600, 60);
    
        const file = this.request.files?.file;
        if (!file) {
            throw new ValidationError('A file must be uploaded to create a repo.');
        }
    
        const domainInfo = await domain.get(domainId);
        if (!domainInfo) {
            throw new NotFoundError('Domain not found.');
        }
    
        const docId = await Repo.generateNextDocId(domainId);
        console.log(`[RepoEditHandler] Created new docId=${docId}`);
    
        const providedFilename = filename || file.originalFilename;
        const filePath = `repo/${domainId}/${docId}/${providedFilename}`;
    
        await storage.put(filePath, file.filepath, this.user._id);
        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) {
            throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);
        }
    
        const fileData = {
            filename: providedFilename ?? 'unknown_file',
            version: isIterative ? (version ?? '0.0.0') : undefined,
            path: filePath,
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
        };
    
        const rid = await Repo.addWithId(
            domainId,
            docId,
            this.user._id,
            title,
            content,
            this.request.ip,
            { files: [fileData], isIterative }
        );
        console.log(`[RepoEditHandler] Created repository: docId=${docId}, rid=${rid}`);
        
        this.response.body = { rid };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, rid });
    }
    
    @param('rid', Types.RepoId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, rid: string, title: string, content: string) {
        const normalizedId: number | string = /^\d+$/.test(rid) ? Number(rid) : rid;
    
        console.log(`[RepoEditHandler] Updating repo with ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);
    
        const repo = await Repo.get(domainId, normalizedId);
        if (!repo) {
            throw new NotFoundError(`Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);
        }
    
        const repoRid = repo.rid;
        const updatedRepo = await Repo.edit(domainId, repoRid, { title, content });
    
        console.log('Repo updated successfully:', updatedRepo);
    
        this.response.body = { rid: repoRid };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, rid: repoRid });
    }
    

}

export class RepoAddFileHandler extends Handler {
    @param('rid', Types.RepoId, true) 
    async get(domainId: string, rid: string) {
        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        this.response.template = 'repo_add_file.html';
        this.response.body = {
            ddoc: repo,
            domainId,
        };
    }

    @param('rid', Types.RepoId, true)
    @param('filename', Types.String, true)
    @param('version', Types.String, true)
    @post('tag', Types.Content, true, null, parseCategory)
    async post(domainId: string, rid: string, filename: string, version?: string, tag: string[] = []) {
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('A file must be uploaded.');

        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        const docId = repo.docId;
        if (typeof docId !== 'number') {
            throw new Error(`Expected docId to be a number, but got ${typeof docId}`);
        }

        const filePath = `repo/${domainId}/${docId}/${filename}`;
        await storage.put(filePath, file.filepath, this.user._id);
        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);

        const fileData = {
            filename,
            version: repo.isIterative ? version : undefined,
            path: filePath, 
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
            tag: tag,
        };

        if (repo.isIterative) {
            await Repo.addVersion(
                domainId,
                repo.docId,
                fileData.filename,
                fileData.version,
                fileData.path,
                fileData.size,
                fileData.lastModified,
                fileData.etag,
                fileData.tag
            );
        } else {
            await Repo.addFile(
                domainId,
                repo.docId,
                fileData.filename,
                fileData.path,
                fileData.size,
                fileData.lastModified,
                fileData.etag,
                fileData.tag
            );
        }

        console.log('File added successfully:', fileData);

        this.response.redirect = this.url('repo_detail', { domainId, rid });
    }
}

export class RepoHistoryHandler extends Handler {
    @param('rid', Types.RepoId, true) 
    async get(domainId: string, rid: string) {
        console.log(`[RepoHistoryHandler] Querying repository with rid=${rid}`);

        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) {
            console.error(`[RepoHistoryHandler] Repository not found for RID: ${rid}`);
            throw new NotFoundError(`Repository not found for RID: ${rid}`);
        }

        const repoRid = repo.rid ?? String(repo.docId);
        console.log(`[RepoHistoryHandler] Using rid=${repoRid}`);

        const sortedFiles = (repo.files || [])
            .map(file => ({
                ...file,
                lastModified: new Date(file.lastModified),
                tag: file.tag || []
            }))
            .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

        if (!sortedFiles.length) {
            console.warn(`[RepoHistoryHandler] No files found in repo=${repoRid}`);
            throw new NotFoundError('No files found in the repository.');
        }

        this.response.template = 'repo_history.html';
        this.response.body = {
            ddoc: repo,
            domainId,
            rid: repoRid, 
            files: sortedFiles,
            urlForFile: (filename: string) => this.url('repo_file_download', { domainId, rid: repoRid, filename }), // ✅ 确保 rid 是字符串
        };
        console.log('files', sortedFiles);
        console.log('repo', repo);
    }
}

export class RepofileDownloadHandler extends Handler {
    async get({ rid, filename }: { rid: string; filename: string }) {
        const domainId = this.context.domainId || 'default_domain';

        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        const docId = repo.docId ?? rid;  
        const filePath = `repo/${domainId}/${docId}/${filename}`;

        console.log(`[RepofileDownloadHandler] Checking filePath=${filePath}`);

        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) throw new NotFoundError(`File "${filename}" does not exist in repository "${rid}".`);

        this.response.body = await storage.get(filePath);
        this.response.type = lookup(filename) || 'application/octet-stream';

        if (!['application/pdf', 'image/jpeg', 'image/png'].includes(this.response.type)) {
            this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('repo_domain', '/repo', RepoMainHandler);
    ctx.Route('repo_create', '/repo/create', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_detail', '/repo/:rid', RepoDetailHandler);
    ctx.Route('repo_edit', '/repo/:rid/edit', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_add_file', '/repo/:rid/add_file', RepoAddFileHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_history', '/repo/:rid/history', RepoHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_file_download', '/repo/:rid/file/:filename', RepofileDownloadHandler, PRIV.PRIV_USER_PROFILE);

    
    ctx.injectUI('Nav', 'repo_domain', () => ({
        name: 'repo_domain',
        displayName: 'Repo',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));

    ctx.i18n.load('en', {
        repo_domain: 'Repository',
        repo_detail: 'Repository Detail',
        repo_edit: 'Edit Repository',
    });
    ctx.i18n.load('zh', {
        repo_domain: '资料库',
        repo_detail: '资料详情',
        repo_edit: '编辑资料',
    });
    ctx.inject(['api'], ({ api }) => {
        api.value('Repo', [
            ['docId', 'Int!'],
            ['rid', 'String!'],
            ['title', 'String!'],
            ['content', 'String!'],
            ['owner', 'Int!'],
            ['updateAt', 'String!'],
            ['views', 'Int!'],
            ['nReply', 'Int!'],
            ['files', '[File!]'],
        ]);

        api.value('File', [
            ['filename', 'String!'],
            ['version', 'String!'],
            ['path', 'String!'],
            ['size', 'Int!'],
            ['lastModified', 'String!'],
            ['etag', 'String!'],
        ]);

        api.resolver(
            'Query', 'repo(id: Int, title: String)', 'Repo',
            async (arg, c) => {
                c.checkPerm(PERM.PERM_VIEW);
                const rdoc = await Repo.get(c.args.domainId, arg.title || arg.id);
                if (!rdoc) return null;
                c.rdoc = rdoc;
                return rdoc;
            },
        );
        api.resolver('Query', 'repos(ids: [Int])', '[Repo]', async (arg, c) => {
            c.checkPerm(PERM.PERM_VIEW);
            const res = await Repo.getList(c.args.domainId, arg.ids, undefined);
            return Object.keys(res)
                .map((id) => res[+id])
                .filter((repo) => repo !== null && repo !== undefined); 
        }, 'Get a list of docs by ids');
        

    });
}

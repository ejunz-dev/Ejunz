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
import { QueryContext } from './repo';
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
export class RepoFileHandler extends Handler {
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

    @param('rid', Types.RepoId, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('limit', Types.PositiveInt, true)
    @param('pjax', Types.Boolean)
    @param('quick', Types.Boolean)
    async get(domainId: string, rid: string, page = 1, q = '', limit: number, pjax = false, quick = false) {
        this.response.template = 'repo_history.html';
        if (!limit || limit > this.ctx.setting.get('pagination.problem') || page > 1) limit = this.ctx.setting.get('pagination.problem');
        
        console.log('Initial Query Context:', this.queryContext);

        this.queryContext.query = buildQuery(this.user);
        this.queryContext.query.rid = rid;
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
        await this.ctx.parallel('repofile/list', query, this, sort);

        let [docs, ppcount, pcount] = this.queryContext.fail
        ? [[], 0, 0]
        : await Repo.listFiles(
            domainId, 
            query, 
            sort.length ? 1 : page, 
            limit,
            quick 
                ? ['title', 'rid', 'domainId', 'docId', 'files'] // 只投影到顶级属性
                : undefined,
            this.user._id,
        );
        console.log('docs', docs);
    
        // 提取文件信息
        const files = docs.flatMap(doc => doc.files.map(file => ({
            ...file,
            domainId: doc.domainId,
            docId: doc.docId,
            rid: doc.rid,
            title: doc.title,
        }))).filter(file => file.rid === rid); // 过滤出特定 rid 的文件
        console.log('files', files);

        if (total) {
            pcount = total;
            ppcount = Math.ceil(total / limit);
        }
        if (sort.length) docs = docs.sort((a, b) => sort.indexOf(`${a.domainId}/${a.docId}`) - sort.indexOf(`${b.domainId}/${b.docId}`));
        if (text && pcount > docs.length) pcount = docs.length;

       

        if (pjax) {
            this.response.body = {
                title: this.renderTitle(this.translate('repo_history')),
                fragments: (await Promise.all([
                    this.renderHTML('partials/repo_file_list.html', {
                        page, ppcount, pcount, files, psdict, qs: q,
                    }),
                ])).map((i) => ({ html: i })),
            };
        } else {
            this.response.body = {
                rid,
                page,
                pcount,
                ppcount,
                pcountRelation: this.queryContext.pcountRelation,
                files,
                psdict,
                qs: q,
            };
            console.log('rid', rid);
        }
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
    ctx.Route('repo_add_file', '/repo/:rid/add_file', RepoAddFileHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_history', '/repo/:rid/history', RepoFileHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_file_download', '/repo/:rid/file/:filename', RepofileDownloadHandler, PRIV.PRIV_USER_PROFILE);

}

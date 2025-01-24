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

class RepoHandler extends Handler {
    ddoc?: RepoDoc;

    @param('rid', Types.String, true) 
    async _prepare(domainId: string, rid: string) {
        if (rid) {
            const normalizedId: number | string = /^\d+$/.test(rid) ? Number(rid) : rid;

            console.log(`[RepoHandler] Querying document with ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);

            this.ddoc = await Repo.get(domainId, normalizedId); 

            if (!this.ddoc) {
                console.error(`[RepoHandler] Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);
                throw new NotFoundError(`Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}: ${normalizedId}`);
            }
        }
    }
}


export class RepoDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId;

        try {
            const domainInfo = await domain.get(domainId);
            if (!domainInfo) throw new NotFoundError(`Domain not found for ID: ${domainId}`);

            const allDocs = await Repo.getMulti(domainId, {}).toArray();

            const totalCount = allDocs.length;
            const totalPages = Math.ceil(totalCount / pageSize);
            const currentPage = Math.max(1, Math.min(page, totalPages));
            const startIndex = (currentPage - 1) * pageSize;
            const paginatedDocs = allDocs.slice(startIndex, startIndex + pageSize);

            this.response.template = 'repo_domain.html';
            this.response.body = {
                domainId,
                ddocs: paginatedDocs,
                page: currentPage,
                totalPages,
                totalCount,
            };
        } catch (error) {
            console.error('Error in fetching Repos:', error);
            this.response.template = 'error.html';
            this.response.body = { error: 'Failed to fetch repositories.' };
        }
    }
}

export class RepoDetailHandler extends Handler {
    ddoc?: RepoDoc;

    @param('rid', Types.String, true) 
    async _prepare(domainId: string, rid: string) {
        if (rid) {

            const normalizedId: number | string = /^\d+$/.test(rid) ? Number(rid) : rid;

            console.log(`[RepoDetailHandler] Querying document with ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);

            this.ddoc = await Repo.get(domainId, normalizedId);
            if (!this.ddoc) {
                console.error(`[RepoDetailHandler] Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}=${normalizedId}`);
                throw new NotFoundError(`Repository not found for ${typeof normalizedId === 'number' ? 'docId' : 'rid'}: ${normalizedId}`);
            }
        }
    }

    @param('rid', Types.String) 
    async get(domainId: string, rid: string) {
        if (!this.ddoc) throw new NotFoundError(`Repository not found for ID: ${rid}`);

        this.response.template = 'repo_detail.html';
        this.response.body = {
            domainId,
            ddoc: this.ddoc,
            files: this.ddoc.files || [],
        };
        console.log('Repo detail:', this.ddoc);
    }
}


export class RepoEditHandler extends RepoHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';
    
        const docId = this.ddoc?.docId;
        if (!docId) {
            throw new ValidationError('Missing docId');
        }
    
        // 这里用 `docId` 作为路径
        const files = await storage.list(`repo/${domainId}/${String(docId).padStart(3, '0')}`);
    
        const urlForFile = (filename: string) => `/d/${domainId}/${String(docId).padStart(3, '0')}/${filename}`;
    
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
@param('version', Types.String)
async postCreate(
    domainId: string,
    title: string,
    content: string,
    filename: string,
    version: string,
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

    domainInfo.files = domainInfo.files || [];
    
    // ✅ 生成 `docId`
    const docId = await Repo.generateNextDocId(domainId);

    const providedFilename = filename || file.originalFilename;
    const filePath = `repo/${domainId}/${docId}/${providedFilename}`;  // ✅ 修正 `filePath` 使用 `docId`

    const existingFile = domainInfo.files.find(
        (f) => f.filename === providedFilename && f.path.startsWith(`repo/${domainId}/`)
    );
    if (existingFile) {
        throw new ValidationError(`A file with the name "${providedFilename}" already exists in this repository.`);
    }

    await storage.put(filePath, file.filepath, this.user._id);
    const fileMeta = await storage.getMeta(filePath);
    if (!fileMeta) {
        throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);
    }

    const fileData = {
        filename: providedFilename ?? 'unknown_file',
        version: version ?? '0.0.0',
        path: filePath,  // ✅ 这里也是 `docId` 作为路径
        size: fileMeta.size ?? 0,
        lastModified: fileMeta.lastModified ?? new Date(),
        etag: fileMeta.etag ?? '',
    };

    // ✅ `addWithId()` 返回 `rid: string`，但 `filePath` 仍然用 `docId`
    const rid = await Repo.addWithId(
        domainId,
        docId,  // ✅ 这里传 `docId`
        this.user._id,
        title,
        content,
        this.request.ip,
        { files: [fileData] }
    );

    this.response.body = { docId };
    this.response.redirect = this.url('repo_detail', { uid: this.user._id, docId });
}

    

    @param('rid', Types.String)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, rid: string, title: string, content: string) {
        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) {
            throw new NotFoundError(`Repository not found for RID: ${rid}`);
        }

        const updatedRepo = await Repo.edit(domainId, rid, { title, content });

        console.log('Repo updated successfully:', updatedRepo);

        this.response.body = { rid };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, rid });
    }
}


export class RepoVersionHandler extends Handler {
    @param('rid', Types.String, true) // ✅ 现在直接使用 rid
    async get(domainId: string, rid: string) {
        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        this.response.template = 'repo_version.html';
        this.response.body = {
            ddoc: repo,
            domainId,
        };
    }

    @param('rid', Types.String, true)
    @param('filename', Types.String, true)
    @param('version', Types.String, true)
    async post(domainId: string, rid: string, filename: string, version: string) {
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('A file must be uploaded.');

        // ✅ 获取 RepoDoc（确保 rid 传递正确）
        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        // ✅ 使用 docId 作为路径，而不是 rid
        const docId = repo.docId;
        if (typeof docId !== 'number') {
            throw new Error(`Expected docId to be a number, but got ${typeof docId}`);
        }

        const filePath = `repo/${domainId}/${String(docId).padStart(3, '0')}/${filename}`;
        await storage.put(filePath, file.filepath, this.user._id);
        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);

        const fileData = {
            filename,
            version,
            path: filePath, // ✅ 修正 `path` 使用 `docId`
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
        };

        await Repo.addVersion(
            domainId,
            repo.docId,
            fileData.filename,
            fileData.version,
            fileData.path,
            fileData.size,
            fileData.lastModified,
            fileData.etag
        );
        

        console.log('Version added successfully:', fileData);

        this.response.redirect = this.url('repo_detail', { domainId, rid });
    }
}


export class RepoHistoryHandler extends Handler {
    @param('rid', Types.String, true) // 🔹 Now uses rid instead of rid
    async get(domainId: string, rid: string) {
        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        const sortedFiles = repo.files?.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()) || [];
        if (!sortedFiles.length) throw new NotFoundError('No files found in the repository.');

        this.response.template = 'repo_history.html';
        this.response.body = {
            ddoc: repo,
            domainId,
            rid: repo.rid,
            files: sortedFiles,
            urlForFile: (filename: string) => this.url('repo_file_download', { domainId, rid, filename }),
        };
    }
}



export class RepofileDownloadHandler extends Handler {
    async get({ rid, filename }: { rid: string; filename: string }) {
        const domainId = this.context.domainId || 'default_domain';
        const filePath = `repo/${domainId}/${rid}/${filename}`;

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
    ctx.Route('repo_domain', '/repo', RepoDomainHandler);
    ctx.Route('repo_create', '/repo/create', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_detail', '/repo/:rid', RepoDetailHandler);
    ctx.Route('repo_edit', '/repo/:rid/edit', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_add_version', '/repo/:rid/add-version', RepoVersionHandler, PRIV.PRIV_USER_PROFILE);
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
}

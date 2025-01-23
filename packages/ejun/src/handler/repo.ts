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

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await Repo.get(domainId, did);
            if (!this.ddoc) throw new NotFoundError(domainId, did);
        }
    }
}

export class RepoDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId;

        try {
            const domainInfo = await domain.get(domainId);
            if (!domainInfo) {
                throw new NotFoundError(`Domain not found for ID: ${domainId}`);
            }

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
            this.response.body = {
                error: 'Failed to fetch repositories.',
            };
        }
    }
}


export class RepoDetailHandler extends Handler {
    ddoc?: RepoDoc;

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await Repo.get(domainId, did);
            if (!this.ddoc) {
                throw new NotFoundError(`Repository not found for ID: ${did}`);
            }
        }
    }

    @param('did', Types.ObjectId)
    async get(domainId: string, did: ObjectId) {
        if (!this.ddoc) {
            throw new NotFoundError(`Repository not found for ID: ${did}`);
        }

        const files = this.ddoc.files || [];

        this.response.template = 'repo_detail.html';
        this.response.body = {
            domainId,
            ddoc: this.ddoc,
            files,
        };
    }
}



export class RepoEditHandler extends RepoHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';
        const rid = this.ddoc?.rid;
        const files = await storage.list(`repo/${domainId}/${rid}`);
        

        const urlForFile = (filename: string) =>
            `/d/${domainId}/${rid}/${(filename)}`;

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
    
        const Domain = await domain.get(domainId);
        if (!Domain) {
            throw new NotFoundError('Domain not found.');
        }
    
        Domain.files = Domain.files || [];
        const rid = await Repo.generateNextRid(domainId);
    
        const providedFilename = filename || file.originalFilename;
        const filePath = `repo/${domainId}/${rid}/${providedFilename}`;
    
        const existingFile = Domain.files.find(
            (f) => f.filename === providedFilename && f.path.startsWith(`repo/${domainId}/${rid}/`)
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
            path: filePath,
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
        };
    

        const did = await Repo.addWithId(domainId, this.user._id, title, content, this.request.ip, {
            files: [fileData],
            rid,
        });
    
        this.response.body = { did };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, did });
    }
    
    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectId, title: string, content: string) {

        const repo = await Repo.get(domainId, did);
        if (!repo) {
            throw new NotFoundError(`Repository not found for ID: ${did}`);
        }

        const updatedRepo = await Repo.edit(domainId, did, title, content);

        console.log('Repo updated successfully:', updatedRepo);

        this.response.body = { did };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, did });
    }
}

export class RepoVersionHandler extends Handler {
    @param('did', Types.ObjectId, true)
    async get(domainId: string, did: ObjectId) {
        const repo = await Repo.get(domainId, did);
        if (!repo) {
            throw new NotFoundError(`Repository not found for ID: ${did}`);
        }

        this.response.template = 'repo_version.html';
        this.response.body = {
            ddoc: repo,
            domainId,
        };
    }

    @param('did', Types.ObjectId, true)
    @param('filename', Types.String, true)
    @param('version', Types.String, true)
    async post(domainId: string, did: ObjectId, filename: string, version: string) {
        const file = this.request.files?.file;
        if (!file) {
            throw new ValidationError('A file must be uploaded.');
        }

        const repo = await Repo.get(domainId, did);
        if (!repo) {
            throw new NotFoundError(`Repository not found for ID: ${did}`);
        }

        const isValidVersion = /^\d+\.\d+\.\d+$/.test(version);
        if (!isValidVersion) {
            throw new ValidationError('Version must follow the format x.x.x (e.g., 1.0.0).');
        }

        const sortedFiles = repo.files?.sort((a, b) => this.compareVersion(a.version, b.version)) || [];
        const latestVersion = sortedFiles.length ? sortedFiles[sortedFiles.length - 1].version : null;
        if (latestVersion && this.compareVersion(version, latestVersion) <= 0) {
            throw new ValidationError(`Version ${version} must be greater than the latest version ${latestVersion}.`);
        }

        const existingFile = repo.files?.find((f) => f.filename === filename);
        if (existingFile) {
            throw new ValidationError(`A file with the name "${filename}" already exists in this repository.`);
        }

        const rid = repo.rid;
        const filePath = `repo/${domainId}/${rid}/${filename}`;
        await storage.put(filePath, file.filepath, this.user._id);
        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) {
            throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);
        }

        const fileData = {
            filename,
            version,
            path: filePath,
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
        };

        repo.files.push(fileData);
        await Repo.addversion(
            domainId,
            did,
            fileData.filename,
            fileData.version,
            fileData.path,
            fileData.size, 
            fileData.lastModified,
            fileData.etag 
        );
        console.log('New version added successfully:', fileData);

        this.response.body = { message: 'New version uploaded successfully.', fileData };
        this.response.redirect = this.url('repo_detail', { domainId, did });
    }

    private compareVersion(v1: string, v2: string): number {
        const v1Parts = v1.split('.').map(Number);
        const v2Parts = v2.split('.').map(Number);

        for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
            const part1 = v1Parts[i] || 0;
            const part2 = v2Parts[i] || 0;
            if (part1 > part2) return 1;
            if (part1 < part2) return -1;
        }
        return 0;
    }
}
export class RepoHistoryHandler extends Handler {
    @param('did', Types.ObjectId, true)
    async get(domainId: string, did: ObjectId) {
        const repo = await Repo.get(domainId, did);
        if (!repo) {
            throw new NotFoundError(`Repository not found for ID: ${did}`);
        }
        // 按 lastModified 时间排序
        const sortedFiles = repo.files?.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
        if (!sortedFiles || sortedFiles.length === 0) {
            throw new NotFoundError('No files found in the repository.');
        }

        this.response.template = 'repo_history.html';
        this.response.body = {
            ddoc: repo,
            domainId,
            rid: repo.rid,
            files: sortedFiles,
            urlForFile: (filename: string) =>
                this.url('repo_file_download', { domainId, filename }),
        };
    }
}


export class RepofileDownloadHandler extends Handler {
    async get({ rid, filename }: { rid: string; filename: string }) {
        const domainId = this.context.domainId || 'default_domain';

        console.log("Entering RepofileDownloadHandler.get...");
        console.log("Received rid:", rid, "filename:", filename);

        if (!rid || !filename) {
            throw new ValidationError('Invalid request: RID or filename missing.');
        }

        const filePath = `repo/${domainId}/${rid}/${filename}`;
        console.log("Resolved file path:", filePath);

        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) {
            throw new NotFoundError(`File "${filename}" does not exist in repository "${rid}".`);
        }

        const mimeType = lookup(filename) || 'application/octet-stream';
        console.log("File MIME type:", mimeType);

        try {
            this.response.body = await storage.get(filePath);
            this.response.type = mimeType;

            if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)) {
                this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
            }

            console.log("File streamed successfully:", fileMeta);
        } catch (error) {
            throw new Error(`Error streaming file "${filename}": ${error.message}`);
        }
    }
}
    
    






export async function apply(ctx: Context) {
    ctx.Route('repo_domain', '/repo', RepoDomainHandler);
    ctx.Route('repo_create', '/repo/create', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_detail', '/repo/:did', RepoDetailHandler);
    ctx.Route('repo_edit', '/repo/:did/edit', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_add_version', '/repo/:did/add-version', RepoVersionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_history', '/repo/:did/history', RepoHistoryHandler, PRIV.PRIV_USER_PROFILE);
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

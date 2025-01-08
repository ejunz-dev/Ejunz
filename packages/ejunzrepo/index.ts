import {
    _, Context, DocumentModel, Filter, DomainModel, bus,post,
    Handler, ObjectId, paginate, Projection, buildProjection,SystemModel,
    param, PRIV, Types, UserModel, BadRequestError, NotFoundError,ValidationError,FileLimitExceededError,StorageModel,FileUploadError
} from 'ejun';
import * as document from 'ejun/src/model/document';
import { Logger } from '@ejunz/utils/lib/utils';
import { pick } from 'lodash';
export const TYPE_REPO: 110 = 110; // 定义 REPO 类型常量

export interface RepoDoc {
    _id: ObjectId;
    docType: 110;
    domainId: string;
    docId: number;
    name: string;
    owner: number;
    files: RepoFileDoc[];
    createdAt: Date;
    updatedAt?: Date;
}

export interface RepoFileDoc {
    id: string; // 文件唯一标识符
    name: string; // 文件名
    size: number; // 文件大小
    lastModified: Date; // 最后修改时间
    etag: string; // 文件 ETag
}

declare module 'ejun' {
    interface Model {
        repo: typeof RepoModel;
    }
    interface DocType {
        [TYPE_REPO]: RepoDoc;
    }
}

interface RepoCreateOptions {
    name: string;
    owner: number;
    files?: RepoFileDoc[];
}

const logger = new Logger('repo');

export class RepoModel {
    static PROJECTION_PUBLIC: (keyof RepoDoc)[] = [
        '_id', 'domainId', 'docId', 'name', 'owner', 'files', 'createdAt', 'updatedAt'
    ];

    static async get(
        domainId: string,
        docId: number,
        projection: Projection<RepoDoc> = RepoModel.PROJECTION_PUBLIC
    ): Promise<RepoDoc | null> {
        const repo = await document.get(domainId, TYPE_REPO, docId, projection);
        return repo as RepoDoc | null;
    }

    static async list(
        domainId: string,
        query: Filter<RepoDoc>,
        page: number,
        pageSize: number,
        projection = RepoModel.PROJECTION_PUBLIC
    ): Promise<[RepoDoc[], number, number]> {
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union?.union || [])];
        let count = 0;
        const repos: RepoDoc[] = [];

        for (const id of domainIds) {
            const ccount = await document.count(id, TYPE_REPO, query);
            if (repos.length < pageSize && (page - 1) * pageSize - count <= ccount) {
                repos.push(
                    ...(await document
                        .getMulti(id, TYPE_REPO, query, projection)
                        .sort({ name: 1 })
                        .skip(Math.max((page - 1) * pageSize - count, 0))
                        .limit(pageSize - repos.length)
                        .toArray())
                );
            }
            count += ccount;
        }
        return [repos, Math.ceil(count / pageSize), count];
    }

    static async generateNextDocId(domainId: string): Promise<number> {
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_REPO, {})
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();
        return (lastDoc[0]?.docId || 0) + 1;
    }

    static async add(
        domainId: string,
        name: string,
        owner: number,
        files: RepoFileDoc[] = []
    ): Promise<RepoDoc> {
        const docId = await RepoModel.generateNextDocId(domainId);

        const repo: Partial<RepoDoc> = {
            name,
            owner,
            files,
            createdAt: new Date(),
            updatedAt: undefined,
        };

        const result = await document.add(
            domainId,
            name,
            owner,
            TYPE_REPO,
            docId,
            null,
            null,
            repo
        )as unknown as RepoDoc;
        return result as RepoDoc;
    }
    static async updateFiles(domainId: string, docId: number, files: RepoFileDoc[]): Promise<void> {
        await document.set(domainId, TYPE_REPO, docId, { files });
    }
    
}
class RepoMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const [repos, totalPages, totalCount] = await RepoModel.list(domainId, {}, page, 10);
        this.response.body = { repos, page, totalPages, totalCount };
        this.response.template = 'repo_main.html';
    }
}

class RepoDetailHandler extends Handler {
    @param('docId', Types.PositiveInt)
    async get(domainId: string, docId: number) {
        const repo = await RepoModel.get(domainId, docId);
        if (!repo) throw new NotFoundError(`Repo not found: ${docId}`);
        this.response.body = { repo };
        this.response.template = 'repo_detail.html';
    }
}

class RepoFilesHandler extends Handler {
    repo: RepoDoc;

    @param('docId', Types.PositiveInt)
    async prepare(domainId: string, docId: number) {
        const repo = await RepoModel.get(domainId, docId);
        if (!repo) throw new NotFoundError(`Repo not found: ${docId}`);
        this.repo = repo;
    }

    @param('docId', Types.PositiveInt)
    async get(domainId: string, docId: number) {
        this.response.body = {
            repo: this.repo,
            files: this.repo.files,
            urlForFile: (filename: string) => this.url('repo_file_download', { docId, filename }),
        };
        this.response.template = 'repo_files.html';
    }

    @param('docId', Types.PositiveInt)
    @post('files', Types.ArrayOf(Types.Filename))
    async postUploadFile(domainId: string, docId: number, filename: string) {
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');

        if ((this.repo.files?.length || 0) >= SystemModel.get('limit.repo_files')) {
            throw new FileLimitExceededError('count');
        }

        const f = statSync(file.filepath);
        const size = (this.repo.files || []).reduce((sum, f) => sum + f.size, 0) + f.size;

        if (size >= SystemModel.get('limit.repo_files_size')) {
            throw new FileLimitExceededError('size');
        }

        await StorageModel.put(`repo/${domainId}/${docId}/${filename}`, file.filepath, this.user._id);
        const meta = await StorageModel.getMeta(`repo/${domainId}/${docId}/${filename}`);
        const payload: RepoFileDoc = {
            id: filename,
            name: filename,
            ...pick(meta, ['size', 'lastModified', 'etag']),
        };

        if (!meta) throw new FileUploadError();

        this.repo.files.push(payload);
        await RepoModel.updateFiles(domainId, docId, this.repo.files);

        this.response.redirect = this.url('repo_files', { docId });
    }

    @param('docId', Types.PositiveInt)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, docId: number, files: string[]) {
        await Promise.all([
            StorageModel.del(files.map((f) => `repo/${domainId}/${docId}/${f}`), this.user._id),
            RepoModel.updateFiles(domainId, docId, this.repo.files.filter((f) => !files.includes(f.name))),
        ]);
        this.response.redirect = this.url('repo_files', { docId });
    }
}

export async function apply(ctx) {
    ctx.Route('repo_main', '/repo', RepoMainHandler);
    ctx.Route('repo_detail', '/repo/:docId', RepoDetailHandler);
    ctx.Route('repo_files', '/repo/:docId/files', RepoFilesHandler);
    ctx.injectUI('Nav', 'repo_main', () => ({
        name: 'repo_main',
        displayName: 'repo',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
}
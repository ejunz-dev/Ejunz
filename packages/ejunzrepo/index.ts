import {
    _, Context, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,ValidationError,
    param, PRIV, Types, UserModel, DomainModel, StorageModel, ProblemModel, NotFoundError,DiscussionNotFoundError
} from 'ejun';

export const TYPE_REPO: 110 = 110;
export interface RepoDoc {
    docType: 110;
    docId: ObjectId;
    domainId: string,
    rid: number;
    owner: number;
    reponame: string;
    content: string;
    ip: string;
    updateAt: Date;
    nReply: number;
    views: number;
    reply: any[];
    react: Record<string, number>;
    files: {
        name: string;            // 文件名
        path: string;            // 文件路径
        size: number;            // 文件大小
        lastModified: Date;      // 最后修改时间
        etag?: string;           // 文件校验码
    }[];                         // 支持多个文件
}                         // 支持多个文件


declare module 'ejun' {
    interface Model {
        repo: typeof RepoModel;
    }
    interface DocType {
        [TYPE_REPO]: RepoDoc;
    }
}

export class RepoModel {
    static async generateNextRid(domainId: string): Promise<number> {
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_REPO, {})
            .sort({ rid: -1 }) // 按 rid 降序排列
            .limit(1)
            .project({ rid: 1 })
            .toArray();
        return (lastDoc[0]?.rid || 0) + 1; // 若不存在文档，从 1 开始
    }

    static async addWithId(
        domainId: string,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<RepoDoc> = {},
    ): Promise<ObjectId> {
        const rid = await RepoModel.generateNextRid(domainId); // 生成新的 rid
        const payload: Partial<RepoDoc> = {
            domainId,
            content,
            owner,
            title,
            ip,
            rid,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            ...meta, // 合并其他元信息
        };

        const res = await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_REPO,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        payload.docId = res; // 添加生成的 docId
        return payload.docId;
    }

    static async getByRid(domainId: string, rid: number): Promise<RepoDoc | null> {
        const cursor = DocumentModel.getMulti(domainId, TYPE_REPO, { rid });
        const doc = await cursor.next();
        return doc ? (doc as RepoDoc) : null;
    }

    static async get(domainId: string, did: ObjectId): Promise<RepoDoc> {
        return await DocumentModel.get(domainId, TYPE_REPO, did);
    }

    static edit(domainId: string, did: ObjectId, title: string, content: string): Promise<RepoDoc> {
        const payload = { title, content };
        return DocumentModel.set(domainId, TYPE_REPO, did, payload);
    }

    static inc(domainId: string, did: ObjectId, key: NumberKeys<RepoDoc>, value: number): Promise<RepoDoc | null> {
        return DocumentModel.inc(domainId, TYPE_REPO, did, key, value);
    }

    static del(domainId: string, did: ObjectId): Promise<never> {
        return Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_REPO, did),
            DocumentModel.deleteMultiStatus(domainId, TYPE_REPO, { docId: did }),
        ]) as any;
    }

    static count(domainId: string, query: Filter<RepoDoc>) {
        return DocumentModel.count(domainId, TYPE_REPO, query);
    }

    static getMulti(domainId: string, query: Filter<RepoDoc> = {}) {
        return DocumentModel.getMulti(domainId, TYPE_REPO, query)
            .sort({ _id: -1 });
    }

    static async addReply(domainId: string, did: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [[, rrid]] = await Promise.all([
            DocumentModel.push(domainId, TYPE_REPO, did, 'reply', content, owner, { ip }),
            DocumentModel.incAndSet(domainId, TYPE_REPO, did, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return rrid;
    }

    static setStar(domainId: string, did: ObjectId, uid: number, star: boolean) {
        return DocumentModel.setStatus(domainId, TYPE_REPO, did, uid, { star });
    }

    static getStatus(domainId: string, did: ObjectId, uid: number) {
        return DocumentModel.getStatus(domainId, TYPE_REPO, did, uid);
    }

    static setStatus(domainId: string, did: ObjectId, uid: number, $set) {
        return DocumentModel.setStatus(domainId, TYPE_REPO, did, uid, $set);
    }
}

global.Ejunz.model.repo = RepoModel;



class RepoHandler extends Handler {
    ddoc?: RepoDoc;

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await RepoModel.get(domainId, did);
            if (!this.ddoc) throw new NotFoundError(domainId, did);
        }
    }
}



export class RepoDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        // 获取当前域 ID
        domainId = this.args?.domainId || this.context?.domainId || 'default_domain';

        const query = {};
        try {
            const domainInfo = await DomainModel.get(domainId);

            if (!domainInfo) {
                throw new Error(`Domain not found for id: ${domainId}`);
            }

            // 分页获取 Repo 列表
            const [repos, totalPages, totalCount] = await paginate(
                RepoModel.getMulti(domainId, query),
                page,
                pageSize
            );

            // 配置模板
            this.response.template = 'repo_domain.html';
            this.response.body = {
                domainId,
                domainName: domainInfo.name,
                repos,
                page,
                pageSize,
                totalPages,
                totalCount,
            };
        } catch (error) {
            console.error('Error in fetching Repos:', error);

            // 错误页面
            this.response.template = 'error.html';
            this.response.body = {
                error: 'Failed to fetch repositories.',
            };
        }
    }
}

class RepoDetailHandler extends RepoHandler {
    @param('did', Types.ObjectId)
    async get(domainId: string, did: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await RepoModel.getStatus(domainId, did, this.user._id)
            : null;

        const udoc = await UserModel.getById(domainId, this.ddoc!.owner);

        if (!dsdoc?.view) {
            await Promise.all([
                RepoModel.inc(domainId, did, 'views', 1),
                RepoModel.setStatus(domainId, did, this.user._id, { view: true }),
            ]);
        }
        console.log('ddoc:', this.ddoc);

        let rid = this.ddoc.rid;
        console.log('Original rid:', rid, 'Type:', typeof rid);

        if (typeof rid === 'string') {
            rid = parseInt(rid, 10);
            console.log('Converted rid to number:', rid);
        }

        if (isNaN(rid)) {
            throw new Error(`Invarid rid: ${this.ddoc.rid}`);
        }

        const problems = await getProblemsByRepoId(domainId, rid);

        this.response.template = 'repo_detail.html';
        this.response.body = {
            ddoc: this.ddoc,
            dsdoc,
            udoc,
            problems,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('did', Types.ObjectId)
    async postStar(domainId: string, did: ObjectId) {
        await RepoModel.setStar(domainId, did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await RepoModel.setStar(domainId, did, this.user._id, false);
        this.back({ star: false });
    }
}
export async function getProblemsByRepoId(domainId: string, rid: number) {
    console.log(`Fetching problems for repo ID: ${rid}`);
    const query = {
        domainId,
        associatedDocumentId: rid 
    };
    console.log(`Querying problems with:`, query);
    return await ProblemModel.getMulti(domainId, query).toArray();
}




export class RepoEditHandler extends RepoHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';
        const rid = this.ddoc?.rid;
        const files = await StorageModel.list(`domain/${domainId}/${rid}`);
        

        const urlForFile = (filename: string) =>
            `/d/${domainId}/${rid}/domainfile/${(filename)}`;

        this.response.template = 'repo_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            files,
            urlForFile,
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(
        domainId: string,
        title: string,
        content: string,
        filename: string,
        reponame: string
    ) {
        await this.limitRate('add_repo', 3600, 60);
    
        // 确保文件上传
        const file = this.request.files?.file;
        if (!file) {
            throw new ValidationError('A file must be uploaded to create a repo.');
        }
    
        // 校验 domain 是否存在
        const domain = await DomainModel.get(domainId);
        if (!domain) {
            throw new NotFoundError('Domain not found.');
        }
    
        // 初始化 domain.files
        domain.files = domain.files || [];
    
        // 生成新的 rid
        const rid = await RepoModel.generateNextRid(domainId);
    
        // 处理文件名
        const providedFilename = filename || file.originalFilename; // 优先使用用户提供的文件名
        const filePath = `domain/${domainId}/${rid}/${providedFilename}`;
    
        // 检查是否有重复的文件名
        const existingFile = domain.files.find(
            (f) => f.name === providedFilename && f.path.startsWith(`domain/${domainId}/${rid}/`)
        );
        if (existingFile) {
            throw new ValidationError(`A file with the name "${providedFilename}" already exists in this repository.`);
        }
    
        // 上传文件
        await StorageModel.put(filePath, file.filepath, this.user._id);
        // 获取文件元数据
        const fileMeta = await StorageModel.getMeta(filePath);
        if (!fileMeta) {
            throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);
        }
        const fileData = {
            name: providedFilename ?? 'unknown_file', // 如果 name 为 null，使用默认值
            path: filePath, // 文件路径
            size: fileMeta.size ?? 0, // 如果 size 为 undefined，使用默认值 0
            lastModified: fileMeta.lastModified ?? new Date(), // 如果 lastModified 为 undefined，使用当前时间
            etag: fileMeta.etag ?? '', // 如果 etag 为 undefined，使用空字符串
        };
        
        console.log('File uploaded successfully:', fileData);
    
        // 将文件信息添加到 domain.files
        domain.files.push(fileData);
        await DomainModel.edit(domainId, { files: domain.files });
    
        // 创建 repo
        const did = await RepoModel.addWithId(domainId, this.user._id, title, content, this.request.ip, {
            files: [fileData], // 存储文件信息到 repo
            reponame,
            rid,
        });
        
    
        // 响应
        this.response.body = { did };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, did });
    }
    
}



export async function apply(ctx: Context) {
    ctx.Route('repo_domain', '/repo', RepoDomainHandler);
    ctx.Route('repo_create', '/repo/create', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_detail', '/repo/:did', RepoDetailHandler);
    ctx.Route('repo_edit', '/repo/:did/edit', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
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

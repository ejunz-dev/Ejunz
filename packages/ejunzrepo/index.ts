import {
    _, Context, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel, DomainModel, StorageModel, ProblemModel, NotFoundError,DiscussionNotFoundError
} from 'ejun';

export const TYPE_REPO: 110 = 110;
export interface RepoDoc {
    docType: 110;
    docId: ObjectId;
    domainId: string,
    rid: number;
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    nReply: number;
    views: number;
    reply: any[];
    react: Record<string, number>;
}
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
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        const query = {};
        try {
            const domainInfo = await DomainModel.get(domainId);

            if (!domainInfo) {
                throw new Error(`Domain not found for id: ${domainId}`);
            }

            const [ddocs, totalPages, totalCount] = await paginate(
                RepoModel.getMulti(domainId, query),
                page,
                pageSize
            );

            this.response.template = 'repo_domain.html';
            this.response.body = {
                ddocs,
                domainId,
                dname: domainInfo.name,
                page,
                pageSize,
                totalPages,
                totalCount,
            };
        } catch (error) {
            this.response.template = 'error.html';
            this.response.body = {
                error: 'Failed to fetch documents for the domain.',
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
        const files = await StorageModel.list(`domain/${domainId}/`);

        const urlForFile = (filename: string) => `/d/${domainId}/domainfile/${encodeURIComponent(filename)}`;

        this.response.template = 'repo_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            files,
            urlForFile, 
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, title: string, content: string) {
        await this.limitRate('add_repo', 3600, 60);

        const did = await RepoModel.addWithId(
            domainId,
            this.user._id,
            title,
            content,
            this.request.ip
        );
        
        this.response.body = { did };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectId, title: string, content: string) {
       
        await Promise.all([
            RepoModel.edit(domainId,did, title, content),
            OplogModel.log(this, 'repo.edit', this.ddoc),
        ]);

        this.response.body = { did };
        this.response.redirect = this.url('repo_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {

        await Promise.all([
            RepoModel.del(domainId, did),
            OplogModel.log(this, 'repo.delete', this.ddoc),
        ]);

        this.response.redirect = this.url('repo_domain');
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

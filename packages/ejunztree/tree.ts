import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel, DomainModel,StorageModel,ProblemModel,NotFoundError
} from 'ejun';


export const TYPE_TREE: 1 = 1;

export interface TREEDoc {
    docType: 1;
    docId: ObjectId;
    domainId: string;
    teid: number;
    owner: number;
    ip: string;
    updateAt: Date;
    views: number;
    lids: Array<number>; 
    rids: Array<number>; 
}

declare module 'ejun' {
    interface Model {
        tree: typeof TreeModel;
    }
    interface DocType {
        [TYPE_TREE]: TREEDoc;
    }
}
export class TreeModel {
    static async generateNextTeid(domainId: string): Promise<number> {
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_TREE, {})
            .sort({ teid: -1 }) // 按 teid 降序排列
            .limit(1)
            .project({ teid: 1 })
            .toArray();
        return (lastDoc[0]?.teid || 0) + 1; // 若不存在文档，从 1 开始
    }

    // 添加 addWithId 方法
    static async addWithId(
        domainId: string,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<TreeDoc> = {},
    ): Promise<ObjectId> {
        const teid = await TreeModel.generateNextTeid(domainId); // 生成新的 teid
        const payload: Partial<TreeDoc> = {
            domainId,
            content,
            owner,
            title,
            ip,
            teid,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            ...meta, // 合并其他元信息
        };

        const res = await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_TREE,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        payload.docId = res; // 添加生成的 docId
        return payload.docId;
    }
    static async add(
        domainId:string, owner: number, title: string, content: string, ip?: string,
    ): Promise<ObjectId> {
        const payload: Partial<TreeDoc> = {
            domainId,
            content,
            owner,
            title,
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
        };
        const res = await DocumentModel.add(
            domainId, payload.content!, payload.owner!, TYPE_TREE,
            null, null, null, _.omit(payload, ['domainId', 'content', 'owner']),
        );
        payload.docId = res;
        return payload.docId;
    }
    static async getByTeid(domainId: string, teid: number): Promise<TreeDoc | null> {

        const cursor = DocumentModel.getMulti(domainId, TYPE_TREE, { teid });

        const doc = await cursor.next();
  
        if (!doc) {
            console.warn(`No Tree document found for teid: ${teid} in domain: ${domainId}`);
            return null;
        }
    
        return doc as TreeDoc;
    }
    

    static async get(domainId: string, did: ObjectId): Promise<TreeDoc> {
        return await DocumentModel.get(domainId, TYPE_TREE, did);
    }

    static edit(domainId: string, did: ObjectId, title: string, content: string): Promise<TreeDoc> {
        const payload = { title, content };
        return DocumentModel.set(domainId, TYPE_TREE, did, payload);
    }

    static inc(domainId: string, did: ObjectId, key: NumberKeys<TreeDoc>, value: number): Promise<TreeDoc | null> {
        return DocumentModel.inc(domainId, TYPE_TREE, did, key, value);
    }

    static del(domainId: string, did: ObjectId): Promise<never> {
        return Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_TREE, did),
            DocumentModel.deleteMultiStatus(domainId, TYPE_TREE, { docId: did }),
        ]) as any;
    }

    static count(domainId: string, query: Filter<TreeDoc>) {
        return DocumentModel.count(domainId, TYPE_TREE, query);
    }

    static getMulti(domainId: string, query: Filter<TreeDoc> = {}) {
        return DocumentModel.getMulti(domainId, TYPE_TREE, query)
            .sort({ _id: -1 });
    }

    static async addReply(domainId: string, did: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [[, drid]] = await Promise.all([
            DocumentModel.push(domainId, TYPE_TREE, did, 'reply', content, owner, { ip }),
            DocumentModel.incAndSet(domainId, TYPE_TREE, did, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return drid;
    }

    static setStar(domainId: string, did: ObjectId, uid: number, star: boolean) {
        return DocumentModel.setStatus(domainId, TYPE_TREE, did, uid, { star });
    }

    static getStatus(domainId: string, did: ObjectId, uid: number) {
        return DocumentModel.getStatus(domainId, TYPE_TREE, did, uid);
    }

    static setStatus(domainId: string, did: ObjectId, uid: number, $set) {
        return DocumentModel.setStatus(domainId, TYPE_TREE, did, uid, $set);
    }
}

global.Ejunz.model.tree = TreeModel;

class TreeHandler extends Handler {
    ddoc?: TreeDoc;

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await TreeModel.get(domainId, did);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, did);
        }
    }
}




export class TreeDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        const query = {};
        try {
            const domainInfo = await DomainModel.get(domainId);

            if (!domainInfo) {
                throw new Error(`Domain not found for id: ${domainId}`);
            }

            const [dtree, totalPages, totalCount] = await paginate(
                TreeModel.getMulti(domainId, query),
                page,
                pageSize
            );

            this.response.template = 'tree_domain.html';
            this.response.body = {
                dtree,
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
class TreeDetailHandler extends TreeHandler {
    @param('did', Types.ObjectId)
    async get(domainId: string, did: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await TreeModel.getStatus(domainId, did, this.user._id)
            : null;

        const udoc = await UserModel.getById(domainId, this.ddoc!.owner);

        if (!dsdoc?.view) {
            await Promise.all([
                TreeModel.inc(domainId, did, 'views', 1),
                TreeModel.setStatus(domainId, did, this.user._id, { view: true }),
            ]);
        }
        console.log('ddoc:', this.ddoc);

        let teid = this.ddoc.teid;
        console.log('Original teid:', teid, 'Type:', typeof teid);

        if (typeof teid === 'string') {
            teid = parseInt(teid, 10);
            console.log('Converted teid to number:', teid);
        }

        if (isNaN(teid)) {
            throw new Error(`Invalid teid: ${this.ddoc.teid}`);
        }

        const problems = await getProblemsByTreeId(domainId, teid);

        this.response.template = 'tree_detail.html';
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
        await TreeModel.setStar(domainId, did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await TreeModel.setStar(domainId, did, this.user._id, false);
        this.back({ star: false });
    }
}
export async function getProblemsByTreeId(domainId: string, teid: number) {
    console.log(`Fetching problems for tree ID: ${teid}`);
    const query = {
        domainId,
        associatedDocumentId: teid 
    };
    console.log(`Querying problems with:`, query);
    return await ProblemModel.getMulti(domainId, query).toArray();
}




export class TreeEditHandler extends TreeHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';
        const files = await StorageModel.list(`domain/${domainId}/`);

        const urlForFile = (filename: string) => `/d/${domainId}/domainfile/${encodeURIComponent(filename)}`;

        this.response.template = 'tree_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            files,
            urlForFile, 
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, title: string, content: string) {
        await this.limitRate('add_tree', 3600, 60);

        const did = await TreeModel.addWithId(
            domainId,
            this.user._id,
            title,
            content,
            this.request.ip
        );
        
        this.response.body = { did };
        this.response.redirect = this.url('tree_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectId, title: string, content: string) {
       
        await Promise.all([
            TreeModel.edit(domainId,did, title, content),
            OplogModel.log(this, 'tree.edit', this.ddoc),
        ]);

        this.response.body = { did };
        this.response.redirect = this.url('tree_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {

        await Promise.all([
            TreeModel.del(domainId, did),
            OplogModel.log(this, 'tree.delete', this.ddoc),
        ]);

        this.response.redirect = this.url('tree_domain');
    }
}




export async function apply(ctx: Context) {
    // ctx.Route('tree', '/tree', LibHandler);
    ctx.Route('tree_domain', '/tree', TreeDomainHandler);
    ctx.Route('tree_create', '/tree/create', TreeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tree_detail', '/tree/:did', TreeDetailHandler);
    ctx.Route('tree_edit', '/tree/:did/edit', TreeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('Nav', 'tree_main', () => ({
        name: 'tree_main',
        displayName: 'Tree',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
    

}

import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel, DomainModel,StorageModel,ProblemModel,NotFoundError
} from 'ejun';

export const TYPE_DOCS: 100 = 100;
export interface DocsDoc {
    docType: 100;
    docId: ObjectId;
    domainId: string,
    lid: number;
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
        docs: typeof DocsModel;
    }
    interface DocType {
        [TYPE_DOCS]: DocsDoc;
    }
}

export class DocsModel {
    static async generateNextLid(domainId: string): Promise<number> {
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_DOCS, {})
            .sort({ lid: -1 }) // 按 lid 降序排列
            .limit(1)
            .project({ lid: 1 })
            .toArray();
        return (lastDoc[0]?.lid || 0) + 1; // 若不存在文档，从 1 开始
    }

    // 添加 addWithId 方法
    static async addWithId(
        domainId: string,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<DocsDoc> = {},
    ): Promise<ObjectId> {
        const lid = await DocsModel.generateNextLid(domainId); // 生成新的 lid
        const payload: Partial<DocsDoc> = {
            domainId,
            content,
            owner,
            title,
            ip,
            lid,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            ...meta, // 合并其他元信息
        };

        const res = await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_DOCS,
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
        const payload: Partial<DocsDoc> = {
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
            domainId, payload.content!, payload.owner!, TYPE_DOCS,
            null, null, null, _.omit(payload, ['domainId', 'content', 'owner']),
        );
        payload.docId = res;
        return payload.docId;
    }
    static async getByLid(domainId: string, lid: number): Promise<DocsDoc | null> {

        const cursor = DocumentModel.getMulti(domainId, TYPE_DOCS, { lid });

        const doc = await cursor.next();
  
        if (!doc) {
            console.warn(`No Docs document found for lid: ${lid} in domain: ${domainId}`);
            return null;
        }
    
        return doc as DocsDoc;
    }
    

    static async get(domainId: string, did: ObjectId): Promise<DocsDoc> {
        return await DocumentModel.get(domainId, TYPE_DOCS, did);
    }

    static edit(domainId: string, did: ObjectId, title: string, content: string): Promise<DocsDoc> {
        const payload = { title, content };
        return DocumentModel.set(domainId, TYPE_DOCS, did, payload);
    }

    static inc(domainId: string, did: ObjectId, key: NumberKeys<DocsDoc>, value: number): Promise<DocsDoc | null> {
        return DocumentModel.inc(domainId, TYPE_DOCS, did, key, value);
    }

    static del(domainId: string, did: ObjectId): Promise<never> {
        return Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_DOCS, did),
            DocumentModel.deleteMultiStatus(domainId, TYPE_DOCS, { docId: did }),
        ]) as any;
    }

    static count(domainId: string, query: Filter<DocsDoc>) {
        return DocumentModel.count(domainId, TYPE_DOCS, query);
    }

    static getMulti(domainId: string, query: Filter<DocsDoc> = {}) {
        return DocumentModel.getMulti(domainId, TYPE_DOCS, query)
            .sort({ _id: -1 });
    }

    static async addReply(domainId: string, did: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [[, drid]] = await Promise.all([
            DocumentModel.push(domainId, TYPE_DOCS, did, 'reply', content, owner, { ip }),
            DocumentModel.incAndSet(domainId, TYPE_DOCS, did, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return drid;
    }

    static setStar(domainId: string, did: ObjectId, uid: number, star: boolean) {
        return DocumentModel.setStatus(domainId, TYPE_DOCS, did, uid, { star });
    }

    static getStatus(domainId: string, did: ObjectId, uid: number) {
        return DocumentModel.getStatus(domainId, TYPE_DOCS, did, uid);
    }

    static setStatus(domainId: string, did: ObjectId, uid: number, $set) {
        return DocumentModel.setStatus(domainId, TYPE_DOCS, did, uid, $set);
    }
}

global.Ejunz.model.docs = DocsModel;

class DocsHandler extends Handler {
    ddoc?: DocsDoc;

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await DocsModel.get(domainId, did);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, did);
        }
    }
}




export class DocsDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        const query = {};
        try {
            const domainInfo = await DomainModel.get(domainId);

            if (!domainInfo) {
                throw new Error(`Domain not found for id: ${domainId}`);
            }

            const [ddocs, totalPages, totalCount] = await paginate(
                DocsModel.getMulti(domainId, query),
                page,
                pageSize
            );

            this.response.template = 'docs_domain.html';
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
class DocsDetailHandler extends DocsHandler {
    @param('did', Types.ObjectId)
    async get(domainId: string, did: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await DocsModel.getStatus(domainId, did, this.user._id)
            : null;

        const udoc = await UserModel.getById(domainId, this.ddoc!.owner);

        if (!dsdoc?.view) {
            await Promise.all([
                DocsModel.inc(domainId, did, 'views', 1),
                DocsModel.setStatus(domainId, did, this.user._id, { view: true }),
            ]);
        }
        console.log('ddoc:', this.ddoc);

        let lid = this.ddoc.lid;
        console.log('Original lid:', lid, 'Type:', typeof lid);

        if (typeof lid === 'string') {
            lid = parseInt(lid, 10);
            console.log('Converted lid to number:', lid);
        }

        if (isNaN(lid)) {
            throw new Error(`Invalid lid: ${this.ddoc.lid}`);
        }

        const problems = await getProblemsByDocsId(domainId, lid);

        this.response.template = 'docs_detail.html';
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
        await DocsModel.setStar(domainId, did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await DocsModel.setStar(domainId, did, this.user._id, false);
        this.back({ star: false });
    }
}
export async function getProblemsByDocsId(domainId: string, lid: number) {
    console.log(`Fetching problems for docs ID: ${lid}`);
    const query = {
        domainId,
        associatedDocumentId: lid 
    };
    console.log(`Querying problems with:`, query);
    return await ProblemModel.getMulti(domainId, query).toArray();
}




export class DocsEditHandler extends DocsHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';
        const files = await StorageModel.list(`domain/${domainId}/`);

        const urlForFile = (filename: string) => `/d/${domainId}/domainfile/${encodeURIComponent(filename)}`;

        this.response.template = 'docs_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            files,
            urlForFile, 
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, title: string, content: string) {
        await this.limitRate('add_docs', 3600, 60);

        const did = await DocsModel.addWithId(
            domainId,
            this.user._id,
            title,
            content,
            this.request.ip
        );
        
        this.response.body = { did };
        this.response.redirect = this.url('docs_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectId, title: string, content: string) {
       
        await Promise.all([
            DocsModel.edit(domainId,did, title, content),
            OplogModel.log(this, 'docs.edit', this.ddoc),
        ]);

        this.response.body = { did };
        this.response.redirect = this.url('docs_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {

        await Promise.all([
            DocsModel.del(domainId, did),
            OplogModel.log(this, 'docs.delete', this.ddoc),
        ]);

        this.response.redirect = this.url('docs_domain');
    }
}




export async function apply(ctx: Context) {
    // ctx.Route('docs', '/docs', LibHandler);
    ctx.Route('docs_domain', '/docs', DocsDomainHandler);
    ctx.Route('docs_create', '/docs/create', DocsEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('docs_detail', '/docs/:did', DocsDetailHandler);
    ctx.Route('docs_edit', '/docs/:did/edit', DocsEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('Nav', 'docs_domain', () => ({
        name: 'docs_domain',
        displayName: 'Docs',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
    
    ctx.i18n.load('zh', {
        "{0}'s docs": '{0} 的文档',
        Docs: '文档',
        docs_detail: '文档详情',
        docs_edit: '编辑文档',
        docs_domain: '文档',
    });
    ctx.i18n.load('zh_TW', {
        "{0}'s docs": '{0} 的部落格',
        Docs: '部落格',
        docs_detail: '部落格詳情',
        docs_edit: '編輯部落格',
        docs_main: '部落格',
    });
    ctx.i18n.load('kr', {
        "{0}'s docs": '{0}의 블로그',
        Docs: '블로그',
        docs_main: '블로그',
        docs_detail: '블로그 상세',
        docs_edit: '블로그 수정',
    });
    ctx.i18n.load('en', {
        docs_main: 'Docs',
        docs_detail: 'Docs Detail',
        docs_edit: 'Edit Docs',
    });
}

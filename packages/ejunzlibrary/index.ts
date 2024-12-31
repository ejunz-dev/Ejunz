import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel, DomainModel
} from 'ejun';

export const TYPE_LIBRARY: 100 = 100;
export interface LibraryDoc {
    docType: 100;
    docId: ObjectId;
    domainId: string,
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
        library: typeof LibraryModel;
    }
    interface DocType {
        [TYPE_LIBRARY]: LibraryDoc;
    }
}

export class LibraryModel {
    static async add(
        domainId:string, owner: number, title: string, content: string, ip?: string,
    ): Promise<ObjectId> {
        const payload: Partial<LibraryDoc> = {
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
            domainId, payload.content!, payload.owner!, TYPE_LIBRARY,
            null, null, null, _.omit(payload, ['domainId', 'content', 'owner']),
        );
        payload.docId = res;
        return payload.docId;
    }

    static async get(domainId: string, did: ObjectId): Promise<LibraryDoc> {
        return await DocumentModel.get(domainId, TYPE_LIBRARY, did);
    }

    static edit(domainId: string, did: ObjectId, title: string, content: string): Promise<LibraryDoc> {
        const payload = { title, content };
        return DocumentModel.set(domainId, TYPE_LIBRARY, did, payload);
    }

    static inc(domainId: string, did: ObjectId, key: NumberKeys<LibraryDoc>, value: number): Promise<LibraryDoc | null> {
        return DocumentModel.inc(domainId, TYPE_LIBRARY, did, key, value);
    }

    static del(domainId: string, did: ObjectId): Promise<never> {
        return Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_LIBRARY, did),
            DocumentModel.deleteMultiStatus(domainId, TYPE_LIBRARY, { docId: did }),
        ]) as any;
    }

    static count(domainId: string, query: Filter<LibraryDoc>) {
        return DocumentModel.count(domainId, TYPE_LIBRARY, query);
    }

    static getMulti(domainId: string, query: Filter<LibraryDoc> = {}) {
        return DocumentModel.getMulti(domainId, TYPE_LIBRARY, query)
            .sort({ _id: -1 });
    }

    static async addReply(domainId: string, did: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [[, drid]] = await Promise.all([
            DocumentModel.push(domainId, TYPE_LIBRARY, did, 'reply', content, owner, { ip }),
            DocumentModel.incAndSet(domainId, TYPE_LIBRARY, did, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return drid;
    }

    static setStar(domainId: string, did: ObjectId, uid: number, star: boolean) {
        return DocumentModel.setStatus(domainId, TYPE_LIBRARY, did, uid, { star });
    }

    static getStatus(domainId: string, did: ObjectId, uid: number) {
        return DocumentModel.getStatus(domainId, TYPE_LIBRARY, did, uid);
    }

    static setStatus(domainId: string, did: ObjectId, uid: number, $set) {
        return DocumentModel.setStatus(domainId, TYPE_LIBRARY, did, uid, $set);
    }
}

global.Ejunz.model.library = LibraryModel;

class LibraryHandler extends Handler {
    ddoc?: LibraryDoc;

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await LibraryModel.get(domainId, did);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, did);
        }
    }
}




export class LibraryDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        const query = {};
        try {
            const domainInfo = await DomainModel.get(domainId);

            if (!domainInfo) {
                throw new Error(`Domain not found for id: ${domainId}`);
            }

            const [ddocs, totalPages, totalCount] = await paginate(
                LibraryModel.getMulti(domainId, query),
                page,
                pageSize
            );

            this.response.template = 'library_domain.html';
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






class LibraryDetailHandler extends LibraryHandler {
    @param('did', Types.ObjectId)
    async get(domainId: string, did: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await LibraryModel.getStatus(domainId, did, this.user._id)
            : null;
        const udoc = await UserModel.getById(domainId, this.ddoc!.owner);
        if (!dsdoc?.view) {
            await Promise.all([
                LibraryModel.inc(domainId, did, 'views', 1),
                LibraryModel.setStatus(domainId, did, this.user._id, { view: true }),
            ]);
        }
        this.response.template = 'library_detail.html';
        this.response.body = {
            ddoc: this.ddoc, dsdoc, udoc,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('did', Types.ObjectId)
    async postStar(domainId: string, did: ObjectId) {
        await LibraryModel.setStar(domainId, did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await LibraryModel.setStar(domainId, did, this.user._id, false);
        this.back({ star: false });
    }
}

class LibraryEditHandler extends LibraryHandler {
    async get() {
        this.response.template = 'library_edit.html';
        this.response.body = { ddoc: this.ddoc };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, title: string, content: string) {
        await this.limitRate('add_library', 3600, 60);
        const did = await LibraryModel.add(domainId, this.user._id, title, content, this.request.ip);
        this.response.body = { did };
        this.response.redirect = this.url('library_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectId, title: string, content: string) {
        if (!this.user.own(this.ddoc!)) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await Promise.all([
            LibraryModel.edit(domainId, did, title, content),
            OplogModel.log(this, 'library.edit', this.ddoc),
        ]);
        this.response.body = { did };
        this.response.redirect = this.url('library_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {
        if (!this.user.own(this.ddoc!)) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await Promise.all([
            LibraryModel.del(domainId, did),
            OplogModel.log(this, 'library.delete', this.ddoc),
        ]);
        this.response.redirect = this.url('library_main', { uid: this.ddoc!.owner });
    }
}

export async function apply(ctx: Context) {
    // ctx.Route('library', '/library', LibHandler);
    ctx.Route('library_domain', '/library', LibraryDomainHandler);
    ctx.Route('library_create', '/library/create', LibraryEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('library_detail', '/library/:did', LibraryDetailHandler);
    ctx.Route('library_edit', '/library/:did/edit', LibraryEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('Nav', 'library_domain', () => ({
        name: 'library_domain',
        displayName: 'Library',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
    ctx.i18n.load('zh', {
        "{0}'s library": '{0} 的项目',
        Library: '项目',
        library_detail: '项目详情',
        library_edit: '编辑项目',
        library_main: '项目',
    });
    ctx.i18n.load('zh_TW', {
        "{0}'s library": '{0} 的部落格',
        Library: '部落格',
        library_detail: '部落格詳情',
        library_edit: '編輯部落格',
        library_main: '部落格',
    });
    ctx.i18n.load('kr', {
        "{0}'s library": '{0}의 블로그',
        Library: '블로그',
        library_main: '블로그',
        library_detail: '블로그 상세',
        library_edit: '블로그 수정',
    });
    ctx.i18n.load('en', {
        library_main: 'Library',
        library_detail: 'Library Detail',
        library_edit: 'Edit Library',
    });
}

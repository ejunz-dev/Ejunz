import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel,
} from 'ejun';

export const TYPE_LIBRARY: 100 = 100;
export interface LibraryDoc {
    docType: 100;
    docId: ObjectId;
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
        owner: number, title: string, content: string, ip?: string,
    ): Promise<ObjectId> {
        const payload: Partial<LibraryDoc> = {
            content,
            owner,
            title,
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
        };
        const res = await DocumentModel.add(
            'system', payload.content!, payload.owner!, TYPE_LIBRARY,
            null, null, null, _.omit(payload, ['domainId', 'content', 'owner']),
        );
        payload.docId = res;
        return payload.docId;
    }

    static async get(did: ObjectId): Promise<LibraryDoc> {
        return await DocumentModel.get('system', TYPE_LIBRARY, did);
    }

    static edit(did: ObjectId, title: string, content: string): Promise<LibraryDoc> {
        const payload = { title, content };
        return DocumentModel.set('system', TYPE_LIBRARY, did, payload);
    }

    static inc(did: ObjectId, key: NumberKeys<LibraryDoc>, value: number): Promise<LibraryDoc | null> {
        return DocumentModel.inc('system', TYPE_LIBRARY, did, key, value);
    }

    static del(did: ObjectId): Promise<never> {
        return Promise.all([
            DocumentModel.deleteOne('system', TYPE_LIBRARY, did),
            DocumentModel.deleteMultiStatus('system', TYPE_LIBRARY, { docId: did }),
        ]) as any;
    }

    static count(query: Filter<LibraryDoc>) {
        return DocumentModel.count('system', TYPE_LIBRARY, query);
    }

    static getMulti(query: Filter<LibraryDoc> = {}) {
        return DocumentModel.getMulti('system', TYPE_LIBRARY, query)
            .sort({ _id: -1 });
    }

    static async addReply(did: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [[, drid]] = await Promise.all([
            DocumentModel.push('system', TYPE_LIBRARY, did, 'reply', content, owner, { ip }),
            DocumentModel.incAndSet('system', TYPE_LIBRARY, did, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return drid;
    }

    static setStar(did: ObjectId, uid: number, star: boolean) {
        return DocumentModel.setStatus('system', TYPE_LIBRARY, did, uid, { star });
    }

    static getStatus(did: ObjectId, uid: number) {
        return DocumentModel.getStatus('system', TYPE_LIBRARY, did, uid);
    }

    static setStatus(did: ObjectId, uid: number, $set) {
        return DocumentModel.setStatus('system', TYPE_LIBRARY, did, uid, $set);
    }
}

global.Ejunz.model.library = LibraryModel;

class LibraryHandler extends Handler {
    ddoc?: LibraryDoc;

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await LibraryModel.get(did);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, did);
        }
    }
}

class LibraryUserHandler extends LibraryHandler {
    @param('uid', Types.Int)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, uid: number, page = 1) {
        const [ddocs, dpcount] = await paginate(
            LibraryModel.getMulti({ owner: uid }),
            page,
            10,
        );
        const udoc = await UserModel.getById(domainId, uid);
        this.response.template = 'library_main.html';
        this.response.body = {
            ddocs,
            dpcount,
            udoc,
            page,
        };
    }
}

class LibraryDetailHandler extends LibraryHandler {
    @param('did', Types.ObjectId)
    async get(domainId: string, did: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await LibraryModel.getStatus(did, this.user._id)
            : null;
        const udoc = await UserModel.getById(domainId, this.ddoc!.owner);
        if (!dsdoc?.view) {
            await Promise.all([
                LibraryModel.inc(did, 'views', 1),
                LibraryModel.setStatus(did, this.user._id, { view: true }),
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
        await LibraryModel.setStar(did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await LibraryModel.setStar(did, this.user._id, false);
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
        const did = await LibraryModel.add(this.user._id, title, content, this.request.ip);
        this.response.body = { did };
        this.response.redirect = this.url('library_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectId, title: string, content: string) {
        if (!this.user.own(this.ddoc!)) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await Promise.all([
            LibraryModel.edit(did, title, content),
            OplogModel.log(this, 'library.edit', this.ddoc),
        ]);
        this.response.body = { did };
        this.response.redirect = this.url('library_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {
        if (!this.user.own(this.ddoc!)) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await Promise.all([
            LibraryModel.del(did),
            OplogModel.log(this, 'library.delete', this.ddoc),
        ]);
        this.response.redirect = this.url('library_main', { uid: this.ddoc!.owner });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('library_main', '/library/:uid', LibraryUserHandler);
    ctx.Route('library_create', '/library/:uid/create', LibraryEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('library_detail', '/library/:uid/:did', LibraryDetailHandler);
    ctx.Route('library_edit', '/library/:uid/:did/edit', LibraryEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('UserDropdown', 'library_main', (h) => ({ icon: 'book', displayName: 'Library', uid: h.user._id.toString() }),
        PRIV.PRIV_USER_PROFILE);
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

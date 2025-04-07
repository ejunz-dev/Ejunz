import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel, PERM, PERMS_BY_FAMILY, Permission
} from 'ejun';

export const TYPE_BLOG: 80 = 80;
export interface BlogDoc {
    docType: 80;
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
        blog: typeof BlogModel;
    }
    interface DocType {
        [TYPE_BLOG]: BlogDoc;
    }
}

export class BlogModel {
    static async add(
        owner: number, title: string, content: string, ip?: string,
    ): Promise<ObjectId> {
        const payload: Partial<BlogDoc> = {
            content,
            owner,
            title,
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
        };
        const res = await DocumentModel.add(
            'system', payload.content!, payload.owner!, TYPE_BLOG,
            null, null, null, _.omit(payload, ['domainId', 'content', 'owner']),
        );
        payload.docId = res;
        return payload.docId;
    }

    static async get(did: ObjectId): Promise<BlogDoc> {
        return await DocumentModel.get('system', TYPE_BLOG, did);
    }

    static edit(did: ObjectId, title: string, content: string): Promise<BlogDoc> {
        const payload = { title, content };
        return DocumentModel.set('system', TYPE_BLOG, did, payload);
    }

    static inc(did: ObjectId, key: NumberKeys<BlogDoc>, value: number): Promise<BlogDoc | null> {
        return DocumentModel.inc('system', TYPE_BLOG, did, key, value);
    }

    static del(did: ObjectId): Promise<never> {
        return Promise.all([
            DocumentModel.deleteOne('system', TYPE_BLOG, did),
            DocumentModel.deleteMultiStatus('system', TYPE_BLOG, { docId: did }),
        ]) as any;
    }

    static count(query: Filter<BlogDoc>) {
        return DocumentModel.count('system', TYPE_BLOG, query);
    }

    static getMulti(query: Filter<BlogDoc> = {}) {
        return DocumentModel.getMulti('system', TYPE_BLOG, query)
            .sort({ _id: -1 });
    }

    static async addReply(did: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [[, drid]] = await Promise.all([
            DocumentModel.push('system', TYPE_BLOG, did, 'reply', content, owner, { ip }),
            DocumentModel.incAndSet('system', TYPE_BLOG, did, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return drid;
    }

    static setStar(did: ObjectId, uid: number, star: boolean) {
        return DocumentModel.setStatus('system', TYPE_BLOG, did, uid, { star });
    }

    static getStatus(did: ObjectId, uid: number) {
        return DocumentModel.getStatus('system', TYPE_BLOG, did, uid);
    }

    static setStatus(did: ObjectId, uid: number, $set) {
        return DocumentModel.setStatus('system', TYPE_BLOG, did, uid, $set);
    }
}

global.Ejunz.model.blog = BlogModel;

class BlogHandler extends Handler {
    ddoc?: BlogDoc;

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await BlogModel.get(did);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, did);
        }
    }
}

class BlogUserHandler extends BlogHandler {
    @param('uid', Types.Int)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, uid: number, page = 1) {
        const [ddocs, dpcount] = await paginate(
            BlogModel.getMulti({ owner: uid }),
            page,
            10,
        );
        const udoc = await UserModel.getById(domainId, uid);
        this.response.template = 'blog_main.html';
        this.response.body = {
            ddocs,
            dpcount,
            udoc,
            page,
        };
    }
}

class BlogDetailHandler extends BlogHandler {
    @param('did', Types.ObjectId)
    async get(domainId: string, did: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await BlogModel.getStatus(did, this.user._id)
            : null;
        const udoc = await UserModel.getById(domainId, this.ddoc!.owner);
        if (!dsdoc?.view) {
            await Promise.all([
                BlogModel.inc(did, 'views', 1),
                BlogModel.setStatus(did, this.user._id, { view: true }),
            ]);
        }
        this.response.template = 'blog_detail.html';
        this.response.body = {
            ddoc: this.ddoc, dsdoc, udoc,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('did', Types.ObjectId)
    async postStar(domainId: string, did: ObjectId) {
        await BlogModel.setStar(did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await BlogModel.setStar(did, this.user._id, false);
        this.back({ star: false });
    }
}

class BlogEditHandler extends BlogHandler {
    async get() {
        this.response.template = 'blog_edit.html';
        this.response.body = { ddoc: this.ddoc };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, title: string, content: string) {
        await this.limitRate('add_blog', 3600, 60);
        const did = await BlogModel.add(this.user._id, title, content, this.request.ip);
        this.response.body = { did };
        this.response.redirect = this.url('blog_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectId, title: string, content: string) {
        if (!this.user.own(this.ddoc!)) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await Promise.all([
            BlogModel.edit(did, title, content),
            OplogModel.log(this, 'blog.edit', this.ddoc),
        ]);
        this.response.body = { did };
        this.response.redirect = this.url('blog_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {
        if (!this.user.own(this.ddoc!)) this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await Promise.all([
            BlogModel.del(did),
            OplogModel.log(this, 'blog.delete', this.ddoc),
        ]);
        this.response.redirect = this.url('blog_main', { uid: this.ddoc!.owner });
    }
}

export async function apply(ctx: Context) {
    // 定义插件权限标识符
    const PERM = {
        PERM_VIEW_BLOG: 1n << 71n, // 查看博客权限
        PERM_VIEW_BLOG_DETAILED: 1n << 72n, // 查看详细博客权限
    };

    // 动态注册权限
    global.Ejunz.model.builtin.registerPluginPermission(
        'blog', 
        PERM.PERM_VIEW_BLOG, 
        'View blogs'
    );

    global.Ejunz.model.builtin.registerPluginPermission(
        'blog', 
        PERM.PERM_VIEW_BLOG_DETAILED, 
        'View detailed blogs'
    );

    // 定义路由并绑定权限
    ctx.Route('blog_main', '/blog/:uid', BlogUserHandler, PERM.PERM_VIEW_BLOG);
    ctx.Route('blog_create', '/blog/:uid/create', BlogEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('blog_detail', '/blog/:uid/:did', BlogDetailHandler, PERM.PERM_VIEW_BLOG_DETAILED);
    ctx.Route('blog_edit', '/blog/:uid/:did/edit', BlogEditHandler, PRIV.PRIV_USER_PROFILE);

    // 注入到用户的 UserDropdown
    ctx.injectUI('UserDropdown', 'blog_main', (h) => ({
        icon: 'book',
        displayName: 'Blog',
        uid: h.user._id.toString(),
    }), PRIV.PRIV_USER_PROFILE);

    // 注入到用户的 Detail 页
    ctx.injectUI('ProfileHeaderContact', 'blog_main', (h) => ({
        icon: 'book',
        displayName: 'Go Blog',
        uid: h.udoc._id.toString()
        
    }
));
    // 加载多语言支持
    ctx.i18n.load('zh', {
        "{0}'s blog": '{0} 的博客',
        Blog: '博客',
        blog: '博客',
        blog_detail: '博客详情',
        blog_edit: '编辑博客',
        blog_main: '博客',
        'View blogs': '查看博客',
        'View detailed blogs': '查看详细博客',
    });
    ctx.i18n.load('zh_TW', {
        "{0}'s blog": '{0} 的部落格',
        Blog: '部落格',
        blog: '部落格',
        blog_detail: '部落格詳情',
        blog_edit: '編輯部落格',
        blog_main: '部落格',
        'View blogs': '檢視博客',
        'View detailed blogs': '檢視詳細博客',
    });
    ctx.i18n.load('kr', {
        "{0}'s blog": '{0}의 블로그',
        Blog: '블로그',
        blog: '블로그',
        blog_main: '블로그',
        blog_detail: '블로그 상세',
        blog_edit: '블로그 수정',
        'View blogs': '블로그 보기',
        'View detailed blogs': '상세 블로그 보기',
    });
    ctx.i18n.load('en', {
        blog: 'Blog',
        blog_main: 'Blog',
        blog_detail: 'Blog Detail',
        blog_edit: 'Edit Blog',
        'View blogs': 'View blogs',
        'View detailed blogs': 'View detailed blogs',
    });


}

import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel, DomainModel, StorageModel, ProblemModel, NotFoundError
} from 'ejun';

export const TYPE_BR: 1 = 1;

export interface BRDoc {
    docType: 1;
    docId: ObjectId;
    domainId: string;
    brId?: ObjectId | null;
    brid: number;
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    lids: Array<number>;
    rids: Array<number>;
    parentId?: ObjectId | null;
    path: string;
    branch: boolean;
    childrenCount?: number;
}

declare module 'ejun' {
    interface Model {
        br: typeof BranchModel;
    }
    interface DocType {
        [TYPE_BR]: BRDoc;
    }
}

export class BranchModel {
    static async generateNextTeid(domainId: string): Promise<number> {
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_BR, {})
            .sort({ teid: -1 })
            .limit(1)
            .project({ teid: 1 })
            .toArray();
        return (lastDoc[0]?.teid || 0) + 1;
    }

    static async addTrunkNode(
        domainId: string,
        brId: ObjectId | null,
        owner: number,
        title: string,
        content: string,
        ip?: string
    ): Promise<ObjectId> {
        const teid = await this.generateNextTeid(domainId);

        const payload: Partial<BRDoc> = {
            domainId,
            brId,
            title,
            content,
            owner,
            ip,
            updateAt: new Date(),
            views: 0,
            path: `/${teid}`,
            branch: false,
            parentId: null,
        };

        const docId = await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_BR,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])
        );

        return docId;
    }

    static async addBranchNode(
        domainId: string,
        brId: ObjectId,
        parentId: ObjectId,
        owner: number,
        title: string,
        content: string,
        ip?: string
    ): Promise<ObjectId> {
        const parentNode = await this.get(domainId, parentId);
        if (!parentNode) {
            throw new Error('Parent node does not exist.');
        }

        const teid = await this.generateNextTeid(domainId);
        const path = `${parentNode.path}/${teid}`;

        const payload: Partial<BRDoc> = {
            domainId,
            brId,
            parentId,
            title,
            content,
            owner,
            ip,
            updateAt: new Date(),
            views: 0,
            path,
            branch: true,
        };

        const docId = await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_BR,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])
        );

        return docId;
    }

    static async get(domainId: string, docId: ObjectId): Promise<BRDoc | null> {
        return await DocumentModel.get(domainId, TYPE_BR, docId);
    }

    static async getChildren(domainId: string, parentId: ObjectId): Promise<BRDoc[]> {
        return await DocumentModel.getMulti(domainId, TYPE_BR, { parentId }).toArray();
    }

    static async getBranch(domainId: string, query: Partial<BRDoc>) {
        return DocumentModel.getMulti(domainId, TYPE_BR, query);
    }

    static async deleteNode(domainId: string, docId: ObjectId): Promise<void> {
        const node = await this.get(domainId, docId);
        if (!node) throw new Error('Node not found.');

        const descendants = await DocumentModel.getMulti(domainId, TYPE_BR, {
            path: { $regex: `^${node.path}` },
        }).toArray();

        const docIds = descendants.map((n) => n.docId);
        await Promise.all(docIds.map((id) => DocumentModel.deleteOne(domainId, TYPE_BR, id)));
    }

    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await DocumentModel.inc(domainId, TYPE_BR, docId, 'views', 1);
    }

    static async edit(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        await DocumentModel.set(domainId, TYPE_BR, docId, { title, content });
    }
}

class BranchHandler extends Handler {
    ddoc?: BRDoc;

    @param('docId', Types.ObjectId, true)
    async _prepare(domainId: string, docId: ObjectId) {
        if (docId) {
            this.ddoc = await BranchModel.get(domainId, docId);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, docId);
        }
    }
}

export class TreeDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        try {
            const domainInfo = await DomainModel.get(domainId);
            if (!domainInfo) throw new NotFoundError(`Domain "${domainId}" not found.`);

            const branches = await BranchModel.getBranch(domainId, { parentId: null });
            if (!branches) throw new Error('No branches found.');

            const [nodes, totalPages, totalCount] = await paginate(branches, page, pageSize);

            this.response.template = 'tree_domain.html';
            this.response.body = {
                nodes,
                domainId,
                domainName: domainInfo.name,
                page,
                pageSize,
                totalPages,
                totalCount,
            };
        } catch (error) {
            console.error('Error in TreeDomainHandler.get:', error);
            this.response.template = 'error.html';
            this.response.body = { error: error.message || 'An unexpected error occurred.' };
        }
    }
}

export class BranchDetailHandler extends BranchHandler {
    @param('docId', Types.ObjectId)
    async get(domainId: string, docId: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await BranchModel.get(domainId, docId)
            : null;

        const udoc = await UserModel.getById(domainId, this.ddoc!.owner);

        const children = await BranchModel.getChildren(domainId, docId);

        this.response.template = 'branch_detail.html';
        this.response.body = {
            ddoc: this.ddoc,
            dsdoc,
            udoc,
            children,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }
}

export class BranchEditHandler extends BranchHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';
        const files = await StorageModel.list(`domain/${domainId}/`);

        const urlForFile = (filename: string) =>
            `/d/${domainId}/domainfile/${encodeURIComponent(filename)}`;

        this.response.template = 'branch_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            files,
            urlForFile,
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, title: string, content: string) {
        await this.limitRate('add_branch', 3600, 60);

        const docId = await BranchModel.addTrunkNode(
            domainId,
            null,
            this.user._id,
            title,
            content,
            this.request.ip
        );

        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { uid: this.user._id, docId });
    }

    @param('parentId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreateBranch(domainId: string, parentId: ObjectId, title: string, content: string) {
        await this.limitRate('add_subbranch', 3600, 60);

        const brId = this.ddoc?.brId || parentId;
        const docId = await BranchModel.addBranchNode(
            domainId,
            brId,
            parentId,
            this.user._id,
            title,
            content,
            this.request.ip
        );

        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { uid: this.user._id, docId });
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string) {
        await Promise.all([
            BranchModel.edit(domainId, docId, title, content),
            OplogModel.log(this, 'branch.edit', this.ddoc),
        ]);

        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { uid: this.user._id, docId });
    }

    @param('docId', Types.ObjectId)
    async postDelete(domainId: string, docId: ObjectId) {
        await Promise.all([
            BranchModel.deleteNode(domainId, docId),
            OplogModel.log(this, 'branch.delete', this.ddoc),
        ]);

        this.response.redirect = this.url('tree_domain');
    }
}

export async function apply(ctx: Context) {
    ctx.Route('tree_domain', '/tree', TreeDomainHandler);
    ctx.Route('branch_create', '/tree/createbanch', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_create_subbranch', '/tree/:parentId/createbanch', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_detail', '/tree/branch/:docId', BranchDetailHandler);
    ctx.Route('branch_edit', '/tree/branch/:docId/edit', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('Nav', 'tree_domain', () => ({
        name: 'tree_main',
        displayName: 'Tree',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
}

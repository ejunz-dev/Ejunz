import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel, DomainModel, StorageModel, ProblemModel, NotFoundError,DocsModel,RepoModel
} from 'ejun';

export const TYPE_BR: 1 = 1;

export interface BRDoc {
    docType: 1;
    docId: ObjectId;
    domainId: string;
    bid: number;
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    lids: Array<number>;
    rids: Array<number>;
    parentId?: number|null;
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
    static async generateNextBid(domainId: string): Promise<number> {
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_BR, {})
            .sort({ bid: -1 })
            .limit(1)
            .project({ bid: 1 })
            .toArray();
        return (lastDoc[0]?.bid || 0) + 1;
    }

    static async addTrunkNode(
        domainId: string,
        bid: number,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        lids: number[] = [],
        rids: number[] = []
    ): Promise<ObjectId> {
        const newBid = bid || await this.generateNextBid(domainId);
        const payload: Partial<BRDoc> = {
            domainId,
            bid: newBid,
            title,
            content,
            owner,
            ip,
            lids,
            rids,
            updateAt: new Date(),
            views: 0,
            path: `/${newBid}`,
            branch: false,
            parentId: null, // 顶层节点 parentId 为 null
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
        bid: number | null,
        parentBid: number,
        owner: number,
        title: string,
        content: string,
        ip?: string
    ): Promise<ObjectId> {
        const parentNode = await DocumentModel.getMulti(domainId, TYPE_BR, { bid: parentBid })
            .limit(1)
            .toArray();

        if (!parentNode.length) {
            throw new Error('Parent node does not exist.');
        }

        const newBid = bid ?? await this.generateNextBid(domainId);
        const path = `${parentNode[0].path}/${newBid}`;

        const payload: Partial<BRDoc> = {
            domainId,
            bid: newBid,
            parentId: parentBid, // 使用父节点的 bid
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

    static async getChildren(domainId: string, parentId: number): Promise<BRDoc[]> {
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

    static async edit(domainId: string, docId: ObjectId, title: string, content: string, lids?: number[], rids?: number[]): Promise<void> {
        const updateFields: any = { title, content };
        
        if (lids !== undefined) updateFields.lids = lids;
        if (rids !== undefined) updateFields.rids = rids;
    
        await DocumentModel.set(domainId, TYPE_BR, docId, updateFields);
    }
    
}
export async function getDocsByLid(domainId: string, lids: number | number[]) {
    console.log(`Fetching docs for lids: ${lids}`);

    const query = {
        domainId,
        lid: Array.isArray(lids) ? { $in: lids } : lids,
    };

    console.log(`Querying docs with:`, query);
    return await DocsModel.getMulti(domainId, query).toArray();
}

export async function getReposByRid(domainId: string, rids: number | number[]) {
    console.log(`Fetching docs for rids: ${rids}`);

    const query = {
        domainId,
        rid: Array.isArray(rids) ? { $in: rids } : rids,
    };

    console.log(`Querying docs with:`, query);
    return await RepoModel.getMulti(domainId, query).toArray();
}


class BranchHandler extends Handler {
    ddoc?: BRDoc;

    @param('docId', Types.ObjectId, true)
    async _prepare(domainId: string, docId: ObjectId) {
        if (docId) {
            const branchDoc = await BranchModel.get(domainId, docId);
            if (!branchDoc) {
                throw new NotFoundError(domainId, docId);
            }
            this.ddoc = branchDoc;
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

            const [ddocs, totalPages, totalCount] = await paginate(branches, page, pageSize);

            this.response.template = 'tree_domain.html';
            this.response.body = {
                ddocs,
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
        console.log('ddocs', this.response.body.ddocs);
    }
}


export class BranchDetailHandler extends BranchHandler {
    @param('docId', Types.ObjectId)
    async get(domainId: string, docId: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await BranchModel.get(domainId, docId)
            : null;

        const udoc = await UserModel.getById(domainId, this.ddoc!.owner);

        const children = await BranchModel.getChildren(domainId, this.ddoc!.bid);


        const docs = this.ddoc?.lids ? await getDocsByLid(domainId, this.ddoc.lids) : [];
        const repos = this.ddoc?.rids ? await getReposByRid(domainId, this.ddoc.rids) : [];
        

        this.response.template = 'branch_detail.html';
        this.response.body = {
            ddoc: this.ddoc,
            dsdoc,
            udoc,
            docs,
            repos,
            children,
        };
        console.log('docs', docs);
        console.log('repos', repos);
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
    @param('lids', Types.ArrayOf(Types.Int))
    @param('rids', Types.ArrayOf(Types.Int))

    async postCreate(
        domainId: string,
        title: string,
        content: string,
        lids: number[],
        rids: number[]
    ) {
        await this.limitRate('add_branch', 3600, 60);

        const docId = await BranchModel.addTrunkNode(
            domainId,
            null,
            this.user._id,
            title,
            content,
            this.request.ip,
            lids,
            rids
        );

        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { uid: this.user._id, docId });
    }

    @param('parentId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreateBranch(domainId: string, parentId: ObjectId, title: string, content: string) {
        await this.limitRate('add_subbranch', 3600, 60);

        const bid = this.ddoc?.bid || parentId;
        const docId = await BranchModel.addBranchNode(
            domainId,
            bid,
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
    @param('lids', Types.String)  // 先接受字符串
    @param('rids', Types.String)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string, lids: string, rids: string) {
        // 解析 lids 和 rids，将字符串转换成数字数组
        const parsedLids = lids ? lids.split(',').map(Number).filter(n => !isNaN(n)) : [];
        const parsedRids = rids ? rids.split(',').map(Number).filter(n => !isNaN(n)) : [];
    
        await Promise.all([
            BranchModel.edit(domainId, docId, title, content, parsedLids, parsedRids),
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
    ctx.Route('tree_domain', '/tree/branch', TreeDomainHandler);
    ctx.Route('branch_create', '/tree/createbranch', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_create_subbranch', '/tree/:parentId/createbranch', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_detail', '/tree/branch/:docId', BranchDetailHandler);
    ctx.Route('branch_edit', '/tree/branch/:docId/editbranch', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('Nav', 'tree_domain', () => ({
        name: 'tree_main',
        displayName: 'Tree',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
}

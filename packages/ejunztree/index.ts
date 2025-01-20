import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV, Types, UserModel, DomainModel, StorageModel, ProblemModel, NotFoundError,DocsModel,RepoModel,
    parseMemoryMB
} from 'ejun';

export const TYPE_BR: 1 = 1;
export const TYPE_TR: 6 = 6;

export interface TRDoc {
    docType: 6;  // 标识它是一个 Tree
    docId: ObjectId;
    domainId: string;
    trid: number;
    title: string;
    owner: number;
    createdAt: Date;
}


export interface BRDoc {
    docType: 1;
    docId: ObjectId;
    domainId: string;
    trid: number;
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
    createdAt?: Date;
}

declare module 'ejun' {
    interface Model {
        br: typeof BranchModel;
        tr: typeof TreeModel;
    }
    interface DocType {
        [TYPE_BR]: BRDoc;
        [TYPE_TR]: TRDoc;
    }
}
export class TreeModel {
    static async generateNextTrid(domainId: string): Promise<number> {
        const lastTree = await DocumentModel.getMulti(domainId, TYPE_TR, {}) 
            .sort({ trid: -1 })
            .limit(1)
            .project({ trid: 1 })
            .toArray();
        return (lastTree[0]?.trid || 0) + 1;
    }

    static async createTree(domainId: string, owner: number, title: string): Promise<number> {
        const newTrid = await this.generateNextTrid(domainId);
        const payload: Partial<TRDoc> = {
            docType: 6,
            domainId,
            trid: newTrid,
            title,
            owner,
            createdAt: new Date(),
        };

        await DocumentModel.add(
            domainId,
            JSON.stringify(payload), 
            owner, 
            TYPE_TR, 
            null, null, null, 
            payload
        );

        return newTrid;
    }

    static async getTree(domainId: string, docId: ObjectId): Promise<TRDoc | null> {
        return await DocumentModel.get(domainId, TYPE_TR, docId);
    }

    static async getAllTrees(domainId: string): Promise<TRDoc[]> {
        return await DocumentModel.getMulti(domainId, TYPE_TR, {}).toArray();
    }
    static async getBranchesByTree(domainId: string, trid: number): Promise<BRDoc[]> {
        return await DocumentModel.getMulti(domainId, TYPE_BR, { trid }).toArray();
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
    static async generateNextTrid(domainId: string): Promise<number> {
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_BR, {})
            .sort({ trid: -1 })
            .limit(1)
            .project({ trid: 1 })
            .toArray();
        return (lastDoc[0]?.trid || 0) + 1;
    }

    static async addTrunkNode(
        domainId: string,
        trid: number,
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
            trid,
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
        trid: number,
        bid: number | null,
        parentBid: number,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        lids: number[] = [],
        rids: number[] = []
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
            trid,
            bid: newBid,
            parentId: parentBid, // 使用父节点的 bid
            title,
            content,
            owner,
            ip,
            lids,
            rids,
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
  
    

    static async createTree(domainId: string, owner: number, title: string): Promise<number> {
        const newTrid = await this.generateNextTrid(domainId);
        const payload = {
            domainId,
            trid: newTrid,
            title,
            owner,
            createdAt: new Date(),
        };

        await DocumentModel.add(domainId, JSON.stringify(payload), owner, TYPE_BR, null, null, null, payload);
        return newTrid;
    }

    static async getTree(domainId: string, trid: number) {
        return await DocumentModel.getMulti(domainId, TYPE_BR, { trid }).toArray();
    }
    static async getBranchesByIds(domainId: string, bids: number[]) {
        return await DocumentModel.getMulti(domainId, TYPE_BR, { bid: { $in: bids } }).toArray();
    }
    static async getBranches(domainId: string, query: Filter<BRDoc>) {
        return DocumentModel.getMulti(domainId, TYPE_BR, query);
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


export async function getProblemsByDocsId(domainId: string, lid: number) {
    console.log(`Fetching problems for docs ID: ${lid}`);
    const query = {
        domainId,
        associatedDocumentId: lid 
    };
    console.log(`Querying problems with:`, query);
    return await ProblemModel.getMulti(domainId, query).toArray();
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
    async get({ domainId }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        try {
            const trees = await TreeModel.getAllTrees(domainId);
            
            this.response.template = 'tree_domain.html';  
            this.response.body = {
                domainId,
                trees
            };
        console.log('trees:', trees);
        } catch (error) {
            console.error("Error fetching trees:", error);
            this.response.template = 'error.html';  
            this.response.body = { error: "Failed to fetch trees" };
        }
    }
}


export class TreeEditHandler extends Handler {
    async get() {
        this.response.template = 'tree_edit.html';
        this.response.body = {
            tree: null, // 新建模式，没有已有的 Tree 数据
        };
    }

    @param('title', Types.Title)
    async postCreate(domainId: string, title: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);

        const trid = await TreeModel.createTree(domainId, this.user._id, title);
        this.response.body = { trid };
        this.response.redirect = this.url('tree_detail', { domainId, trid });
    }
}


export class TreeDetailHandler extends Handler {
    @param('docId', Types.ObjectId)
    async get(domainId: string, docId: ObjectId) {
        if (!docId) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }
        console.log(`Fetching tree with docId: ${docId}`);

        // 获取当前树的信息
        const tree = await TreeModel.getTree(domainId, docId);
        if (!tree) {
            throw new NotFoundError(`Tree with docId ${docId} not found.`);
        }

        // 获取所有的 treeBranches
        console.log(`Fetching entire tree for trid: ${tree.trid}`);
        const treeBranches = await TreeModel.getBranchesByTree(domainId, tree.trid);

        // 确定根节点 (trunk)
        const trunk = treeBranches.find(branch => branch.parentId === null || branch.path.split('/').length === 1);

        // 递归构建分支层次结构
        const buildHierarchy = (parentId: number | null, branches: any[]) => {
            return branches
                .filter(branch => branch.parentId === parentId)
                .map(branch => ({
                    ...branch,
                    subBranches: buildHierarchy(branch.bid, branches)
                }));
        };

        // 构建 `branchHierarchy`
        const branchHierarchy = {
            trunk: trunk || null,
            branches: trunk ? buildHierarchy(trunk.bid, treeBranches) : [],
        };

        // 获取当前节点的子分支
        const childrenBranchesCursor = await BranchModel.getBranch(domainId, { parentId: trunk?.bid });
        const childrenBranches = await childrenBranchesCursor.toArray();

        // 解析路径
        const pathLevels = trunk?.path?.split('/').filter(Boolean) || [];
        const pathBranches = await BranchModel.getBranchesByIds(domainId, pathLevels.map(Number));

        // 发送数据到模板
        this.response.template = 'tree_detail.html';
        this.response.pjax = 'tree_detail.html';
        this.response.body = {
            tree,
            childrenBranches,
            pathBranches,
            treeBranches,
            branchHierarchy,
        };

        console.log('treeBranches:', JSON.stringify(treeBranches, null, 2));
        console.log('branchHierarchy:', JSON.stringify(branchHierarchy, null, 2));
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }
}


export class TreeBranchHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        try {
            const domainInfo = await DomainModel.get(domainId);
            if (!domainInfo) throw new NotFoundError(`Domain "${domainId}" not found.`);

            const branches = await BranchModel.getBranch(domainId, { parentId: null });
            if (!branches) throw new Error('No branches found.');

            const [ddocs, totalPages, totalCount] = await paginate(branches, page, pageSize);

            this.response.template = 'tree_branch.html';
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
        if (!docId) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }

        console.log(`Fetching details for branch docId: ${docId}`);

        const ddoc = await BranchModel.get(domainId, docId);
        if (!ddoc) {
            throw new NotFoundError(`Branch with docId ${docId} not found.`);
        }

        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE) ? ddoc : null;
        const udoc = await UserModel.getById(domainId, ddoc.owner);
        const childrenBranchesCursor = await BranchModel.getBranch(domainId, { parentId: ddoc.bid });
        const childrenBranches = await childrenBranchesCursor.toArray();

        const pathLevels = ddoc.path?.split('/').filter(Boolean) || [];
        const pathBranches = await BranchModel.getBranchesByIds(domainId, pathLevels.map(Number));

        console.log(`Fetching entire tree for trid: ${ddoc.trid}`);
        const treeBranches = await TreeModel.getBranchesByTree(domainId, ddoc.trid);

        const branchHierarchy = {};

        const buildHierarchy = (parentId: number, branchList: any[]) => {
            const branches = branchList.filter(branch => branch.parentId === parentId);
            return branches.map(branch => ({
                ...branch,
                subBranches: buildHierarchy(branch.bid, branchList)
            }));
        };

        branchHierarchy[ddoc.trid] = buildHierarchy(5, treeBranches); 

        const docs = ddoc.lids ? await getDocsByLid(domainId, ddoc.lids) : [];
        const repos = ddoc.rids ? await getReposByRid(domainId, ddoc.rids) : [];
        const problems = ddoc.lids?.length ? await getProblemsByDocsId(domainId, ddoc.lids[0]) : [];

        this.response.template = 'branch_detail.html';
        this.response.pjax = 'branch_detail.html'; 
        this.response.body = {
            ddoc,
            dsdoc,
            udoc,
            docs,
            repos,
            problems,
            childrenBranches,
            pathBranches,
            treeBranches,
            branchHierarchy,
        };
    console.log('problems:', problems);
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }
}






export class BranchEditHandler extends BranchHandler {
    async get() {
        const domainId = this.context.domainId || 'system';

        this.response.template = 'branch_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            trid: this.args.trid,
        };
        console.log('ddoc:', this.ddoc);
        console.log('trid:', this.args.trid);
    }

    @param('trid', Types.Int) // 新增接收 `trid`
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('lids', Types.ArrayOf(Types.Int))
    @param('rids', Types.ArrayOf(Types.Int))
    async postCreate(
        domainId: string,
        trid: number, // 让新建分支时必须绑定一个 `trid`
        title: string,
        content: string,
        lids: number[],
        rids: number[]
    ) {
        await this.limitRate('add_branch', 3600, 60);

        const docId = await BranchModel.addTrunkNode(
            domainId,
            trid, // 绑定树 ID
            null, // bid 由系统生成
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

    @param('trid', Types.Int) // 让子分支也必须有 `trid`
    @param('parentId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreateBranch(domainId: string, trid: number, parentId: number, title: string, content: string) {
        await this.limitRate('add_subbranch', 3600, 60);

        const docId = await BranchModel.addBranchNode(
            domainId,
            trid, // 绑定 `trid`
            null, // bid 由系统生成
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
    @param('lids', Types.String)
    @param('rids', Types.String)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string, lids: string, rids: string) {
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

        this.response.redirect = this.url('tree_detail', { trid: this.ddoc?.trid });
    }
}


export class BranchCreateSubbranchHandler extends BranchHandler {
    async get() {
        const domainId = this.context.domainId || 'system';
        const parentId = Number(this.args?.parentId);

        console.log(`Debug: Opening sub-branch creation for parentId: ${parentId}`);

        this.response.template = 'branch_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            parentId,
        };
    }
    
  
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('parentId', Types.Int)
    @param('lids', Types.ArrayOf(Types.Int))
    @param('rids', Types.ArrayOf(Types.Int))

    async postCreateSubbranch(domainId: string,title: string, content: string, parentId: number, trid: number, lids: number[], rids: number[]) {
        await this.limitRate('add_subbranch', 3600, 60);

        console.log(`Debug: Creating sub-branch under trid ${trid}, parentId ${parentId}`);


        const bid = await BranchModel.generateNextBid(domainId);
        const docId = await BranchModel.addBranchNode(
            domainId,
            trid, 
            bid,
            parentId,
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
}



export async function apply(ctx: Context) {
    ctx.Route('tree_domain', '/tree', TreeDomainHandler);
    ctx.Route('tree_create', '/tree/create', TreeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tree_detail', '/tree/:docId', TreeDetailHandler);
    ctx.Route('tree_edit', '/tree/:docId/edit', TreeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tree_branch', '/tree/:trid/branch', TreeBranchHandler);
    ctx.Route('branch_create', '/tree/:trid/createbranch', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_create_subbranch', '/tree/branch/:parentId/createsubbranch', BranchCreateSubbranchHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_detail', '/tree/branch/:docId', BranchDetailHandler);
    ctx.Route('branch_edit', '/tree/branch/:docId/editbranch', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('Nav', 'tree_domain', () => ({
        name: 'tree_domain',
        displayName: 'tree_domain',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
}

import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel, paginate,
    param, PRIV,PERM, Types, UserModel, DomainModel, StorageModel, ProblemModel, NotFoundError,DocsModel,RepoModel,
    parseMemoryMB,ContestModel,DiscussionModel,TrainingModel,buildProjection,RepoDoc,encodeRFC5987ValueChars
} from 'ejun';
import { lookup } from 'mime-types';
export const TYPE_BR: 1 = 1;
export const TYPE_TR: 6 = 6;
export const TYPE_FR: 7 = 7;

export interface FRDoc {
    docType: 7; // Forest 
    docId: ObjectId;
    domainId: string;
    trids: number[]; // 存储所有 Tree ID
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
}


export interface TRDoc {
    docType: 6;  // 标识它是一个 Tree
    docId: ObjectId;
    domainId: string;
    trid: number;
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
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
        fr: typeof ForestModel;
        tr: typeof TreeModel;
        br: typeof BranchModel;
    }
    interface DocType {
        [TYPE_FR]: FRDoc;
        [TYPE_TR]: TRDoc;
        [TYPE_BR]: BRDoc;
        
    }
}
export class ForestModel {
    /**
     * 获取指定 domainId 的森林
     */
    static async getForest(domainId: string): Promise<FRDoc | null> {
        const results = await DocumentModel.getMulti(domainId, TYPE_FR, { domainId }).limit(1).toArray();
        return results.length ? results[0] : null;
    }
    

    /**
     * 创建森林（每个 domain 只能有一个森林）
     */
    static async createForest(domainId: string, owner: number, title: string, content: string): Promise<ObjectId> {
        const trees = await TreeModel.getAllTrees(domainId);
        const treeIds = trees.map(tree => tree.trid); // 获取所有 Tree 的 ID

        const payload: Partial<ForestDoc> = {
            docType: TYPE_FR,
            domainId,
            trids: treeIds, 
            title: title || 'Unnamed Forest',
            content: content || '',
            owner,
            createdAt: new Date(),
            updateAt: new Date(),
        };

        return await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_FR,
            null,
            null,
            null,
            _.omit(payload, ['content', 'owner'])
        );
    }

    /**
     * 更新森林的 title 和 content
     */
    static async updateForest(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        const forest = await this.getForest(domainId);
    
        if (!forest) {
            throw new Error(`Forest not found for domain: ${domainId}`);
        }
    
        await DocumentModel.set(domainId, TYPE_FR, docId, {
            title,
            content
        });
    }
    
    
    static async addTreeToForest(domainId: string, trid: number): Promise<void> {
        const forest = await this.getForest(domainId);
    
        if (!forest) {
            throw new Error(`Forest not found for domain: ${domainId}`);
        }
    
        
        if (forest.trids.includes(trid)) {
            console.warn(`Tree ${trid} already exists in the forest.`);
            return;
        }
    
        forest.trids.push(trid);
    
        await DocumentModel.set(domainId, TYPE_FR, forest.docId, {
            trids: forest.trids
        });
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

    static async createTree(domainId: string, owner: number, title: string, content: string): Promise<{ docId: ObjectId, trid: number }> {
        const newTrid = await this.generateNextTrid(domainId);
    
        const payload: Partial<TRDoc> = {
            docType: TYPE_TR,
            domainId,
            trid: newTrid,
            title,
            content: content || '',  // 避免 null
            owner,
            createdAt: new Date(),
        };
    
        const docId = await DocumentModel.add(
            domainId,
            payload.content!, 
            payload.owner!, 
            TYPE_TR,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])  
        );
    
        return { docId, trid: newTrid };  
    }
    
    

    static async edit(domainId: string, trid: number, title: string, content: string): Promise<void> {
        // 🔍 先获取 `docId`，确保正确更新
        const treeDoc = await this.getTreeByTrid(domainId, trid);
        if (!treeDoc) {
            throw new Error(`Tree with trid ${trid} not found in domain ${domainId}`);
        }
    
        await DocumentModel.set(domainId, TYPE_TR, treeDoc.docId, {
            title,
            content: content || '',   
        });
    }
    


    static async getTree(domainId: string, docId: ObjectId): Promise<TRDoc | null> {
        return await DocumentModel.get(domainId, TYPE_TR, docId);
    }
    static async getTreeByTrid(domainId: string, trid: number): Promise<TRDoc | null> {
        const result = await DocumentModel.getMulti(domainId, TYPE_TR, { trid }).limit(1).toArray();
        return result.length > 0 ? result[0] : null;  
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
    static async updateResources(domainId: string, docId: ObjectId, lids?: number[], rids?: number[]): Promise<void> {
        if (!docId) {
            throw new Error(`updateResources: docId is required`);
        }
    
        const updateFields: any = {};
    
        if (lids !== undefined) updateFields.lids = lids;
        if (rids !== undefined) updateFields.rids = rids;
    
        console.log(`Updating resources for docId: ${docId}`);
        console.log(`Lids: ${lids}`);
        console.log(`Rids: ${rids}`);
    
        await DocumentModel.set(domainId, TYPE_BR, docId, updateFields);
    }
    



    static async addTrunkNode(
        domainId: string,
        trid: number | string,
        bid: number,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        lids: number[] = [],
        rids: number[] = []
    ): Promise<ObjectId> {
        const newBid = bid || await this.generateNextBid(domainId);
        const parsedTrid = typeof trid === 'string' ? parseInt(trid, 10) : trid;
    if (isNaN(parsedTrid)) {
        throw new Error(`Invalid trid: ${trid}`);
    }

        const payload: Partial<BRDoc> = {
            domainId,
            trid: parsedTrid,
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
        trid: number[],
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

    static async getBranchesByIds(domainId: string, bids: number[]) {
        return await DocumentModel.getMulti(domainId, TYPE_BR, { bid: { $in: bids } }).toArray();
    }
    static async getBranches(domainId: string, query: Filter<BRDoc>) {
        return DocumentModel.getMulti(domainId, TYPE_BR, query);
    }
}
export async function getDocsByDomain (domainId: string) {
    console.log(`Fetching docs for domain: ${domainId}`);
    return await DocsModel.getMulti(domainId, {}).toArray();
}

export async function getDocsByIds (domainId: string, ids: ObjectId[]) {
    console.log(`Fetching docs for ids: ${ids}`);
    return await DocsModel.getMulti(domainId, { _id: { $in: ids } }).toArray();
}

export async function getDocsByDocId(domainId: string, docIds: number | number[]) {
    console.log(`Fetching docs for docIds: ${JSON.stringify(docIds)}`);

    const query = {
        domainId,
        docId: Array.isArray(docIds) ? { $in: docIds } : docIds, // 直接使用 docIds
    };

    console.log(`Querying docs with:`, JSON.stringify(query, null, 2));

    const results = await DocsModel.getMulti(domainId, query)
        .project(buildProjection(DocsModel.PROJECTION_PUBLIC)) // 仅获取必要字段
        .toArray();

    console.log(`Fetched docs:`, results);

    return results;
}

export async function getReposByDocId(domainId: string, docId: number | number[]) {
    console.log(`Fetching repos for rids: ${JSON.stringify(docId)}`);

    const query = {
        domainId,
        docId: Array.isArray(docId) ? { $in: docId } : docId, // 使用 rid 进行查询
    };

    console.log(`Querying repos with:`, JSON.stringify(query, null, 2));

    const results = await RepoModel.getMulti(domainId, query)
        .project(buildProjection(RepoModel.PROJECTION_PUBLIC)) // 仅获取必要字段
        .toArray();

    console.log(`Fetched repos:`, JSON.stringify(results, null, 2));

    return results;
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

export async function getRelated(domainId: string, pid: number, rule?: string) {
    const rules = Object.keys(ContestModel.RULES).filter((i) => !ContestModel.RULES[i].hidden);
    return await DocumentModel.getMulti(domainId, DocumentModel.TYPE_CONTEST, { pids: pid, rule: rule || { $in: rules } }).toArray();
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
export class ForestDomainHandler extends Handler {
    async get({ domainId }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';
        
        try {
            const forest = await ForestModel.getForest(domainId);
            console.log("Fetched forest:", forest);  

            if (!forest) {
                console.warn(`No forest found for domain: ${domainId}`);
                this.response.template = 'forest_domain.html';
                this.response.body = { 
                    domainId,
                    forest: { docId: null, title: 'Default Forest', content: 'No content available.', trids: [] },
                    trees: []  
                };
                console.log('forest',forest);
                return;
            }

            
            const trees = await TreeModel.getAllTrees(domainId);
            console.log("Fetched trees:", trees); 

            
            this.response.template = 'forest_domain.html';
            this.response.body = { 
                domainId, 
                forest,
                trees  
            };
            console.log("trees.length:", trees.length);
            
        } catch (error) {
            console.error("Error fetching forest:", error);
            this.response.template = 'error.html';
            this.response.body = { error: "Failed to fetch forest" };
        }
    }
}



export class ForestEditHandler extends Handler {
    @param('docId', Types.ObjectId, true) 
    async get(domainId: string, docId?: ObjectId) {
        let forest = (await ForestModel.getForest(domainId)) as FRDoc | null; 
        if (!forest) {
            console.warn(`No forest found for domain: ${domainId}`);
            forest = {
                docType: 7,
                domainId: domainId,
                trids: [],
                title: '',
                content: '',
                owner: this.user._id,
                createdAt: new Date(),
                updateAt: new Date(),
            } as Partial<FRDoc>; 
        }

        this.response.template = 'forest_edit.html';
        this.response.body = { forest };
    }

    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postCreate(domainId: string, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);

        
        const docId = await ForestModel.createForest(domainId, this.user._id, title, content || '');

        this.response.body = { docId };
        this.response.redirect = this.url('forest_domain', { domainId });
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);

        
        await ForestModel.updateForest(domainId, docId, title, content || '');

        this.response.body = { docId };
        this.response.redirect = this.url('forest_domain', { domainId });
    }
}




export class TreeEditHandler extends Handler {
    @param('trid', Types.Int, true)
    async get(domainId: string, trid: number) {

        
            const tree = await TreeModel.getTreeByTrid(domainId, trid);

        this.response.template = 'tree_edit.html';
        this.response.body = { tree };
        console.log('tree:', this.response.body.tree);
    }

    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postCreate(domainId: string, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
    
        if (!title.trim()) {
            throw new Error("Title cannot be empty.");
        }
    
        if (!content || typeof content !== 'string') {
            content = '';
        }
    
        
        const { docId, trid } = await TreeModel.createTree(domainId, this.user._id, title, content);
    
        this.response.body = { docId, trid };
        this.response.redirect = this.url('tree_detail', { domainId, trid }); 
    }
    
    
    

    @param('trid', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, trid: number, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
    
        if (!title.trim()) {
            throw new Error("Title cannot be empty.");
        }
    
        
        if (!content || typeof content !== 'string') {
            content = '';
        }
    
       await TreeModel.edit(domainId, trid, title, content);
        this.response.body = { trid };
        this.response.redirect = this.url('tree_detail', { domainId, trid });
        console.log('docId:', this.response.body.docId);

    }
    
}



export class TreeDetailHandler extends Handler {
    @param('trid', Types.Int)
    async get(domainId: string, trid: number) {
        if (!trid) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }
        console.log(`Fetching tree with docId: ${trid}`);

        // 获取当前树的信息
        const tree = await TreeModel.getTreeByTrid(domainId, trid);
        if (!tree) {
            throw new NotFoundError(`Tree with docId ${trid} not found.`);
        }

        // 获取所有的 treeBranches
        console.log(`Fetching entire tree for trid: ${tree.trid}`);
        const treeBranches = await TreeModel.getBranchesByTree(domainId, tree.trid);

        
        const trunk = treeBranches.find(branch => branch.parentId === null || branch.path.split('/').length === 1);

        
        const buildHierarchy = (parentId: number | null, branches: any[]) => {
            return branches
                .filter(branch => branch.parentId === parentId)
                .map(branch => ({
                    ...branch,
                    subBranches: buildHierarchy(branch.bid, branches)
                }));
        };

        
        const branchHierarchy = {
            trunk: trunk || null,
            branches: trunk ? buildHierarchy(trunk.bid, treeBranches) : [],
        };

        
        const childrenBranchesCursor = await BranchModel.getBranch(domainId, { parentId: trunk?.bid });
        const childrenBranches = await childrenBranchesCursor.toArray();

        // 解析路径
        const pathLevels = trunk?.path?.split('/').filter(Boolean) || [];
        const pathBranches = await BranchModel.getBranchesByIds(domainId, pathLevels.map(Number));


        this.response.template = 'tree_detail.html';
        this.response.pjax = 'tree_detail.html';
        this.response.body = {
            tree,
            trunk,
            childrenBranches,
            pathBranches,
            treeBranches,
            branchHierarchy,
        };

       console.log('tree', this.response.body.tree);
       console.log('trunk', this.response.body.trunk);
       console.log("branchHierarchy:", JSON.stringify(branchHierarchy, null, 2));

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

        if (Array.isArray(ddoc.trid)) {
            ddoc.trid = ddoc.trid[0]; 
        }
        console.log('trunk trid:', ddoc.trid);
        
        

        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE) ? ddoc : null;
        const udoc = await UserModel.getById(domainId, ddoc.owner);

        const pathLevels = ddoc.path?.split('/').filter(Boolean) || [];
        const pathBranches = await BranchModel.getBranchesByIds(domainId, pathLevels.map(Number));
        console.log('pathBranches', pathBranches);
        console.log('pathLevels', pathLevels);

        console.log(`Fetching entire tree for trid: ${ddoc.trid}`);
        const treeBranches = await TreeModel.getBranchesByTree(domainId, ddoc.trid);
        console.log('treeBranches', treeBranches);

        const branchHierarchy = {};

        const trunkBid = pathBranches.length ? pathBranches[0].bid : ddoc.bid;

        const buildHierarchy = (parentId: number, branchList: any[]) => {

            const branches = branchList.filter(branch => branch.parentId === parentId);

            if (branches.length === 0) {
                console.warn(`⚠️ Warning: No branches found for parentId = ${parentId}`);
            } else {
                console.log(`✅ Found branches:`, branches.map(b => ({ bid: b.bid, title: b.title })));
            }

            return branches.map(branch => ({
                ...branch,
                subBranches: buildHierarchy(branch.bid, branchList)
            }));
        };

        branchHierarchy[ddoc.trid] = buildHierarchy(trunkBid, treeBranches);
        console.log('branchHierarchy', branchHierarchy);

        const docs = ddoc.lids?.length
            ? await getDocsByDocId(domainId, ddoc.lids.filter(lid => lid != null).map(Number))
            : [];

        docs.forEach(doc => {
            doc.lid = doc.lid ? String(doc.lid) : String(doc.docId);
        });

        const repos = ddoc.rids ? await getReposByDocId(domainId, ddoc.rids) : [];
        const reposWithFiles = repos.map(repo => ({
            ...repo,
            files: repo.files || [] 
        }));

        const problems = ddoc.lids?.length ? await getProblemsByDocsId(domainId, ddoc.lids[0]) : [];
        const pids = problems.map(p => Number(p.docId));
        const [ctdocs, htdocs, tdocs] = await Promise.all([
            Promise.all(pids.map(pid => getRelated(domainId, pid))),
            Promise.all(pids.map(pid => getRelated(domainId, pid, 'homework'))),
            TrainingModel.getByPid(domainId, pids)
        ]);
       
        const resources = {};
        docs.forEach(doc => {
            resources[doc.title] = `/d/system/docs/${doc.docId}`;
        });
        reposWithFiles.forEach(repo => {
            resources[repo.title] = `/d/system/repo/${repo.docId}`;
            repo.files.forEach(file => {
                resources[file.filename] = `/tree/branch/${ddoc.docId}/repo/${repo.rid}/${encodeURIComponent(file.filename)}`;
            });
        });

        this.response.template = 'branch_detail.html';
        this.response.pjax = 'branch_detail.html';
        this.response.body = {
            ddoc,
            dsdoc,
            udoc,
            docs,
            repos: reposWithFiles, 
            problems,
            pids,
            ctdocs: ctdocs.flat(),
            htdocs: htdocs.flat(),
            tdocs: tdocs.flat(),
            pathBranches,
            treeBranches,
            branchHierarchy,
            resources 
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }
}







export class TreeCreateTrunkHandler extends BranchHandler {
    async get() {
        const domainId = this.context.domainId || 'system';
        const parentId = Number(this.args?.parentId);
        const trid = Number(this.args?.trid);

        console.log(`Debug: Opening sub-branch creation for parentId: ${parentId}, trid: ${trid}`);

        this.response.template = 'branch_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            parentId,
            trid
        };
    }

    @param('title', Types.Title)
    @param('trid', Types.String)
    async postCreate(
        domainId: string,
        title: string,
        trid: string,
        lids: number[] = [],
        rids: number[] = []
    ) {
        await this.limitRate('add_trunk', 3600, 60);

        // 🟢 解析 trid，并确保传入的是单个 `number`
        const tridArray = trid.split(',').map(Number).filter(n => !isNaN(n));
        if (tridArray.length === 0) {
            throw new Error(`Invalid trid: ${trid}`);
        }
        const parsedTrid = tridArray[0]; // 取数组的第一个值

        console.log(`Debug: Creating Trunk for trid ${parsedTrid}`);

        const bid = await BranchModel.generateNextBid(domainId);

        // ✅ 修正 `addTrunkNode` 调用，确保 `trid` 是 `number`
        const docId = await BranchModel.addTrunkNode(
            domainId,
            parsedTrid, // 传递 `number` 类型的 `trid`
            bid,
            this.user._id,
            title,
            '',
            this.request.ip,
            lids,
            rids
        );

        console.log(`Debug: Created Trunk docId=${docId}, bid=${bid}`);

        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { uid: this.user._id, trid: parsedTrid, docId });
    }

}




export class BranchCreateSubbranchHandler extends BranchHandler {
    async get() {
        const domainId = this.context.domainId || 'system';
        const parentId = Number(this.args?.parentId);
        const trid = Number(this.args?.trid);

        console.log(`Debug: Opening sub-branch creation for parentId: ${parentId}, trid: ${trid}`);

        this.response.template = 'branch_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            parentId,
            trid
        };
    }

    @param('title', Types.Title)
    @param('parentId', Types.Int)
    @param('trid', Types.String)
    async postCreateSubbranch(
        domainId: string,
        title: string,
        parentId: number,
        trid: string,
        lids: number[] = [],  
        rids: number[] = []  
    ) {
        await this.limitRate('add_subbranch', 3600, 60);
        const tridArray = trid.split(',').map(Number).filter(n => !isNaN(n));

        console.log(`Debug: Creating sub-branch under trid ${trid}, parentId ${parentId}`);

        const bid = await BranchModel.generateNextBid(domainId);
        const docId = await BranchModel.addBranchNode(
            domainId,
            tridArray,
            bid,
            parentId,
            this.user._id,
            title,
            '', 
            this.request.ip,
            lids,
            rids
        );

        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { uid: this.user._id,trid, docId });
    }
}



export class BranchEditHandler extends BranchHandler {
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
        const docs = ddoc.lids?.length
            ? await getDocsByDocId(domainId, ddoc.lids.filter(lid => lid != null).map(Number))
            : [];

        docs.forEach(doc => {
            doc.lid = String(doc.lid || doc.docId);
        });

        const repos = ddoc.rids ? await getReposByDocId(domainId, ddoc.rids) : [];
        const reposWithFiles = repos.map(repo => ({
            ...repo,
            files: repo.files || []
        }));
        const problems = ddoc.lids?.length ? await getProblemsByDocsId(domainId, ddoc.lids[0]) : [];
        const pids = problems.map(p => Number(p.docId));
        const [ctdocs, htdocs, tdocs] = await Promise.all([
            Promise.all(pids.map(pid => getRelated(domainId, pid))),
            Promise.all(pids.map(pid => getRelated(domainId, pid, 'homework'))),
            TrainingModel.getByPid(domainId, pids)
        ]);

        const resources = {};

        docs.forEach(doc => {
            resources[doc.title] = `/d/system/docs/${doc.docId}`;
        });

        reposWithFiles.forEach(repo => {
            resources[repo.title] = `/d/system/repo/${repo.docId}`;
            repo.files.forEach(file => {
                resources[file.filename] = `/repo/${repo.docId}/file/${encodeURIComponent(file.filename)}`;
            });
        });
        problems.forEach(problem => {
            resources[problem.title] = `/p/${problem.docId}`;
        }
        );

        ctdocs.flat().forEach(contest => {
            if (contest && contest.docId && contest.title) {
                resources[contest.title] = `/contest/${contest.docId}`;
            }
        });

        htdocs.flat().forEach(homework => {
            if (homework && homework.docId && homework.title) {
                resources[homework.title] = `/homework/${homework.docId}`;
            }
        });

        tdocs.flat().forEach(training => {
            if (training && training.docId && training.title) {
                resources[training.title] = `/training/${training.docId}`;
            }
        });

        console.log("Resources Mapping:", resources);

        this.response.template = 'branch_edit.html';

        this.response.body = {
            ddoc,
            docs,
            pids,
            ctdocs: ctdocs.flat(),
            htdocs: htdocs.flat(),
            tdocs: tdocs.flat(),
            repos: reposWithFiles,
            problems,
            trid: this.args.trid,
            resources,
       
        };
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string) {

        const branch = await BranchModel.get(domainId, docId);
        if (!branch || !branch.trid) {
            throw new NotFoundError(`Branch with docId ${docId} not found or has no trid.`);
        }

        await BranchModel.edit(domainId, docId, title, content);
 
        this.response.body = { docId };
        this.response.redirect = this.url('branch_detail', { trid: branch.trid, docId });
    }
    

    @param('docId', Types.ObjectId)
    async postDelete(domainId: string, docId: ObjectId) {
        await BranchModel.deleteNode(domainId, docId);
        this.response.redirect = this.url('tree_detail', { trid: this.ddoc?.trid });
    }
}


export class BranchResourceEditHandler extends BranchHandler {
    @param('docId', Types.ObjectId)
    async get(domainId: string, docId: ObjectId) {
        if (!docId) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }

        console.log(`Fetching resources for branch docId: ${docId}`);

        const ddoc = await BranchModel.get(domainId, docId);
        if (!ddoc) {
            throw new NotFoundError(`Branch with docId ${docId} not found.`);
        }

        this.response.template = 'branch_resource_edit.html';
        this.response.body = {
            ddoc,
            trid: this.args.trid,
            lids: ddoc.lids?.join(',') || '',
            rids: ddoc.rids?.join(',') || '',
        };
    }

    @param('docId', Types.ObjectId)
@param('lids', Types.String)
@param('rids', Types.String)
async postUpdateResources(domainId: string, docId: ObjectId, lids: string, rids: string) {
    const parsedLids = lids ? lids.split(',').map(Number).filter(n => !isNaN(n)) : [];
    const parsedRids = rids ? rids.split(',').map(Number).filter(n => !isNaN(n)) : [];

    const branch = await BranchModel.get(domainId, docId);
    if (!branch || !branch.trid) {
        throw new NotFoundError(`Branch with docId ${docId} not found or has no trid.`);
    }

    await BranchModel.updateResources(domainId, docId, parsedLids, parsedRids);

    this.response.body = { docId };
    this.response.redirect = this.url('branch_detail', { trid: branch.trid, docId });
}

}




export class BranchfileDownloadHandler extends Handler {
    async get({ docId, rid, filename }: { docId: string; rid: string|number; filename: string }) {
        const domainId = this.context.domainId || 'default_domain';

        const repo = await RepoModel.get(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        const actualDocId = repo.docId ?? docId;  
        const filePath = `repo/${domainId}/${actualDocId}/${filename}`;

        console.log(`[BranchfileDownloadHandler] Checking filePath=${filePath}`);

        const fileMeta = await StorageModel.getMeta(filePath);
        if (!fileMeta) throw new NotFoundError(`File "${filename}" does not exist in repository "${rid}".`);

        this.response.body = await StorageModel.get(filePath);
        this.response.type = lookup(filename) || 'application/octet-stream';

        if (!['application/pdf', 'image/jpeg', 'image/png'].includes(this.response.type)) {
            this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
        }
    }
}
export async function apply(ctx: Context) {

    const PERM = {
        PERM_VIEW_TREE: 1n << 75n,
    };

    global.Ejunz.model.builtin.registerPermission(
        'plugins',
        PERM.PERM_VIEW_TREE, 
        'View tree',
        true,
        'ejunzTree'
    );
    ctx.Route('forest_domain', '/forest', ForestDomainHandler);
    ctx.Route('forest_edit', '/forest/:docId/edit', ForestEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('forest_create', '/forest/create', ForestEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tree_create', '/tree/create', TreeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tree_detail', '/tree/:trid', TreeDetailHandler);
    ctx.Route('tree_create_trunk', '/tree/:trid/createtrunk', TreeCreateTrunkHandler);
    ctx.Route('tree_edit', '/tree/:trid/edit', TreeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tree_branch', '/tree/:trid/branch', TreeBranchHandler);
    ctx.Route('branch_create_subbranch', '/tree/:trid/branch/:parentId/createsubbranch', BranchCreateSubbranchHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_detail', '/tree/:trid/branch/:docId', BranchDetailHandler);
    ctx.Route('branch_edit', '/tree/:trid/branch/:docId/editbranch', BranchEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_resource_edit', '/tree/:trid/branch/:docId/edit/resources', BranchResourceEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('branch_file_download', '/tree/:trid/branch/:docId/repo/:rid/:filename', BranchfileDownloadHandler);
    ctx.injectUI('PluginDropdown', 'forest_domain', () => ({
        name: 'forest_domain',
        displayName: 'forest_domain',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
}

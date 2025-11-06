import {
    _, Context, DiscussionNotFoundError, DocumentModel, Filter,
    Handler, NumberKeys, ObjectId, OplogModel,
    param, PRIV,PERM, Types, UserModel, DomainModel, StorageModel, NotFoundError,
    parseMemoryMB, DiscussionModel,
    SystemModel
} from 'ejun';
import yaml from 'js-yaml';
import { SettingModel, Setting } from 'ejun';
import { lookup } from 'mime-types';
export const TYPE_DC: 32 = 32;
export const TYPE_RP: 31 = 31;
export const TYPE_BS: 30 = 30;
export const TYPE_BK: 33 = 33;

export interface BSDoc {
    docType: 30; // Base 
    docId: ObjectId;
    domainId: string;
    rpids: number[]; // 存储所有 Repo ID
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
}


export interface RPDoc {
    docType: 31;  // 标识它是一个 Repo
    docId: ObjectId;
    domainId: string;
    rpid: number;
    title: string;
    content: string;
    owner: number;
    createdAt: Date;
    updateAt: Date;
}


export interface DCDoc {
    docType: 32;
    docId: ObjectId;
    domainId: string;
    rpid: number;
    did: number;  // Doc ID，从1开始
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    parentId?: number|null;
    path: string;
    doc: boolean;
    childrenCount?: number;
    createdAt?: Date;
}

export interface BKDoc {
    docType: 33;
    docId: ObjectId;
    domainId: string;
    rpid: number;
    did: number;  // 关联的 doc ID
    bid: number;  // Block ID，从1开始
    owner: number;
    title: string;
    content: string;
    ip: string;
    updateAt: Date;
    views: number;
    createdAt?: Date;
}

declare module 'ejun' {
    interface Model {
        bs: typeof BaseModel;
        rp: typeof EjunRepoModel;
        dc: typeof DocModel;
        bk: typeof BlockModel;
    }
    interface DocType {
        [TYPE_BS]: BSDoc;
        [TYPE_RP]: RPDoc;
        [TYPE_DC]: DCDoc;
        [TYPE_BK]: BKDoc;
    }
}
export class BaseModel {
    /**
     * 获取指定 domainId 的森林
     */
    static async getBase(domainId: string): Promise<BSDoc | null> {
        const results = await DocumentModel.getMulti(domainId, TYPE_BS, { domainId }).limit(1).toArray();
        return results.length ? results[0] : null;
    }
    

    /**
     * 创建森林（每个 domain 只能有一个森林）
     */
    static async createBase(domainId: string, owner: number, title: string, content: string): Promise<ObjectId> {
        const repos = await EjunRepoModel.getAllRepos(domainId);
        const repoIds = repos.map(repo => repo.rpid); // 获取所有 Repo 的 ID

        const payload: Partial<BSDoc> = {
            docType: TYPE_BS,
            domainId,
            rpids: repoIds, 
            title: title || 'Unnamed Base',
            content: content || '',
            owner,
            createdAt: new Date(),
            updateAt: new Date(),
        };

        return await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_BS,
            null,
            null,
            null,
            _.omit(payload, ['content', 'owner'])
        );
    }

    /**
     * 更新森林的 title 和 content
     */
    static async updateBase(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        const base = await this.getBase(domainId);
    
        if (!base) {
            throw new Error(`Base not found for domain: ${domainId}`);
        }
    
        await DocumentModel.set(domainId, TYPE_BS, docId, {
            title,
            content
        });
    }
    
    
    static async addRepoToBase(domainId: string, rpid: number): Promise<void> {
        const base = await this.getBase(domainId);
    
        if (!base) {
            throw new Error(`Base not found for domain: ${domainId}`);
        }
    
        
        if (base.rpids.includes(rpid)) {
            console.warn(`Repo ${rpid} already exists in the base.`);
            return;
        }
    
        base.rpids.push(rpid);
    
        await DocumentModel.set(domainId, TYPE_BS, base.docId, {
            rpids: base.rpids
        });
    }
    
    
   
}

export class EjunRepoModel {
    static async generateNextRpid(domainId: string): Promise<number> {
        const lastRepo = await DocumentModel.getMulti(domainId, TYPE_RP, {}) 
            .sort({ rpid: -1 })
            .limit(1)
            .project({ rpid: 1 })
            .toArray();
        return (lastRepo[0]?.rpid || 0) + 1;
    }

    static async createRepo(domainId: string, owner: number, title: string, content: string): Promise<{ docId: ObjectId, rpid: number }> {
        const newRpid = await this.generateNextRpid(domainId);
    
        const payload: Partial<RPDoc> = {
            docType: TYPE_RP,
            domainId,
            rpid: newRpid,
            title,
            content: content || '',  // 避免 null
            owner,
            createdAt: new Date(),
        };
    
        const docId = await DocumentModel.add(
            domainId,
            payload.content!, 
            payload.owner!, 
            TYPE_RP,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])  
        );
    
        return { docId, rpid: newRpid };  
    }
    
    

    static async edit(domainId: string, rpid: number, title: string, content: string): Promise<void> {
        // 🔍 先获取 `docId`，确保正确更新
        const repoDoc = await this.getRepoByRpid(domainId, rpid);
        if (!repoDoc) {
            throw new Error(`Repo with rpid ${rpid} not found in domain ${domainId}`);
        }
    
        await DocumentModel.set(domainId, TYPE_RP, repoDoc.docId, {
            title,
            content: content || '',   
        });
    }

    static async deleteRepo(domainId: string, rpid: number): Promise<void> {
        const repoDoc = await this.getRepoByRpid(domainId, rpid);
        if (!repoDoc) {
            throw new Error(`Repo with rpid ${rpid} not found in domain ${domainId}`);
        }
        await DocumentModel.deleteOne(domainId, TYPE_RP, repoDoc.docId);
    }
    


    static async getRepo(domainId: string, docId: ObjectId): Promise<RPDoc | null> {
        return await DocumentModel.get(domainId, TYPE_RP, docId);
    }
    static async getRepoByRpid(domainId: string, rpid: number): Promise<RPDoc | null> {
        const result = await DocumentModel.getMulti(domainId, TYPE_RP, { rpid }).limit(1).toArray();
        return result.length > 0 ? result[0] : null;  
    }
    


    static async getAllRepos(domainId: string): Promise<RPDoc[]> {
        return await DocumentModel.getMulti(domainId, TYPE_RP, {}).toArray();
    }
    static async getDocsByRepo(domainId: string, rpid: number): Promise<DCDoc[]> {
        return await DocumentModel.getMulti(domainId, TYPE_DC, { rpid }).toArray();
    }
    
}

export class DocModel {
    static async generateNextDid(domainId: string, rpid: number): Promise<number> {
        // 在每个 repo 内独立计数，从 1 开始
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_DC, { rpid })
            .sort({ did: -1 })
            .limit(1)
            .project({ did: 1 })
            .toArray();
        return (lastDoc[0]?.did || 0) + 1;
    }
    static async generateNextRpid(domainId: string): Promise<number> {
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_DC, {})
            .sort({ rpid: -1 })
            .limit(1)
            .project({ rpid: 1 })
            .toArray();
        return (lastDoc[0]?.rpid || 0) + 1;
    }
    // Removed: updateResources method - resource management removed from doc
    



    static async addRootNode(
        domainId: string,
        rpid: number | string,
        did: number,
        owner: number,
        title: string,
        content: string,
        ip?: string
    ): Promise<ObjectId> {
        const parsedRpid = typeof rpid === 'string' ? parseInt(rpid, 10) : rpid;
    if (isNaN(parsedRpid)) {
        throw new Error(`Invalid rpid: ${rpid}`);
    }
        const newDid = did || await this.generateNextDid(domainId, parsedRpid);

        const payload: Partial<DCDoc> = {
            domainId,
            rpid: parsedRpid,
            did: newDid,
            title,
            content,
            owner,
            ip,
            updateAt: new Date(),
            views: 0,
            path: `/${newDid}`,
            doc: false,
            parentId: null, // 顶层节点 parentId 为 null
        };

        const docId = await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_DC,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])
        );

        return docId;
    }

    static async addSubdocNode(
        domainId: string,
        rpid: number[],
        did: number | null,
        parentDcid: number,
        owner: number,
        title: string,
        content: string,
        ip?: string
    ): Promise<ObjectId> {
        const parentNode = await DocumentModel.getMulti(domainId, TYPE_DC, { did: parentDcid })
            .limit(1)
            .toArray();

        if (!parentNode.length) {
            throw new Error('Parent node does not exist.');
        }

        const firstRpid = Array.isArray(rpid) ? rpid[0] : rpid;
        const newDid = did ?? await this.generateNextDid(domainId, firstRpid);
        const path = `${parentNode[0].path}/${newDid}`;

        const payload: Partial<DCDoc> = {
            domainId,
            rpid,
            did: newDid,
            parentId: parentDcid, // 使用父节点的 did
            title,
            content,
            owner,
            ip,
            updateAt: new Date(),
            views: 0,
            path,
            doc: true,
        };

        const docId = await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_DC,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])
        );

        return docId;
    }


    static async get(domainId: string, query: ObjectId | { did: number } | { rpid: number, did: number }): Promise<DCDoc | null> {
        // 支持通过 ObjectId 或 did 查询
        if (typeof query === 'object' && 'did' in query) {
            const docs = await DocumentModel.getMulti(domainId, TYPE_DC, query).limit(1).toArray();
            return docs[0] || null;
        }
        return await DocumentModel.get(domainId, TYPE_DC, query as ObjectId);
    }

    static async getChildren(domainId: string, parentId: number): Promise<DCDoc[]> {
        return await DocumentModel.getMulti(domainId, TYPE_DC, { parentId }).toArray();
    }

    static async getDoc(domainId: string, query: Partial<DCDoc>) {
        return DocumentModel.getMulti(domainId, TYPE_DC, query);
    }

    static async deleteNode(domainId: string, docId: ObjectId): Promise<void> {
        const node = await this.get(domainId, docId);
        if (!node) throw new Error('Node not found.');

        const descendants = await DocumentModel.getMulti(domainId, TYPE_DC, {
            path: { $regex: `^${node.path}` },
        }).toArray();

        const docIds = descendants.map((n) => n.docId);
        await Promise.all(docIds.map((id) => DocumentModel.deleteOne(domainId, TYPE_DC, id)));
    }

    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await DocumentModel.inc(domainId, TYPE_DC, docId, 'views', 1);
    }

    static async edit(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        await DocumentModel.set(domainId, TYPE_DC, docId, { 
            title, 
            content,
            updateAt: new Date()
        });
    }

    static async getDocsByIds(domainId: string, dids: number[]) {
        return await DocumentModel.getMulti(domainId, TYPE_DC, { did: { $in: dids } }).toArray();
    }
    static async getDocs(domainId: string, query: Filter<DCDoc>) {
        return DocumentModel.getMulti(domainId, TYPE_DC, query);
    }
}

export class BlockModel {
    static async generateNextBid(domainId: string, rpid: number): Promise<number> {
        // 在整个 repo 范围内独立计数，从 1 开始
        const lastBlock = await DocumentModel.getMulti(domainId, TYPE_BK, { rpid })
            .sort({ bid: -1 })
            .limit(1)
            .project({ bid: 1 })
            .toArray();
        return (lastBlock[0]?.bid || 0) + 1;
    }

    static async create(
        domainId: string,
        rpid: number,
        did: number,
        owner: number,
        title: string,
        content: string,
        ip?: string
    ): Promise<ObjectId> {
        const bid = await this.generateNextBid(domainId, rpid);
        
        const payload: Partial<BKDoc> = {
            domainId,
            rpid,
            did,
            bid,
            title,
            content,
            owner,
            ip,
            updateAt: new Date(),
            views: 0,
        };

        const docId = await DocumentModel.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_BK,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])
        );

        return docId;
    }

    static async get(domainId: string, query: ObjectId | { rpid: number, bid: number }): Promise<BKDoc | null> {
        // 支持通过 ObjectId 或 { rpid, bid } 查询
        if (typeof query === 'object' && 'bid' in query) {
            const blocks = await DocumentModel.getMulti(domainId, TYPE_BK, query).limit(1).toArray();
            return blocks[0] || null;
        }
        return await DocumentModel.get(domainId, TYPE_BK, query as ObjectId);
    }

    static async getByDid(domainId: string, did: number, rpid?: number): Promise<BKDoc[]> {
        const query: any = { did };
        if (rpid !== undefined) {
            query.rpid = rpid;  // 确保只查询当前 repo 的 blocks
        }
        return await DocumentModel.getMulti(domainId, TYPE_BK, query).toArray();
    }

    static async edit(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        await DocumentModel.set(domainId, TYPE_BK, docId, { 
            title, 
            content,
            updateAt: new Date()
        });
    }

    static async delete(domainId: string, docId: ObjectId): Promise<void> {
        await DocumentModel.deleteOne(domainId, TYPE_BK, docId);
    }

    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await DocumentModel.inc(domainId, TYPE_BK, docId, 'views', 1);
    }
}

// Removed: DocsModel not exported from ejun
export async function getDocsByDomain (domainId: string) {
    // return await DocsModel.getMulti(domainId, {}).toArray();
    return []; // Temporarily return empty array
}

// Removed: DocsModel and buildProjection not exported from ejun
export async function getDocsByIds (domainId: string, ids: ObjectId[]) {
    // return await DocsModel.getMulti(domainId, { _id: { $in: ids } }).toArray();
    return []; // Temporarily return empty array
}

export async function getDocsByDocId(domainId: string, docIds: number | number[]) {
    // DocsModel functionality removed - return empty array
    return [];
    
    /* Original implementation (commented out):
    const query = {
        domainId,
        docId: Array.isArray(docIds) ? { $in: docIds } : docIds,
    };

    const results = await DocsModel.getMulti(domainId, query)
        .project(buildProjection(DocsModel.PROJECTION_PUBLIC))
        .toArray();

    return results;
    */
}

// Removed: RepoModel has been deleted from ejun core
// This function now returns empty array as repo functionality is moved to ejunzrepo plugin
export async function getReposByDocId(domainId: string, docId: number | number[]) {
    // RepoModel functionality removed - return empty array
    return [];
    
    /* Original implementation (commented out):
    const query = {
        domainId,
        docId: Array.isArray(docId) ? { $in: docId } : docId,
    };

    const results = await RepoModel.getMulti(domainId, query)
        .project(buildProjection(RepoModel.PROJECTION_PUBLIC))
        .toArray();

    return results;
    */
}




// Removed: ProblemModel, ContestModel, TrainingModel not exported from ejun
/* 
export async function getProblemsByDocsId(domainId: string, lid: number) {
    const query = {
        domainId,
        associatedDocumentId: lid 
    };
    return await ProblemModel.getMulti(domainId, query).toArray();
}

export async function getRelated(domainId: string, pid: number, rule?: string) {
    const rules = Object.keys(ContestModel.RULES).filter((i) => !ContestModel.RULES[i].hidden);
    return await DocumentModel.getMulti(domainId, DocumentModel.TYPE_CONTEST, { pids: pid, rule: rule || { $in: rules } }).toArray();
}
*/


class DocHandler extends Handler {
    ddoc?: DCDoc;

    @param('docId', Types.ObjectId, true)
    async _prepare(domainId: string, docId: ObjectId) {
        if (docId) {
            const docDoc = await DocModel.get(domainId, docId);
            if (!docDoc) {
                throw new NotFoundError(domainId, docId);
            }
            this.ddoc = docDoc;
        }
    }
}
export class BaseDomainHandler extends Handler {
    async get({ domainId }) {
      domainId = this.args?.domainId || this.context?.domainId || 'system';
  
      try {
        const base = await BaseModel.getBase(domainId);
        const repos = await EjunRepoModel.getAllRepos(domainId);
  
        const nodes = [
          {
            id: "base-root",
            name: "Base",
            type: "base",
            url: this.url("base_domain", { domainId })
          },
          ...repos.map(repo => ({
            id: `repo-${repo.rpid}`,
            name: repo.title,
            type: 'repo',
            url: this.url('repo_detail', { domainId, rpid: repo.rpid }),
          }))
        ];
  
        const links = repos.map(repo => ({
          source: "base-root",
          target: `repo-${repo.rpid}`
        }));
  
        this.UiContext.forceGraphData = { nodes, links };
  
        this.response.template = 'base_domain.html';
        this.response.body = {
          domainId,
          base: base || null,
          repos: repos || []
        };
  
      } catch (error) {
        console.error("Error fetching base:", error);
        this.response.template = 'error.html';
        this.response.body = { error: "Failed to fetch base" };
      }
    }
  }
  


export class BaseEditHandler extends Handler {
    @param('docId', Types.ObjectId, true) 
    async get(domainId: string, docId?: ObjectId) {
        let base = (await BaseModel.getBase(domainId)) as BSDoc | null; 
        if (!base) {
            console.warn(`No base found for domain: ${domainId}`);
            base = {
                docType: 30,
                domainId: domainId,
                rpids: [],
                title: '',
                content: '',
                owner: this.user._id,
                createdAt: new Date(),
                updateAt: new Date(),
            } as Partial<BSDoc>; 
        }

        this.response.template = 'base_edit.html';
        this.response.body = { base };
    }

    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postCreate(domainId: string, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);

        
        const docId = await BaseModel.createBase(domainId, this.user._id, title, content || '');

        this.response.body = { docId };
        this.response.redirect = this.url('base_domain', { domainId });
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content, true)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);

        
        await BaseModel.updateBase(domainId, docId, title, content || '');

        this.response.body = { docId };
        this.response.redirect = this.url('base_domain', { domainId });
    }
}




export class RepoEditHandler extends Handler {
    @param('rpid', Types.Int, true)
    async get(domainId: string, rpid: number) {

        
            const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);

        this.response.template = 'repo_edit.html';
        this.response.body = { repo };
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
    
        
        const { docId, rpid } = await EjunRepoModel.createRepo(domainId, this.user._id, title, content);
    
        this.response.body = { docId, rpid };
        this.response.redirect = this.url('repo_detail', { domainId, rpid }); 
    }
    
    
    

    @param('rpid', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, rpid: number, title: string, content: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
    
        if (!title.trim()) {
            throw new Error("Title cannot be empty.");
        }
    
        
        if (!content || typeof content !== 'string') {
            content = '';
        }
    
       await EjunRepoModel.edit(domainId, rpid, title, content);
        this.response.body = { rpid };
        this.response.redirect = this.url('repo_detail', { domainId, rpid });

    }

    @param('rpid', Types.Int)
    async postDelete(domainId: string, rpid: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        await EjunRepoModel.deleteRepo(domainId, rpid);
        this.response.body = { rpid };
        this.response.redirect = this.url('base_domain', { domainId });
    }
    
}

export class RepoDetailHandler extends Handler {
    @param('rpid', Types.Int)
    async get(domainId: string, rpid: number) {
      if (!rpid) {
        throw new NotFoundError(`Invalid request: rpid is missing`);
      }
  
      // 获取仓库信息
      const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
      if (!repo) {
        throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
      }
  
      // 获取所有文档
      const repoDocs = await EjunRepoModel.getDocsByRepo(domainId, repo.rpid);
      
      // 获取所有顶层文档（没有 parent 的文档）
      const rootDocs = repoDocs.filter(doc => doc.parentId === null);
  
      // 获取所有 docs 的 blocks
      const allDocsWithBlocks = {};
      for (const doc of repoDocs) {
        const blocks = await BlockModel.getByDid(domainId, doc.did);
        if (blocks && blocks.length > 0) {
          allDocsWithBlocks[doc.did] = blocks.map(block => ({
            ...block,
            url: this.url('block_detail', {
              domainId,
              rpid: repo.rpid,
              did: doc.did,
              bid: block.bid
            })
          }));
        }
      }

      // 构造递归层级结构（从顶层文档开始）
      const buildHierarchy = (parentId: number | null, docs: any[]) => {
        return docs
          .filter(doc => doc.parentId === parentId)
          .map(doc => ({
            ...doc,
            url: this.url('doc_detail', {
              domainId,
              rpid: repo.rpid,
              did: doc.did
            }),
            subDocs: buildHierarchy(doc.did, docs)
          }));
      };
  
      // 构建所有顶层文档的层级结构
      const docHierarchy = {};
      docHierarchy[rpid] = buildHierarchy(null, repoDocs);
  
      // 设置响应数据
        this.response.template = 'repo_detail.html';
        this.response.pjax = 'repo_detail.html';
      this.response.body = {
        repo,
        rootDocs,
        repoDocs,
        docHierarchy,
      };
  
      // 注入给前端用的数据
      this.UiContext.docHierarchy = docHierarchy;
      this.UiContext.allDocsWithBlocks = allDocsWithBlocks;
      this.UiContext.repo = {
        domainId: repo.domainId,
        rpid: repo.rpid
      };
      
    }
  
    async post() {
      this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }
  }
  


export class RepoDocHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        try {
            const domainInfo = await DomainModel.get(domainId);
            if (!domainInfo) throw new NotFoundError(`Domain "${domainId}" not found.`);

            const branches = await DocModel.getDoc(domainId, { parentId: null });
            if (!branches) throw new Error('No branches found.');

            const [ddocs, totalPages, totalCount] = await paginate(branches, page, pageSize);

            this.response.template = 'repo_doc.html';
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
        
    }
}


export class DocDetailHandler extends DocHandler {
    @param('rpid', Types.Int)
    @param('did', Types.Int)
    async get(domainId: string, rpid: number, did: number) {
        if (!rpid || !did) {
            throw new NotFoundError(`Invalid request: rpid or did is missing`);
        }

        

        const ddoc = await DocModel.get(domainId, { rpid, did } as any);
        if (!ddoc) {
            throw new NotFoundError(`Doc with rpid ${rpid} and did ${did} not found.`);
        }

        if (Array.isArray(ddoc.rpid)) {
            ddoc.rpid = ddoc.rpid[0]; 
        }
        
        

        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE) ? ddoc : null;
        const udoc = await UserModel.getById(domainId, ddoc.owner);

        const repoDocs = await EjunRepoModel.getDocsByRepo(domainId, ddoc.rpid);

        // 获取所有 docs 的 blocks（确保只查询当前 repo 的 blocks）
        const allDocsWithBlocks = {};
        for (const doc of repoDocs) {
          const docBlocks = await BlockModel.getByDid(domainId, doc.did, ddoc.rpid);
          if (docBlocks && docBlocks.length > 0) {
            allDocsWithBlocks[doc.did] = docBlocks.map(block => ({
              ...block,
              url: this.url('block_detail', {
                domainId,
                rpid: ddoc.rpid,
                did: doc.did,
                bid: block.bid
              })
            }));
          }
        }

        // 构造递归层级结构（从顶层文档开始）
        const buildHierarchy = (parentId: number | null, docs: any[]) => {
          return docs
            .filter(doc => doc.parentId === parentId)
            .map(doc => ({
              ...doc,
              url: this.url('doc_detail', {
                domainId,
                rpid: ddoc.rpid,
                did: doc.did
              }),
              subDocs: buildHierarchy(doc.did, docs)
            }));
        };
    
        // 构建所有顶层文档的层级结构
        const docHierarchy = {};
        docHierarchy[ddoc.rpid] = buildHierarchy(null, repoDocs);

        // Get blocks for this doc（确保只查询当前 repo 的 blocks）
        const blocks = await BlockModel.getByDid(domainId, ddoc.did, ddoc.rpid);

        this.UiContext.docHierarchy = docHierarchy;
        this.UiContext.allDocsWithBlocks = allDocsWithBlocks;
        this.UiContext.repo = {
          domainId,
          rpid: ddoc.rpid
        };
        this.UiContext.ddoc = ddoc;
        
          
        this.response.template = 'doc_detail.html';
        this.response.pjax = 'doc_detail.html';
        this.response.body = {
            ddoc,
            dsdoc,
            udoc,
            blocks,
            repoDocs,
            docHierarchy,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }
}







export class DocCreateHandler extends DocHandler {
    async get() {
        const domainId = this.context.domainId || 'system';
        const parentId = Number(this.args?.parentId) || null;
        const rpid = Number(this.args?.rpid);

        this.response.template = 'doc_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            parentId,
            rpid
        };
    }

    @param('title', Types.Title)
    @param('rpid', Types.String)
    async postCreate(
        domainId: string,
        title: string,
        rpid: string
    ) {
        return this.postCreateSubdoc(domainId, title, rpid, undefined);
    }

    @param('title', Types.Title)
    @param('rpid', Types.String)
    @param('parentId', Types.Int, true) // 可选参数
    async postCreateSubdoc(
        domainId: string,
        title: string,
        rpid: string,
        parentId?: number
    ) {
        await this.limitRate('add_doc', 3600, 60);

        // 解析 rpid，并确保传入的是单个 `number`
        const rpidArray = rpid.split(',').map(Number).filter(n => !isNaN(n));
        if (rpidArray.length === 0) {
            throw new Error(`Invalid rpid: ${rpid}`);
        }
        const parsedRpid = rpidArray[0]; // 取数组的第一个值

        const did = await DocModel.generateNextDid(domainId, parsedRpid);

        let docId;
        if (parentId) {
            // 创建子文档
            docId = await DocModel.addSubdocNode(
                domainId,
                [parsedRpid],  // 需要传递数组
                did,
                parentId,      // parentDcid
                this.user._id, // owner
                title,
                '',
                this.request.ip
            );
        } else {
            // 创建顶层文档（没有 parent）
            docId = await DocModel.addRootNode(
                domainId,
                parsedRpid,
                did,
                this.user._id,
                title,
                '',
                this.request.ip
            );
        }

        this.response.body = { docId, did };
        this.response.redirect = this.url('doc_detail', { uid: this.user._id, rpid: parsedRpid, did });
    }

}




// Structure Update Handler
export class RepoStructureUpdateHandler extends Handler {
    @param('rpid', Types.Int)
    async post(domainId: string, rpid: number) {
        const { structure, creates } = this.request.body;
        
        if (!structure || !structure.docs) {
            throw new Error('Invalid structure');
        }

        console.log('Received structure:', JSON.stringify(structure, null, 2));
        console.log('Received creates:', JSON.stringify(creates || [], null, 2));

        try {
            // 先创建新项目
            if (creates && creates.length > 0) {
                await this.createItems(domainId, rpid, creates);
            }

            // 然后更新文档结构
            await this.updateDocStructure(domainId, rpid, structure.docs);
            
            this.response.body = { success: true };
        } catch (error: any) {
            console.error(`Failed to update structure: ${error.message}`);
            throw error;
        }
    }

    async createItems(domainId: string, rpid: number, creates: any[]) {
        // 首先创建一个映射：placeholderId -> did
        const placeholderMap: { [key: string]: number } = {};
        
        // 第一遍：只创建文档（按层级顺序）
        // 需要多轮创建：先创建没有父节点的，再创建有父节点的
        const docCreates = creates.filter(c => c.type === 'doc');
        
        // 多轮创建，确保父子关系正确
        let createdDocs = new Set<string>();
        let hasNewDocs = true;
        let round = 0;
        
        while (hasNewDocs && round < 10) { // 最多 10 轮，防止无限循环
            round++;
            hasNewDocs = false;
            
            for (const create of docCreates) {
                // 如果已经创建过，跳过
                const placeholderId = (create as any).placeholderId;
                if (placeholderId && placeholderMap[placeholderId]) {
                    continue;
                }
                
                const { type, title, parentDid, parentPlaceholderId } = create;
                
                if (!title || !title.trim()) {
                    continue;
                }

                // 确定实际的父节点 did
                let actualParentDid: number | null = null;
                let canCreate = false;
                
                if (parentPlaceholderId) {
                    // 父节点是占位符 doc，从映射中获取
                    actualParentDid = placeholderMap[parentPlaceholderId];
                    canCreate = actualParentDid !== undefined;
                } else if (parentDid !== null && parentDid !== undefined) {
                    // 父节点是已存在的 doc
                    if (typeof parentDid === 'string') {
                        // 如果 parentDid 是字符串，说明也是占位符 ID
                        actualParentDid = placeholderMap[parentDid];
                        canCreate = actualParentDid !== undefined;
                    } else {
                        actualParentDid = parentDid;
                        canCreate = true; // 已存在的 doc，可以直接创建
                    }
                } else {
                    // 没有父节点，根层级
                    canCreate = true;
                }
                
                if (!canCreate) {
                    continue; // 父节点还没创建，跳过这一轮
                }
                
                // 创建文档
                const did = await DocModel.generateNextDid(domainId, rpid);
                const docId = actualParentDid 
                    ? await DocModel.addSubdocNode(
                        domainId,
                        [rpid],
                        did,
                        actualParentDid,
                        this.user._id,
                        title.trim(),
                        '',
                        this.request.ip
                    )
                    : await DocModel.addRootNode(
                        domainId,
                        rpid,
                        did,
                        this.user._id,
                        title.trim(),
                        '',
                        this.request.ip
                    );
                
                // 记录 placeholderId 到 did 的映射
                if (placeholderId) {
                    placeholderMap[placeholderId] = did;
                    console.log(`Mapped placeholder ${placeholderId} -> did ${did}`);
                }
                
                console.log(`Created doc: ${title}, did=${did}, docId=${docId}`);
                hasNewDocs = true;
            }
        }
        
        // 第二遍：创建 blocks
        const blockCreates = creates.filter(c => c.type === 'block');
        console.log(`Creating ${blockCreates.length} blocks...`);
        for (const create of blockCreates) {
            const { type, title, parentDid, parentPlaceholderId } = create;
            
            if (!title || !title.trim()) {
                console.warn(`Block without title, skipping`);
                continue;
            }

            // 确定实际的父节点 did
            let actualParentDid: number | null = null;
            if (parentPlaceholderId) {
                actualParentDid = placeholderMap[parentPlaceholderId];
                console.log(`Block ${title}: parentPlaceholderId=${parentPlaceholderId}, mapped to did=${actualParentDid}`);
            } else if (parentDid !== null && parentDid !== undefined) {
                if (typeof parentDid === 'string') {
                    actualParentDid = placeholderMap[parentDid];
                    console.log(`Block ${title}: parentDid (string)=${parentDid}, mapped to did=${actualParentDid}`);
                } else {
                    actualParentDid = parentDid;
                    console.log(`Block ${title}: parentDid (number)=${actualParentDid}`);
                }
            }
            
            if (!actualParentDid) {
                console.warn(`Cannot create block without parentDid: ${title}, parentDid=${parentDid}, parentPlaceholderId=${parentPlaceholderId}`);
                continue;
            }
            
            const bid = await BlockModel.generateNextBid(domainId, rpid);
            const blockId = await BlockModel.create(
                domainId,
                rpid,
                actualParentDid,
                this.user._id,
                title.trim(),
                '',
                this.request.ip
            );
            console.log(`Created block: ${title}, bid=${bid}, blockId=${blockId}, parentDid=${actualParentDid}`);
        }
    }

    async updateDocStructure(domainId: string, rpid: number, docs: any[], parentDid: number | null = null) {
        for (const docData of docs) {
            const { did, order, subDocs, blocks } = docData;

            // 更新文档的父节点和顺序
            const doc = await DocModel.get(domainId, { rpid, did });
            if (!doc) {
                console.log(`Doc not found: rpid=${rpid}, did=${did}`);
                continue;
            }

            console.log(`Updating doc ${did}: parentId=${parentDid}, order=${order}`);

            // 使用 DocumentModel.set 更新文档
            await DocumentModel.set(domainId, TYPE_DC, doc._id, {
                parentId: parentDid,
                order: order || 0,
                updateAt: new Date()
            });

            // 更新 blocks 的顺序和父文档
            if (blocks && blocks.length > 0) {
                for (const blockData of blocks) {
                    const bid = blockData.bid;
                    const blockOrder = blockData.order;
                    
                    // 使用 rpid + bid 来唯一标识 block（bid 在整个 repo 内唯一）
                    const block = await BlockModel.get(domainId, { rpid, bid });
                    
                    if (block) {
                        console.log(`Updating block ${bid}: did=${did}, order=${blockOrder}`);
                        await DocumentModel.set(domainId, TYPE_BK, block._id, {
                            did: did,  // 更新 block 的父文档 ID
                            order: blockOrder || 0,
                            updateAt: new Date()
                        });
                    } else {
                        console.log(`Block not found: rpid=${rpid}, bid=${bid}`);
                    }
                }
            }

            // 递归处理子文档
            if (subDocs && subDocs.length > 0) {
                await this.updateDocStructure(domainId, rpid, subDocs, did);
            }
        }
    }
}

// Removed: DocCreateSubdocHandler - unified with DocCreateHandler



// Removed: DocEditHandler and DocResourceEditHandler - resource management removed from doc

export class DocEditHandler extends DocHandler {
    @param('docId', Types.ObjectId)
    async get(domainId: string, docId: ObjectId) {
        if (!docId) {
            throw new NotFoundError(`Invalid request: docId is missing`);
        }

        const ddoc = await DocModel.get(domainId, docId);
        if (!ddoc) {
            throw new NotFoundError(`Doc with docId ${docId} not found.`);
        }

        this.response.template = 'doc_edit.html';
        this.response.body = {
            ddoc,
            rpid: this.args.rpid,
        };
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, docId: ObjectId, title: string, content: string) {
        const doc = await DocModel.get(domainId, docId);
        if (!doc || !doc.rpid) {
            throw new NotFoundError(`Doc with docId ${docId} not found or has no rpid.`);
        }

        await DocModel.edit(domainId, docId, title, content);
 
        this.response.body = { docId, did: doc.did };
        this.response.redirect = this.url('doc_detail', { rpid: doc.rpid, did: doc.did });
    }

    @param('docId', Types.ObjectId)
    async postDelete(domainId: string, docId: ObjectId) {
        await DocModel.deleteNode(domainId, docId);
        this.response.redirect = this.url('repo_detail', { rpid: this.ddoc?.rpid });
    }
}

// Block Handlers
export class BlockCreateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('did', Types.Int)
    async get(domainId: string, rpid: number, did: number) {
        const ddoc = await DocModel.get(domainId, { rpid, did } as any);
        if (!ddoc) {
            throw new NotFoundError(`Doc not found`);
        }

        this.response.template = 'block_edit.html';
        this.response.body = {
            ddoc,
            rpid: ddoc.rpid,
            did: ddoc.did
        };
    }

    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, rpid: number, did: number, title: string, content: string) {
        await this.limitRate('create_block', 3600, 100);

        const docId = await BlockModel.create(
            domainId,
            rpid,
            did,
            this.user._id,
            title,
            content,
            this.request.ip
        );

        const block = await BlockModel.get(domainId, docId);
        this.response.body = { docId, bid: block?.bid };
        this.response.redirect = this.url('block_detail', { rpid, did, bid: block?.bid });
    }
}

export class BlockDetailHandler extends Handler {
    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    async get(domainId: string, rpid: number, did: number, bid: number) {
        // bid 在整个 repo 内唯一，只需要 rpid + bid
        const block = await BlockModel.get(domainId, { rpid, bid });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        await BlockModel.incrementViews(domainId, block.docId);

        const ddoc = await DocModel.get(domainId, { rpid, did } as any);
        const udoc = await UserModel.getById(domainId, block.owner);

        // 获取所有文档和树形结构（用于侧边栏）
        const repoDocs = await EjunRepoModel.getDocsByRepo(domainId, rpid);

        // 获取所有 docs 的 blocks（确保只查询当前 repo 的 blocks）
        const allDocsWithBlocks = {};
        for (const doc of repoDocs) {
          const docBlocks = await BlockModel.getByDid(domainId, doc.did, rpid);
          if (docBlocks && docBlocks.length > 0) {
            allDocsWithBlocks[doc.did] = docBlocks.map(b => ({
              ...b,
              url: this.url('block_detail', {
                domainId,
                rpid: rpid,
                did: doc.did,
                bid: b.bid
              })
            }));
          }
        }

        // 构造递归层级结构（从顶层文档开始）
        const buildHierarchy = (parentId: number | null, docs: any[]) => {
          return docs
            .filter(doc => doc.parentId === parentId)
            .map(doc => ({
              ...doc,
              url: this.url('doc_detail', {
                domainId,
                rpid: rpid,
                did: doc.did
              }),
              subDocs: buildHierarchy(doc.did, docs)
            }));
        };
    
        // 构建所有顶层文档的层级结构
        const docHierarchy = {};
        docHierarchy[rpid] = buildHierarchy(null, repoDocs);

        this.UiContext.docHierarchy = docHierarchy;
        this.UiContext.allDocsWithBlocks = allDocsWithBlocks;
        this.UiContext.repo = {
          domainId,
          rpid: rpid
        };
        this.UiContext.ddoc = ddoc;
        this.UiContext.block = block;

        this.response.template = 'block_detail.html';
        this.response.pjax = 'block_detail.html';
        this.response.body = {
            block,
            ddoc,
            udoc
        };
    }
}

export class BlockEditHandler extends Handler {
    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    async get(domainId: string, rpid: number, did: number, bid: number) {
        // bid 在整个 repo 内唯一，只需要 rpid + bid
        const block = await BlockModel.get(domainId, { rpid, bid });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        this.response.template = 'block_edit.html';
        this.response.body = {
            block,
            rpid: block.rpid,
            did: block.did
        };
    }

    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, rpid: number, did: number, bid: number, title: string, content: string) {
        // bid 在整个 repo 内唯一，只需要 rpid + bid
        const block = await BlockModel.get(domainId, { rpid, bid });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        await BlockModel.edit(domainId, block.docId, title, content);

        this.response.body = { bid };
        this.response.redirect = this.url('block_detail', { rpid, did, bid });
    }

    @param('rpid', Types.Int)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    async postDelete(domainId: string, rpid: number, did: number, bid: number) {
        // bid 在整个 repo 内唯一，只需要 rpid + bid
        const block = await BlockModel.get(domainId, { rpid, bid });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }

        await BlockModel.delete(domainId, block.docId);
        
        this.response.redirect = this.url('doc_detail', { rpid, did });
    }
}




// Removed: RepoModel has been deleted from ejun core
// This handler is commented out as it depends on the removed RepoModel
/* 
export class DocfileDownloadHandler extends Handler {
    async get({ docId, rid, filename }: { docId: string; rid: string|number; filename: string }) {
        const domainId = this.context.domainId || 'default_domain';

        const repo = await RepoModel.get(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        const actualDocId = repo.docId ?? docId;  
        const filePath = `repo/${domainId}/${actualDocId}/${filename}`;

        const fileMeta = await StorageModel.getMeta(filePath);
        if (!fileMeta) throw new NotFoundError(`File "${filename}" does not exist in repository "${rid}".`);

        this.response.body = await StorageModel.get(filePath);
        this.response.type = lookup(filename) || 'application/octet-stream';

        if (!['application/pdf', 'image/jpeg', 'image/png'].includes(this.response.type)) {
            this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
        }
    }
}
*/
export async function apply(ctx: Context) {
    const customChecker = (handler) => {
        // 获取允许的域列表
        const allowedDomains = SystemModel.get('ejunzrepo.allowed_domains');
        const allowedDomainsArray = yaml.load(allowedDomains) as string[];

        // 检查当前域是否在允许的域列表中
        if (!allowedDomainsArray.includes(handler.domain._id)) {
            return false; // 如果不在允许的域中，返回 false
        }
        if (handler.user._id === 2) {
            return true;
        } else {
            const hasPermission = handler.user.hasPerm(PERM.PERM_VIEW_BASE);
            return hasPermission;
        }
        
    };
    
    // function ToOverrideNav(h) {
    //     if (!h.response.body.overrideNav) {
    //         h.response.body.overrideNav = [];
    //     }

    //     h.response.body.overrideNav.push(
    //         {
    //             name: 'base_domain',
    //             args: {},
    //             displayName: 'base_domain',
    //             checker: customChecker,
    //         },

    //     );
        
    // }

    // ctx.on('handler/after/Processing#get', async (h) => {
    //     ToOverrideNav(h);
    // });

    // ctx.on('handler/after', async (h) => {
    //     if (h.request.path.includes('/tree')||h.request.path.includes('/forest')) {
    //         if (!h.response.body.overrideNav) {
    //             h.response.body.overrideNav = [];
    //         }
    //         h.response.body.overrideNav.push(
    //             {
    //                 name: 'processing_main',
    //                 args: {},
    //                 displayName: 'processing_main',
    //                 checker: () => true, 
    //             }
    //         );
    //     ToOverrideNav(h);
    //     }
    // });

    const PERM = {
        PERM_VIEW_BASE: 1n << 80n,
    };

    global.Ejunz.model.builtin.registerPluginPermission(
        'plugins',
        PERM.PERM_VIEW_BASE, 
        'Base View',
        true,
        false,
        'ejunzrepo'
    );
    
    SettingModel.DomainPluginSetting(
        SettingModel.Setting('plugins', 'ejunzrepo', [''], 'yaml', 'repo_map'),
    );

    ctx.Route('base_domain', '/base', BaseDomainHandler);
    ctx.Route('base_edit', '/base/:docId/edit', BaseEditHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('base_create', '/base/create', BaseEditHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_create', '/base/repo/create', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_detail', '/base/repo/:rpid', RepoDetailHandler);
    ctx.Route('repo_structure_update', '/base/repo/:rpid/update_structure', RepoStructureUpdateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('doc_create', '/base/repo/:rpid/doc/create', DocCreateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_edit', '/base/repo/:rpid/edit', RepoEditHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_doc', '/base/repo/:rpid/doc', RepoDocHandler);
    ctx.Route('doc_create_subdoc', '/base/repo/:rpid/doc/:parentId/createsubdoc', DocCreateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('doc_detail', '/base/repo/:rpid/doc/:did', DocDetailHandler);
    ctx.Route('doc_edit', '/base/repo/:rpid/doc/:docId/editdoc', DocEditHandler, PERM.PERM_VIEW_BASE);
    // Removed: doc_resource_edit - resource management removed from doc
    // Block routes
    ctx.Route('block_create', '/base/repo/:rpid/doc/:did/block/create', BlockCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('block_detail', '/base/repo/:rpid/doc/:did/block/:bid', BlockDetailHandler);
    ctx.Route('block_edit', '/base/repo/:rpid/doc/:did/block/:bid/edit', BlockEditHandler, PRIV.PRIV_USER_PROFILE);

    ctx.i18n.load('zh', {
        base_domain: '基础',
        repo_create: '创建仓库',
        repo_detail: '仓库详情',
        repo_edit: '编辑仓库',
        repo_doc: '仓库文档',
        doc_create: '创建文档',
        doc_create_subdoc: '创建子文档',
        doc_detail: '文档详情',  
        doc_edit: '编辑文档',
        block_create: '创建块',
        block_detail: '块详情',
        block_edit: '编辑块',
    });
    ctx.i18n.load('en', {
        base_domain: 'Base',
        repo_create: 'Create Repo',
        repo_detail: 'Repo Detail',
        repo_edit: 'Edit Repo',
        repo_doc: 'Repo Doc',
        doc_create: 'Create Doc',
        doc_create_subdoc: 'Create Subdoc',
        doc_detail: 'Doc Detail',
        doc_edit: 'Edit Doc',
        block_create: 'Create Block',
        block_detail: 'Block Detail',
        block_edit: 'Edit Block',
    });
}
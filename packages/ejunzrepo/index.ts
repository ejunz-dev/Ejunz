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
import { exec as execCb } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
const exec = promisify(execCb);
// 防止重复注册系统设置导致系统设置页面出现多个相同输入项
let EJUNZREPO_SETTINGS_REGISTERED = false;
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
    currentBranch?: string; // 当前编辑分支
    branches?: string[];    // 已存在的本地分支列表
    githubRepo?: string;    // GitHub 仓库地址，如 git@github.com:user/repo.git
    mode?: 'file' | 'manuscript'; // 显示模式：文件模式或文稿模式
    mcpServerId?: number; // 关联的MCP服务器ID（内部调用）
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
    branch?: string; // 所属分支，默认为 main
    order?: number;
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
    branch?: string; // 所属分支，默认为 main
    order?: number;
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
    static async generateNextDid(domainId: string, rpid: number, branch: string = 'main'): Promise<number> {
        // 在每个 repo+branch 内独立计数，从 1 开始
        const lastDoc = await DocumentModel.getMulti(domainId, TYPE_DC, { rpid, branch })
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
        ip?: string,
        branch: string = 'main'
    ): Promise<ObjectId> {
        const parsedRpid = typeof rpid === 'string' ? parseInt(rpid, 10) : rpid;
    if (isNaN(parsedRpid)) {
        throw new Error(`Invalid rpid: ${rpid}`);
    }
        const newDid = did || await this.generateNextDid(domainId, parsedRpid, branch);

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
            branch,
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
        ip?: string,
        branch: string = 'main'
    ): Promise<ObjectId> {
        const parentNode = await DocumentModel.getMulti(domainId, TYPE_DC, { did: parentDcid })
            .limit(1)
            .toArray();

        if (!parentNode.length) {
            throw new Error('Parent node does not exist.');
        }

        const firstRpid = Array.isArray(rpid) ? rpid[0] : rpid;
        const newDid = did ?? await this.generateNextDid(domainId, firstRpid, branch);
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
            branch,
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

    static async getChildren(domainId: string, parentId: number, branch?: string): Promise<DCDoc[]> {
        const query: any = { parentId };
        if (branch) query.branch = branch;
        return await DocumentModel.getMulti(domainId, TYPE_DC, query).toArray();
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
    static async generateNextBid(domainId: string, rpid: number, branch: string = 'main'): Promise<number> {
        // 在 repo+branch 范围内独立计数，从 1 开始
        const lastBlock = await DocumentModel.getMulti(domainId, TYPE_BK, { rpid, branch })
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
        ip?: string,
        branch: string = 'main'
    ): Promise<ObjectId> {
        const bid = await this.generateNextBid(domainId, rpid, branch);
        
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
            branch,
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

    static async getByDid(domainId: string, did: number, rpid?: number, branch?: string): Promise<BKDoc[]> {
        const query: any = { did };
        if (rpid !== undefined) query.rpid = rpid;
        if (branch !== undefined) query.branch = branch;
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
        
        // 自动创建对应的 MCP server（内部调用）
        try {
            const mcpServerModel = (global as any).Ejunz?.model?.mcpServer;
            if (mcpServerModel) {
                const mcpServerName = `repo-${rpid}-${title}`.substring(0, 50); // 限制名称长度
                const mcpServer = await mcpServerModel.add({
                    domainId,
                    name: mcpServerName,
                    description: `Repo ${title} 的 MCP 服务（内部调用）`,
                    owner: this.user._id,
                    wsToken: null, // 内部调用不需要token
                    status: 'connected', // 内部服务始终为connected
                });
                
                // 更新repo，关联MCP server
                await DocumentModel.set(domainId, TYPE_RP, docId, { mcpServerId: mcpServer.serverId });
                
                // 创建默认的MCP工具（查询、创建、编辑、删除）
                await createDefaultRepoMcpTools(domainId, mcpServer.serverId, mcpServer.docId, rpid, this.user._id);
            }
        } catch (err) {
            // 创建MCP server失败不影响repo创建
            console.error('Failed to create MCP server for repo:', err);
        }
    
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
    @param('branch', Types.String, true)
    async get(domainId: string, rpid: number, branch?: string) {
      if (!rpid) {
        throw new NotFoundError(`Invalid request: rpid is missing`);
      }
  
      const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
      if (!repo) {
        throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
      }
  
      // 若未显式传入分支，重定向到带分支的URL，默认使用 main
      if (!branch || !String(branch).trim()) {
        const target = this.url('repo_detail_branch', { domainId, rpid, branch: 'main' });
        this.response.redirect = target;
        return;
      }
  
      const requestedBranch = branch;
      
      const repoDocsAll = await EjunRepoModel.getDocsByRepo(domainId, repo.rpid);
      const repoDocs = repoDocsAll.filter(d => (d.branch || 'main') === requestedBranch);
      const rootDocs = repoDocs.filter(doc => doc.parentId === null);
  
      const allDocsWithBlocks = {};
      for (const doc of repoDocs) {
        const blocks = await BlockModel.getByDid(domainId, doc.did, undefined, requestedBranch);
        if (blocks && blocks.length > 0) {
          allDocsWithBlocks[doc.did] = blocks.map(block => ({
            ...block,
            url: this.url('block_detail_branch', {
              domainId,
              rpid: repo.rpid,
              branch: requestedBranch,
              did: doc.did,
              bid: block.bid
            })
          }));
        }
      }

      const buildHierarchy = (parentId: number | null, docs: any[]) => {
        return docs
          .filter(doc => doc.parentId === parentId)
          .map(doc => ({
            ...doc,
            url: this.url('doc_detail_branch', {
              domainId,
              rpid: repo.rpid,
              branch: requestedBranch,
              did: doc.did
            }),
            subDocs: buildHierarchy(doc.did, docs)
          }));
      };
  
      const docHierarchy = {};
      docHierarchy[rpid] = buildHierarchy(null, repoDocs);
  
      let branches: string[] = Array.isArray((repo as any).branches)
        ? ((repo as any).branches as string[])
        : ((typeof (repo as any).branches === 'string' && (repo as any).branches)
            ? [String((repo as any).branches)]
            : []);
      if (!branches.includes('main')) branches.push('main');
      if (!branches.includes(requestedBranch)) branches.push(requestedBranch);
      branches = Array.from(new Set(branches));
  
      // 根据模式选择模板
      const mode = (repo as any).mode || 'file';
      if (mode === 'manuscript') {
        // 文稿模式：构建完整的文档树和内容
        const manuscriptData = await this.buildManuscriptData(domainId, repo.rpid, requestedBranch, repoDocs);
        this.response.template = 'repo_manuscript.html';
        this.response.pjax = 'repo_manuscript.html';
        this.response.body = {
          repo,
          currentBranch: requestedBranch,
          branches,
          ...manuscriptData,
        };
      } else {
        // 文件模式：使用原有模板
        this.response.template = 'repo_detail.html';
        this.response.pjax = 'repo_detail.html';
      this.response.body = {
        repo,
        rootDocs,
        repoDocs,
        docHierarchy,
          currentBranch: requestedBranch,
          branches,
      };
      }
  
      this.UiContext.docHierarchy = docHierarchy;
      this.UiContext.allDocsWithBlocks = allDocsWithBlocks;
      this.UiContext.repo = {
        domainId: repo.domainId,
        rpid: repo.rpid,
        currentBranch: requestedBranch,
      };
    }
  
    async post() {
      this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    /**
     * 构建文稿模式的数据结构
     */
    private async buildManuscriptData(domainId: string, rpid: number, branch: string, repoDocs: DCDoc[]) {
      // 构建带编号的目录树
      let docCounter = 0;
      let blockCounter = 0;
      
      const buildTOC = (parentId: number | null, level: number = 0, parentNumber: string = ''): any[] => {
        const children = repoDocs.filter(doc => doc.parentId === parentId);
        return children.map((doc, index) => {
          docCounter++;
          const number = parentNumber ? `${parentNumber}.${index + 1}` : `${index + 1}`;
          const docBlocks = repoDocs.filter(d => false); // 这里需要获取blocks，稍后处理
          
          return {
            type: 'doc',
            did: doc.did,
            number,
            level,
            title: doc.title,
            content: doc.content || '',
            children: buildTOC(doc.did, level + 1, number),
          };
        });
      };

      // 构建完整内容（按顺序）
      const buildContent = (parentId: number | null): any[] => {
        const children = repoDocs
          .filter(doc => doc.parentId === parentId)
          .sort((a, b) => {
            // 简单的排序，可以根据需要改进
            return (a.did || 0) - (b.did || 0);
          });
        
        const result: any[] = [];
        for (const doc of children) {
          result.push({
            type: 'doc',
            did: doc.did,
            title: doc.title,
            content: doc.content || '',
          });
          
          // 添加该doc下的blocks
          // 这里需要异步获取blocks，稍后处理
          
          // 递归添加子文档
          result.push(...buildContent(doc.did));
        }
        return result;
      };

      // 获取所有blocks
      const allBlocksMap: { [did: number]: BKDoc[] } = {};
      for (const doc of repoDocs) {
        const blocks = await BlockModel.getByDid(domainId, doc.did, rpid, branch);
        if (blocks && blocks.length > 0) {
          // 按bid排序
          allBlocksMap[doc.did] = blocks.sort((a, b) => (a.bid || 0) - (b.bid || 0));
        }
      }

      // 重新构建TOC，包含blocks
      // 编号规则：doc用数字，block用字母（如 1, 1.1, 1.1.a, 1.1.b, 1.2）
      const buildTOCWithBlocks = (parentId: number | null, level: number = 0, parentNumber: string = ''): any[] => {
        const children = repoDocs
          .filter(doc => doc.parentId === parentId)
          .sort((a, b) => (a.did || 0) - (b.did || 0));
        
        const tocItems: any[] = [];
        children.forEach((doc, index) => {
          const number = parentNumber ? `${parentNumber}.${index + 1}` : `${index + 1}`;
          const blocks = allBlocksMap[doc.did] || [];
          
          // 构建blocks项（作为doc的子项，使用字母编号）
          const blockItems = blocks.map((block, blockIndex) => ({
            type: 'block',
            did: doc.did,
            bid: block.bid,
            number: `${number}.${String.fromCharCode(97 + blockIndex)}`, // a, b, c...
            level: level + 1,
            title: block.title,
            content: block.content || '',
            preview: (block.content || '').substring(0, 100),
          }));
          
          // 递归添加子文档（子文档继续使用数字编号）
          const subDocs = buildTOCWithBlocks(doc.did, level + 1, number);
          
          // 添加doc项，包含blocks和子文档
          tocItems.push({
            type: 'doc',
            did: doc.did,
            number,
            level,
            title: doc.title,
            content: doc.content || '',
            preview: (doc.content || '').substring(0, 100),
            children: [...blockItems, ...subDocs],
          });
        });
        
        return tocItems;
      };

      // 构建完整内容（带编号）
      const buildContentWithBlocks = (parentId: number | null, parentNumber: string = ''): any[] => {
        const children = repoDocs
          .filter(doc => doc.parentId === parentId)
          .sort((a, b) => (a.did || 0) - (b.did || 0));
        
        const result: any[] = [];
        children.forEach((doc, index) => {
          const number = parentNumber ? `${parentNumber}.${index + 1}` : `${index + 1}`;
          
          result.push({
            type: 'doc',
            did: doc.did,
            number,
            title: doc.title,
            content: doc.content || '',
          });
          
          // 添加该doc下的blocks（使用字母编号）
          const blocks = allBlocksMap[doc.did] || [];
          blocks.forEach((block, blockIndex) => {
            result.push({
              type: 'block',
              did: doc.did,
              bid: block.bid,
              number: `${number}.${String.fromCharCode(97 + blockIndex)}`,
              title: block.title,
              content: block.content || '',
            });
          });
          
          // 递归添加子文档
          result.push(...buildContentWithBlocks(doc.did, number));
        });
        return result;
      };

      const toc = buildTOCWithBlocks(null);
      const content = buildContentWithBlocks(null, '');

      return {
        toc,
        content,
        // 传递原始数据用于编辑
        rawData: {
          docs: repoDocs.map(doc => ({
            did: doc.did,
            title: doc.title,
            content: doc.content || '',
            parentId: doc.parentId,
          })),
          blocks: Object.values(allBlocksMap).flat().map(block => ({
            bid: block.bid,
            did: block.did,
            title: block.title,
            content: block.content || '',
          })),
        },
      };
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
    @param('branch', Types.String, true)
    @param('did', Types.Int)
    async get(domainId: string, rpid: number, branch: string | undefined, did: number) {
        if (!rpid || !did) {
            throw new NotFoundError(`Invalid request: rpid or did is missing`);
        }

        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo not found`);
        if (!branch || !String(branch).trim()) {
            this.response.redirect = this.url('doc_detail_branch', { domainId, rpid, branch: repo.currentBranch || 'main', did });
            return;
        }

        const ddoc = await DocModel.get(domainId, { rpid, did } as any);
        if (!ddoc) {
            throw new NotFoundError(`Doc with rpid ${rpid} and did ${did} not found.`);
        }
        if (Array.isArray(ddoc.rpid)) {
            ddoc.rpid = ddoc.rpid[0]; 
        }
        const currentBranch = branch || (ddoc as any).branch || 'main';
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE) ? ddoc : null;
        const udoc = await UserModel.getById(domainId, ddoc.owner);

        const repoDocsAll = await EjunRepoModel.getDocsByRepo(domainId, ddoc.rpid);
        const repoDocs = repoDocsAll.filter(doc => (doc.branch || 'main') === currentBranch);

        const allDocsWithBlocks = {};
        for (const doc of repoDocs) {
          const docBlocks = await BlockModel.getByDid(domainId, doc.did, ddoc.rpid, currentBranch);
          if (docBlocks && docBlocks.length > 0) {
            allDocsWithBlocks[doc.did] = docBlocks.map(block => ({
              ...block,
              url: this.url('block_detail_branch', {
                domainId,
                rpid: ddoc.rpid,
                branch: currentBranch,
                did: doc.did,
                bid: block.bid
              })
            }));
          }
        }

        const buildHierarchy = (parentId: number | null, docs: any[]) => {
          return docs
            .filter(doc => doc.parentId === parentId)
            .map(doc => ({
              ...doc,
              url: this.url('doc_detail_branch', {
                domainId,
                rpid: ddoc.rpid,
                branch: currentBranch,
                did: doc.did
              }),
              subDocs: buildHierarchy(doc.did, docs)
            }));
        };
    
        const docHierarchy = {};
        docHierarchy[ddoc.rpid] = buildHierarchy(null, repoDocs);

        const blocks = await BlockModel.getByDid(domainId, ddoc.did, ddoc.rpid, currentBranch);

        this.UiContext.docHierarchy = docHierarchy;
        this.UiContext.allDocsWithBlocks = allDocsWithBlocks;
        this.UiContext.repo = {
          domainId,
          rpid: ddoc.rpid,
          currentBranch,
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
            currentBranch,
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
        const branch = (this.args?.branch) || '';
        if (!branch) {
            const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
            const b = repo?.currentBranch || 'main';
            this.response.redirect = this.url('doc_create_branch', { domainId, rpid, branch: b });
            return;
        }
        this.response.template = 'doc_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            parentId,
            rpid,
            branch,
        };
    }

    @param('title', Types.Title)
    @param('rpid', Types.String)
    @param('branch', Types.String, true)
    async postCreate(
        domainId: string,
        title: string,
        rpid: string,
        branch?: string,
    ) {
        return this.postCreateSubdoc(domainId, title, rpid, undefined, branch);
    }

    @param('title', Types.Title)
    @param('rpid', Types.String)
    @param('parentId', Types.Int, true)
    @param('branch', Types.String, true)
    async postCreateSubdoc(
        domainId: string,
        title: string,
        rpid: string,
        parentId?: number,
        branch?: string,
    ) {
        await this.limitRate('add_doc', 3600, 60);
        const rpidArray = rpid.split(',').map(Number).filter(n => !isNaN(n));
        if (rpidArray.length === 0) {
            throw new Error(`Invalid rpid: ${rpid}`);
        }
        const parsedRpid = rpidArray[0];
        const repo = await EjunRepoModel.getRepoByRpid(domainId, parsedRpid);
        const effectiveBranch = (branch || repo?.currentBranch || 'main');
        const did = await DocModel.generateNextDid(domainId, parsedRpid, effectiveBranch);
        let docId;
        if (parentId) {
            docId = await DocModel.addSubdocNode(
                domainId,
                [parsedRpid],
                did,
                parentId,
                this.user._id,
                title,
                '',
                this.request.ip,
                effectiveBranch
            );
        } else {
            docId = await DocModel.addRootNode(
                domainId,
                parsedRpid,
                did,
                this.user._id,
                title,
                '',
                this.request.ip,
                effectiveBranch
            );
        }
        this.response.body = { docId, did };
        this.response.redirect = this.url('doc_detail_branch', { uid: this.user._id, rpid: parsedRpid, branch: effectiveBranch, did });
    }

}




// Structure Update Handler
export class RepoStructureUpdateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number) {
        const { structure, creates, deletes, updates, branch } = this.request.body;
        const effectiveBranch = (branch || this.args?.branch || 'main');
        
        if (!structure || !structure.docs) {
            throw new Error('Invalid structure');
        }

        

        try {
            // 先处理删除
            if (deletes && Array.isArray(deletes) && deletes.length > 0) {
                await this.deleteItems(domainId, rpid, deletes, effectiveBranch);
            }
            // 然后处理创建
            if (creates && creates.length > 0) {
                await this.createItems(domainId, rpid, creates, effectiveBranch);
            }
            // 处理标题更新
            if (updates && Array.isArray(updates) && updates.length > 0) {
                await this.updateItems(domainId, rpid, updates, effectiveBranch);
            }
            // 最后更新结构
            await this.updateDocStructure(domainId, rpid, structure.docs);
            this.response.body = { success: true, branch: effectiveBranch };
        } catch (error: any) {
            console.error(`Failed to update structure: ${error.message}`);
            throw error;
        }
    }

    async updateItems(domainId: string, rpid: number, updates: any[], branch: string) {
        for (const updateItem of updates) {
            const { type, did, bid, title } = updateItem;
            
            if (type === 'doc' && did && title) {
                const doc = await DocModel.get(domainId, { rpid, did });
                if (doc && (doc.branch || 'main') === branch) {
                    await DocModel.edit(domainId, doc.docId, title, doc.content);
                }
            } else if (type === 'block' && bid && title) {
                const block = await BlockModel.get(domainId, { rpid, bid });
                if (block && (block.branch || 'main') === branch) {
                    await BlockModel.edit(domainId, block.docId, title, block.content);
                }
            }
        }
    }

    async deleteItems(domainId: string, rpid: number, deletes: any[], branch: string) {
        for (const deleteItem of deletes) {
            const { type, did, bid } = deleteItem;
            
            if (type === 'doc' && did) {
                // 删除文档及其所有子文档和 blocks
                const doc = await DocModel.get(domainId, { rpid, did });
                if (doc && (doc.branch || 'main') === branch) {
                    // 使用 deleteNode 会递归删除所有子节点
                    await DocModel.deleteNode(domainId, doc.docId);
                }
            } else if (type === 'block' && bid) {
                // 删除 block
                const block = await BlockModel.get(domainId, { rpid, bid });
                if (block && (block.branch || 'main') === branch) {
                    await BlockModel.delete(domainId, block.docId);
                }
            }
        }
    }

    async createItems(domainId: string, rpid: number, creates: any[], branch: string) {
        const placeholderMap: { [key: string]: number } = {};
        const docCreates = creates.filter(c => c.type === 'doc');
        let hasNewDocs = true;
        let round = 0;
        while (hasNewDocs && round < 10) {
            round++;
            hasNewDocs = false;
            for (const create of docCreates) {
                const placeholderId = (create as any).placeholderId;
                if (placeholderId && placeholderMap[placeholderId]) continue;
                const { title, parentDid, parentPlaceholderId } = create;
                if (!title || !title.trim()) continue;
                let actualParentDid: number | null = null;
                let canCreate = false;
                if (parentPlaceholderId) {
                    actualParentDid = placeholderMap[parentPlaceholderId];
                    canCreate = actualParentDid !== undefined;
                } else if (parentDid !== null && parentDid !== undefined) {
                    if (typeof parentDid === 'string') {
                        actualParentDid = placeholderMap[parentDid];
                        canCreate = actualParentDid !== undefined;
                    } else {
                        actualParentDid = parentDid;
                        canCreate = true;
                    }
                } else {
                    canCreate = true;
                }
                if (!canCreate) continue;
                const did = await DocModel.generateNextDid(domainId, rpid, branch);
                const docId = actualParentDid 
                    ? await DocModel.addSubdocNode(
                        domainId,
                        [rpid],
                        did,
                        actualParentDid,
                        this.user._id,
                        title.trim(),
                        '',
                        this.request.ip,
                        branch
                    )
                    : await DocModel.addRootNode(
                        domainId,
                        rpid,
                        did,
                        this.user._id,
                        title.trim(),
                        '',
                        this.request.ip,
                        branch
                    );
                if (placeholderId) {
                    placeholderMap[placeholderId] = did;
                }
                hasNewDocs = true;
            }
        }
        const blockCreates = creates.filter(c => c.type === 'block');
        for (const create of blockCreates) {
            const { title, parentDid, parentPlaceholderId } = create;
            if (!title || !title.trim()) continue;
            let actualParentDid: number | null = null;
            if (parentPlaceholderId) {
                actualParentDid = placeholderMap[parentPlaceholderId];
            } else if (parentDid !== null && parentDid !== undefined) {
                actualParentDid = typeof parentDid === 'string' ? placeholderMap[parentDid] : parentDid;
            }
            if (!actualParentDid) continue;
            await BlockModel.create(
                domainId,
                rpid,
                actualParentDid,
                this.user._id,
                title.trim(),
                '',
                this.request.ip,
                branch
            );
        }
    }

    async updateDocStructure(domainId: string, rpid: number, docs: any[], parentDid: number | null = null) {
        for (const docData of docs) {
            const { did, order, subDocs, blocks } = docData;

            // 更新文档的父节点和顺序
            const doc = await DocModel.get(domainId, { rpid, did });
            if (!doc) {
                
                continue;
            }

            

            const docIdentifier = (doc as any).docId ?? (doc as any)._id;
            if (!docIdentifier) {
                continue;
            }

            // 使用 DocumentModel.set 更新文档
            await DocumentModel.set(domainId, TYPE_DC, docIdentifier, {
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
                        
                        const blockIdentifier = (block as any).docId ?? (block as any)._id;
                        if (!blockIdentifier) {
                            continue;
                        }

                        await DocumentModel.set(domainId, TYPE_BK, blockIdentifier, {
                            did: did,  // 更新 block 的父文档 ID
                            order: blockOrder || 0,
                            updateAt: new Date()
                        });
                    } else {
                        
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
    @param('branch', Types.String, true)
    @param('did', Types.Int)
    async get(domainId: string, rpid: number, branch: string | undefined, did: number) {
        if (!branch) {
            const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
            const b = repo?.currentBranch || 'main';
            this.response.redirect = this.url('block_create_branch', { domainId, rpid, branch: b, did });
            return;
        }
        const ddoc = await DocModel.get(domainId, { rpid, did } as any);
        if (!ddoc) {
            throw new NotFoundError(`Doc not found`);
        }

        this.response.template = 'block_edit.html';
        this.response.body = {
            ddoc,
            rpid: ddoc.rpid,
            did: ddoc.did,
            branch: branch || (ddoc as any).branch || 'main',
        };
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    @param('did', Types.Int)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, rpid: number, did: number, title: string, content: string, branch?: string) {
        await this.limitRate('create_block', 3600, 100);
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        const effectiveBranch = branch || repo?.currentBranch || 'main';
        const docId = await BlockModel.create(
            domainId,
            rpid,
            did,
            this.user._id,
            title,
            content,
            this.request.ip,
            effectiveBranch
        );

        const block = await BlockModel.get(domainId, docId);
        this.response.body = { docId, bid: block?.bid };
        this.response.redirect = this.url('block_detail_branch', { rpid, branch: effectiveBranch, did, bid: block?.bid });
    }
}

export class BlockDetailHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    @param('did', Types.Int)
    @param('bid', Types.Int)
    async get(domainId: string, rpid: number, branch: string | undefined, did: number, bid: number) {
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError('Repo not found');
        if (!branch || !String(branch).trim()) {
            this.response.redirect = this.url('block_detail_branch', { domainId, rpid, branch: repo.currentBranch || 'main', did, bid });
            return;
        }
        const currentBranch = branch || 'main';
        const block = await BlockModel.get(domainId, { rpid, bid });
        if (!block) {
            throw new NotFoundError(`Block not found`);
        }
        await BlockModel.incrementViews(domainId, block.docId);
        const ddoc = await DocModel.get(domainId, { rpid, did } as any);
        const udoc = await UserModel.getById(domainId, block.owner);
        const repoDocs = (await EjunRepoModel.getDocsByRepo(domainId, rpid)).filter(d => (d.branch || 'main') === currentBranch);
        const allDocsWithBlocks = {};
        for (const doc of repoDocs) {
          const docBlocks = await BlockModel.getByDid(domainId, doc.did, rpid, currentBranch);
          if (docBlocks && docBlocks.length > 0) {
            allDocsWithBlocks[doc.did] = docBlocks.map(b => ({
              ...b,
              url: this.url('block_detail_branch', {
                domainId,
                rpid: rpid,
                branch: currentBranch,
                did: doc.did,
                bid: b.bid
              })
            }));
          }
        }
        const buildHierarchy = (parentId: number | null, docs: any[]) => {
          return docs
            .filter(doc => doc.parentId === parentId)
            .map(doc => ({
              ...doc,
              url: this.url('doc_detail_branch', {
                domainId,
                rpid: rpid,
                branch: currentBranch,
                did: doc.did
              }),
              subDocs: buildHierarchy(doc.did, docs)
            }));
        };
        const docHierarchy = {};
        docHierarchy[rpid] = buildHierarchy(null, repoDocs);
        this.UiContext.docHierarchy = docHierarchy;
        this.UiContext.allDocsWithBlocks = allDocsWithBlocks;
        this.UiContext.repo = { domainId, rpid, currentBranch };
        this.UiContext.ddoc = ddoc;
        this.UiContext.block = block;
        this.response.template = 'block_detail.html';
        this.response.pjax = 'block_detail.html';
        this.response.body = { block, ddoc, udoc, currentBranch };
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

// GitHub 同步工具
async function buildLocalRepoFromEjunz(domainId: string, rpid: number, targetDir: string, branch: string = 'main') {
    const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
    if (!repo) throw new Error(`Repo not found: rpid=${rpid}`);
    const docsAll = await EjunRepoModel.getDocsByRepo(domainId, rpid);
    const docs = docsAll.filter(d => (d.branch || 'main') === branch);

    // 为了安全与跨平台，文件名做基本清洗
    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';

    // 建立 did -> children 的映射
    const childrenMap = new Map<number|null, DCDoc[]>();
    for (const d of docs) {
        const key = (d.parentId ?? null) as number|null;
        if (!childrenMap.has(key)) childrenMap.set(key, []);
        childrenMap.get(key)!.push(d);
    }

    const docOrderValue = (doc: DCDoc) => doc.order ?? doc.did ?? 0;
    const blockOrderValue = (block: BKDoc) => block.order ?? block.bid ?? 0;

    const sortDocs = (list: DCDoc[]) =>
        list
            .slice()
            .sort((a, b) => {
                const orderA = docOrderValue(a);
                const orderB = docOrderValue(b);
                if (orderA !== orderB) return orderA - orderB;
                return (a.did || 0) - (b.did || 0);
            });

    const sortBlocks = (list: BKDoc[]) =>
        list
            .slice()
            .sort((a, b) => {
                const orderA = blockOrderValue(a);
                const orderB = blockOrderValue(b);
                if (orderA !== orderB) return orderA - orderB;
                return (a.bid || 0) - (b.bid || 0);
            });

    // 递归创建目录与 block 文件（名称包含编号）
    async function writeDocTree(parentId: number|null, parentPath: string) {
        const list = sortDocs(childrenMap.get(parentId) || []);
        for (const d of list) {
            const dirName = sanitize(d.title);
            const curDir = path.join(parentPath, dirName);
            await fs.promises.mkdir(curDir, { recursive: true });

            // 写入 doc 的 content 到该目录的 README.md
            if (d.content && d.content.trim()) {
                const readmePath = path.join(curDir, 'README.md');
                await fs.promises.writeFile(readmePath, d.content, 'utf8');
            }

            const blocksRaw = await BlockModel.getByDid(domainId, d.did, rpid, branch);
            const blocks = sortBlocks(blocksRaw || []);
            for (const b of blocks) {
                const fileName = `${sanitize(b.title)}.md`;
                const filePath = path.join(curDir, fileName);
                await fs.promises.writeFile(filePath, b.content ?? '', 'utf8');
            }

            // 若没有 blocks 且没有子文档，创建占位文件，避免空目录不被 git 跟踪
            const children = childrenMap.get(d.did) || [];
            if (blocks.length === 0 && children.length === 0) {
                const keepPath = path.join(curDir, '.keep');
                await fs.promises.writeFile(keepPath, '', 'utf8');
            }

            await writeDocTree(d.did, curDir);
        }
    }

    // 直接从仓库根开始写，不再建立 doc 根目录
    await writeDocTree(null, targetDir);

    // 写入 repo 的 content 到仓库根目录的 README.md
    await fs.promises.writeFile(
        path.join(targetDir, 'README.md'),
        repo.content || `# ${repo.title}\n\nThis repo is generated by ejunzrepo.`,
        'utf8'
    );
}

/**
 * 将源目录的内容复制到目标目录（覆盖），排除 .git 目录
 */
async function copyDir(src: string, dest: string) {
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        // 排除 .git 目录，避免覆盖 Git 历史
        if (entry.name === '.git') continue;
        
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await fs.promises.mkdir(destPath, { recursive: true });
            await copyDir(srcPath, destPath);
        } else {
            await fs.promises.copyFile(srcPath, destPath);
        }
    }
}

/**
 * Git 版本控制推送：先尝试克隆远程仓库，保留历史记录
 */
async function gitInitAndPush(
    sourceDir: string, 
    remoteUrlWithAuth: string, 
    branch: string = 'main', 
    commitMessage: string = 'chore: sync from ejunzrepo'
) {
    const tmpRepoDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-git-repo-'));
    let isNewRepo = false;
    
    try {
        // 尝试克隆远程仓库
        try {
            await exec(`git clone ${remoteUrlWithAuth} .`, { cwd: tmpRepoDir });
            // 获取所有远程分支
            try {
                await exec('git fetch origin', { cwd: tmpRepoDir });
            } catch {}
            
            // 检查目标分支是否存在（本地或远程）
            try {
                await exec(`git checkout ${branch}`, { cwd: tmpRepoDir });
            } catch {
                // 本地分支不存在，尝试从远程创建
                try {
                    await exec(`git checkout -b ${branch} origin/${branch}`, { cwd: tmpRepoDir });
                } catch {
                    // 远程分支也不存在，从当前分支（通常是 main 或 master）创建新分支
                    const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: tmpRepoDir });
                    const baseBranch = currentBranch.trim() || 'main';
                    await exec(`git checkout -b ${branch} ${baseBranch}`, { cwd: tmpRepoDir });
                }
            }
            // 拉取最新内容（如果分支已存在）
            try {
                await exec(`git pull origin ${branch}`, { cwd: tmpRepoDir });
            } catch {
                // 如果 pull 失败（可能是新分支），忽略
            }
        } catch {
            // 克隆失败，说明仓库不存在，初始化新仓库
            isNewRepo = true;
            await exec('git init', { cwd: tmpRepoDir });
            await exec(`git checkout -b ${branch}`, { cwd: tmpRepoDir });
        }
        
        // 配置 Git 用户信息
        await exec('git config user.name "ejunz-bot"', { cwd: tmpRepoDir });
        await exec('git config user.email "bot@ejunz.local"', { cwd: tmpRepoDir });
        
        // 将源目录的内容复制到仓库目录（覆盖）
        await copyDir(sourceDir, tmpRepoDir);
        
        // 添加所有变更
        await exec('git add .', { cwd: tmpRepoDir });
        
        // 检查是否有变更需要提交
        try {
            const { stdout } = await exec('git status --porcelain', { cwd: tmpRepoDir });
            if (stdout.trim()) {
                // 有变更，提交
                const escapedMessage = commitMessage.replace(/'/g, "'\\''");
                await exec(`git commit -m '${escapedMessage}'`, { cwd: tmpRepoDir });
            }
        } catch (err) {
            // 如果 status 失败，尝试直接提交
            const escapedMessage = commitMessage.replace(/'/g, "'\\''");
            try {
                await exec(`git commit -m '${escapedMessage}'`, { cwd: tmpRepoDir });
            } catch {
                // 没有变更，忽略
            }
        }
        
        // 设置远程仓库
        try { 
            await exec('git remote remove origin', { cwd: tmpRepoDir }); 
        } catch {}
        await exec(`git remote add origin ${remoteUrlWithAuth}`, { cwd: tmpRepoDir });
        
        // 推送：如果是新仓库或新分支，使用 -u；否则正常推送
        if (isNewRepo) {
            await exec(`git push -u origin ${branch}`, { cwd: tmpRepoDir });
        } else {
            try {
                await exec(`git push origin ${branch}`, { cwd: tmpRepoDir });
            } catch {
                // 如果推送失败（可能是分支不存在），使用 -u
                await exec(`git push -u origin ${branch}`, { cwd: tmpRepoDir });
            }
        }
    } finally {
        // 清理临时目录
        try { 
            await fs.promises.rm(tmpRepoDir, { recursive: true, force: true }); 
        } catch {}
    }
}

async function cloneRepoToTemp(remoteUrlWithAuth: string): Promise<string> {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-gh-'));
    await exec(`git clone ${remoteUrlWithAuth} .`, { cwd: tmp });
    return tmp;
}

async function importGitStructureToEjunz(domainId: string, rpid: number, localDir: string, userId: number, ip: string, branch: string = 'main') {
    // 直接从仓库根读取；没有专门的 doc 目录
    const exists = await fs.promises
        .stat(localDir)
        .then((s) => s.isDirectory())
        .catch(() => false);
    if (!exists) return;

    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim();

    // 读取仓库根目录的 README.md 更新 repo.content
    const repoReadmePath = path.join(localDir, 'README.md');
    try {
        const repoContent = await fs.promises.readFile(repoReadmePath, 'utf8');
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (repo) {
            await EjunRepoModel.edit(domainId, rpid, repo.title, repoContent);
        }
    } catch (err) {
        // README.md 不存在或读取失败，忽略
    }

    async function ensureDoc(parentDid: number|null, dirPath: string, dirName: string): Promise<number> {
        const title = sanitize(dirName) || 'untitled';
        let did: number;
        
        // 读取该目录下的 README.md 作为 doc.content
        const docReadmePath = path.join(dirPath, 'README.md');
        let docContent = '';
        try {
            docContent = await fs.promises.readFile(docReadmePath, 'utf8');
        } catch (err) {
            // README.md 不存在，使用空字符串
        }
        
        if (parentDid == null) {
            const newDid = await DocModel.generateNextDid(domainId, rpid, branch);
            const docId = await DocModel.addRootNode(domainId, rpid, newDid, userId, title, docContent, ip, branch);
            did = newDid;
        } else {
            const newDid = await DocModel.generateNextDid(domainId, rpid, branch);
            const docId = await DocModel.addSubdocNode(domainId, [rpid], newDid, parentDid, userId, title, docContent, ip, branch);
            did = newDid;
        }
        return did;
    }

    async function walk(parentDid: number|null, currentDir: string) {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        // 先处理 md 文件为 block（排除 README.md，因为它已经作为 doc.content）
        for (const e of entries) {
            if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') {
                if (parentDid == null) continue;
                const content = await fs.promises.readFile(path.join(currentDir, e.name), 'utf8');
                const nameWithout = e.name.replace(/\.md$/i, '');
                const title = sanitize(nameWithout) || 'untitled';
                await BlockModel.create(domainId, rpid, parentDid, userId, title, content, ip, branch);
            }
        }
        // 再处理子目录为子 doc
        for (const e of entries) {
            if (e.isDirectory()) {
                const childDirPath = path.join(currentDir, e.name);
                const childDid = await ensureDoc(parentDid, childDirPath, e.name);
                await walk(childDid, childDirPath);
            }
        }
    }

    // 仓库根下的每个目录（排除 .git 等）作为一个 root doc
    const top = await fs.promises.readdir(localDir, { withFileTypes: true });
    for (const d of top) {
        if (d.isDirectory() && d.name !== '.git') {
            const did = await ensureDoc(null, path.join(localDir, d.name), d.name);
            await walk(did, path.join(localDir, d.name));
        }
    }
}

async function cloneBranchData(domainId: string, rpid: number, sourceBranch: string, targetBranch: string, userId: number, ip: string) {
    if (sourceBranch === targetBranch) return;
    // 读取源分支的所有文档
    const allDocs = await EjunRepoModel.getDocsByRepo(domainId, rpid);
    const sourceDocs = allDocs.filter(d => (d.branch || 'main') === sourceBranch);
    if (sourceDocs.length === 0) return;

    // 旧 did -> 新 did
    const didMap = new Map<number, number>();

    // 按路径深度从浅到深，确保父先于子
    const sortedDocs = sourceDocs.slice().sort((a, b) => (a.path?.split('/').length || 1) - (b.path?.split('/').length || 1));

    for (const d of sortedDocs) {
        const isRoot = d.parentId == null;
        if (isRoot) {
            const newDid = await DocModel.generateNextDid(domainId, rpid, targetBranch);
            await DocModel.addRootNode(domainId, rpid, newDid, d.owner || userId, d.title, d.content || '', ip, targetBranch);
            didMap.set(d.did, newDid);
        } else {
            const parentNewDid = didMap.get(d.parentId!);
            if (parentNewDid == null) continue; // 父节点缺失，跳过
            const newDid = await DocModel.generateNextDid(domainId, rpid, targetBranch);
            await DocModel.addSubdocNode(domainId, [rpid], newDid, parentNewDid, d.owner || userId, d.title, d.content || '', ip, targetBranch);
            didMap.set(d.did, newDid);
        }

        // 复制该文档下的 blocks
        const blocks = await BlockModel.getByDid(domainId, d.did, rpid, sourceBranch);
        const newDid = didMap.get(d.did)!;
        for (const b of blocks) {
            await BlockModel.create(domainId, rpid, newDid, b.owner || userId, b.title, b.content || '', ip, targetBranch);
        }
    }
}
/**
 * 清空指定 repo+branch 的本地数据（docs 与 blocks）。
 */
async function clearRepoBranchData(domainId: string, rpid: number, branch: string) {
    // 删除 blocks
    const blocks = await DocumentModel.getMulti(domainId, TYPE_BK, { rpid, branch }).toArray();
    for (const b of blocks) {
        await DocumentModel.deleteOne(domainId, TYPE_BK, b.docId);
    }
    // 删除 docs
    const docs = await DocumentModel.getMulti(domainId, TYPE_DC, { rpid, branch }).toArray();
    for (const d of docs) {
        await DocumentModel.deleteOne(domainId, TYPE_DC, d.docId);
    }
}
// (deprecated old RepoGithubPushHandler removed)

/**
 * 为repo创建默认的MCP工具（查询、创建、编辑、删除）
 */
async function createDefaultRepoMcpTools(
    domainId: string,
    serverId: number,
    serverDocId: ObjectId,
    rpid: number,
    owner: number
): Promise<void> {
    const mcpToolModel = (global as any).Ejunz?.model?.mcpTool;
    if (!mcpToolModel) {
        console.error('MCP Tool Model not available');
        return;
    }

    const tools = [
        {
            name: `repo_${rpid}_query_doc`,
            description: `查询repo ${rpid}中的文档（doc）`,
            inputSchema: {
                type: 'object',
                properties: {
                    did: { type: 'number', description: '文档ID（可选，不提供则返回所有文档）' },
                    branch: { type: 'string', description: '分支名称（默认：main）', default: 'main' },
                },
            },
        },
        {
            name: `repo_${rpid}_create_doc`,
            description: `在repo ${rpid}中创建文档（doc）`,
            inputSchema: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: '文档标题' },
                    content: { type: 'string', description: '文档内容' },
                    parentId: { type: 'number', description: '父文档ID（可选，不提供则创建根文档）' },
                    branch: { type: 'string', description: '分支名称（默认：main）', default: 'main' },
                },
                required: ['title', 'content'],
            },
        },
        {
            name: `repo_${rpid}_edit_doc`,
            description: `编辑repo ${rpid}中的文档（doc）`,
            inputSchema: {
                type: 'object',
                properties: {
                    did: { type: 'number', description: '文档ID' },
                    title: { type: 'string', description: '文档标题（可选）' },
                    content: { type: 'string', description: '文档内容（可选）' },
                    branch: { type: 'string', description: '分支名称（默认：main）', default: 'main' },
                },
                required: ['did'],
            },
        },
        {
            name: `repo_${rpid}_delete_doc`,
            description: `删除repo ${rpid}中的文档（doc）`,
            inputSchema: {
                type: 'object',
                properties: {
                    did: { type: 'number', description: '文档ID' },
                    branch: { type: 'string', description: '分支名称（默认：main）', default: 'main' },
                },
                required: ['did'],
            },
        },
        {
            name: `repo_${rpid}_query_block`,
            description: `查询repo ${rpid}中的块（block）`,
            inputSchema: {
                type: 'object',
                properties: {
                    bid: { type: 'number', description: '块ID（可选，不提供则返回所有块）' },
                    did: { type: 'number', description: '文档ID（可选，用于过滤特定文档的块）' },
                    branch: { type: 'string', description: '分支名称（默认：main）', default: 'main' },
                },
            },
        },
        {
            name: `repo_${rpid}_create_block`,
            description: `在repo ${rpid}中创建块（block）`,
            inputSchema: {
                type: 'object',
                properties: {
                    did: { type: 'number', description: '所属文档ID' },
                    title: { type: 'string', description: '块标题' },
                    content: { type: 'string', description: '块内容' },
                    branch: { type: 'string', description: '分支名称（默认：main）', default: 'main' },
                },
                required: ['did', 'title', 'content'],
            },
        },
        {
            name: `repo_${rpid}_edit_block`,
            description: `编辑repo ${rpid}中的块（block）`,
            inputSchema: {
                type: 'object',
                properties: {
                    bid: { type: 'number', description: '块ID' },
                    title: { type: 'string', description: '块标题（可选）' },
                    content: { type: 'string', description: '块内容（可选）' },
                    branch: { type: 'string', description: '分支名称（默认：main）', default: 'main' },
                },
                required: ['bid'],
            },
        },
        {
            name: `repo_${rpid}_delete_block`,
            description: `删除repo ${rpid}中的块（block）`,
            inputSchema: {
                type: 'object',
                properties: {
                    bid: { type: 'number', description: '块ID' },
                    branch: { type: 'string', description: '分支名称（默认：main）', default: 'main' },
                },
                required: ['bid'],
            },
        },
    ];

    for (const tool of tools) {
        try {
            await mcpToolModel.add({
                domainId,
                serverId,
                serverDocId,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                owner,
            });
        } catch (err) {
            console.error(`Failed to create MCP tool ${tool.name}:`, err);
        }
    }
}

// Repo 配置 Handler
export class RepoConfigHandler extends Handler {
    @param('rpid', Types.Int)
    async get(domainId: string, rpid: number) {
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        
        // 获取repo的MCP工具列表
        let mcpTools: any[] = [];
        if (repo.mcpServerId) {
            try {
                const mcpModel = (global as any).Ejunz?.model?.mcpTool;
                if (mcpModel) {
                    mcpTools = await mcpModel.getByServer(domainId, repo.mcpServerId);
                }
            } catch (error: any) {
                console.error('Failed to load MCP tools:', error);
            }
        }
        
        this.response.template = 'repo_config.html';
        this.response.body = { repo, mcpTools };
    }

    @param('rpid', Types.Int)
    @param('githubRepo', Types.String, true)
    async post(domainId: string, rpid: number, githubRepo?: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        await DocumentModel.set(domainId, TYPE_RP, repo.docId, {
            githubRepo: githubRepo || ''
        });
        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch: repo.currentBranch || 'main' });
    }
}

// PR/Push：将 ejunzrepo 结构推送到指定 GitHub 仓库
export class RepoGithubPushHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, branch?: string) {
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        
        // 从 system 配置读取 GitHub token（优先域配置，再回落系统配置）
        const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
        const systemValue = SystemModel.get('ejunzrepo.github_token');
        const GH_TOKEN = settingValue || systemValue || '';
        if (!GH_TOKEN) {
            throw new Error('GitHub token not configured. Please configure it in system settings.');
        }
        
        // 从 repo 配置读取仓库地址
        const githubRepo = repo.githubRepo || '';
        if (!githubRepo) {
            throw new Error('GitHub repository not configured. Please configure it in repo settings.');
        }
        
        // 将 SSH 格式转换为 HTTPS 格式（如果提供的是 SSH 格式）
        let REPO_HTTPS = githubRepo;
        if (githubRepo.startsWith('git@github.com:')) {
            const repoPath = githubRepo.replace('git@github.com:', '').replace('.git', '');
            REPO_HTTPS = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
        } else if (!githubRepo.includes('@')) {
            // 如果没有协议，假设是 user/repo 格式
            const repoPath = githubRepo.replace('.git', '');
            REPO_HTTPS = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
        }
        
        const effectiveBranch = (branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        // 构建 commit message：默认包含 domainId + userId + username，用户可添加备注
        const userNote = (this.request.body?.note || '').toString().trim();
        const defaultMessage = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const commitMessage = userNote ? `${defaultMessage}: ${userNote}` : defaultMessage;

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-push-'));
        try {
            await buildLocalRepoFromEjunz(domainId, rpid, tmpDir, effectiveBranch);
            await gitInitAndPush(tmpDir, REPO_HTTPS, effectiveBranch, commitMessage);
            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Push failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        } finally {
            try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
        }
        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch: effectiveBranch });
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid: number, branch?: string) {
        return this.post(domainId, rpid, branch);
    }
}

// Pull：从 GitHub 仓库拉取并在 ejunz 中创建结构
export class RepoGithubPullHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, branch?: string) {
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) {
            throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        }
        const GH_TOKEN = this.ctx.setting.get('ejunzrepo.github_token') || '';
        if (!GH_TOKEN) {
            throw new Error('GitHub token not configured. Please configure it in system settings.');
        }
        const githubRepo = repo.githubRepo || '';
        if (!githubRepo) {
            throw new Error('GitHub repository not configured. Please configure it in repo settings.');
        }
        let REPO_HTTPS = githubRepo;
        if (githubRepo.startsWith('git@github.com:')) {
            const repoPath = githubRepo.replace('git@github.com:', '').replace('.git', '');
            REPO_HTTPS = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
        } else if (!githubRepo.includes('@')) {
            const repoPath = githubRepo.replace('.git', '');
            REPO_HTTPS = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
        }
        const effectiveBranch = (branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-pull-'));
        try {
            await exec('git init', { cwd: tmpDir });
            try { await exec('git remote remove origin', { cwd: tmpDir }); } catch {}
            await exec(`git remote add origin ${REPO_HTTPS}`, { cwd: tmpDir });
            await exec(`git fetch --depth=1 origin ${effectiveBranch}`, { cwd: tmpDir });
            await exec(`git checkout -B ${effectiveBranch} origin/${effectiveBranch}`, { cwd: tmpDir });

            // 先清空本地该分支的数据，以正确反映远端的删除
            await clearRepoBranchData(domainId, rpid, effectiveBranch);
            await importGitStructureToEjunz(domainId, rpid, tmpDir, this.user._id, this.request.ip, effectiveBranch);
            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Pull failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        } finally {
            try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
        }
        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch: effectiveBranch });
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid: number, branch?: string) {
        return this.post(domainId, rpid, branch);
    }
}

// 分支管理：创建与切换
export class RepoBranchCreateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String)
    async post(domainId: string, rpid: number, branch: string) {
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        const branches = Array.isArray(repo.branches) ? repo.branches.slice() : [];
        const newBranch = (branch || '').trim() || 'main';
        if (!branches.includes(newBranch)) branches.push(newBranch);
        await DocumentModel.set(domainId, TYPE_RP, repo.docId, { branches, currentBranch: newBranch });

        const sourceBranch = repo.currentBranch || 'main';
        try {
            await cloneBranchData(domainId, rpid, sourceBranch, newBranch, this.user._id, this.request.ip);
        } catch (e) {
            console.error('cloneBranchData failed:', e);
        }

        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch: newBranch });
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String)
    async get(domainId: string, rpid: number, branch: string) { return this.post(domainId, rpid, branch); }
}

export class RepoBranchSwitchHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String)
    async post(domainId: string, rpid: number, branch: string) {
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        await DocumentModel.set(domainId, TYPE_RP, repo.docId, { currentBranch: branch });
        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch });
    }

    @param('rpid', Types.Int)
    @param('branch', Types.String)
    async get(domainId: string, rpid: number, branch: string) { return this.post(domainId, rpid, branch); }
}

// 模式切换 Handler
export class RepoModeSwitchHandler extends Handler {
    @param('rpid', Types.Int)
    @param('mode', Types.String)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, mode: string, branch?: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        
        const validMode = (mode === 'file' || mode === 'manuscript') ? mode : 'file';
        await DocumentModel.set(domainId, TYPE_RP, repo.docId, { mode: validMode });
        
        const targetBranch = branch || repo.currentBranch || 'main';
        this.response.redirect = this.url('repo_detail_branch', { domainId, rpid, branch: targetBranch });
    }

    @param('rpid', Types.Int)
    @param('mode', Types.String)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid: number, mode: string, branch?: string) {
        return this.post(domainId, rpid, mode, branch);
    }
}

// 文稿模式批量更新 Handler
export class RepoManuscriptBatchUpdateHandler extends Handler {
    @param('rpid', Types.Int)
    @param('branch', Types.String, true)
    async post(domainId: string, rpid: number, branch?: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const repo = await EjunRepoModel.getRepoByRpid(domainId, rpid);
        if (!repo) throw new NotFoundError(`Repo with rpid ${rpid} not found.`);
        
        const effectiveBranch = branch || repo.currentBranch || 'main';
        const { updates, creates, deletes } = this.request.body;
        
        try {
            // 处理删除
            if (deletes && Array.isArray(deletes) && deletes.length > 0) {
                for (const deleteItem of deletes) {
                    const { type, did, bid } = deleteItem;
                    
                    if (type === 'doc' && did) {
                        const doc = await DocModel.get(domainId, { rpid, did });
                        if (doc && (doc.branch || 'main') === effectiveBranch) {
                            await DocModel.deleteNode(domainId, doc.docId);
                        }
                    } else if (type === 'block' && bid) {
                        const block = await BlockModel.get(domainId, { rpid, bid });
                        if (block && (block.branch || 'main') === effectiveBranch) {
                            await BlockModel.delete(domainId, block.docId);
                        }
                    }
                }
            }
            
            // 处理更新
            if (updates && Array.isArray(updates)) {
                for (const update of updates) {
                    const { type, did, bid, title, content } = update;
                    
                    if (type === 'doc' && did) {
                        const doc = await DocModel.get(domainId, { rpid, did });
                        if (doc && (doc.branch || 'main') === effectiveBranch) {
                            await DocModel.edit(domainId, doc.docId, title || doc.title, content !== undefined ? content : doc.content);
                        }
                    } else if (type === 'block' && bid) {
                        const block = await BlockModel.get(domainId, { rpid, bid });
                        if (block && (block.branch || 'main') === effectiveBranch) {
                            await BlockModel.edit(domainId, block.docId, title || block.title, content !== undefined ? content : block.content);
                        }
                    }
                }
            }
            
            // 处理创建
            if (creates && Array.isArray(creates)) {
                for (const create of creates) {
                    const { type, parentDid, title, content, position } = create;
                    
                    if (type === 'doc') {
                        const did = await DocModel.generateNextDid(domainId, rpid, effectiveBranch);
                        if (parentDid) {
                            await DocModel.addSubdocNode(
                                domainId,
                                [rpid],
                                did,
                                parentDid,
                                this.user._id,
                                title || 'Untitled',
                                content || '',
                                this.request.ip,
                                effectiveBranch
                            );
                        } else {
                            await DocModel.addRootNode(
                                domainId,
                                rpid,
                                did,
                                this.user._id,
                                title || 'Untitled',
                                content || '',
                                this.request.ip,
                                effectiveBranch
                            );
                        }
                    } else if (type === 'block' && parentDid) {
                        await BlockModel.create(
                            domainId,
                            rpid,
                            parentDid,
                            this.user._id,
                            title || 'Untitled',
                            content || '',
                            this.request.ip,
                            effectiveBranch
                        );
                    }
                }
            }
            
            const structure = this.request.body?.structure;
            if (structure) {
                await this.applyStructureUpdates(domainId, rpid, effectiveBranch, structure);
            }
            
            this.response.body = { success: true, branch: effectiveBranch };
        } catch (error: any) {
            console.error(`Failed to batch update manuscript: ${error.message}`);
            this.response.status = 500;
            this.response.body = { success: false, error: error.message };
        }
    }

    private async applyStructureUpdates(domainId: string, rpid: number, branch: string, structure: any) {
        const docEntries = Array.isArray(structure?.docs) ? structure.docs : [];
        const blockEntries = Array.isArray(structure?.blocks) ? structure.blocks : [];

        const docCache = new Map<number, string>();

        const sortedDocs = docEntries
            .filter((entry: any) => entry && typeof entry.did === 'number')
            .sort((a: any, b: any) => {
                const levelA = typeof a.level === 'number' ? a.level : Number(a.level) || 0;
                const levelB = typeof b.level === 'number' ? b.level : Number(b.level) || 0;
                if (levelA !== levelB) return levelA - levelB;
                const orderA = typeof a.order === 'number' ? a.order : Number(a.order) || 0;
                const orderB = typeof b.order === 'number' ? b.order : Number(b.order) || 0;
                if (orderA !== orderB) return orderA - orderB;
                return a.did - b.did;
            });

        for (const entry of sortedDocs) {
            const did = entry.did as number;
            const doc = await DocModel.get(domainId, { rpid, did } as any);
            if (!doc || (doc.branch || 'main') !== branch) continue;

            const parentDidValue = typeof entry.parentDid === 'number'
                ? entry.parentDid
                : (entry.parentDid === null ? null : undefined);

            let parentPath = '';
            if (typeof parentDidValue === 'number') {
                if (docCache.has(parentDidValue)) {
                    parentPath = docCache.get(parentDidValue)!;
                } else {
                    const parentDoc = await DocModel.get(domainId, { rpid, did: parentDidValue } as any);
                    if (parentDoc && (parentDoc.branch || 'main') === branch) {
                        parentPath = parentDoc.path || '';
                        docCache.set(parentDidValue, parentPath);
                    } else {
                        parentPath = '';
                    }
                }
            }

            const newPath = parentPath ? `${parentPath}/${did}` : `/${did}`;
            const updatePayload: any = {
                parentId: typeof parentDidValue === 'number' ? parentDidValue : null,
                order: typeof entry.order === 'number' ? entry.order : Number(entry.order) || 0,
                path: newPath,
            };

            await DocumentModel.set(domainId, TYPE_DC, doc.docId, updatePayload);
            docCache.set(did, newPath);
        }

        for (const entry of blockEntries) {
            if (!entry || typeof entry.bid !== 'number') continue;
            const block = await BlockModel.get(domainId, { rpid, bid: entry.bid });
            if (!block || (block.branch || 'main') !== branch) continue;

            const parentDid = typeof entry.parentDid === 'number' ? entry.parentDid : null;
            if (parentDid === null) continue;

            await DocumentModel.set(domainId, TYPE_BK, block.docId, {
                did: parentDid,
                order: typeof entry.order === 'number' ? entry.order : Number(entry.order) || 0,
            });
        }
    }
}

export async function apply(ctx: Context) {
    const customChecker = (handler) => {
        // 获取允许的域列表
        const allowedDomains = handler.ctx.setting.get('ejunzrepo.allowed_domains');
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

    // 注册 GitHub token 系统配置（通过 ctx.setting，避免重复，写入系统 config）
    if (!EJUNZREPO_SETTINGS_REGISTERED) {
        ctx.setting.SystemSetting(
            SettingModel.Setting('ejunzrepo', 'ejunzrepo.github_token', '', 'password', 'GitHub Token', 'GitHub Personal Access Token for repository sync'),
        );
        EJUNZREPO_SETTINGS_REGISTERED = true;
    }

    ctx.Route('base_domain', '/base', BaseDomainHandler);
    ctx.Route('base_edit', '/base/:docId/edit', BaseEditHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('base_create', '/base/create', BaseEditHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_create', '/base/repo/create', RepoEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('repo_detail', '/base/repo/:rpid', RepoDetailHandler);
    ctx.Route('repo_detail_branch', '/base/repo/:rpid/branch/:branch', RepoDetailHandler);
    ctx.Route('repo_structure_update', '/base/repo/:rpid/update_structure', RepoStructureUpdateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_edit', '/base/repo/:rpid/edit', RepoEditHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_config', '/base/repo/:rpid/config', RepoConfigHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('doc_create', '/base/repo/:rpid/doc/create', DocCreateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('doc_create_branch', '/base/repo/:rpid/branch/:branch/doc/create', DocCreateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('doc_create_subdoc', '/base/repo/:rpid/doc/:parentId/createsubdoc', DocCreateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('doc_create_subdoc_branch', '/base/repo/:rpid/branch/:branch/doc/:parentId/createsubdoc', DocCreateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('doc_detail', '/base/repo/:rpid/doc/:did', DocDetailHandler);
    ctx.Route('doc_detail_branch', '/base/repo/:rpid/branch/:branch/doc/:did', DocDetailHandler);
    ctx.Route('doc_edit', '/base/repo/:rpid/doc/:docId/editdoc', DocEditHandler, PERM.PERM_VIEW_BASE);
    // Added: GitHub同步
    ctx.Route('repo_github_push', '/base/repo/:rpid/github/push', RepoGithubPushHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_github_push_branch', '/base/repo/:rpid/branch/:branch/github/push', RepoGithubPushHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_github_pull', '/base/repo/:rpid/github/pull', RepoGithubPullHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_github_pull_branch', '/base/repo/:rpid/branch/:branch/github/pull', RepoGithubPullHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_branch_create', '/base/repo/:rpid/branch/create', RepoBranchCreateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_branch_create_with_param', '/base/repo/:rpid/branch/:branch/create', RepoBranchCreateHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_branch_switch', '/base/repo/:rpid/branch/switch', RepoBranchSwitchHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_mode_switch', '/base/repo/:rpid/mode/:mode', RepoModeSwitchHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_mode_switch_branch', '/base/repo/:rpid/branch/:branch/mode/:mode', RepoModeSwitchHandler, PERM.PERM_VIEW_BASE);
    ctx.Route('repo_manuscript_batch_update', '/base/repo/:rpid/branch/:branch/manuscript/batch-update', RepoManuscriptBatchUpdateHandler, PERM.PERM_VIEW_BASE);
    // Removed: doc_resource_edit - resource management removed from doc
    // Block routes
    ctx.Route('block_create', '/base/repo/:rpid/doc/:did/block/create', BlockCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('block_create_branch', '/base/repo/:rpid/branch/:branch/doc/:did/block/create', BlockCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('block_detail', '/base/repo/:rpid/doc/:did/block/:bid', BlockDetailHandler);
    ctx.Route('block_detail_branch', '/base/repo/:rpid/branch/:branch/doc/:did/block/:bid', BlockDetailHandler);
    ctx.Route('block_edit', '/base/repo/:rpid/doc/:did/block/:bid/edit', BlockEditHandler, PRIV.PRIV_USER_PROFILE);
}
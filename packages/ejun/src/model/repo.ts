import { _, ObjectId, Filter } from '../libs';
import * as document from './document';
import { buildProjection } from '../utils';
import type { Context } from '../context';
import type { BSDoc, RPDoc, DCDoc, BKDoc } from '../interface';

export const TYPE_BS: 30 = 30;
export const TYPE_RP: 31 = 31;
export const TYPE_DC: 32 = 32;
export const TYPE_BK: 33 = 33;

export class BaseModel {
    /**
     * 获取指定 domainId 的 Base
     */
    static async getBase(domainId: string): Promise<BSDoc | null> {
        // document.getMulti 已经自动包含 domainId，所以不需要在 query 中再次指定
        const results = await document.getMulti(domainId, TYPE_BS, {}).limit(1).toArray();
        return results.length ? results[0] : null;
    }
    

    /**
     * 创建 Base（每个 domain 只能有一个 Base）
     */
    static async createBase(domainId: string, owner: number, title: string, content: string): Promise<ObjectId> {
        const repos = await RepoModel.getAllRepos(domainId);
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

        return await document.add(
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
     * 更新 Base 的 title 和 content
     */
    static async updateBase(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        const base = await this.getBase(domainId);
    
        if (!base) {
            throw new Error(`Base not found for domain: ${domainId}`);
        }
    
        await document.set(domainId, TYPE_BS, docId, {
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
    
        await document.set(domainId, TYPE_BS, base.docId, {
            rpids: base.rpids
        });
    }
}

export class RepoModel {
    static async generateNextRpid(domainId: string): Promise<number> {
        const lastRepo = await document.getMulti(domainId, TYPE_RP, {}) 
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
    
        const docId = await document.add(
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
        const repoDoc = await this.getRepoByRpid(domainId, rpid);
        if (!repoDoc) {
            throw new Error(`Repo with rpid ${rpid} not found in domain ${domainId}`);
        }
    
        await document.set(domainId, TYPE_RP, repoDoc.docId, {
            title,
            content: content || '',   
        });
    }

    static async deleteRepo(domainId: string, rpid: number): Promise<void> {
        const repoDoc = await this.getRepoByRpid(domainId, rpid);
        if (!repoDoc) {
            throw new Error(`Repo with rpid ${rpid} not found in domain ${domainId}`);
        }
        await document.deleteOne(domainId, TYPE_RP, repoDoc.docId);
    }
    

    static async getRepo(domainId: string, docId: ObjectId): Promise<RPDoc | null> {
        return await document.get(domainId, TYPE_RP, docId);
    }
    static async getRepoByRpid(domainId: string, rpid: number): Promise<RPDoc | null> {
        const result = await document.getMulti(domainId, TYPE_RP, { rpid }).limit(1).toArray();
        return result.length > 0 ? result[0] : null;  
    }
    

    static async getAllRepos(domainId: string): Promise<RPDoc[]> {
        const repos = await document.getMulti(domainId, TYPE_RP, {}).toArray();
        return repos;
    }
    static async getDocsByRepo(domainId: string, rpid: number): Promise<DCDoc[]> {
        // MongoDB 中 { rpid: number } 可以匹配数组中包含该数字的文档
        // 但为了确保兼容性，我们也查询数组格式
        const docs = await document.getMulti(domainId, TYPE_DC, { rpid }).toArray();
        // 标准化 rpid 为数字（如果是数组，取第一个）
        return docs.map(doc => {
            if (Array.isArray(doc.rpid)) {
                doc.rpid = doc.rpid[0];
            }
            return doc;
        });
    }
}

export class DocModel {
    static async generateNextDid(domainId: string, rpid: number, branch: string = 'main'): Promise<number> {
        const lastDoc = await document.getMulti(domainId, TYPE_DC, { rpid, branch })
            .sort({ did: -1 })
            .limit(1)
            .project({ did: 1 })
            .toArray();
        return (lastDoc[0]?.did || 0) + 1;
    }

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
            parentId: null,
            branch,
        };

        const docId = await document.add(
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
        const parentNode = await document.getMulti(domainId, TYPE_DC, { did: parentDcid })
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
            rpid: rpid as any, // 保持与 ejunzrepo 一致，存储数组格式（虽然接口定义为 number，但实际存储为数组）
            did: newDid,
            parentId: parentDcid,
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

        const docId = await document.add(
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
        if (typeof query === 'object' && 'did' in query) {
            const docs = await document.getMulti(domainId, TYPE_DC, query).limit(1).toArray();
            const doc = docs[0] || null;
            // 标准化 rpid 为数字（如果是数组，取第一个）
            if (doc && Array.isArray(doc.rpid)) {
                doc.rpid = doc.rpid[0];
            }
            return doc;
        }
        return await document.get(domainId, TYPE_DC, query as ObjectId);
    }

    static async getChildren(domainId: string, parentId: number, branch?: string): Promise<DCDoc[]> {
        const query: any = { parentId };
        if (branch) query.branch = branch;
        return await document.getMulti(domainId, TYPE_DC, query).toArray();
    }

    static async getDoc(domainId: string, query: Partial<DCDoc>) {
        return document.getMulti(domainId, TYPE_DC, query);
    }

    static async deleteNode(domainId: string, docId: ObjectId): Promise<void> {
        const node = await this.get(domainId, docId);
        if (!node) throw new Error('Node not found.');

        const descendants = await document.getMulti(domainId, TYPE_DC, {
            path: { $regex: `^${node.path}` },
        }).toArray();

        const docIds = descendants.map((n) => n.docId);
        await Promise.all(docIds.map((id) => document.deleteOne(domainId, TYPE_DC, id)));
    }

    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await document.inc(domainId, TYPE_DC, docId, 'views', 1);
    }

    static async edit(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        await document.set(domainId, TYPE_DC, docId, { 
            title, 
            content,
            updateAt: new Date()
        });
    }

    static async getDocsByIds(domainId: string, dids: number[]) {
        return await document.getMulti(domainId, TYPE_DC, { did: { $in: dids } }).toArray();
    }
    static async getDocs(domainId: string, query: Filter<DCDoc>) {
        return document.getMulti(domainId, TYPE_DC, query);
    }
}

export class BlockModel {
    static async generateNextBid(domainId: string, rpid: number, branch: string = 'main'): Promise<number> {
        const lastBlock = await document.getMulti(domainId, TYPE_BK, { rpid, branch })
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

        const docId = await document.add(
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
        if (typeof query === 'object' && 'bid' in query) {
            const blocks = await document.getMulti(domainId, TYPE_BK, query).limit(1).toArray();
            const block = blocks[0] || null;
            // 标准化 rpid 为数字（如果是数组，取第一个）
            if (block && Array.isArray(block.rpid)) {
                block.rpid = block.rpid[0];
            }
            return block;
        }
        return await document.get(domainId, TYPE_BK, query as ObjectId);
    }

    static async getByDid(domainId: string, did: number, rpid?: number, branch?: string): Promise<BKDoc[]> {
        const query: any = { did };
        if (rpid !== undefined) query.rpid = rpid;
        if (branch !== undefined) query.branch = branch;
        const blocks = await document.getMulti(domainId, TYPE_BK, query).toArray();
        // 标准化 rpid 为数字（如果是数组，取第一个）
        return blocks.map(block => {
            if (Array.isArray(block.rpid)) {
                block.rpid = block.rpid[0];
            }
            return block;
        });
    }

    static async edit(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        await document.set(domainId, TYPE_BK, docId, { 
            title, 
            content,
            updateAt: new Date()
        });
    }

    static async delete(domainId: string, docId: ObjectId): Promise<void> {
        await document.deleteOne(domainId, TYPE_BK, docId);
    }

    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await document.inc(domainId, TYPE_BK, docId, 'views', 1);
    }
}

export function apply(ctx: Context) {}

// @ts-ignore
global.Ejunz.model.bs = BaseModel;
// @ts-ignore
global.Ejunz.model.rp = RepoModel;
// @ts-ignore
global.Ejunz.model.dc = DocModel;
// @ts-ignore
global.Ejunz.model.bk = BlockModel;
export default { BaseModel, RepoModel, DocModel, BlockModel };


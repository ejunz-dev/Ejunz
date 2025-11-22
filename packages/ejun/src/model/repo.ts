import { _, ObjectId, Filter } from '../libs';
import * as document from './document';
import { buildProjection } from '../utils';
import type { Context } from '../context';
import type { BSDoc, RPDoc, DCDoc, BKDoc } from '../interface';
import db from '../service/db';
import { Collection } from 'mongodb';

export const TYPE_BS: 30 = 30;
export const TYPE_RP: 31 = 31;
export const TYPE_DC: 32 = 32;
export const TYPE_BK: 33 = 33;

/**
 * Keyword index document structure
 */
export interface RepoKeywordIndexDoc {
    _id?: ObjectId;
    domainId: string;
    rpid: number;
    branch: string;
    keyword: string; // keyword (lowercase)
    type: 'doc' | 'block'; // document type
    targetId: number; // did or bid
    targetDocId: ObjectId; // document docId
    title: string; // title (for display)
    contentSnippet: string; // content snippet (for context display)
    position: number; // keyword position in content (character offset)
    weight: number; // weight (keywords in title have higher weight)
    updatedAt: Date;
}

/**
 * Keyword index collection
 */
export const collKeywordIndex: Collection<RepoKeywordIndexDoc> = (db as any).collection('repo.keyword_index');

export class BaseModel {
    /**
     * Get Base for specified domainId
     */
    static async getBase(domainId: string): Promise<BSDoc | null> {
        const results = await document.getMulti(domainId, TYPE_BS, {}).limit(1).toArray();
        return results.length ? results[0] : null;
    }
    

    /**
     * Create Base (each domain can only have one Base)
     */
    static async createBase(domainId: string, owner: number, title: string, content: string): Promise<ObjectId> {
        const repos = await RepoModel.getAllRepos(domainId);
        const repoIds = repos.map(repo => repo.rpid);

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
     * Update Base title and content
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
            content: content || '',
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
        const docs = await document.getMulti(domainId, TYPE_DC, { rpid }).toArray();
        return docs.map(doc => {
            if (Array.isArray(doc.rpid)) {
                doc.rpid = doc.rpid[0];
            }
            return doc;
        });
    }
}

export class DocModel {
    // 不再使用did，直接使用docId（ObjectId）作为标识
    static async addRootNode(
        domainId: string,
        rpid: number | string,
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

        const payload: Partial<DCDoc> = {
            domainId,
            rpid: parsedRpid,
            title,
            content,
            owner,
            ip,
            updateAt: new Date(),
            views: 0,
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

        await RepoKeywordIndexModel.indexContent(
            domainId,
            parsedRpid,
            branch,
            'doc',
            docId.toString(), // 使用docId作为标识
            docId,
            title,
            content
        ).catch(err => console.error('Failed to update keyword index:', err));

        return docId;
    }

    static async get(domainId: string, query: ObjectId): Promise<DCDoc | null> {
        // 现在只支持通过docId（ObjectId）查询
        const doc = await document.get(domainId, TYPE_DC, query);
        if (doc && Array.isArray(doc.rpid)) {
            doc.rpid = doc.rpid[0];
        }
        return doc;
    }

    static async getByRepo(domainId: string, rpid: number, branch?: string): Promise<DCDoc[]> {
        // 获取repo下的所有doc
        const query: any = { rpid };
        if (branch) query.branch = branch;
        const docs = await document.getMulti(domainId, TYPE_DC, query).toArray();
        return docs.map(doc => {
            if (Array.isArray(doc.rpid)) {
                doc.rpid = doc.rpid[0];
            }
            return doc;
        });
    }

    static async getDoc(domainId: string, query: Partial<DCDoc>) {
        return document.getMulti(domainId, TYPE_DC, query);
    }

    static async deleteNode(domainId: string, docId: ObjectId): Promise<void> {
        const node = await this.get(domainId, docId);
        if (!node) throw new Error('Node not found.');

        // 删除该doc下的所有block（block的did字段指向doc的docId）
        const blocks = await BlockModel.getByDocId(domainId, docId, node.branch);
        
        // 删除所有block
        for (const block of blocks) {
            await BlockModel.delete(domainId, block.docId);
        }

        // 删除doc本身
        await document.deleteOne(domainId, document.TYPE_DOC, docId);
        
        const rpidNum = Array.isArray(node.rpid) ? node.rpid[0] : node.rpid;
        await RepoKeywordIndexModel.removeIndex(
            domainId,
            rpidNum,
            node.branch || 'main',
            'doc',
            docId.toString() // 使用docId作为标识
        ).catch(err => console.error('Failed to remove keyword index:', err));
    }

    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await document.inc(domainId, TYPE_DC, docId, 'views', 1);
    }

    static async edit(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        const doc = await this.get(domainId, docId);
        if (!doc) throw new Error('Document not found');
        
        await document.set(domainId, TYPE_DC, docId, { 
            title, 
            content,
            updateAt: new Date()
        });
        
        const rpidNum = Array.isArray(doc.rpid) ? doc.rpid[0] : doc.rpid;
        await RepoKeywordIndexModel.indexContent(
            domainId,
            rpidNum,
            doc.branch || 'main',
            'doc',
            doc.did,
            docId,
            title,
            content
        ).catch(err => console.error('Failed to update keyword index:', err));
    }

    static async getDocsByIds(domainId: string, dids: number[]) {
        return await document.getMulti(domainId, TYPE_DC, { did: { $in: dids } }).toArray();
    }
    static async getDocs(domainId: string, query: Filter<DCDoc>) {
        return document.getMulti(domainId, TYPE_DC, query);
    }
}

/**
 * Keyword index model
 * For fast keyword search in repo
 */
export class RepoKeywordIndexModel {
    /**
     * Simple tokenization function (supports Chinese and English)
     * For Chinese: split by character; For English: split by word
     */
    private static tokenize(text: string): string[] {
        if (!text) return [];
        const tokens: string[] = [];
        const lowerText = text.toLowerCase();
        
        const regex = /[\u4e00-\u9fa5]|[a-zA-Z0-9]+/g;
        let match;
        while ((match = regex.exec(lowerText)) !== null) {
            tokens.push(match[0]);
        }
        
        const subTokens = new Set<string>();
        tokens.forEach(token => {
            if (token.length > 1) {
                for (let i = 0; i < token.length; i++) {
                    for (let j = i + 1; j <= token.length; j++) {
                        subTokens.add(token.substring(i, j));
                    }
                }
            }
        });
        
        return Array.from(new Set([...tokens, ...subTokens]));
    }

    /**
     * Extract keywords and build index
     */
    static async indexContent(
        domainId: string,
        rpid: number,
        branch: string,
        type: 'doc' | 'block',
        targetId: number,
        targetDocId: ObjectId,
        title: string,
        content: string
    ): Promise<void> {
        await this.removeIndex(domainId, rpid, branch, type, targetId);
        
        if (!title && !content) return;
        
        const fullText = `${title} ${content}`;
        const tokens = this.tokenize(fullText);
        
        const titleTokens = this.tokenize(title);
        const titleTokenSet = new Set(titleTokens);
        
        const indexDocs: Omit<RepoKeywordIndexDoc, '_id'>[] = [];
        const seen = new Set<string>();
        
        for (const token of tokens) {
            if (token.length < 2) continue;
            if (seen.has(token)) continue;
            seen.add(token);
            
            const weight = titleTokenSet.has(token) ? 2 : 1;
            
            const position = content.toLowerCase().indexOf(token);
            const contentSnippet = position >= 0 
                ? content.substring(Math.max(0, position - 20), Math.min(content.length, position + 50))
                : '';
            
            indexDocs.push({
                domainId,
                rpid,
                branch,
                keyword: token,
                type,
                targetId,
                targetDocId,
                title,
                contentSnippet,
                position: position >= 0 ? position : 0,
                weight,
                updatedAt: new Date(),
            });
        }
        
        if (indexDocs.length > 0) {
            await collKeywordIndex.insertMany(indexDocs);
        }
    }

    /**
     * Remove index
     */
    static async removeIndex(
        domainId: string,
        rpid: number,
        branch: string,
        type: 'doc' | 'block',
        targetId: number
    ): Promise<void> {
        await collKeywordIndex.deleteMany({
            domainId,
            rpid,
            branch,
            type,
            targetId,
        });
    }

    /**
     * Search keywords
     */
    static async search(
        domainId: string,
        rpid: number,
        branch: string,
        keywords: string,
        type?: 'doc' | 'block',
        limit: number = 50,
        skip: number = 0
    ): Promise<{
        results: Array<{
            type: 'doc' | 'block';
            targetId: number;
            targetDocId: ObjectId;
            title: string;
            contentSnippet: string;
            score: number;
            matchedKeywords: string[];
        }>;
        total: number;
    }> {
        const searchTokens = this.tokenize(keywords);
        if (searchTokens.length === 0) {
            return { results: [], total: 0 };
        }
        
        const query: any = {
            domainId,
            rpid,
            branch,
            keyword: { $in: searchTokens },
        };
        
        if (type) {
            query.type = type;
        }
        
        const indexEntries = await collKeywordIndex.find(query).toArray();
        
        const resultMap = new Map<string, {
            type: 'doc' | 'block';
            targetId: number;
            targetDocId: ObjectId;
            title: string;
            contentSnippet: string;
            score: number;
            matchedKeywords: Set<string>;
        }>();
        
        for (const entry of indexEntries) {
            const key = `${entry.type}_${entry.targetId}`;
            const existing = resultMap.get(key);
            
            if (existing) {
                existing.score += entry.weight;
                existing.matchedKeywords.add(entry.keyword);
                if (entry.weight > 1 || !existing.contentSnippet) {
                    existing.contentSnippet = entry.contentSnippet;
                }
            } else {
                resultMap.set(key, {
                    type: entry.type,
                    targetId: entry.targetId,
                    targetDocId: entry.targetDocId,
                    title: entry.title,
                    contentSnippet: entry.contentSnippet,
                    score: entry.weight,
                    matchedKeywords: new Set([entry.keyword]),
                });
            }
        }
        
        const results = Array.from(resultMap.values())
            .map(item => ({
                ...item,
                matchedKeywords: Array.from(item.matchedKeywords),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(skip, skip + limit);
        
        return {
            results,
            total: resultMap.size,
        };
    }

    /**
     * Rebuild entire repo index (for initialization or repair)
     */
    static async rebuildIndex(
        domainId: string,
        rpid: number,
        branch: string = 'main'
    ): Promise<void> {
        await collKeywordIndex.deleteMany({ domainId, rpid, branch });
        
        const docs = await document.getMulti(domainId, TYPE_DC, { rpid, branch }).toArray();
        for (const doc of docs) {
            const rpidNum = Array.isArray(doc.rpid) ? doc.rpid[0] : doc.rpid;
            await this.indexContent(
                domainId,
                rpidNum,
                branch,
                'doc',
                doc.did,
                doc.docId,
                doc.title || '',
                doc.content || ''
            );
        }
        
        const blocks = await document.getMulti(domainId, TYPE_BK, { rpid, branch }).toArray();
        for (const block of blocks) {
            const rpidNum = Array.isArray(block.rpid) ? block.rpid[0] : block.rpid;
            await this.indexContent(
                domainId,
                rpidNum,
                branch,
                'block',
                block.bid,
                block.docId,
                block.title || '',
                block.content || ''
            );
        }
    }
}

export class BlockModel {
    static async create(
        domainId: string,
        rpid: number,
        docDocId: ObjectId, // 指向doc的docId（ObjectId）
        owner: number,
        title: string,
        content: string,
        ip?: string,
        branch: string = 'main'
    ): Promise<ObjectId> {
        // 不再使用bid，直接使用返回的docId作为标识
        const payload: Partial<BKDoc> = {
            domainId,
            rpid,
            did: docDocId, // did字段现在指向doc的docId（ObjectId）
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

        await RepoKeywordIndexModel.indexContent(
            domainId,
            rpid,
            branch,
            'block',
            docId.toString(), // 使用docId作为标识
            docId,
            title,
            content
        ).catch(err => console.error('Failed to update keyword index:', err));

        return docId;
    }

    static async get(domainId: string, query: ObjectId): Promise<BKDoc | null> {
        // 现在只支持通过docId（ObjectId）查询
        const block = await document.get(domainId, TYPE_BK, query);
        if (block && Array.isArray(block.rpid)) {
            block.rpid = block.rpid[0];
        }
        return block;
    }

    static async getByDocId(domainId: string, docDocId: ObjectId, branch?: string): Promise<BKDoc[]> {
        // 通过doc的docId查询该doc下的所有blocks
        const query: any = { did: docDocId };
        if (branch !== undefined) {
            query.branch = branch;
        } else {
            query.branch = 'main';
        }
        const blocks = await document.getMulti(domainId, TYPE_BK, query).toArray();
        const branchFilter = branch || 'main';
        return blocks
            .filter(block => {
                const blockBranch = block.branch || 'main';
                return blockBranch === branchFilter;
            })
            .map(block => {
                if (Array.isArray(block.rpid)) {
                    block.rpid = block.rpid[0];
                }
                return block;
            });
    }

    static async edit(domainId: string, docId: ObjectId, title: string, content: string): Promise<void> {
        const block = await this.get(domainId, docId);
        if (!block) throw new Error('Block not found');
        
        await document.set(domainId, TYPE_BK, docId, { 
            title, 
            content,
            updateAt: new Date()
        });
        
        const rpidNum = Array.isArray(block.rpid) ? block.rpid[0] : block.rpid;
        await RepoKeywordIndexModel.indexContent(
            domainId,
            rpidNum,
            block.branch || 'main',
            'block',
            docId.toString(), // 使用docId作为标识
            docId,
            title,
            content
        ).catch(err => console.error('Failed to update keyword index:', err));
    }

    static async delete(domainId: string, docId: ObjectId): Promise<void> {
        const block = await this.get(domainId, docId);
        if (!block) throw new Error('Block not found');
        
        await document.deleteOne(domainId, document.TYPE_BLOCK, docId);
        
        const rpidNum = Array.isArray(block.rpid) ? block.rpid[0] : block.rpid;
        await RepoKeywordIndexModel.removeIndex(
            domainId,
            rpidNum,
            block.branch || 'main',
            'block',
            docId.toString() // 使用docId作为标识
        ).catch(err => console.error('Failed to remove keyword index:', err));
    }

    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await document.inc(domainId, TYPE_BK, docId, 'views', 1);
    }
}

export function apply(ctx: Context) {
    (ctx as any).on('ready', async () => {
        await db.ensureIndexes(
            collKeywordIndex,
            { key: { domainId: 1, rpid: 1, branch: 1, keyword: 1, type: 1, targetId: 1 }, name: 'search', unique: false },
            { key: { domainId: 1, rpid: 1, branch: 1, type: 1, targetId: 1 }, name: 'target' },
            { key: { keyword: 1 }, name: 'keyword' },
        );
    });
}

// @ts-ignore
global.Ejunz.model.bs = BaseModel;
// @ts-ignore
global.Ejunz.model.rp = RepoModel;
// @ts-ignore
global.Ejunz.model.dc = DocModel;
// @ts-ignore
global.Ejunz.model.bk = BlockModel;
// @ts-ignore
global.Ejunz.model.repoKeywordIndex = RepoKeywordIndexModel;
export default { BaseModel, RepoModel, DocModel, BlockModel, RepoKeywordIndexModel };


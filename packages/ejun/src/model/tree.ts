import { _, ObjectId, Filter } from '../libs';
import * as document from './document';
import DocsModel from './doc';
import RepoModel, { RepoDoc } from './repo';
import { buildProjection } from '../utils';
import { encodeRFC5987ValueChars } from '../service/storage';
import type { Context } from '../context';
import type { FRDoc, TRDoc, BRDoc } from '../interface';

export const TYPE_BR: 1 = 1;
export const TYPE_TR: 6 = 6;
export const TYPE_FR: 7 = 7;

export class ForestModel {
    /**
     * 获取指定 domainId 的森林
     */
    static async getForest(domainId: string): Promise<FRDoc | null> {
        const results = await document.getMulti(domainId, TYPE_FR, { domainId }).limit(1).toArray();
        return results.length ? results[0] : null;
    }

    /**
     * 创建森林（每个 domain 只能有一个森林）
     */
    static async createForest(domainId: string, owner: number, title: string, content: string): Promise<ObjectId> {
        const trees = await TreeModel.getAllTrees(domainId);
        const treeIds = trees.map(tree => tree.trid); // 获取所有 Tree 的 ID

        const payload: Partial<FRDoc> = {
            docType: TYPE_FR,
            domainId,
            trids: treeIds, 
            title: title || 'Unnamed Forest',
            content: content || '',
            owner,
            createdAt: new Date(),
            updateAt: new Date(),
        };

        return await document.add(
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
    
        await document.set(domainId, TYPE_FR, docId, {
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
    
        await document.set(domainId, TYPE_FR, forest.docId, {
            trids: forest.trids
        });
    }
}

export class TreeModel {
    static async generateNextTrid(domainId: string): Promise<number> {
        const lastTree = await document.getMulti(domainId, TYPE_TR, {}) 
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
    
        const docId = await document.add(
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
        const treeDoc = await this.getTreeByTrid(domainId, trid);
        if (!treeDoc) {
            throw new Error(`Tree with trid ${trid} not found in domain ${domainId}`);
        }
    
        await document.set(domainId, TYPE_TR, treeDoc.docId, {
            title,
            content: content || '',   
        });
    }

    static async deleteTree(domainId: string, trid: number): Promise<void> {
        const treeDoc = await this.getTreeByTrid(domainId, trid);
        if (!treeDoc) {
            throw new Error(`Tree with trid ${trid} not found in domain ${domainId}`);
        }
        await document.deleteOne(domainId, TYPE_TR, treeDoc.docId);
    }

    static async getTree(domainId: string, docId: ObjectId): Promise<TRDoc | null> {
        return await document.get(domainId, TYPE_TR, docId);
    }

    static async getTreeByTrid(domainId: string, trid: number): Promise<TRDoc | null> {
        const result = await document.getMulti(domainId, TYPE_TR, { trid }).limit(1).toArray();
        return result.length > 0 ? result[0] : null;  
    }

    static async getAllTrees(domainId: string): Promise<TRDoc[]> {
        return await document.getMulti(domainId, TYPE_TR, {}).toArray();
    }

    static async getBranchesByTree(domainId: string, trid: number): Promise<BRDoc[]> {
        return await document.getMulti(domainId, TYPE_BR, { trid }).toArray();
    }
}

export class BranchModel {
    static async generateNextBid(domainId: string): Promise<number> {
        const lastDoc = await document.getMulti(domainId, TYPE_BR, {})
            .sort({ bid: -1 })
            .limit(1)
            .project({ bid: 1 })
            .toArray();
        return (lastDoc[0]?.bid || 0) + 1;
    }

    static async generateNextTrid(domainId: string): Promise<number> {
        const lastDoc = await document.getMulti(domainId, TYPE_BR, {})
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
    
        await document.set(domainId, TYPE_BR, docId, updateFields);
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

        const docId = await document.add(
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
        trid: number | number[],
        bid: number | null,
        parentBid: number,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        lids: number[] = [],
        rids: number[] = []
    ): Promise<ObjectId> {
        const parentNode = await document.getMulti(domainId, TYPE_BR, { bid: parentBid })
            .limit(1)
            .toArray();

        if (!parentNode.length) {
            throw new Error('Parent node does not exist.');
        }

        const newBid = bid ?? await this.generateNextBid(domainId);
        const path = `${parentNode[0].path}/${newBid}`;

        const payload: Partial<BRDoc> = {
            domainId,
            trid: Array.isArray(trid) ? trid[0] : trid,
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

        const docId = await document.add(
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
        return await document.get(domainId, TYPE_BR, docId);
    }

    static async getChildren(domainId: string, parentId: number): Promise<BRDoc[]> {
        return await document.getMulti(domainId, TYPE_BR, { parentId }).toArray();
    }

    static async getBranch(domainId: string, query: Partial<BRDoc>) {
        return document.getMulti(domainId, TYPE_BR, query);
    }

    static async deleteNode(domainId: string, docId: ObjectId): Promise<void> {
        const node = await this.get(domainId, docId);
        if (!node) throw new Error('Node not found.');

        const descendants = await document.getMulti(domainId, TYPE_BR, {
            path: { $regex: `^${node.path}` },
        }).toArray();

        const docIds = descendants.map((n) => n.docId);
        await Promise.all(docIds.map((id) => document.deleteOne(domainId, TYPE_BR, id)));
    }

    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await document.inc(domainId, TYPE_BR, docId, 'views', 1);
    }

    static async edit(domainId: string, docId: ObjectId, title: string, content: string, lids?: number[], rids?: number[]): Promise<void> {
        const updateFields: any = { title, content };
        
        if (lids !== undefined) updateFields.lids = lids;
        if (rids !== undefined) updateFields.rids = rids;
    
        await document.set(domainId, TYPE_BR, docId, updateFields);
    }

    static async getBranchesByIds(domainId: string, bids: number[]) {
        return await document.getMulti(domainId, TYPE_BR, { bid: { $in: bids } }).toArray();
    }

    static async getBranches(domainId: string, query: Filter<BRDoc>) {
        return document.getMulti(domainId, TYPE_BR, query);
    }
}

export async function getDocsByDomain(domainId: string) {
    return await DocsModel.getMulti(domainId, {}).toArray();
}

export async function getDocsByIds(domainId: string, ids: ObjectId[]) {
    return await DocsModel.getMulti(domainId, { _id: { $in: ids } }).toArray();
}

export async function getDocsByDocId(domainId: string, docIds: number | number[]) {
    const query = {
        domainId,
        docId: Array.isArray(docIds) ? { $in: docIds } : docIds,
    };

    const results = await DocsModel.getMulti(domainId, query)
        .project(buildProjection(DocsModel.PROJECTION_PUBLIC))
        .toArray();

    return results;
}

export async function getReposByDocId(domainId: string, docId: number | number[]) {
    const query = {
        domainId,
        docId: Array.isArray(docId) ? { $in: docId } : docId,
    };

    const results = await RepoModel.getMulti(domainId, query)
        .project(buildProjection(RepoModel.PROJECTION_PUBLIC))
        .toArray();

    return results;
}

export async function getProblemsByDocsId(domainId: string, lid: number) {
    // TODO: Implement when ProblemModel is available
    return [];
}

export async function getRelated(domainId: string, pid: number, rule?: string) {
    // TODO: Implement when ContestModel is available
    return [];
}

export function apply(ctx: Context) {}

global.Ejunz.model.tree = {
    ForestModel,
    TreeModel,
    BranchModel,
    TYPE_FR,
    TYPE_TR,
    TYPE_BR,
    getDocsByDomain,
    getDocsByIds,
    getDocsByDocId,
    getReposByDocId,
    getProblemsByDocsId,
    getRelated,
};


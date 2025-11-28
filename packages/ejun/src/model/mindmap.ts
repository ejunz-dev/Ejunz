import { _, ObjectId, Filter } from '../libs';
import * as document from './document';
import { buildProjection } from '../utils';
import type { Context } from '../context';
import type { MindMapDoc, MindMapNode, MindMapEdge, CardDoc, MindMapHistoryEntry } from '../interface';
import db from '../service/db';
import { Collection } from 'mongodb';

export const TYPE_MM: 70 = 70;
export const TYPE_CARD: 71 = 71;

/**
 * MindMap Model
 * 提供思维导图的 CRUD 操作
 */
export class MindMapModel {
    /**
     * 生成下一个思维导图ID
     */
    static async generateNextMmid(domainId: string): Promise<number> {
        const lastMindMap = await document.getMulti(domainId, TYPE_MM, {})
            .sort({ mmid: -1 })
            .limit(1)
            .project({ mmid: 1 })
            .toArray();
        return (lastMindMap[0]?.mmid || 0) + 1;
    }

    /**
     * 创建思维导图
     */
    static async create(
        domainId: string,
        owner: number,
        title: string,
        content: string = '',
        rpid?: number,
        branch?: string,
        ip?: string
    ): Promise<{ docId: ObjectId; mmid: number }> {
        const newMmid = await this.generateNextMmid(domainId);

        // 创建根节点
        const rootNode: MindMapNode = {
            id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            text: title || '根节点',
            x: 0,
            y: 0,
            level: 0,
            expanded: true,
        };

        const payload: Partial<MindMapDoc> = {
            docType: TYPE_MM,
            domainId,
            mmid: newMmid,
            title: title || '未命名思维导图',
            content: content || '',
            owner,
            nodes: [rootNode],
            edges: [],
            layout: {
                type: 'hierarchical',
                direction: 'LR',
                spacing: { x: 200, y: 100 },
            },
            viewport: {
                x: 0,
                y: 0,
                zoom: 1,
            },
            createdAt: new Date(),
            updateAt: new Date(),
            views: 0,
            ip,
            rpid,
            branch,
        };

        const docId = await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_MM,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])
        );

        return { docId, mmid: newMmid };
    }

    /**
     * 获取思维导图
     */
    static async get(domainId: string, docId: ObjectId): Promise<MindMapDoc | null> {
        return await document.get(domainId, TYPE_MM, docId);
    }

    /**
     * 通过 mmid 获取思维导图
     */
    static async getByMmid(domainId: string, mmid: number): Promise<MindMapDoc | null> {
        const result = await document.getMulti(domainId, TYPE_MM, { mmid }).limit(1).toArray();
        return result.length > 0 ? result[0] : null;
    }

    /**
     * 获取所有思维导图
     */
    static async getAll(domainId: string, query?: Filter<MindMapDoc>): Promise<MindMapDoc[]> {
        const baseQuery = query || {};
        return await document.getMulti(domainId, TYPE_MM, baseQuery).toArray();
    }

    /**
     * 获取仓库关联的思维导图
     */
    static async getByRepo(domainId: string, rpid: number, branch?: string): Promise<MindMapDoc[]> {
        const query: any = { rpid };
        if (branch) query.branch = branch;
        return await document.getMulti(domainId, TYPE_MM, query).toArray();
    }

    /**
     * 更新思维导图基本信息
     */
    static async update(
        domainId: string,
        docId: ObjectId,
        updates: Partial<Pick<MindMapDoc, 'title' | 'content' | 'layout' | 'viewport' | 'theme'>>
    ): Promise<void> {
        await document.set(domainId, TYPE_MM, docId, {
            ...updates,
            updateAt: new Date(),
        });
    }

    /**
     * 更新节点
     */
    static async updateNode(
        domainId: string,
        docId: ObjectId,
        nodeId: string,
        updates: Partial<MindMapNode>
    ): Promise<void> {
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('MindMap not found');

        const nodeIndex = mindMap.nodes.findIndex(n => n.id === nodeId);
        if (nodeIndex === -1) throw new Error('Node not found');

        mindMap.nodes[nodeIndex] = {
            ...mindMap.nodes[nodeIndex],
            ...updates,
        };

        await document.set(domainId, TYPE_MM, docId, {
            nodes: mindMap.nodes,
            updateAt: new Date(),
        });
    }

    /**
     * 添加节点
     */
    static async addNode(
        domainId: string,
        docId: ObjectId,
        node: Omit<MindMapNode, 'id'>,
        parentId?: string
    ): Promise<string> {
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('MindMap not found');

        const newNodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newNode: MindMapNode = {
            ...node,
            id: newNodeId,
        };

        // 如果指定了父节点，更新父子关系
        if (parentId) {
            const parentNode = mindMap.nodes.find(n => n.id === parentId);
            if (!parentNode) throw new Error('Parent node not found');

            newNode.parentId = parentId;
            newNode.level = (parentNode.level || 0) + 1;

            // 更新父节点的子节点列表
            if (!parentNode.children) parentNode.children = [];
            parentNode.children.push(newNodeId);

            const parentIndex = mindMap.nodes.findIndex(n => n.id === parentId);
            mindMap.nodes[parentIndex] = parentNode;
        } else {
            newNode.level = 0;
        }

        mindMap.nodes.push(newNode);

        await document.set(domainId, TYPE_MM, docId, {
            nodes: mindMap.nodes,
            updateAt: new Date(),
        });

        return newNodeId;
    }

    /**
     * 删除节点
     */
    static async deleteNode(domainId: string, docId: ObjectId, nodeId: string): Promise<void> {
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('MindMap not found');

        const node = mindMap.nodes.find(n => n.id === nodeId);
        if (!node) throw new Error('Node not found');

        // 递归删除所有子节点
        const deleteNodeRecursive = (id: string) => {
            const nodeToDelete = mindMap.nodes.find(n => n.id === id);
            if (nodeToDelete?.children) {
                nodeToDelete.children.forEach(childId => deleteNodeRecursive(childId));
            }
            // 删除节点
            const index = mindMap.nodes.findIndex(n => n.id === id);
            if (index !== -1) mindMap.nodes.splice(index, 1);
            // 删除相关连接
            mindMap.edges = mindMap.edges.filter(e => e.source !== id && e.target !== id);
        };

        // 如果节点有父节点，从父节点的子节点列表中移除
        if (node.parentId) {
            const parentNode = mindMap.nodes.find(n => n.id === node.parentId);
            if (parentNode?.children) {
                parentNode.children = parentNode.children.filter(id => id !== nodeId);
                const parentIndex = mindMap.nodes.findIndex(n => n.id === node.parentId);
                mindMap.nodes[parentIndex] = parentNode;
            }
        }

        deleteNodeRecursive(nodeId);

        await document.set(domainId, TYPE_MM, docId, {
            nodes: mindMap.nodes,
            edges: mindMap.edges,
            updateAt: new Date(),
        });
    }

    /**
     * 添加连接
     */
    static async addEdge(
        domainId: string,
        docId: ObjectId,
        edge: Omit<MindMapEdge, 'id'>
    ): Promise<string> {
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('MindMap not found');

        // 验证源节点和目标节点是否存在
        const sourceExists = mindMap.nodes.some(n => n.id === edge.source);
        const targetExists = mindMap.nodes.some(n => n.id === edge.target);
        if (!sourceExists || !targetExists) {
            throw new Error('Source or target node not found');
        }

        // 检查连接是否已存在
        const edgeExists = mindMap.edges.some(
            e => e.source === edge.source && e.target === edge.target
        );
        if (edgeExists) {
            throw new Error('Edge already exists');
        }

        const newEdgeId = `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newEdge: MindMapEdge = {
            ...edge,
            id: newEdgeId,
        };

        mindMap.edges.push(newEdge);

        await document.set(domainId, TYPE_MM, docId, {
            edges: mindMap.edges,
            updateAt: new Date(),
        });

        return newEdgeId;
    }

    /**
     * 删除连接
     */
    static async deleteEdge(domainId: string, docId: ObjectId, edgeId: string): Promise<void> {
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('MindMap not found');

        const edgeIndex = mindMap.edges.findIndex(e => e.id === edgeId);
        if (edgeIndex === -1) throw new Error('Edge not found');

        mindMap.edges.splice(edgeIndex, 1);

        await document.set(domainId, TYPE_MM, docId, {
            edges: mindMap.edges,
            updateAt: new Date(),
        });
    }

    /**
     * 批量更新节点（用于布局更新）
     */
    static async updateNodes(
        domainId: string,
        docId: ObjectId,
        nodes: MindMapNode[]
    ): Promise<void> {
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('MindMap not found');

        // 验证所有节点ID都存在
        const nodeIds = new Set(mindMap.nodes.map(n => n.id));
        for (const node of nodes) {
            if (!nodeIds.has(node.id)) {
                throw new Error(`Node ${node.id} not found`);
            }
        }

        // 更新节点
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        mindMap.nodes = mindMap.nodes.map(n => nodeMap.get(n.id) || n);

        await document.set(domainId, TYPE_MM, docId, {
            nodes: mindMap.nodes,
            updateAt: new Date(),
        });
    }

    /**
     * 批量更新连接
     */
    static async updateEdges(
        domainId: string,
        docId: ObjectId,
        edges: MindMapEdge[]
    ): Promise<void> {
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('MindMap not found');

        // 验证所有连接ID都存在
        const edgeIds = new Set(mindMap.edges.map(e => e.id));
        for (const edge of edges) {
            if (!edgeIds.has(edge.id)) {
                throw new Error(`Edge ${edge.id} not found`);
            }
        }

        await document.set(domainId, TYPE_MM, docId, {
            edges: edges,
            updateAt: new Date(),
        });
    }

    /**
     * 删除思维导图
     */
    static async delete(domainId: string, docId: ObjectId): Promise<void> {
        await document.deleteOne(domainId, TYPE_MM, docId);
    }

    /**
     * 增加访问量
     */
    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await document.inc(domainId, TYPE_MM, docId, 'views', 1);
    }

    /**
     * 更新整个思维导图（用于完整保存）
     */
    static async updateFull(
        domainId: string,
        docId: ObjectId,
        updates: {
            nodes?: MindMapNode[];
            edges?: MindMapEdge[];
            branchData?: { [branch: string]: { nodes: MindMapNode[]; edges: MindMapEdge[] } };
            content?: string;
            layout?: MindMapDoc['layout'];
            viewport?: MindMapDoc['viewport'];
            theme?: MindMapDoc['theme'];
            history?: MindMapDoc['history'];
        }
    ): Promise<void> {
        await document.set(domainId, TYPE_MM, docId, {
            ...updates,
            updateAt: new Date(),
        });
    }
}

export function apply(ctx: Context) {
    // 可以在这里添加索引或其他初始化逻辑
    (ctx as any).on('ready', async () => {
        // 如果需要，可以在这里添加数据库索引
    });
}

/**
 * Card Model
 * 提供 Card 的 CRUD 操作（类似 Block）
 */
export class CardModel {
    /**
     * 生成下一个 Card ID（在 node 内唯一）
     */
    static async generateNextCid(domainId: string, mmid: number, nodeId: string): Promise<number> {
        const lastCard = await document.getMulti(domainId, TYPE_CARD, { mmid, nodeId })
            .sort({ cid: -1 })
            .limit(1)
            .project({ cid: 1 })
            .toArray();
        return (lastCard[0]?.cid || 0) + 1;
    }

    /**
     * 创建 Card
     */
    static async create(
        domainId: string,
        mmid: number,
        nodeId: string,
        owner: number,
        title: string,
        content: string = '',
        ip?: string
    ): Promise<ObjectId> {
        const newCid = await this.generateNextCid(domainId, mmid, nodeId);

        const payload: Partial<CardDoc> = {
            docType: TYPE_CARD,
            domainId,
            mmid,
            nodeId,
            cid: newCid,
            title: title || '未命名卡片',
            content: content || '',
            owner,
            ip,
            updateAt: new Date(),
            views: 0,
            createdAt: new Date(),
        };

        const docId = await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_CARD,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])
        );

        return docId;
    }

    /**
     * 获取 Card
     */
    static async get(domainId: string, docId: ObjectId): Promise<CardDoc | null> {
        return await document.get(domainId, TYPE_CARD, docId);
    }

    /**
     * 获取 node 下的所有 cards
     */
    static async getByNodeId(domainId: string, mmid: number, nodeId: string): Promise<CardDoc[]> {
        const cards = await document.getMulti(domainId, TYPE_CARD, { mmid, nodeId })
            .sort({ order: 1, cid: 1 })
            .toArray();
        return cards;
    }

    /**
     * 根据 cid 获取卡片
     */
    static async getByCid(
        domainId: string,
        nodeId: string,
        cid: number,
        mmid?: number
    ): Promise<CardDoc | null> {
        const filter: any = { nodeId, cid };
        if (mmid !== undefined) {
            filter.mmid = mmid;
        }
        const cards = await document
            .getMulti(domainId, TYPE_CARD, filter)
            .limit(1)
            .toArray();
        return cards[0] || null;
    }

    /**
     * 更新 Card
     */
    static async update(
        domainId: string,
        docId: ObjectId,
        updates: Partial<Pick<CardDoc, 'title' | 'content' | 'order'>>
    ): Promise<void> {
        await document.set(domainId, TYPE_CARD, docId, {
            ...updates,
            updateAt: new Date(),
        });
    }

    /**
     * 删除 Card
     */
    static async delete(domainId: string, docId: ObjectId): Promise<void> {
        await document.deleteOne(domainId, TYPE_CARD, docId);
    }

    /**
     * 增加访问量
     */
    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await document.inc(domainId, TYPE_CARD, docId, 'views', 1);
    }
}

// @ts-ignore
global.Ejunz.model.mindmap = MindMapModel;
// @ts-ignore
global.Ejunz.model.card = CardModel;
export default { MindMapModel, CardModel };


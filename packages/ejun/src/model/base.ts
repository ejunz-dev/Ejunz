import { _, ObjectId, Filter } from '../libs';
import * as document from './document';
import { buildProjection } from '../utils';
import type { Context } from '../context';
import type { BaseDoc, BaseNode, BaseEdge, CardDoc, BaseHistoryEntry } from '../interface';
import db from '../service/db';
import { Collection } from 'mongodb';

export const TYPE_MM: 70 = 70;
export const TYPE_CARD: 71 = 71;

/**
 * Base Model
 * 提供思维导图的 CRUD 操作
 */
export class BaseModel {
    /**
     * 通过 domainId 获取思维导图（一个 domain 一个 base）
     * 排除 Skills Base（type 为 'skill'）
     */
    static async getByDomain(domainId: string): Promise<BaseDoc | null> {
        // 排除 Skills Base，确保普通 base 和 Skills base 独立
        const result = await document.getMulti(domainId, TYPE_MM, {
            type: { $ne: 'skill' }
        }).limit(1).toArray();
        return result.length > 0 ? result[0] : null;
    }

    /**
     * 创建或获取思维导图（一个 domain 一个 base）
     */
    static async create(
        domainId: string,
        owner: number,
        title: string,
        content: string = '',
        rpid?: number,
        branch?: string,
        ip?: string,
        parentId?: ObjectId,
        domainName?: string,
        type?: 'base' | 'skill'
    ): Promise<{ docId: ObjectId }> {
        // 如果是 skill 类型，使用不同的查询逻辑
        if (type === 'skill') {
            const existing = await document.getMulti(domainId, TYPE_MM, { type: 'skill' }).limit(1).toArray();
            if (existing.length > 0) {
                return { docId: existing[0].docId };
            }
        } else {
            // 检查 domain 是否已有 base（排除 skill 类型）
            const existing = await this.getByDomain(domainId);
            if (existing) {
                // 如果已存在，更新标题和内容（如果需要）
                if (title && title !== existing.title) {
                    await this.update(domainId, existing.docId, { title });
                }
                if (content !== undefined && content !== existing.content) {
                    await this.update(domainId, existing.docId, { content });
                }
                return { docId: existing.docId };
            }
        }

        // 创建根节点，使用域名字作为默认名称
        const rootNodeText = title || domainName || '根节点';
        const rootNode: BaseNode = {
            id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            text: rootNodeText,
            x: 0,
            y: 0,
            level: 0,
            expanded: true,
        };

        const payload: Partial<BaseDoc> = {
            docType: TYPE_MM,
            domainId,
            title: title || '未命名思维导图',
            content: content || '',
            type: type || 'base', // 默认为 'base'，如果未指定
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
            parentId, // 设置父思维导图ID
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

        return { docId };
    }

    /**
     * 获取思维导图
     */
    static async get(domainId: string, docId: ObjectId): Promise<BaseDoc | null> {
        return await document.get(domainId, TYPE_MM, docId);
    }

    /**
     * 获取所有思维导图（向后兼容，现在一个 domain 只有一个）
     */
    static async getAll(domainId: string, query?: Filter<BaseDoc>): Promise<BaseDoc[]> {
        const base = await this.getByDomain(domainId);
        return base ? [base] : [];
    }

    /**
     * 获取仓库关联的思维导图
     */
    static async getByRepo(domainId: string, rpid: number, branch?: string): Promise<BaseDoc[]> {
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
        updates: Partial<Pick<BaseDoc, 'title' | 'content' | 'layout' | 'viewport' | 'theme' | 'files' | 'parentId' | 'domainPosition'>>
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
        updates: Partial<BaseNode>
    ): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        const nodeIndex = base.nodes.findIndex(n => n.id === nodeId);
        if (nodeIndex === -1) throw new Error('Node not found');

        // 创建新的 nodes 数组，确保引用改变
        const newNodes = [...base.nodes];
        newNodes[nodeIndex] = {
            ...newNodes[nodeIndex],
            ...updates,
        };

        // 获取当前分支
        const currentBranch = (base as any).currentBranch || 'main';
        
        // 更新分支数据（如果存在）
        const branchData = (base as any).branchData || {};
        if (branchData[currentBranch]) {
            const branchNodes = branchData[currentBranch].nodes || [];
            const branchNodeIndex = branchNodes.findIndex((n: BaseNode) => n.id === nodeId);
            if (branchNodeIndex >= 0) {
                branchNodes[branchNodeIndex] = {
                    ...branchNodes[branchNodeIndex],
                    ...updates,
                };
                branchData[currentBranch] = {
                    ...branchData[currentBranch],
                    nodes: branchNodes,
                };
            }
        }

        // 使用 $set 更新整个 nodes 数组和分支数据
        await document.set(domainId, TYPE_MM, docId, {
            nodes: newNodes,
            branchData: branchData,
            updateAt: new Date(),
        });
    }

    /**
     * 添加节点
     * @param edgeSourceId 如果提供，将同时创建从 edgeSourceId 到新节点的边
     * @returns 返回 nodeId，如果创建了边则同时返回 edgeId
     */
    static async addNode(
        domainId: string,
        docId: ObjectId,
        node: Omit<BaseNode, 'id'>,
        parentId?: string,
        branch?: string,
        edgeSourceId?: string
    ): Promise<{ nodeId: string; edgeId?: string }> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        // 获取分支名称（优先使用传入的分支，否则使用 base 中的分支，最后默认为 'main'）
        const branchName = branch || (base as any).currentBranch || (base as any).branch || 'main';
        const branchData: {
            [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] };
        } = (base as any).branchData || {};

        // 确定使用哪个节点和边数组（使用与 getBranchData 相同的逻辑）
        let nodes: BaseNode[];
        let edges: BaseEdge[];
        
        // 如果存在 branchData，优先使用
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            // 向后兼容：如果 branchData 不存在，使用根节点的 nodes/edges（仅对 main 分支）
            nodes = base.nodes || [];
            edges = base.edges || [];
        } else {
            // 其他分支如果没有数据，创建新的
            nodes = [];
            edges = [];
        }

        const newNodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newNode: BaseNode = {
            ...node,
            id: newNodeId,
        };

        // 如果指定了父节点，更新父子关系
        if (parentId) {
            const parentNode = nodes.find(n => n.id === parentId);
            if (!parentNode) throw new Error(`Parent node not found: ${parentId}. Branch: ${branchName}`);

            newNode.parentId = parentId;
            newNode.level = (parentNode.level || 0) + 1;

            // 更新父节点的子节点列表
            if (!parentNode.children) parentNode.children = [];
            parentNode.children.push(newNodeId);

            const parentIndex = nodes.findIndex(n => n.id === parentId);
            nodes[parentIndex] = parentNode;
        } else {
            newNode.level = 0;
        }

        nodes.push(newNode);

        // 如果需要创建边，在同一个操作中创建
        let newEdgeId: string | undefined;
        if (edgeSourceId) {
            // 验证源节点是否存在
            const sourceExists = nodes.some(n => n.id === edgeSourceId);
            if (!sourceExists) {
                throw new Error(`Source node not found: ${edgeSourceId}. Branch: ${branchName}`);
            }

            // 检查边是否已存在
            const existingEdge = edges.find(
                e => e.source === edgeSourceId && e.target === newNodeId
            );
            
            if (existingEdge) {
                newEdgeId = existingEdge.id;
            } else {
                // 创建新边
                newEdgeId = `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const newEdge: BaseEdge = {
                    id: newEdgeId,
                    source: edgeSourceId,
                    target: newNodeId,
                };
                edges.push(newEdge);
            }
        }

        // 更新分支数据
        if (!branchData[branchName]) {
            branchData[branchName] = { nodes: [], edges: [] };
        }
        branchData[branchName] = {
            nodes: nodes,
            edges: edges,
        };

        // 同时更新主数据（向后兼容，仅对 main 分支）
        const updateData: any = {
            branchData: branchData,
            updateAt: new Date(),
        };
        
        if (branchName === 'main') {
            updateData.nodes = nodes;
            updateData.edges = edges;
        }

        await document.set(domainId, TYPE_MM, docId, updateData);

        return { nodeId: newNodeId, edgeId: newEdgeId };
    }

    /**
     * 删除节点
     */
    static async deleteNode(domainId: string, docId: ObjectId, nodeId: string, branch?: string): Promise<void> {
        const actualDomainId = typeof domainId === 'string' ? domainId : String(domainId);
        const base = await this.get(actualDomainId, docId);
        if (!base) {
            throw new Error('Base not found');
        }

        const branchName = branch || (base as any).currentBranch || (base as any).branch || 'main';
        const branchData: {
            [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] };
        } = (base as any).branchData || {};

        let nodes: BaseNode[];
        let edges: BaseEdge[];
        
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            nodes = base.nodes || [];
            edges = base.edges || [];
        } else {
            nodes = [];
            edges = [];
        }

        const node = nodes.find(n => n.id === nodeId);
        if (!node) {
            try {
                const cards = await CardModel.getByNodeId(actualDomainId, base.docId, nodeId);
                for (const card of cards) {
                    await CardModel.delete(actualDomainId, card.docId);
                }
            } catch (err) {
            }
            return;
        }

        const nodesToDelete = new Set<string>();
        
        const collectChildNodes = (id: string) => {
            if (nodesToDelete.has(id)) {
                return;
            }
            
            nodesToDelete.add(id);
            const nodeToDelete = nodes.find(n => n.id === id);
            
            if (!nodeToDelete) {
                return;
            }
            
            if (nodeToDelete.children && nodeToDelete.children.length > 0) {
                nodeToDelete.children.forEach(childId => {
                    if (!nodesToDelete.has(childId)) {
                        collectChildNodes(childId);
                    }
                });
            }
            
            const childEdges = edges.filter(e => e.source === id);
            childEdges.forEach(edge => {
                if (!nodesToDelete.has(edge.target)) {
                    collectChildNodes(edge.target);
                }
            });
        };

        collectChildNodes(nodeId);

        for (const nodeIdToDelete of nodesToDelete) {
            try {
                const cards = await CardModel.getByNodeId(actualDomainId, docId, nodeIdToDelete);
                for (const card of cards) {
                    await CardModel.delete(actualDomainId, card.docId);
                }
            } catch (err) {
            }
        }

        const deleteNodeRecursive = (id: string) => {
            const nodeToDelete = nodes.find(n => n.id === id);
            
            if (!nodeToDelete) {
                return;
            }
            
            const childIds = new Set<string>();
            
            if (nodeToDelete.children && nodeToDelete.children.length > 0) {
                nodeToDelete.children.forEach(childId => {
                    childIds.add(childId);
                });
            }
            
            const childEdges = edges.filter(e => e.source === id);
            childEdges.forEach(edge => {
                childIds.add(edge.target);
            });
            
            childIds.forEach(childId => {
                deleteNodeRecursive(childId);
            });
            
            const index = nodes.findIndex(n => n.id === id);
            if (index !== -1) nodes.splice(index, 1);
            
            edges = edges.filter(e => e.source !== id && e.target !== id);
        };

        if (node.parentId) {
            const parentNode = nodes.find(n => n.id === node.parentId);
            if (parentNode?.children) {
                parentNode.children = parentNode.children.filter(id => id !== nodeId);
                const parentIndex = nodes.findIndex(n => n.id === node.parentId);
                if (parentIndex !== -1) {
                    nodes[parentIndex] = parentNode;
                }
            }
        }
        
        edges = edges.filter(e => !(e.source === node.parentId && e.target === nodeId));

        deleteNodeRecursive(nodeId);

        if (!branchData[branchName]) {
            branchData[branchName] = { nodes: [], edges: [] };
        }
        branchData[branchName] = {
            nodes: nodes,
            edges: edges,
        };

        const updateData: any = {
            branchData: branchData,
            updateAt: new Date(),
        };
        
        if (branchName === 'main') {
            updateData.nodes = nodes;
            updateData.edges = edges;
        }

        await document.set(actualDomainId, TYPE_MM, docId, updateData);
    }

    /**
     * 添加连接
     */
    static async addEdge(
        domainId: string,
        docId: ObjectId,
        edge: Omit<BaseEdge, 'id'>,
        branch?: string
    ): Promise<string> {
        let base = await this.get(domainId, docId);
        if (!base) {
            // 如果获取失败，可能是数据库延迟，尝试再获取一次
            await new Promise(resolve => setTimeout(resolve, 100)); // 等待100ms
            base = await this.get(domainId, docId);
            if (!base) {
                // 如果仍然获取失败，再等待一次
                await new Promise(resolve => setTimeout(resolve, 100)); // 再等待100ms
                base = await this.get(domainId, docId);
                if (!base) {
                    // 如果仍然获取失败，抛出错误
                    throw new Error('Base not found');
                }
            }
        }

        // 获取分支名称（优先使用传入的分支，否则使用 base 中的分支，最后默认为 'main'）
        const branchName = branch || (base as any).currentBranch || (base as any).branch || 'main';
        const branchData: {
            [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] };
        } = (base as any).branchData || {};

        // 确定使用哪个节点和边数组（使用与 getBranchData 相同的逻辑）
        let nodes: BaseNode[];
        let edges: BaseEdge[];
        
        // 如果存在 branchData，优先使用
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            // 向后兼容：如果 branchData 不存在，使用根节点的 nodes/edges（仅对 main 分支）
            nodes = base.nodes || [];
            edges = base.edges || [];
        } else {
            // 其他分支如果没有数据，创建新的
            nodes = [];
            edges = [];
        }

        // 验证源节点和目标节点是否存在（参考旧版本的简单逻辑）
        const sourceExists = nodes.some(n => n.id === edge.source);
        const targetExists = nodes.some(n => n.id === edge.target);
        if (!sourceExists || !targetExists) {
            throw new Error(`Source or target node not found. Source: ${edge.source}, Target: ${edge.target}, Branch: ${branchName}`);
        }

        // 如果连接已经存在，则直接返回已有的 edgeId，而不是抛错
        const existingEdge = edges.find(
            e => e.source === edge.source && e.target === edge.target
        );
        if (existingEdge) {
            // 同步到当前分支数据（如果分支中没有这条边，则补上）
            if (!branchData[branchName]) {
                branchData[branchName] = { nodes: nodes, edges: edges };
            }
            
            const branchEdges = branchData[branchName].edges || [];
            const branchHasEdge = branchEdges.some(
                e => e.source === edge.source && e.target === edge.target
            );
            if (!branchHasEdge) {
                branchEdges.push(existingEdge);
                branchData[branchName] = {
                    ...branchData[branchName],
                    edges: branchEdges,
                };
            }

            const updateData: any = {
                branchData,
                updateAt: new Date(),
            };
            
            if (branchName === 'main') {
                updateData.nodes = nodes;
                updateData.edges = edges;
            }

            await document.set(domainId, TYPE_MM, docId, updateData);

            return existingEdge.id;
        }

        const newEdgeId = `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newEdge: BaseEdge = {
            ...edge,
            id: newEdgeId,
        };

        edges.push(newEdge);

        // 更新分支数据
        if (!branchData[branchName]) {
            branchData[branchName] = { nodes: nodes, edges: edges };
        } else {
            branchData[branchName] = {
                ...branchData[branchName],
                edges: edges,
            };
        }

        // 同时更新主数据（向后兼容，仅对 main 分支）
        const updateData: any = {
            branchData: branchData,
            updateAt: new Date(),
        };
        
        if (branchName === 'main') {
            updateData.nodes = nodes;
            updateData.edges = edges;
        }

        await document.set(domainId, TYPE_MM, docId, updateData);

        return newEdgeId;
    }

    /**
     * 删除连接
     */
    static async deleteEdge(domainId: string, docId: ObjectId, edgeId: string): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        // 获取当前分支
        const currentBranch = (base as any).currentBranch || 'main';
        const branchData: {
            [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] };
        } = (base as any).branchData || {};

        const edgeIndex = base.edges.findIndex(e => e.id === edgeId);
        if (edgeIndex !== -1) {
        base.edges.splice(edgeIndex, 1);
        }

        // 从当前分支的 edges 中删除
        if (branchData[currentBranch]) {
            const branchEdges = branchData[currentBranch].edges || [];
            const branchEdgeIndex = branchEdges.findIndex(e => e.id === edgeId);
            if (branchEdgeIndex !== -1) {
                branchEdges.splice(branchEdgeIndex, 1);
                branchData[currentBranch] = {
                    ...branchData[currentBranch],
                    edges: branchEdges,
                };
            }
        }

        await document.set(domainId, TYPE_MM, docId, {
            edges: base.edges,
            branchData,
            updateAt: new Date(),
        });
    }

    /**
     * 批量更新节点（用于布局更新）
     */
    static async updateNodes(
        domainId: string,
        docId: ObjectId,
        nodes: BaseNode[]
    ): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        // 验证所有节点ID都存在
        const nodeIds = new Set(base.nodes.map(n => n.id));
        for (const node of nodes) {
            if (!nodeIds.has(node.id)) {
                throw new Error(`Node ${node.id} not found`);
            }
        }

        // 更新节点
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        base.nodes = base.nodes.map(n => nodeMap.get(n.id) || n);

        await document.set(domainId, TYPE_MM, docId, {
            nodes: base.nodes,
            updateAt: new Date(),
        });
    }

    /**
     * 批量更新连接
     */
    static async updateEdges(
        domainId: string,
        docId: ObjectId,
        edges: BaseEdge[]
    ): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        // 验证所有连接ID都存在
        const edgeIds = new Set(base.edges.map(e => e.id));
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
            nodes?: BaseNode[];
            edges?: BaseEdge[];
            branchData?: { [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] } };
            content?: string;
            layout?: BaseDoc['layout'];
            viewport?: BaseDoc['viewport'];
            theme?: BaseDoc['theme'];
            history?: BaseDoc['history'];
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
    static async generateNextCid(domainId: string, baseDocId: ObjectId, nodeId: string): Promise<number> {
        const lastCard = await document.getMulti(domainId, TYPE_CARD, { baseDocId, nodeId })
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
        baseDocId: ObjectId,
        nodeId: string,
        owner: number,
        title: string,
        content: string = '',
        ip?: string,
        problems?: CardDoc['problems'],
    ): Promise<ObjectId> {
        const newCid = await this.generateNextCid(domainId, baseDocId, nodeId);

        const payload: Partial<CardDoc> = {
            docType: TYPE_CARD,
            domainId,
            baseDocId,
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
        if (problems && problems.length > 0) {
            (payload as any).problems = problems;
        }

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
     * 获取最近更新的 cards（按 updateAt 降序）
     */
    static async getRecentUpdated(domainId: string, limit: number = 10): Promise<CardDoc[]> {
        const list = await document.getMulti(domainId, TYPE_CARD, {})
            .sort({ updateAt: -1 })
            .limit(limit)
            .toArray();
        return list as CardDoc[];
    }

    /**
     * 获取 node 下的所有 cards
     */
    static async getByNodeId(domainId: string, baseDocId: ObjectId, nodeId: string): Promise<CardDoc[]> {
        const cards = await document.getMulti(domainId, TYPE_CARD, { baseDocId, nodeId })
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
        baseDocId?: ObjectId
    ): Promise<CardDoc | null> {
        const filter: any = { nodeId, cid };
        if (baseDocId) {
            filter.baseDocId = baseDocId;
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
        updates: Partial<Pick<CardDoc, 'title' | 'content' | 'order' | 'nodeId' | 'problems'>>
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
global.Ejunz.model.base = BaseModel;
// @ts-ignore
global.Ejunz.model.card = CardModel;
export default { BaseModel, CardModel };


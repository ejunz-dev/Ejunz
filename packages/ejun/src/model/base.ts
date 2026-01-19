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
 * Base Model
 * 提供思维导图的 CRUD 操作
 */
export class MindMapModel {
    /**
     * 通过 domainId 获取思维导图（一个 domain 一个 base）
     */
    static async getByDomain(domainId: string): Promise<MindMapDoc | null> {
        const result = await document.getMulti(domainId, TYPE_MM, {}).limit(1).toArray();
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
        parentId?: ObjectId
    ): Promise<{ docId: ObjectId }> {
        // 检查 domain 是否已有 base
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
    static async get(domainId: string, docId: ObjectId): Promise<MindMapDoc | null> {
        return await document.get(domainId, TYPE_MM, docId);
    }

    /**
     * 获取所有思维导图（向后兼容，现在一个 domain 只有一个）
     */
    static async getAll(domainId: string, query?: Filter<MindMapDoc>): Promise<MindMapDoc[]> {
        const mindMap = await this.getByDomain(domainId);
        return mindMap ? [mindMap] : [];
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
        updates: Partial<Pick<MindMapDoc, 'title' | 'content' | 'layout' | 'viewport' | 'theme' | 'files' | 'parentId' | 'domainPosition'>>
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
        if (!mindMap) throw new Error('Base not found');

        const nodeIndex = mindMap.nodes.findIndex(n => n.id === nodeId);
        if (nodeIndex === -1) throw new Error('Node not found');

        // 创建新的 nodes 数组，确保引用改变
        const newNodes = [...mindMap.nodes];
        newNodes[nodeIndex] = {
            ...newNodes[nodeIndex],
            ...updates,
        };

        // 获取当前分支
        const currentBranch = (mindMap as any).currentBranch || 'main';
        
        // 更新分支数据（如果存在）
        const branchData = (mindMap as any).branchData || {};
        if (branchData[currentBranch]) {
            const branchNodes = branchData[currentBranch].nodes || [];
            const branchNodeIndex = branchNodes.findIndex((n: MindMapNode) => n.id === nodeId);
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
        node: Omit<MindMapNode, 'id'>,
        parentId?: string,
        branch?: string,
        edgeSourceId?: string
    ): Promise<{ nodeId: string; edgeId?: string }> {
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('Base not found');

        // 获取分支名称（优先使用传入的分支，否则使用 mindMap 中的分支，最后默认为 'main'）
        const branchName = branch || (mindMap as any).currentBranch || (mindMap as any).branch || 'main';
        const branchData: {
            [branch: string]: { nodes: MindMapNode[]; edges: MindMapEdge[] };
        } = (mindMap as any).branchData || {};

        // 确定使用哪个节点和边数组（使用与 getBranchData 相同的逻辑）
        let nodes: MindMapNode[];
        let edges: MindMapEdge[];
        
        // 如果存在 branchData，优先使用
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            // 向后兼容：如果 branchData 不存在，使用根节点的 nodes/edges（仅对 main 分支）
            nodes = mindMap.nodes || [];
            edges = mindMap.edges || [];
        } else {
            // 其他分支如果没有数据，创建新的
            nodes = [];
            edges = [];
        }

        const newNodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newNode: MindMapNode = {
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
                const newEdge: MindMapEdge = {
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
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('Base not found');

        // 获取分支名称（优先使用传入的分支，否则使用 mindMap 中的分支，最后默认为 'main'）
        const branchName = branch || (mindMap as any).currentBranch || (mindMap as any).branch || 'main';
        const branchData: {
            [branch: string]: { nodes: MindMapNode[]; edges: MindMapEdge[] };
        } = (mindMap as any).branchData || {};

        // 确定使用哪个节点和边数组（使用与 getBranchData 相同的逻辑）
        let nodes: MindMapNode[];
        let edges: MindMapEdge[];
        
        // 如果存在 branchData，优先使用
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            // 向后兼容：如果 branchData 不存在，使用根节点的 nodes/edges（仅对 main 分支）
            nodes = mindMap.nodes || [];
            edges = mindMap.edges || [];
        } else {
            // 其他分支如果没有数据，返回空数组
            nodes = [];
            edges = [];
        }

        const node = nodes.find(n => n.id === nodeId);
        if (!node) {
            // 节点不存在，可能是已经被删除或从未存在
            // 为了幂等性，如果节点不存在，仍然尝试删除该节点的所有卡片，然后返回成功
            // 这样可以确保即使节点不存在，其卡片也能被删除
            try {
                const cards = await CardModel.getByNodeId(domainId, mindMap.docId, nodeId);
                for (const card of cards) {
                    await CardModel.delete(domainId, card.docId);
                }
            } catch (err) {
                // Ignore card deletion errors
            }
            return;
        }

        // 收集所有要删除的节点ID（包括当前节点和所有子节点）
        const nodesToDelete = new Set<string>();
        
        // 递归收集所有子节点
        // 同时考虑 children 字段和 edges 中的父子关系
        const collectChildNodes = (id: string) => {
            // 如果已经收集过，跳过
            if (nodesToDelete.has(id)) {
                return;
            }
            
            nodesToDelete.add(id);
            const nodeToDelete = nodes.find(n => n.id === id);
            
            // 如果节点不存在，跳过（可能已经被删除）
            if (!nodeToDelete) {
                return;
            }
            
            // 方法1: 从节点的 children 字段获取子节点
            if (nodeToDelete.children && nodeToDelete.children.length > 0) {
                nodeToDelete.children.forEach(childId => {
                    if (!nodesToDelete.has(childId)) {
                        collectChildNodes(childId);
                    }
                });
            }
            
            // 方法2: 从 edges 中查找所有以当前节点为 source 的子节点
            const childEdges = edges.filter(e => e.source === id);
            childEdges.forEach(edge => {
                if (!nodesToDelete.has(edge.target)) {
                    collectChildNodes(edge.target);
                }
            });
        };

        collectChildNodes(nodeId);

        // 删除所有相关节点的卡片（删除所有分支的卡片，不限于当前分支）
        for (const nodeIdToDelete of nodesToDelete) {
            try {
                // 获取该节点在所有分支下的所有卡片
                const cards = await CardModel.getByNodeId(domainId, mindMap.bid, nodeIdToDelete);
                for (const card of cards) {
                    await CardModel.delete(domainId, card.docId);
                }
            } catch (err) {
                // Ignore card deletion errors
            }
        }

        // 递归删除所有子节点（同时考虑 children 和 edges）
        const deleteNodeRecursive = (id: string) => {
            const nodeToDelete = nodes.find(n => n.id === id);
            
            // 如果节点不存在，跳过（可能已经被删除）
            if (!nodeToDelete) {
                return;
            }
            
            // 先收集所有子节点ID（避免在删除过程中修改数组导致的问题）
            const childIds = new Set<string>();
            
            // 从 children 字段获取子节点
            if (nodeToDelete.children && nodeToDelete.children.length > 0) {
                nodeToDelete.children.forEach(childId => {
                    childIds.add(childId);
                });
            }
            
            // 从 edges 中获取子节点
            const childEdges = edges.filter(e => e.source === id);
            childEdges.forEach(edge => {
                childIds.add(edge.target);
            });
            
            // 递归删除所有子节点
            childIds.forEach(childId => {
                deleteNodeRecursive(childId);
            });
            
            // 删除节点
            const index = nodes.findIndex(n => n.id === id);
            if (index !== -1) nodes.splice(index, 1);
            
            // 删除相关连接（包括作为 source 和 target 的边）
            edges = edges.filter(e => e.source !== id && e.target !== id);
        };

        // 如果节点有父节点，从父节点的子节点列表中移除
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
        
        // 从父节点的 edges 中移除（如果有的话）
        edges = edges.filter(e => !(e.source === node.parentId && e.target === nodeId));

        deleteNodeRecursive(nodeId);

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
    }

    /**
     * 添加连接
     */
    static async addEdge(
        domainId: string,
        docId: ObjectId,
        edge: Omit<MindMapEdge, 'id'>,
        branch?: string
    ): Promise<string> {
        let mindMap = await this.get(domainId, docId);
        if (!mindMap) {
            // 如果获取失败，可能是数据库延迟，尝试再获取一次
            await new Promise(resolve => setTimeout(resolve, 100)); // 等待100ms
            mindMap = await this.get(domainId, docId);
            if (!mindMap) {
                // 如果仍然获取失败，再等待一次
                await new Promise(resolve => setTimeout(resolve, 100)); // 再等待100ms
                mindMap = await this.get(domainId, docId);
                if (!mindMap) {
                    // 如果仍然获取失败，抛出错误
                    throw new Error('Base not found');
                }
            }
        }

        // 获取分支名称（优先使用传入的分支，否则使用 mindMap 中的分支，最后默认为 'main'）
        const branchName = branch || (mindMap as any).currentBranch || (mindMap as any).branch || 'main';
        const branchData: {
            [branch: string]: { nodes: MindMapNode[]; edges: MindMapEdge[] };
        } = (mindMap as any).branchData || {};

        // 确定使用哪个节点和边数组（使用与 getBranchData 相同的逻辑）
        let nodes: MindMapNode[];
        let edges: MindMapEdge[];
        
        // 如果存在 branchData，优先使用
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            // 向后兼容：如果 branchData 不存在，使用根节点的 nodes/edges（仅对 main 分支）
            nodes = mindMap.nodes || [];
            edges = mindMap.edges || [];
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
        const newEdge: MindMapEdge = {
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
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('Base not found');

        // 获取当前分支
        const currentBranch = (mindMap as any).currentBranch || 'main';
        const branchData: {
            [branch: string]: { nodes: MindMapNode[]; edges: MindMapEdge[] };
        } = (mindMap as any).branchData || {};

        const edgeIndex = mindMap.edges.findIndex(e => e.id === edgeId);
        if (edgeIndex !== -1) {
        mindMap.edges.splice(edgeIndex, 1);
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
            edges: mindMap.edges,
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
        nodes: MindMapNode[]
    ): Promise<void> {
        const mindMap = await this.get(domainId, docId);
        if (!mindMap) throw new Error('Base not found');

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
        if (!mindMap) throw new Error('Base not found');

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
    static async generateNextCid(domainId: string, mindMapDocId: ObjectId, nodeId: string): Promise<number> {
        const lastCard = await document.getMulti(domainId, TYPE_CARD, { mindMapDocId, nodeId })
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
        mindMapDocId: ObjectId,
        nodeId: string,
        owner: number,
        title: string,
        content: string = '',
        ip?: string,
        problems?: CardDoc['problems'],
    ): Promise<ObjectId> {
        const newCid = await this.generateNextCid(domainId, mindMapDocId, nodeId);

        const payload: Partial<CardDoc> = {
            docType: TYPE_CARD,
            domainId,
            mindMapDocId,
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
     * 获取 node 下的所有 cards
     */
    static async getByNodeId(domainId: string, mindMapDocId: ObjectId, nodeId: string): Promise<CardDoc[]> {
        const cards = await document.getMulti(domainId, TYPE_CARD, { mindMapDocId, nodeId })
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
        mindMapDocId?: ObjectId
    ): Promise<CardDoc | null> {
        const filter: any = { nodeId, cid };
        if (mindMapDocId) {
            filter.mindMapDocId = mindMapDocId;
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
global.Ejunz.model.base = MindMapModel;
// @ts-ignore
global.Ejunz.model.card = CardModel;
export default { MindMapModel, CardModel };


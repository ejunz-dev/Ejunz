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
 * Comment translated to English.
 */
export class BaseModel {
    private static getRootNodeId(nodes: BaseNode[] = [], edges: BaseEdge[] = []): string | null {
        if (!nodes.length) return null;
        const levelRoot = nodes.find((n) => n.level === 0);
        if (levelRoot) return levelRoot.id;
        const incoming = new Set(edges.map((e) => e.target));
        const noIncoming = nodes.find((n) => !incoming.has(n.id));
        return noIncoming ? noIncoming.id : nodes[0].id;
    }

    static async generateNextDocId(domainId: string): Promise<number> {
        const lastBase = await document.getMulti(domainId, TYPE_MM, { docId: { $type: 'number' } } as any)
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();
        return (Number(lastBase[0]?.docId) || 0) + 1;
    }

    /**
     * Comment translated to English.
     * Comment translated to English.
     */
    static async getByDomain(domainId: string): Promise<BaseDoc | null> {
        // Comment translated to English.
        const result = await document.getMulti(domainId, TYPE_MM, {
            type: { $ne: 'skill' }
        }).limit(1).toArray();
        return result.length > 0 ? result[0] : null;
    }

    static async getSkillBaseDocId(domainId: string): Promise<number | null> {
        const result = await document.getMulti(domainId, TYPE_MM, { type: 'skill' }).limit(1).toArray();
        if (result.length === 0) return null;
        const docId = (result[0] as any).docId;
        return docId != null ? docId : null;
    }

    /**
     * Comment translated to English.
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
        type?: 'base' | 'skill',
        forceNew?: boolean,
        bid?: string
    ): Promise<{ docId: number }> {
        // Comment translated to English.
        if (type === 'skill') {
            const existing = await document.getMulti(domainId, TYPE_MM, { type: 'skill' }).limit(1).toArray();
            if (existing.length > 0) {
                return { docId: existing[0].docId };
            }
        } else if (!forceNew) {
            // Comment translated to English.
            const existing = await this.getByDomain(domainId);
            if (existing) {
                // Comment translated to English.
                if (title && title !== existing.title) {
                    await this.update(domainId, existing.docId, { title });
                }
                if (content !== undefined && content !== existing.content) {
                    await this.update(domainId, existing.docId, { content });
                }
                return { docId: existing.docId };
            }
        }

        // Comment translated to English.
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
            type: type || 'base', // Comment translated to English.
            owner,
            bid: bid ? String(bid).trim() : undefined,
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
            parentId, // Comment translated to English.
        };

        const nextDocId = await this.generateNextDocId(domainId);
        const docId = await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_MM,
            nextDocId,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])
        );

        return { docId: Number(docId) };
    }

    /**
     * Comment translated to English.
     */
    static async get(domainId: string, docId: number | ObjectId): Promise<BaseDoc | null> {
        return await document.get(domainId, TYPE_MM, docId);
    }


    static async getBybid(domainId: string, bid: string | number): Promise<BaseDoc | null> {
        const bidString = String(bid).trim();
        if (!bidString) return null;
        const list = await document.getMulti(domainId, TYPE_MM, { bid: bidString } as Filter<BaseDoc>).limit(1).toArray();
        return list.length > 0 ? (list[0] as BaseDoc) : null;
    }

    /**
     * Comment translated to English.
     */
    static async getAll(domainId: string, query?: Filter<BaseDoc>): Promise<BaseDoc[]> {
        const filter: Filter<BaseDoc> = { type: { $ne: 'skill' } };
        const merged = query ? { ...filter, ...query } : filter;
        return await document.getMulti(domainId, TYPE_MM, merged).toArray();
    }

    /**
     * Comment translated to English.
     */
    static async getByRepo(domainId: string, rpid: number, branch?: string): Promise<BaseDoc[]> {
        const query: any = { rpid };
        if (branch) query.branch = branch;
        return await document.getMulti(domainId, TYPE_MM, query).toArray();
    }

    /**
     * Comment translated to English.
     */
    static async update(
        domainId: string,
        docId: number | ObjectId,
        updates: Partial<Pick<BaseDoc, 'title' | 'content' | 'layout' | 'viewport' | 'theme' | 'files' | 'parentId' | 'domainPosition'>>
    ): Promise<void> {
        const updatePayload: any = {
            ...updates,
            updateAt: new Date(),
        };
        if (typeof updates.title === 'string') {
            const base = await this.get(domainId, docId);
            if (base) {
                const rootId = this.getRootNodeId(base.nodes || [], base.edges || []);
                if (rootId) {
                    const newNodes = [...(base.nodes || [])];
                    const idx = newNodes.findIndex((n) => n.id === rootId);
                    if (idx >= 0) {
                        newNodes[idx] = { ...newNodes[idx], text: updates.title };
                        updatePayload.nodes = newNodes;
                    }
                    const branchData: any = (base as any).branchData || {};
                    if (branchData.main && Array.isArray(branchData.main.nodes)) {
                        const bNodes = [...branchData.main.nodes];
                        const bIdx = bNodes.findIndex((n: BaseNode) => n.id === rootId);
                        if (bIdx >= 0) {
                            bNodes[bIdx] = { ...bNodes[bIdx], text: updates.title };
                            updatePayload.branchData = {
                                ...branchData,
                                main: { ...branchData.main, nodes: bNodes },
                            };
                        }
                    }
                }
            }
        }
        await document.set(domainId, TYPE_MM, docId, updatePayload);
    }

    /**
     * Comment translated to English.
     */
    static async updateNode(
        domainId: string,
        docId: number | ObjectId,
        nodeId: string,
        updates: Partial<BaseNode>
    ): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        const nodeIndex = base.nodes.findIndex(n => n.id === nodeId);
        if (nodeIndex === -1) throw new Error('Node not found');

        // Comment translated to English.
        const newNodes = [...base.nodes];
        newNodes[nodeIndex] = {
            ...newNodes[nodeIndex],
            ...updates,
        };

        // Comment translated to English.
        const currentBranch = (base as any).currentBranch || 'main';
        
        // Comment translated to English.
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

        // Comment translated to English.
        const updatePayload: any = {
            nodes: newNodes,
            branchData: branchData,
            updateAt: new Date(),
        };
        if (typeof updates.text === 'string' && updates.text.trim()) {
            const currentBranchEdges = (branchData[currentBranch]?.edges || base.edges || []) as BaseEdge[];
            const currentBranchNodes = (branchData[currentBranch]?.nodes || newNodes) as BaseNode[];
            const rootNodeId = this.getRootNodeId(currentBranchNodes, currentBranchEdges);
            if (rootNodeId === nodeId) {
                updatePayload.title = updates.text;
            }
        }
        await document.set(domainId, TYPE_MM, docId, updatePayload);
    }

    /**
     * Comment translated to English.
     * Comment translated to English.
     * Comment translated to English.
     */
    static async addNode(
        domainId: string,
        docId: number | ObjectId,
        node: Omit<BaseNode, 'id'>,
        parentId?: string,
        branch?: string,
        edgeSourceId?: string
    ): Promise<{ nodeId: string; edgeId?: string }> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        // Comment translated to English.
        const branchName = branch || (base as any).currentBranch || (base as any).branch || 'main';
        const branchData: {
            [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] };
        } = (base as any).branchData || {};

        // Comment translated to English.
        let nodes: BaseNode[];
        let edges: BaseEdge[];
        
        // Comment translated to English.
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            // Comment translated to English.
            nodes = base.nodes || [];
            edges = base.edges || [];
        } else {
            // Comment translated to English.
            nodes = [];
            edges = [];
        }

        const newNodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newNode: BaseNode = {
            ...node,
            id: newNodeId,
        };

        // Comment translated to English.
        if (parentId) {
            const parentNode = nodes.find(n => n.id === parentId);
            if (!parentNode) throw new Error(`Parent node not found: ${parentId}. Branch: ${branchName}`);

            newNode.parentId = parentId;
            newNode.level = (parentNode.level || 0) + 1;

            // Comment translated to English.
            if (!parentNode.children) parentNode.children = [];
            parentNode.children.push(newNodeId);

            const parentIndex = nodes.findIndex(n => n.id === parentId);
            nodes[parentIndex] = parentNode;
        } else {
            newNode.level = 0;
        }

        nodes.push(newNode);

        // Comment translated to English.
        let newEdgeId: string | undefined;
        if (edgeSourceId) {
            // Comment translated to English.
            const sourceExists = nodes.some(n => n.id === edgeSourceId);
            if (!sourceExists) {
                throw new Error(`Source node not found: ${edgeSourceId}. Branch: ${branchName}`);
            }

            // Comment translated to English.
            const existingEdge = edges.find(
                e => e.source === edgeSourceId && e.target === newNodeId
            );
            
            if (existingEdge) {
                newEdgeId = existingEdge.id;
            } else {
                // Comment translated to English.
                newEdgeId = `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const newEdge: BaseEdge = {
                    id: newEdgeId,
                    source: edgeSourceId,
                    target: newNodeId,
                };
                edges.push(newEdge);
            }
        }

        // Comment translated to English.
        if (!branchData[branchName]) {
            branchData[branchName] = { nodes: [], edges: [] };
        }
        branchData[branchName] = {
            nodes: nodes,
            edges: edges,
        };

        // Comment translated to English.
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
     * Comment translated to English.
     */
    static async deleteNode(domainId: string, docId: number | ObjectId, nodeId: string, branch?: string): Promise<void> {
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

        const rootNodeId = this.getRootNodeId(nodes, edges);
        if (rootNodeId && nodeId === rootNodeId) {
            throw new Error('Root node cannot be deleted');
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
     * Comment translated to English.
     */
    static async addEdge(
        domainId: string,
        docId: number | ObjectId,
        edge: Omit<BaseEdge, 'id'>,
        branch?: string
    ): Promise<string> {
        let base = await this.get(domainId, docId);
        if (!base) {
            // Comment translated to English.
            await new Promise(resolve => setTimeout(resolve, 100)); // Comment translated to English.
            base = await this.get(domainId, docId);
            if (!base) {
                // Comment translated to English.
                await new Promise(resolve => setTimeout(resolve, 100)); // Comment translated to English.
                base = await this.get(domainId, docId);
                if (!base) {
                    // Comment translated to English.
                    throw new Error('Base not found');
                }
            }
        }

        // Comment translated to English.
        const branchName = branch || (base as any).currentBranch || (base as any).branch || 'main';
        const branchData: {
            [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] };
        } = (base as any).branchData || {};

        // Comment translated to English.
        let nodes: BaseNode[];
        let edges: BaseEdge[];
        
        // Comment translated to English.
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            // Comment translated to English.
            nodes = base.nodes || [];
            edges = base.edges || [];
        } else {
            // Comment translated to English.
            nodes = [];
            edges = [];
        }

        // Comment translated to English.
        const sourceExists = nodes.some(n => n.id === edge.source);
        const targetExists = nodes.some(n => n.id === edge.target);
        if (!sourceExists || !targetExists) {
            throw new Error(`Source or target node not found. Source: ${edge.source}, Target: ${edge.target}, Branch: ${branchName}`);
        }

        // Comment translated to English.
        const existingEdge = edges.find(
            e => e.source === edge.source && e.target === edge.target
        );
        if (existingEdge) {
            // Comment translated to English.
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

        // Comment translated to English.
        if (!branchData[branchName]) {
            branchData[branchName] = { nodes: nodes, edges: edges };
        } else {
            branchData[branchName] = {
                ...branchData[branchName],
                edges: edges,
            };
        }

        // Comment translated to English.
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
     * Comment translated to English.
     */
    static async deleteEdge(domainId: string, docId: number | ObjectId, edgeId: string): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        // Comment translated to English.
        const currentBranch = (base as any).currentBranch || 'main';
        const branchData: {
            [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] };
        } = (base as any).branchData || {};

        const edgeIndex = base.edges.findIndex(e => e.id === edgeId);
        if (edgeIndex !== -1) {
        base.edges.splice(edgeIndex, 1);
        }

        // Comment translated to English.
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
     * Comment translated to English.
     */
    static async updateNodes(
        domainId: string,
        docId: number | ObjectId,
        nodes: BaseNode[]
    ): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        // Comment translated to English.
        const nodeIds = new Set(base.nodes.map(n => n.id));
        for (const node of nodes) {
            if (!nodeIds.has(node.id)) {
                throw new Error(`Node ${node.id} not found`);
            }
        }

        // Comment translated to English.
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        base.nodes = base.nodes.map(n => nodeMap.get(n.id) || n);

        await document.set(domainId, TYPE_MM, docId, {
            nodes: base.nodes,
            updateAt: new Date(),
        });
    }

    /**
     * Comment translated to English.
     */
    static async updateEdges(
        domainId: string,
        docId: number | ObjectId,
        edges: BaseEdge[]
    ): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        // Comment translated to English.
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
     * Comment translated to English.
     */
    static async delete(domainId: string, docId: number | ObjectId): Promise<void> {
        await document.deleteOne(domainId, TYPE_MM, docId);
    }

    /**
     * Comment translated to English.
     */
    static async incrementViews(domainId: string, docId: number | ObjectId): Promise<void> {
        await document.inc(domainId, TYPE_MM, docId, 'views', 1);
    }

    /**
     * Comment translated to English.
     */
    static async updateFull(
        domainId: string,
        docId: number | ObjectId,
        updates: {
            nodes?: BaseNode[];
            edges?: BaseEdge[];
            branchData?: { [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] } };
            content?: string;
            title?: string;
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
    // Comment translated to English.
    (ctx as any).on('ready', async () => {
        // Comment translated to English.
    });
}

/**
 * Card Model
 * Comment translated to English.
 */
export class CardModel {
    /**
     * Comment translated to English.
     */
    static async generateNextCid(domainId: string, baseDocId: number | ObjectId, nodeId: string): Promise<number> {
        const lastCard = await document.getMulti(domainId, TYPE_CARD, { baseDocId, nodeId })
            .sort({ cid: -1 })
            .limit(1)
            .project({ cid: 1 })
            .toArray();
        return (lastCard[0]?.cid || 0) + 1;
    }

    /**
     * Create a card.
     * @param order Optional; if omitted, uses max(order)+1 for the node so new cards sort last when order is missing.
     */
    static async create(
        domainId: string,
        baseDocId: number | ObjectId,
        nodeId: string,
        owner: number,
        title: string,
        content: string = '',
        ip?: string,
        problems?: CardDoc['problems'],
        order?: number,
    ): Promise<ObjectId> {
        const newCid = await this.generateNextCid(domainId, baseDocId, nodeId);

        let orderValue = order;
        if (orderValue === undefined) {
            const lastByOrder = await document.getMulti(domainId, TYPE_CARD, { baseDocId, nodeId })
                .sort({ order: -1 })
                .limit(1)
                .project({ order: 1 })
                .toArray() as { order?: number }[];
            orderValue = (lastByOrder[0]?.order ?? -1) + 1;
        }

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
            order: orderValue,
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
     * Comment translated to English.
     */
    static async get(domainId: string, docId: ObjectId): Promise<CardDoc | null> {
        return await document.get(domainId, TYPE_CARD, docId);
    }

    /**
     * Comment translated to English.
     */
    static async getRecentUpdated(domainId: string, limit: number = 10): Promise<CardDoc[]> {
        const list = await document.getMulti(domainId, TYPE_CARD, {})
            .sort({ updateAt: -1 })
            .limit(limit)
            .toArray();
        return list as CardDoc[];
    }

    /**
     * Comment translated to English.
     */
    static async getByNodeId(domainId: string, baseDocId: number | ObjectId, nodeId: string): Promise<CardDoc[]> {
        const cards = await document.getMulti(domainId, TYPE_CARD, { baseDocId, nodeId })
            .sort({ order: 1, cid: 1 })
            .toArray();
        return cards;
    }

    /**
     * Comment translated to English.
     */
    static async getByCid(
        domainId: string,
        nodeId: string,
        cid: number,
        baseDocId?: number | ObjectId
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
     * Comment translated to English.
     */
    static async update(
        domainId: string,
        docId: ObjectId,
        updates: Partial<Pick<CardDoc, 'title' | 'content' | 'cardFace' | 'order' | 'nodeId' | 'problems' | 'files' | 'baseDocId'>>
    ): Promise<void> {
        await document.set(domainId, TYPE_CARD, docId, {
            ...updates,
            updateAt: new Date(),
        });
    }

    /**
     * Comment translated to English.
     */
    static async delete(domainId: string, docId: ObjectId): Promise<void> {
        await document.deleteOne(domainId, TYPE_CARD, docId);
    }

    /**
     * Comment translated to English.
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


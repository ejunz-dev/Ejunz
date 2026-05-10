import { _, ObjectId, Filter } from '../libs';
import * as document from './document';
import { buildProjection } from '../utils';
import type { Context } from '../context';
import type { BaseDoc, BaseNode, BaseEdge, CardDoc, BaseHistoryEntry } from '../interface';
import db from '../service/db';
import { Collection } from 'mongodb';

export const TYPE_CARD: 71 = 71;

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
        const lastBase = await document.getMulti(domainId, document.TYPE_BASE, { docId: { $type: 'number' } } as any)
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();
        return (Number(lastBase[0]?.docId) || 0) + 1;
    }

    static async getByDomain(domainId: string): Promise<BaseDoc | null> {
        const result = await document.getMulti(domainId, document.TYPE_BASE, {
            type: { $nin: ['skill', 'training'] }
        }).limit(1).toArray();
        return result.length > 0 ? result[0] : null;
    }

    static async getSkillBaseDocId(domainId: string): Promise<number | null> {
        const result = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' }).limit(1).toArray();
        if (result.length === 0) return null;
        const docId = (result[0] as any).docId;
        return docId != null ? docId : null;
    }

    /**
    
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
        if (type === 'skill') {
            const existing = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' }).limit(1).toArray();
            if (existing.length > 0) {
                return { docId: existing[0].docId };
            }
        } else if (!forceNew) {
            const existing = await this.getByDomain(domainId);
            if (existing) {
                if (title && title !== existing.title) {
                    await this.update(domainId, existing.docId, { title });
                }
                if (content !== undefined && content !== existing.content) {
                    await this.update(domainId, existing.docId, { content });
                }
                return { docId: existing.docId };
            }
        }

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
            docType: document.TYPE_BASE,
            domainId,
            title: title || '未命名思维导图',
            content: content || '',
            type: type || 'base',
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
            parentId,
        };

        const nextDocId = await this.generateNextDocId(domainId);
        const docId = await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            document.TYPE_BASE,
            nextDocId,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner'])
        );

        return { docId: Number(docId) };
    }

    static async get(domainId: string, docId: number): Promise<BaseDoc | null> {
        return await document.get(domainId, document.TYPE_BASE, docId);
    }


    static async getBybid(domainId: string, bid: string | number): Promise<BaseDoc | null> {
        const bidString = String(bid).trim();
        if (!bidString) return null;
        const list = await document.getMulti(domainId, document.TYPE_BASE, { bid: bidString } as Filter<BaseDoc>).limit(1).toArray();
        return list.length > 0 ? (list[0] as BaseDoc) : null;
    }

    static async getAll(domainId: string, query?: Filter<BaseDoc>): Promise<BaseDoc[]> {
        const filter: Filter<BaseDoc> = { type: { $nin: ['skill', 'training'] } };
        const merged = query ? { ...filter, ...query } : filter;
        return await document.getMulti(domainId, document.TYPE_BASE, merged).toArray();
    }

    static async getRecentUpdated(domainId: string, limit: number = 10): Promise<BaseDoc[]> {
        const list = await document
            .getMulti(domainId, document.TYPE_BASE, { type: { $nin: ['skill', 'training'] } } as Filter<BaseDoc>)
            .sort({ updateAt: -1 })
            .limit(limit)
            .toArray();
        return list as BaseDoc[];
    }

    static async getByRepo(domainId: string, rpid: number, branch?: string): Promise<BaseDoc[]> {
        const query: any = { rpid, type: { $nin: ['skill', 'training'] } };
        if (branch) query.branch = branch;
        return await document.getMulti(domainId, document.TYPE_BASE, query).toArray();
    }

    static async update(
        domainId: string,
        docId: number,
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
        await document.set(domainId, document.TYPE_BASE, docId, updatePayload);
    }

    static async updateNode(
        domainId: string,
        docId: number,
        nodeId: string,
        updates: Partial<BaseNode>,
        branch?: string
    ): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        const branchName = branch || (base as any).currentBranch || 'main';
        const branchData: { [b: string]: { nodes: BaseNode[]; edges: BaseEdge[] } } = (base as any).branchData || {};

        let nodes: BaseNode[];
        let edges: BaseEdge[];
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            nodes = base.nodes || [];
            edges = base.edges || [];
        } else {
            throw new Error(`Branch "${branchName}" has no data`);
        }

        const nodeIndex = nodes.findIndex(n => n.id === nodeId);
        if (nodeIndex === -1) throw new Error('Node not found');

        nodes[nodeIndex] = { ...nodes[nodeIndex], ...updates };

        if (!branchData[branchName]) {
            branchData[branchName] = { nodes: [], edges: [] };
        }
        branchData[branchName] = { nodes, edges };

        const updatePayload: any = {
            branchData,
            updateAt: new Date(),
        };

        if (branchName === 'main') {
            updatePayload.nodes = nodes;
            updatePayload.edges = edges;
        }

        if (typeof updates.text === 'string' && updates.text.trim()) {
            const rootNodeId = this.getRootNodeId(nodes, edges);
            if (rootNodeId === nodeId) {
                updatePayload.title = updates.text;
            }
        }
        await document.set(domainId, document.TYPE_BASE, docId, updatePayload);
    }

    static async addNode(
        domainId: string,
        docId: number,
        node: Omit<BaseNode, 'id'>,
        parentId?: string,
        branch?: string,
        edgeSourceId?: string
    ): Promise<{ nodeId: string; edgeId?: string }> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

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

        const newNodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newNode: BaseNode = {
            ...node,
            id: newNodeId,
        };

        if (parentId) {
            const parentNode = nodes.find(n => n.id === parentId);
            if (!parentNode) throw new Error(`Parent node not found: ${parentId}. Branch: ${branchName}`);

            newNode.parentId = parentId;
            newNode.level = (parentNode.level || 0) + 1;

            if (!parentNode.children) parentNode.children = [];
            parentNode.children.push(newNodeId);

            const parentIndex = nodes.findIndex(n => n.id === parentId);
            nodes[parentIndex] = parentNode;
        } else {
            newNode.level = 0;
        }

        nodes.push(newNode);

        let newEdgeId: string | undefined;
        if (edgeSourceId) {
            const sourceExists = nodes.some(n => n.id === edgeSourceId);
            if (!sourceExists) {
                throw new Error(`Source node not found: ${edgeSourceId}. Branch: ${branchName}`);
            }

            const existingEdge = edges.find(
                e => e.source === edgeSourceId && e.target === newNodeId
            );
            
            if (existingEdge) {
                newEdgeId = existingEdge.id;
            } else {
                newEdgeId = `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const newEdge: BaseEdge = {
                    id: newEdgeId,
                    source: edgeSourceId,
                    target: newNodeId,
                };
                edges.push(newEdge);
            }
        }

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

        await document.set(domainId, document.TYPE_BASE, docId, updateData);

        return { nodeId: newNodeId, edgeId: newEdgeId };
    }

    static async deleteNode(domainId: string, docId: number, nodeId: string, branch?: string): Promise<void> {
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
                const cards = await CardModel.getByNodeId(actualDomainId, base.docId, nodeId, branchName);
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
                const cards = await CardModel.getByNodeId(actualDomainId, docId, nodeIdToDelete, branchName);
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

        await document.set(actualDomainId, document.TYPE_BASE, docId, updateData);
    }

    static async addEdge(
        domainId: string,
        docId: number,
        edge: Omit<BaseEdge, 'id'>,
        branch?: string
    ): Promise<string> {
        let base = await this.get(domainId, docId);
        if (!base) {
            await new Promise(resolve => setTimeout(resolve, 100));
            base = await this.get(domainId, docId);
            if (!base) {
                await new Promise(resolve => setTimeout(resolve, 100));
                base = await this.get(domainId, docId);
                if (!base) {
                    throw new Error('Base not found');
                }
            }
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

        const sourceExists = nodes.some(n => n.id === edge.source);
        const targetExists = nodes.some(n => n.id === edge.target);
        if (!sourceExists || !targetExists) {
            throw new Error(`Source or target node not found. Source: ${edge.source}, Target: ${edge.target}, Branch: ${branchName}`);
        }

        const existingEdge = edges.find(
            e => e.source === edge.source && e.target === edge.target
        );
        if (existingEdge) {
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

            await document.set(domainId, document.TYPE_BASE, docId, updateData);

            return existingEdge.id;
        }

        const newEdgeId = `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newEdge: BaseEdge = {
            ...edge,
            id: newEdgeId,
        };

        edges.push(newEdge);

        if (!branchData[branchName]) {
            branchData[branchName] = { nodes: nodes, edges: edges };
        } else {
            branchData[branchName] = {
                ...branchData[branchName],
                edges: edges,
            };
        }

        const updateData: any = {
            branchData: branchData,
            updateAt: new Date(),
        };
        
        if (branchName === 'main') {
            updateData.nodes = nodes;
            updateData.edges = edges;
        }

        await document.set(domainId, document.TYPE_BASE, docId, updateData);

        return newEdgeId;
    }

    static async deleteEdge(domainId: string, docId: number, edgeId: string, branch?: string): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        const branchName = branch || (base as any).currentBranch || 'main';
        const branchData: { [b: string]: { nodes: BaseNode[]; edges: BaseEdge[] } } = (base as any).branchData || {};

        let nodes: BaseNode[];
        let edges: BaseEdge[];
        if (branchData[branchName] && branchData[branchName].nodes) {
            nodes = branchData[branchName].nodes;
            edges = branchData[branchName].edges || [];
        } else if (branchName === 'main') {
            nodes = base.nodes || [];
            edges = base.edges || [];
        } else {
            return;
        }

        const edgeIndex = edges.findIndex(e => e.id === edgeId);
        if (edgeIndex !== -1) {
            edges.splice(edgeIndex, 1);
        }

        if (!branchData[branchName]) {
            branchData[branchName] = { nodes: [], edges: [] };
        }
        branchData[branchName] = { nodes, edges };

        const updatePayload: any = {
            branchData,
            updateAt: new Date(),
        };

        if (branchName === 'main') {
            updatePayload.nodes = nodes;
            updatePayload.edges = edges;
        }

        await document.set(domainId, document.TYPE_BASE, docId, updatePayload);
    }

    static async updateNodes(
        domainId: string,
        docId: number,
        nodes: BaseNode[]
    ): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        const nodeIds = new Set(base.nodes.map(n => n.id));
        for (const node of nodes) {
            if (!nodeIds.has(node.id)) {
                throw new Error(`Node ${node.id} not found`);
            }
        }

        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        base.nodes = base.nodes.map(n => nodeMap.get(n.id) || n);

        await document.set(domainId, document.TYPE_BASE, docId, {
            nodes: base.nodes,
            updateAt: new Date(),
        });
    }

    static async updateEdges(
        domainId: string,
        docId: number,
        edges: BaseEdge[]
    ): Promise<void> {
        const base = await this.get(domainId, docId);
        if (!base) throw new Error('Base not found');

        const edgeIds = new Set(base.edges.map(e => e.id));
        for (const edge of edges) {
            if (!edgeIds.has(edge.id)) {
                throw new Error(`Edge ${edge.id} not found`);
            }
        }

        await document.set(domainId, document.TYPE_BASE, docId, {
            edges: edges,
            updateAt: new Date(),
        });
    }

    static async delete(domainId: string, docId: number): Promise<void> {
        await document.deleteOne(domainId, document.TYPE_BASE, docId);
    }

    static async incrementViews(domainId: string, docId: number): Promise<void> {
        await document.inc(domainId, document.TYPE_BASE, docId, 'views', 1);
    }

    static async updateFull(
        domainId: string,
        docId: number,
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
            problemTags?: string[];
        }
    ): Promise<void> {
        await document.set(domainId, document.TYPE_BASE, docId, {
            ...updates,
            updateAt: new Date(),
        });
    }
}

export function apply(ctx: Context) {
    (ctx as any).on('ready', async () => {
    });
}

export class CardModel {
    static async generateNextCid(domainId: string, baseDocId: number | ObjectId, nodeId: string): Promise<number> {
        const lastCard = await document.getMulti(domainId, TYPE_CARD, { baseDocId, nodeId })
            .sort({ cid: -1 })
            .limit(1)
            .project({ cid: 1 })
            .toArray();
        return (lastCard[0]?.cid || 0) + 1;
    }

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
        branch?: string,
    ): Promise<ObjectId> {
        const newCid = await this.generateNextCid(domainId, baseDocId, nodeId);

        let orderValue = order;
        if (orderValue === undefined) {
            const filter: any = { baseDocId, nodeId };
            if (branch) filter.branch = branch;
            const lastByOrder = await document.getMulti(domainId, TYPE_CARD, filter)
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
        if (branch) {
            (payload as any).branch = branch;
        }
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

    static async get(domainId: string, docId: ObjectId): Promise<CardDoc | null> {
        return await document.get(domainId, TYPE_CARD, docId);
    }

    static async getRecentUpdated(domainId: string, limit: number = 10): Promise<CardDoc[]> {
        const list = await document.getMulti(domainId, TYPE_CARD, {})
            .sort({ updateAt: -1 })
            .limit(limit)
            .toArray();
        return list as CardDoc[];
    }

    static async getByNodeId(domainId: string, baseDocId: number | ObjectId, nodeId: string, branch?: string): Promise<CardDoc[]> {
        const filter: any = { baseDocId, nodeId };
        if (branch) {
            if (branch === 'main') {
                filter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
            } else {
                filter.branch = branch;
            }
        }
        const cards = await document.getMulti(domainId, TYPE_CARD, filter)
            .sort({ order: 1, cid: 1 })
            .toArray();
        return cards;
    }

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

    /** 用于学习 DAG 缓存失效：卡片变更不会写回 base 的 `updateAt`，需单独参与版本计算。 */
    static async maxUpdateAtMsForBase(domainId: string, baseDocId: number | ObjectId): Promise<number> {
        const rows = await document.getMulti(domainId, document.TYPE_CARD, { baseDocId })
            .sort({ updateAt: -1 })
            .limit(1)
            .project({ updateAt: 1 })
            .toArray();
        const u = (rows[0] as CardDoc | undefined)?.updateAt;
        return u instanceof Date ? u.getTime() : 0;
    }

    static async delete(domainId: string, docId: ObjectId): Promise<void> {
        await document.deleteOne(domainId, TYPE_CARD, docId);
    }

    static async incrementViews(domainId: string, docId: ObjectId): Promise<void> {
        await document.inc(domainId, TYPE_CARD, docId, 'views', 1);
    }
}

// @ts-ignore
global.Ejunz.model.base = BaseModel;
// @ts-ignore
global.Ejunz.model.card = CardModel;
export default { BaseModel, CardModel };


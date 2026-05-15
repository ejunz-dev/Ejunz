import { _, ObjectId, Filter } from '../libs';
import * as document from './document';
import { buildProjection } from '../utils';
import type { Context } from '../context';
import type { BaseDoc, BaseNode, BaseEdge, CardDoc, BaseHistoryEntry } from '../interface';
import db from '../service/db';
import { Collection } from 'mongodb';

export const TYPE_CARD: 71 = 71;

export type MindMapDocType = typeof document.TYPE_BASE | typeof document.TYPE_SKILL;

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
        const result = await document.getMulti(domainId, document.TYPE_BASE, {}).limit(1).toArray();
        return result.length > 0 ? result[0] : null;
    }

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
        forceNew?: boolean,
        bid?: string
    ): Promise<{ docId: number }> {
        if (!forceNew) {
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

    static async get(domainId: string, docId: number, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<BaseDoc | null> {
        return (await document.get(domainId, mapDocType, docId)) as BaseDoc | null;
    }


    static async getBybid(domainId: string, bid: string | number): Promise<BaseDoc | null> {
        const bidString = String(bid).trim();
        if (!bidString) return null;
        const list = await document.getMulti(domainId, document.TYPE_BASE, { bid: bidString } as Filter<BaseDoc>).limit(1).toArray();
        return list.length > 0 ? (list[0] as BaseDoc) : null;
    }

    static async getAll(domainId: string, query?: Filter<BaseDoc>): Promise<BaseDoc[]> {
        const merged = (query || {}) as Filter<BaseDoc>;
        return await document.getMulti(domainId, document.TYPE_BASE, merged).toArray();
    }

    /** Recently updated knowledge bases (`TYPE_BASE` only). */
    static async getRecentUpdated(domainId: string, limit: number = 10): Promise<BaseDoc[]> {
        const list = await document
            .getMulti(domainId, document.TYPE_BASE, {} as Filter<BaseDoc>)
            .sort({ updateAt: -1 })
            .limit(limit)
            .toArray();
        return list as BaseDoc[];
    }

    static async getByRepo(domainId: string, rpid: number, branch?: string): Promise<BaseDoc[]> {
        const andParts: Filter<BaseDoc>[] = [{ rpid } as Filter<BaseDoc>];
        if (branch) andParts.push({ branch } as Filter<BaseDoc>);
        return await document.getMulti(domainId, document.TYPE_BASE, { $and: andParts } as Filter<BaseDoc>).toArray();
    }

    static async update(
        domainId: string,
        docId: number,
        updates: Partial<Pick<BaseDoc, 'title' | 'content' | 'layout' | 'viewport' | 'theme' | 'files' | 'parentId' | 'domainPosition'>>,
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<void> {
        const updatePayload: any = {
            ...updates,
            updateAt: new Date(),
        };
        if (typeof updates.title === 'string') {
            const base = await this.get(domainId, docId, mapDocType);
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
        await document.set(domainId, mapDocType, docId, updatePayload);
    }

    static async updateNode(
        domainId: string,
        docId: number,
        nodeId: string,
        updates: Partial<BaseNode>,
        branch?: string,
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<void> {
        const base = await this.get(domainId, docId, mapDocType);
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
        await document.set(domainId, mapDocType, docId, updatePayload);
    }

    static async addNode(
        domainId: string,
        docId: number,
        node: Omit<BaseNode, 'id'>,
        parentId?: string,
        branch?: string,
        edgeSourceId?: string,
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<{ nodeId: string; edgeId?: string }> {
        const base = await this.get(domainId, docId, mapDocType);
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

        await document.set(domainId, mapDocType, docId, updateData);

        return { nodeId: newNodeId, edgeId: newEdgeId };
    }

    static async deleteNode(domainId: string, docId: number, nodeId: string, branch?: string, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<void> {
        const actualDomainId = typeof domainId === 'string' ? domainId : String(domainId);
        const base = await this.get(actualDomainId, docId, mapDocType);
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

        await document.set(actualDomainId, mapDocType, docId, updateData);
    }

    static async addEdge(
        domainId: string,
        docId: number,
        edge: Omit<BaseEdge, 'id'>,
        branch?: string,
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<string> {
        let base = await this.get(domainId, docId, mapDocType);
        if (!base) {
            await new Promise(resolve => setTimeout(resolve, 100));
            base = await this.get(domainId, docId, mapDocType);
            if (!base) {
                await new Promise(resolve => setTimeout(resolve, 100));
                base = await this.get(domainId, docId, mapDocType);
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

            await document.set(domainId, mapDocType, docId, updateData);

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

        await document.set(domainId, mapDocType, docId, updateData);

        return newEdgeId;
    }

    static async deleteEdge(domainId: string, docId: number, edgeId: string, branch?: string, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<void> {
        const base = await this.get(domainId, docId, mapDocType);
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

        await document.set(domainId, mapDocType, docId, updatePayload);
    }

    static async updateNodes(
        domainId: string,
        docId: number,
        nodes: BaseNode[],
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<void> {
        const base = await this.get(domainId, docId, mapDocType);
        if (!base) throw new Error('Base not found');

        const nodeIds = new Set(base.nodes.map(n => n.id));
        for (const node of nodes) {
            if (!nodeIds.has(node.id)) {
                throw new Error(`Node ${node.id} not found`);
            }
        }

        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        base.nodes = base.nodes.map(n => nodeMap.get(n.id) || n);

        await document.set(domainId, mapDocType, docId, {
            nodes: base.nodes,
            updateAt: new Date(),
        });
    }

    static async updateEdges(
        domainId: string,
        docId: number,
        edges: BaseEdge[],
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<void> {
        const base = await this.get(domainId, docId, mapDocType);
        if (!base) throw new Error('Base not found');

        const edgeIds = new Set(base.edges.map(e => e.id));
        for (const edge of edges) {
            if (!edgeIds.has(edge.id)) {
                throw new Error(`Edge ${edge.id} not found`);
            }
        }

        await document.set(domainId, mapDocType, docId, {
            edges: edges,
            updateAt: new Date(),
        });
    }

    static async delete(domainId: string, docId: number, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<void> {
        await document.deleteOne(domainId, mapDocType, docId);
    }

    static async incrementViews(domainId: string, docId: number, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<void> {
        await document.inc(domainId, mapDocType, docId, 'views', 1);
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
        },
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<void> {
        await document.set(domainId, mapDocType, docId, {
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

/** URL query–driven narrowing for outline file-tree (used by outline / base data handlers). */
export type OutlineExplorerFilters = {
    filterNode: string;
    filterCard: string;
    filterProblem: string;
};

function cardMatchesOutlineExplorerFilters(
    card: CardDoc,
    filterCardLc: string,
    filterProblemLc: string,
): boolean {
    const needCard = filterCardLc.length > 0;
    const needProb = filterProblemLc.length > 0;
    if (!needCard && !needProb) return true;
    let okCard = !needCard;
    if (needCard) {
        const t = (card.title || '').toLowerCase();
        okCard = t.includes(filterCardLc);
    }
    let okProb = !needProb;
    if (needProb) {
        const probs = card.problems || [];
        okProb = probs.some((pr) => {
            try {
                return JSON.stringify(pr).toLowerCase().includes(filterProblemLc);
            } catch {
                return false;
            }
        });
    }
    return okCard && okProb;
}

function nodeDirectHitForOutlineExplorer(
    nodeId: string,
    nodeById: Map<string, BaseNode>,
    nodeCardsMap: Record<string, CardDoc[]>,
    fn: string,
    fc: string,
    fp: string,
): boolean {
    const needNode = fn.length > 0;
    const needCardDim = fc.length > 0 || fp.length > 0;
    if (!needNode && !needCardDim) return true;
    const parts: boolean[] = [];
    if (needNode) {
        const n = nodeById.get(nodeId);
        parts.push(!!n && (n.text || '').toLowerCase().includes(fn));
    }
    if (needCardDim) {
        const cards = nodeCardsMap[nodeId] || [];
        parts.push(cards.some((c) => cardMatchesOutlineExplorerFilters(c, fc, fp)));
    }
    return parts.every(Boolean);
}

export function hasActiveOutlineExplorerFilters(f: OutlineExplorerFilters): boolean {
    return !!(f.filterNode?.trim() || f.filterCard?.trim() || f.filterProblem?.trim());
}

export function outlineExplorerFiltersFromQuery(
    query: Record<string, unknown> | undefined | null,
): OutlineExplorerFilters {
    const g = (k: string) => {
        const v = query?.[k];
        return typeof v === 'string' ? v : '';
    };
    return {
        filterNode: g('filterNode'),
        filterCard: g('filterCard'),
        filterProblem: g('filterProblem'),
    };
}

export function trimOutlineExplorerFiltersForClient(
    f: OutlineExplorerFilters,
): OutlineExplorerFilters {
    return {
        filterNode: f.filterNode.trim(),
        filterCard: f.filterCard.trim(),
        filterProblem: f.filterProblem.trim(),
    };
}

/**
 * Restricts outline file-tree nodes/edges and card lists using URL query keywords.
 * When multiple dimensions are set (node / card / problem), a node matches only if
 * every active dimension is satisfied (node title, card title only, problems).
 */
export function applyOutlineExplorerUrlFilters(
    nodes: BaseNode[],
    edges: BaseEdge[],
    nodeCardsMap: Record<string, CardDoc[]>,
    filters: OutlineExplorerFilters,
): { nodes: BaseNode[]; edges: BaseEdge[]; nodeCardsMap: Record<string, CardDoc[]> } {
    const fn = filters.filterNode.trim().toLowerCase();
    const fc = filters.filterCard.trim().toLowerCase();
    const fp = filters.filterProblem.trim().toLowerCase();
    if (!fn && !fc && !fp) {
        return { nodes, edges, nodeCardsMap };
    }

    const parentMap = new Map<string, string>();
    const childrenMap = new Map<string, string[]>();
    for (const e of edges) {
        parentMap.set(e.target, e.source);
        if (!childrenMap.has(e.source)) childrenMap.set(e.source, []);
        childrenMap.get(e.source)!.push(e.target);
    }

    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const roots = nodes.filter((n) => !parentMap.has(n.id));

    const relevant = new Set<string>();
    function dfs(nodeId: string): boolean {
        const children = childrenMap.get(nodeId) || [];
        let childRel = false;
        for (const c of children) {
            if (dfs(c)) childRel = true;
        }
        const direct = nodeDirectHitForOutlineExplorer(nodeId, nodeById, nodeCardsMap, fn, fc, fp);
        if (direct || childRel) {
            relevant.add(nodeId);
            return true;
        }
        return false;
    }
    for (const r of roots) dfs(r.id);

    if (relevant.size === 0) {
        return { nodes: [], edges: [], nodeCardsMap: {} };
    }

    const visible = new Set(relevant);
    for (const id of relevant) {
        let p = parentMap.get(id);
        while (p) {
            visible.add(p);
            p = parentMap.get(p);
        }
    }

    const visibleNodes = nodes.filter((n) => visible.has(n.id));
    const visibleEdges = edges.filter((e) => visible.has(e.source) && visible.has(e.target));

    const filteredMap: Record<string, CardDoc[]> = {};
    for (const nodeId of Object.keys(nodeCardsMap)) {
        if (!visible.has(nodeId)) continue;
        let list = [...(nodeCardsMap[nodeId] || [])];
        if (fc || fp) {
            list = list.filter((c) => cardMatchesOutlineExplorerFilters(c, fc, fp));
        }
        filteredMap[nodeId] = list;
    }

    return { nodes: visibleNodes, edges: visibleEdges, nodeCardsMap: filteredMap };
}

/** Optional numeric base doc id from POST body or query (used by mindmap / base APIs). */
export function readOptionalRequestBaseDocId(req: { body?: any; query?: any } | undefined): number | undefined {
    if (!req) return undefined;
    const body = req.body || {};
    const q = req.query || {};
    const raw = body.docId ?? body.baseDocId ?? q.docId;
    if (raw === undefined || raw === null || raw === '') return undefined;
    try {
        const n = Number(raw);
        if (!Number.isSafeInteger(n) || n <= 0) return undefined;
        return n;
    } catch {
        return undefined;
    }
}

/** De-dupe rapid repeat node-creation requests (mindmap node API). */
export const nodeCreationDedupCache = new Map<string, number>();
export const DEDUP_WINDOW_MS = 2000;

export function getBranchData(base: BaseDoc, branch: string): { nodes: BaseNode[]; edges: BaseEdge[] } {
    const branchName = branch || 'main';

    if (base.branchData && base.branchData[branchName]) {
        let nodes = base.branchData[branchName].nodes || [];
        let edges = base.branchData[branchName].edges || [];
        /**
         * Some saves only populate `base.nodes` / `base.edges` for main while `branchData.main` exists
         * but is still empty — outline / develop must not treat the branch as having no nodes.
         */
        if (branchName === 'main' && nodes.length === 0 && (base.nodes?.length || 0) > 0) {
            nodes = base.nodes || [];
            edges = base.edges || [];
        }
        return { nodes, edges };
    }

    if (branchName === 'main') {
        return {
            nodes: base.nodes || [],
            edges: base.edges || [],
        };
    }

    return { nodes: [], edges: [] };
}

export function setBranchData(base: BaseDoc, branch: string, nodes: BaseNode[], edges: BaseEdge[]): void {
    const branchName = branch || 'main';

    if (!base.branchData) {
        base.branchData = {};
    }

    base.branchData[branchName] = { nodes, edges };

    if (branchName === 'main') {
        base.nodes = nodes;
        base.edges = edges;
    }
}

/**
 * Longest root-to-leaf path length (each node counts as one layer). Forest-safe.
 */
export function computeMaxNodeLayers(nodes: BaseNode[], edges: BaseEdge[]): number {
    if (!nodes?.length) return 0;
    const nodeIds = new Set(nodes.map((n) => n.id));
    const children = new Map<string, string[]>();
    for (const e of edges || []) {
        if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
        if (!children.has(e.source)) children.set(e.source, []);
        children.get(e.source)!.push(e.target);
    }
    const hasParent = new Set<string>();
    for (const e of edges || []) {
        if (nodeIds.has(e.target)) hasParent.add(e.target);
    }
    const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
    const startIds = roots.length > 0 ? roots : nodes.map((n) => n.id);

    let maxDepth = 0;
    const memo = new Map<string, number>();

    function depth(nodeId: string, visiting: Set<string>): number {
        if (memo.has(nodeId)) return memo.get(nodeId)!;
        if (visiting.has(nodeId)) return 1;
        visiting.add(nodeId);
        const cs = children.get(nodeId) || [];
        let d = 1;
        if (cs.length) {
            for (const c of cs) {
                d = Math.max(d, 1 + depth(c, visiting));
            }
        }
        visiting.delete(nodeId);
        memo.set(nodeId, d);
        return d;
    }

    for (const r of startIds) {
        maxDepth = Math.max(maxDepth, depth(r, new Set()));
    }
    return maxDepth;
}

/**
 * Count of distinct nodes one hop below root(s): targets of edges whose source is a root (no incoming edge).
 */
export function countMainLevelChildNodes(nodes: BaseNode[], edges: BaseEdge[]): number {
    if (!nodes?.length) return 0;
    const nodeIds = new Set(nodes.map((n) => n.id));
    const hasParent = new Set<string>();
    for (const e of edges || []) {
        if (nodeIds.has(e.target)) hasParent.add(e.target);
    }
    const roots = nodes.filter((n) => !hasParent.has(n.id));
    if (roots.length === 0) return 0;
    const rootSet = new Set(roots.map((r) => r.id));
    const firstLevel = new Set<string>();
    for (const e of edges || []) {
        if (rootSet.has(e.source) && nodeIds.has(e.target)) {
            firstLevel.add(e.target);
        }
    }
    return firstLevel.size;
}

export type BaseListCardStats = { cardCount: number; problemCount: number };

/** Card + problem counts per baseDocId for main-branch cards (and legacy docs without branch). */
export async function loadCardStatsByBaseDocId(
    domainId: string,
    baseDocIds: number[],
): Promise<Map<number, BaseListCardStats>> {
    const map = new Map<number, BaseListCardStats>();
    const ids = [...new Set(baseDocIds.filter((n) => Number.isFinite(n) && n > 0))];
    if (ids.length === 0) return map;

    const pipeline: Record<string, unknown>[] = [
        {
            $match: {
                domainId,
                docType: document.TYPE_CARD,
                baseDocId: { $in: ids },
                $or: [{ branch: 'main' }, { branch: { $exists: false } }],
            },
        },
        {
            $group: {
                _id: '$baseDocId',
                cardCount: { $sum: 1 },
                problemCount: { $sum: { $size: { $ifNull: ['$problems', []] } } },
            },
        },
    ];

    const rows = (await document.coll.aggregate(pipeline).toArray()) as Array<{
        _id: number;
        cardCount: number;
        problemCount: number;
    }>;

    for (const row of rows) {
        const id = Number(row._id);
        if (!Number.isFinite(id)) continue;
        map.set(id, {
            cardCount: Number(row.cardCount) || 0,
            problemCount: Number(row.problemCount) || 0,
        });
    }
    return map;
}

/** Attach list row stats (node/card/problem counts, depth) for base list UIs. */
export function attachBaseListStats<T extends BaseDoc & { docId?: number | string }>(
    bases: T[],
    cardStats: Map<number, { cardCount: number; problemCount: number }>,
): Array<T & {
    listStats: {
        nodeCount: number;
        mainLevelCount: number;
        cardCount: number;
        problemCount: number;
        maxLayers: number;
    };
}> {
    return bases.map((b) => {
        const id = typeof b.docId === 'number' ? b.docId : Number((b as any).docId);
        const { nodes, edges } = getBranchData(b as BaseDoc, 'main');
        const cs = Number.isFinite(id) ? cardStats.get(id) : undefined;
        return {
            ...b,
            listStats: {
                nodeCount: nodes.length,
                mainLevelCount: countMainLevelChildNodes(nodes, edges),
                cardCount: cs?.cardCount ?? 0,
                problemCount: cs?.problemCount ?? 0,
                maxLayers: computeMaxNodeLayers(nodes, edges),
            },
        };
    });
}

// @ts-ignore
global.Ejunz.model.base = BaseModel;
// @ts-ignore
global.Ejunz.model.card = CardModel;
export default { BaseModel, CardModel };


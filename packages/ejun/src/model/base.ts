import { _, ObjectId, Filter } from '../libs';
import * as document from './document';
import { buildProjection } from '../utils';
import type { Context } from '../context';
import storage from './storage';
import type { BaseDoc, BaseNode, BaseEdge, CardDoc, BaseHistoryEntry, PluginDoc } from '../interface';
import db from '../service/db';
import { Collection, type Db } from 'mongodb';
import { ValidationError } from '../error';

export const TYPE_CARD: 71 = 71;

const BASE_EDITOR_EXPLORER_MODES = new Set(['tree', 'pending', 'git', 'mcp']);
const BASE_EDITOR_NODE_SIDE_TABS = new Set(['intent', 'files', 'develop_queue']);
const BASE_EDITOR_RIGHT_PANEL_TABS = new Set(['problems', 'develop_queue', 'plugin_node', 'plugin_mcp_services', 'roadmap_edge']);

const BASE_EDITOR_EXPLORER_W_MIN = 180;
const BASE_EDITOR_EXPLORER_W_MAX = 640;
const BASE_EDITOR_PROBLEMS_W_MIN = 200;
const BASE_EDITOR_PROBLEMS_W_MAX = 800;
const BASE_EDITOR_AI_H_MIN = 120;
const BASE_EDITOR_AI_H_MAX = 640;

/** Whitelist + clamp per-user base editor UI prefs from DB or client body. */
export function sanitizeBaseEditorUiPrefs(raw: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const o = raw as Record<string, unknown>;

    if (typeof o.explorerMode === 'string' && BASE_EDITOR_EXPLORER_MODES.has(o.explorerMode)) {
        out.explorerMode = o.explorerMode;
    }
    if (typeof o.nodeSidePanelTab === 'string' && BASE_EDITOR_NODE_SIDE_TABS.has(o.nodeSidePanelTab)) {
        out.nodeSidePanelTab = o.nodeSidePanelTab;
    }
    if (typeof o.editorRightPanelTab === 'string' && BASE_EDITOR_RIGHT_PANEL_TABS.has(o.editorRightPanelTab)) {
        out.editorRightPanelTab = o.editorRightPanelTab;
    }
    if (typeof o.rightPanelOpen === 'boolean') out.rightPanelOpen = o.rightPanelOpen;
    if (typeof o.aiBottomOpen === 'boolean') out.aiBottomOpen = o.aiBottomOpen;

    if (typeof o.wsIndicatorX === 'number' && Number.isFinite(o.wsIndicatorX)) out.wsIndicatorX = o.wsIndicatorX;
    if (typeof o.wsIndicatorY === 'number' && Number.isFinite(o.wsIndicatorY)) out.wsIndicatorY = o.wsIndicatorY;
    if (typeof o.wsIndicatorOpen === 'boolean') out.wsIndicatorOpen = o.wsIndicatorOpen;

    if (typeof o.explorerPanelWidth === 'number' && Number.isFinite(o.explorerPanelWidth)) {
        out.explorerPanelWidth = Math.round(
            Math.max(BASE_EDITOR_EXPLORER_W_MIN, Math.min(BASE_EDITOR_EXPLORER_W_MAX, o.explorerPanelWidth)),
        );
    }
    if (typeof o.problemsPanelWidth === 'number' && Number.isFinite(o.problemsPanelWidth)) {
        out.problemsPanelWidth = Math.round(
            Math.max(BASE_EDITOR_PROBLEMS_W_MIN, Math.min(BASE_EDITOR_PROBLEMS_W_MAX, o.problemsPanelWidth)),
        );
    }
    if (typeof o.aiPanelHeight === 'number' && Number.isFinite(o.aiPanelHeight)) {
        out.aiPanelHeight = Math.round(Math.max(BASE_EDITOR_AI_H_MIN, Math.min(BASE_EDITOR_AI_H_MAX, o.aiPanelHeight)));
    }

    const rawDisplay = o.displaySettings && typeof o.displaySettings === 'object' && !Array.isArray(o.displaySettings)
        ? o.displaySettings as Record<string, unknown>
        : null;
    const displaySettings: Record<string, boolean> = {};
    if (rawDisplay) {
        if (typeof rawDisplay.showProblemCount === 'boolean') displaySettings.showProblemCount = rawDisplay.showProblemCount;
        if (typeof rawDisplay.showNodeNumber === 'boolean') displaySettings.showNodeNumber = rawDisplay.showNodeNumber;
        if (typeof rawDisplay.showNodeCardTimestamps === 'boolean') displaySettings.showNodeCardTimestamps = rawDisplay.showNodeCardTimestamps;
    }
    out.displaySettings = displaySettings;

    if (Array.isArray(o.expandedNodeIds)) {
        out.expandedNodeIds = o.expandedNodeIds.filter((id: unknown) => typeof id === 'string');
    }

    return out;
}

export async function loadBaseEditorUiPrefs(
    mongoDb: Db,
    domainId: string,
    baseDocId: number,
    uid: unknown,
): Promise<Record<string, unknown>> {
    try {
        const coll = mongoDb.collection('base.userEditorUi');
        const doc = await coll.findOne(
            {
                domainId,
                baseDocId,
                uid,
            },
            { sort: { updateAt: -1, _id: -1 } },
        );
        const prefs = sanitizeBaseEditorUiPrefs(doc?.prefs);
        // Re-append expandedNodeIds that sanitize might have stripped
        if (doc?.prefs && Array.isArray(doc.prefs.expandedNodeIds)) {
            prefs.expandedNodeIds = doc.prefs.expandedNodeIds.filter((id: unknown) => typeof id === 'string');
        }
        return prefs;
    } catch {
        return {};
    }
}

export type MindMapDocType = typeof document.TYPE_BASE | typeof document.TYPE_PLUGIN;
export type MindMapDoc = BaseDoc | PluginDoc;

/** Whitelist detail display prefs from DB or client body. */
export function sanitizeBaseDetailUiPrefs(raw: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const o = raw as Record<string, unknown>;
    if (typeof o.showProblemCount === 'boolean') out.showProblemCount = o.showProblemCount;
    if (typeof o.showNodeNumber === 'boolean') out.showNodeNumber = o.showNodeNumber;
    if (typeof o.showNodeCardTimestamps === 'boolean') out.showNodeCardTimestamps = o.showNodeCardTimestamps;
    if (typeof o.showProblemTree === 'boolean') out.showProblemTree = o.showProblemTree;
    if (typeof o.showProblemTags === 'boolean') out.showProblemTags = o.showProblemTags;
    if (typeof o.showCardTags === 'boolean') out.showCardTags = o.showCardTags;
    if (typeof o.showAiTutor === 'boolean') out.showAiTutor = o.showAiTutor;
    if (typeof o.showExpandSaveIndicator === 'boolean') out.showExpandSaveIndicator = o.showExpandSaveIndicator;
    if (typeof o.showWsIndicator === 'boolean') out.showWsIndicator = o.showWsIndicator;
    if (typeof o.showToolbar === 'boolean') out.showToolbar = o.showToolbar;
    if (typeof o.indicatorX === 'number' && Number.isFinite(o.indicatorX)) out.indicatorX = o.indicatorX;
    if (typeof o.indicatorY === 'number' && Number.isFinite(o.indicatorY)) out.indicatorY = o.indicatorY;
    if (typeof o.toolbarOpen === 'boolean') out.toolbarOpen = o.toolbarOpen;
    if (typeof o.toolbarX === 'number' && Number.isFinite(o.toolbarX)) out.toolbarX = o.toolbarX;
    if (typeof o.toolbarY === 'number' && Number.isFinite(o.toolbarY)) out.toolbarY = o.toolbarY;
    if (typeof o.cardDrawerWidth === 'number' && Number.isFinite(o.cardDrawerWidth)) out.cardDrawerWidth = o.cardDrawerWidth;
    if (typeof o.treeDrawerWidth === 'number' && Number.isFinite(o.treeDrawerWidth)) out.treeDrawerWidth = o.treeDrawerWidth;
    if (typeof o.wsIndicatorX === 'number' && Number.isFinite(o.wsIndicatorX)) out.wsIndicatorX = o.wsIndicatorX;
    if (typeof o.wsIndicatorY === 'number' && Number.isFinite(o.wsIndicatorY)) out.wsIndicatorY = o.wsIndicatorY;
    if (typeof o.wsIndicatorOpen === 'boolean') out.wsIndicatorOpen = o.wsIndicatorOpen;
    if (Array.isArray(o.expandedNodeIds)) {
        out.expandedNodeIds = o.expandedNodeIds.filter((id: unknown) => typeof id === 'string');
    }
    return out;
}

export async function loadBaseDetailUiPrefs(
    db: Db,
    domainId: string,
    baseDocId: number,
    uid: unknown,
): Promise<Record<string, unknown>> {
    try {
        const coll = db.collection('base.userDetailUi');
        const doc = await coll.findOne(
            {
                domainId,
                baseDocId,
                uid,
            },
            { sort: { updateAt: -1, _id: -1 } },
        );
        return sanitizeBaseDetailUiPrefs(doc?.prefs);
    } catch {
        return {};
    }
}

export async function saveBaseDetailUiPrefs(
    db: Db,
    domainId: string,
    baseDocId: number,
    uid: unknown,
    displayPrefs: unknown,
): Promise<void> {
    const sanitized = sanitizeBaseDetailUiPrefs(displayPrefs);
    const coll = db.collection('base.userDetailUi');
    await coll.updateOne(
        {
            domainId,
            baseDocId,
            uid,
        },
        {
            $set: {
                domainId,
                baseDocId,
                uid,
                prefs: sanitized,
                updateAt: new Date(),
            },
        },
        { upsert: true },
    );
}

export class BaseModel {
    private static getRootNodeId(nodes: BaseNode[] = [], edges: BaseEdge[] = []): string | null {
        if (!nodes.length) return null;
        const levelRoot = nodes.find((n) => n.level === 0);
        if (levelRoot) return levelRoot.id;
        const incoming = new Set(edges.map((e) => e.target));
        const noIncoming = nodes.find((n) => !incoming.has(n.id));
        return noIncoming ? noIncoming.id : nodes[0].id;
    }

    static async generateNextDocId(domainId: string, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<number> {
        const lastBase = await document.getMulti(domainId, mapDocType, { docId: { $type: 'number' } } as any)
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();
        return (Number(lastBase[0]?.docId) || 0) + 1;
    }

    static async getByDomain(domainId: string, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<BaseDoc | null> {
        const result = await document.getMulti(domainId, mapDocType, {}).limit(1).toArray();
        return result.length > 0 ? result[0] as BaseDoc : null;
    }

    static async create(
        domainId: string,
        owner: number,
        title: string,
        content: string = '',
        rpid?: number,
        ip?: string,
        parentId?: ObjectId,
        domainName?: string,
        forceNew?: boolean,
        tag?: string[],
        mapDocType: MindMapDocType = document.TYPE_BASE,
        rootNodeData?: Partial<BaseNode>,
        extraPayload?: Partial<MindMapDoc>,
    ): Promise<{ docId: number }> {
        if (mapDocType === document.TYPE_BASE && !forceNew) {
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
            ...rootNodeData,
        };

        const payload: Partial<MindMapDoc> = {
            docType: mapDocType,
            domainId,
            title: title || (
                mapDocType === document.TYPE_PLUGIN ? '未命名插件'
                        : '未命名思维导图'
            ),
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
            parentId,
            tag: tag?.length ? tag : undefined,
            ...extraPayload,
        };

        // Validate slug if provided
        const baseSlug = payload.slug as string | undefined;
        if (baseSlug) {
            const slugErr = BaseModel.validateSlug(baseSlug);
            if (slugErr) throw new ValidationError(slugErr);
            const existingBySlug = await BaseModel.getBySlug(domainId, baseSlug);
            if (existingBySlug) {
                throw new ValidationError('{0} already exists in this domain'.replace('{0}', baseSlug));
            }
        }

        const nextDocId = await this.generateNextDocId(domainId, mapDocType);
        const docId = await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            mapDocType,
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

    /**
     * Validate slug format: only lowercase a-z, 0-9, dots, underscores, hyphens.
     * Returns error message string or null if valid.
     */
    static validateSlug(slug: string): string | null {
        if (!slug || !slug.trim()) return 'Slug is required';
        const s = slug.trim();
        if (s.length < 1) return 'Slug is required';
        if (s.length > 80) return 'Slug must be 80 characters or less';
        if (!/^[a-z0-9._-]+$/.test(s)) return 'Slug can only contain lowercase letters (a-z), digits (0-9), dots (.), underscores (_), and hyphens (-)';
        if (/^\d+$/.test(s)) return 'Slug cannot be entirely numeric to avoid conflict with numeric IDs';
        if (/^[._-]/.test(s)) return 'Slug cannot start with a dot, underscore, or hyphen';
        if (/[._-]$/.test(s)) return 'Slug cannot end with a dot, underscore, or hyphen';
        if (/[._-]{2,}/.test(s)) return 'Slug cannot contain consecutive dots, underscores, or hyphens';
        return null;
    }

    /**
     * Sanitize arbitrary text into a valid slug (for suggestions).
     */
    /**
     * Sanitize arbitrary text into a valid slug (for suggestions).
     * Returns undefined if the result would be purely numeric (conflicts with docId).
     */
    static slugify(raw: string): string | undefined {
        const s = String(raw || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .replace(/[._-]{2,}/g, '-')
            .slice(0, 80);
        if (!s || /^\d+$/.test(s)) return undefined;
        return s;
    }

    static async getBySlug(domainId: string, slug: string): Promise<BaseDoc | null> {
        const slugString = String(slug || '').trim().toLowerCase();
        if (!slugString) return null;
        const list = await document.getMulti(domainId, document.TYPE_BASE, { slug: slugString } as Filter<BaseDoc>).limit(1).toArray();
        return list.length > 0 ? (list[0] as BaseDoc) : null;
    }

    static async getAll(domainId: string, query?: Filter<BaseDoc>, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<BaseDoc[]> {
        const merged = (query || {}) as Filter<BaseDoc>;
        const list = await document.getMulti(domainId, mapDocType, merged as any)
            .sort({ updateAt: -1, docId: -1 })
            .toArray() as BaseDoc[];
        return list;
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

    static async getByRepo(domainId: string, rpid: number): Promise<BaseDoc[]> {
        const list = await document.getMulti(domainId, document.TYPE_BASE, { rpid } as Filter<BaseDoc>)
            .sort({ updateAt: -1, docId: -1 })
            .toArray();
        return list as BaseDoc[];
    }

    static async update(
        domainId: string,
        docId: number,
        updates: Partial<Pick<BaseDoc, 'title' | 'content' | 'layout' | 'viewport' | 'theme' | 'files' | 'parentId' | 'domainPosition' | 'tag' | 'slug'>>,
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<void> {
        const updatePayload: any = {
            ...updates,
            updateAt: new Date(),
        };
        const unsetPayload: Record<string, 1> = {};
        if (updates.tag) {
            updatePayload.tag = Array.isArray(updates.tag) ? updates.tag : [updates.tag];
        }
        // Validate slug if being updated
        if ('slug' in updates) {
            if (updates.slug === undefined || updates.slug === null || updates.slug === '') {
                delete updatePayload.slug;
                unsetPayload.slug = 1;
            } else {
                const slugErr = BaseModel.validateSlug(updates.slug);
                if (slugErr) throw new ValidationError(slugErr);
                // Check uniqueness against other bases
                const existingBySlug = await BaseModel.getBySlug(domainId, updates.slug);
                if (existingBySlug && existingBySlug.docId !== docId) {
                    throw new ValidationError('{0} already exists in this domain'.replace('{0}', updates.slug));
                }
            }
        }
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
                }
            }
        }
        await document.set(domainId, mapDocType, docId, updatePayload, Object.keys(unsetPayload).length ? unsetPayload : undefined);
    }

    static async updateNode(
        domainId: string,
        docId: number,
        nodeId: string,
        updates: Partial<BaseNode>,
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<void> {
        const base = await this.get(domainId, docId, mapDocType);
        if (!base) throw new Error('Base not found');

        const nodes = base.nodes || [];
        const edges = base.edges || [];
        const nodeIndex = nodes.findIndex(n => n.id === nodeId);
        if (nodeIndex === -1) throw new Error('Node not found');

        nodes[nodeIndex] = { ...nodes[nodeIndex], ...updates, updateAt: new Date() };

        const updatePayload: Partial<BaseDoc> = {
            nodes,
            edges,
            updateAt: new Date(),
        };

        if (typeof updates.text === 'string' && updates.text.trim()) {
            const rootNodeId = this.getRootNodeId(nodes, edges);
            if (rootNodeId === nodeId) {
                updatePayload.title = updates.text;
            }
        }
        await document.set(domainId, mapDocType, docId, updatePayload);
    }

    static async updateEdge(
        domainId: string,
        docId: number,
        edgeId: string,
        updates: Partial<BaseEdge> & {
            lineStyle?: string;
            sourceHandle?: string;
            targetHandle?: string;
        },
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<void> {
        const base = await this.get(domainId, docId, mapDocType);
        if (!base) throw new Error('Base not found');

        const nodes = base.nodes || [];
        const edges = base.edges || [];
        const edgeIndex = edges.findIndex((edge) => edge.id === edgeId);
        if (edgeIndex === -1) throw new Error('Edge not found');

        edges[edgeIndex] = { ...edges[edgeIndex], ...updates };

        await document.set(domainId, mapDocType, docId, {
            nodes,
            edges,
            updateAt: new Date(),
        });
    }

    static async addNode(
        domainId: string,
        docId: number,
        node: Omit<BaseNode, 'id'>,
        parentId?: string,
        edgeSourceId?: string,
        mapDocType: MindMapDocType = document.TYPE_BASE,
    ): Promise<{ nodeId: string; edgeId?: string }> {
        const base = await this.get(domainId, docId, mapDocType);
        if (!base) throw new Error('Base not found');

        const nodes = base.nodes || [];
        const edges = base.edges || [];
        const now = new Date();
        const newNodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newNode: BaseNode = {
            ...node,
            id: newNodeId,
            createdAt: node.createdAt || now,
            updateAt: now,
        };

        if (parentId) {
            const parentNode = nodes.find(n => n.id === parentId);
            if (!parentNode) throw new Error(`Parent node not found: ${parentId}`);

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
                throw new Error(`Source node not found: ${edgeSourceId}`);
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

        await document.set(domainId, mapDocType, docId, {
            nodes,
            edges,
            updateAt: new Date(),
        });

        return { nodeId: newNodeId, edgeId: newEdgeId };
    }

    static async deleteNode(domainId: string, docId: number, nodeId: string, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<void> {
        const actualDomainId = typeof domainId === 'string' ? domainId : String(domainId);
        const base = await this.get(actualDomainId, docId, mapDocType);
        if (!base) {
            throw new Error('Base not found');
        }

        const nodes = base.nodes || [];
        let edges = base.edges || [];

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
                // Delete physical files stored directly on this node
                const nodeToDel = nodes.find(n => n.id === nodeIdToDelete);
                if (nodeToDel?.files?.length) {
                    const nodeStoragePaths = nodeToDel.files.map(
                        (f) => `base/${actualDomainId}/${docId.toString()}/node/${nodeIdToDelete}/${f.name}`
                    );
                    await storage.del(nodeStoragePaths, 0);
                }
                // Delete all cards under this node
                const cards = await CardModel.getByNodeId(actualDomainId, docId, nodeIdToDelete);
                for (const card of cards) {
                    // Delete physical files for file-cards (stored under node path)
                    if ((card as CardDoc).cardType === 'file' && (card as CardDoc).fileName) {
                        const filePath = `base/${actualDomainId}/${docId.toString()}/node/${nodeIdToDelete}/${(card as CardDoc).fileName}`;
                        try { await storage.del([filePath], 0); } catch { /* ignore */ }
                    }
                    // Also delete any files attached to the card document
                    if ((card as any).files?.length) {
                        const cardStoragePaths = (card as any).files.map(
                            (f: any) => `base/${actualDomainId}/${docId.toString()}/card/${card.docId.toString()}/${f.name}`
                        );
                        await storage.del(cardStoragePaths, 0);
                    }
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

        await document.set(actualDomainId, mapDocType, docId, {
            nodes,
            edges,
            updateAt: new Date(),
        });
    }

    static async addEdge(
        domainId: string,
        docId: number,
        edge: Omit<BaseEdge, 'id'>,
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

        const nodes = base.nodes || [];
        const edges = base.edges || [];
        const sourceExists = nodes.some(n => n.id === edge.source);
        const targetExists = nodes.some(n => n.id === edge.target);
        if (!sourceExists || !targetExists) {
            throw new Error(`Source or target node not found. Source: ${edge.source}, Target: ${edge.target}`);
        }

        const existingEdge = edges.find(
            e => e.source === edge.source && e.target === edge.target
        );
        if (existingEdge) {
            await document.set(domainId, mapDocType, docId, {
                nodes,
                edges,
                updateAt: new Date(),
            });
            return existingEdge.id;
        }

        const newEdgeId = `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        edges.push({
            ...edge,
            id: newEdgeId,
        });

        await document.set(domainId, mapDocType, docId, {
            nodes,
            edges,
            updateAt: new Date(),
        });

        return newEdgeId;
    }

    static async deleteEdge(domainId: string, docId: number, edgeId: string, mapDocType: MindMapDocType = document.TYPE_BASE): Promise<void> {
        const base = await this.get(domainId, docId, mapDocType);
        if (!base) throw new Error('Base not found');

        const nodes = base.nodes || [];
        const edges = base.edges || [];
        const edgeIndex = edges.findIndex(e => e.id === edgeId);
        if (edgeIndex !== -1) {
            edges.splice(edgeIndex, 1);
        }

        await document.set(domainId, mapDocType, docId, {
            nodes,
            edges,
            updateAt: new Date(),
        });
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

        const now = new Date();
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        base.nodes = base.nodes.map(n => {
            const updated = nodeMap.get(n.id);
            if (!updated) return n;
            return {
                ...updated,
                createdAt: n.createdAt || updated.createdAt || now,
                updateAt: now,
            };
        });

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
            content?: string;
            title?: string;
            layout?: BaseDoc['layout'];
            viewport?: BaseDoc['viewport'];
            theme?: BaseDoc['theme'];
            history?: BaseDoc['history'];
            problemTags?: string[];
        } & Record<string, any>,
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
        cardType?: string,
        fileType?: string,
        fileName?: string,
        fileSize?: number,
        tags?: string[],
    ): Promise<ObjectId> {
        const newCid = await this.generateNextCid(domainId, baseDocId, nodeId);

        let orderValue = order;
        if (orderValue === undefined) {
            const filter = { baseDocId, nodeId };
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
        if (problems && problems.length > 0) {
            (payload as any).problems = problems;
        }
        if (cardType) (payload as any).cardType = cardType;
        if (fileType) (payload as any).fileType = fileType;
        if (fileName) (payload as any).fileName = fileName;
        if (fileSize != null) (payload as any).fileSize = fileSize;
        if (tags && tags.length > 0) (payload as any).tags = tags;

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
        const cards = await document.getMulti(domainId, TYPE_CARD, { docId }).limit(1).toArray();
        return (cards[0] as CardDoc | undefined) || null;
    }

    static async getRecentUpdated(domainId: string, limit: number = 10): Promise<CardDoc[]> {
        const list = await document.getMulti(domainId, TYPE_CARD, {})
            .sort({ updateAt: -1 })
            .limit(limit)
            .toArray();
        return list as CardDoc[];
    }

    static async getByNodeIds(domainId: string, baseDocId: number | ObjectId, nodeIds: string[]): Promise<Map<string, CardDoc[]>> {
        if (!nodeIds.length) return new Map();
        const filter = { baseDocId, nodeId: { $in: nodeIds } };
        const cards = await document.getMulti(domainId, TYPE_CARD, filter)
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        const map = new Map<string, CardDoc[]>();
        for (const card of cards) {
            const list = map.get(card.nodeId);
            if (list) {
                list.push(card);
            } else {
                map.set(card.nodeId, [card]);
            }
        }
        return map;
    }

    static async getByNodeId(domainId: string, baseDocId: number | ObjectId, nodeId: string): Promise<CardDoc[]> {
        const filter = { baseDocId, nodeId };
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
        const filter: Record<string, unknown> = { nodeId, cid };
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
        updates: Partial<Pick<CardDoc, 'title' | 'content' | 'cardFace' | 'order' | 'nodeId' | 'problems' | 'files' | 'baseDocId' | 'cardType' | 'fileType' | 'fileName' | 'fileSize' | 'tags'>>
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
export type DetailExplorerFilters = {
    filterNode: string;
    filterCard: string;
    filterProblem: string;
};

function cardMatchesDetailExplorerFilters(
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

function nodeDirectHitForDetailExplorer(
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
        parts.push(cards.some((c) => cardMatchesDetailExplorerFilters(c, fc, fp)));
    }
    return parts.every(Boolean);
}

export function hasActiveDetailExplorerFilters(f: DetailExplorerFilters): boolean {
    return !!(f.filterNode?.trim() || f.filterCard?.trim() || f.filterProblem?.trim());
}

export function outlineExplorerFiltersFromQuery(
    query: Record<string, unknown> | undefined | null,
): DetailExplorerFilters {
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

export function trimDetailExplorerFiltersForClient(
    f: DetailExplorerFilters,
): DetailExplorerFilters {
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
export function applyDetailExplorerUrlFilters(
    nodes: BaseNode[],
    edges: BaseEdge[],
    nodeCardsMap: Record<string, CardDoc[]>,
    filters: DetailExplorerFilters,
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
        const direct = nodeDirectHitForDetailExplorer(nodeId, nodeById, nodeCardsMap, fn, fc, fp);
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
            list = list.filter((c) => cardMatchesDetailExplorerFilters(c, fc, fp));
        }
        filteredMap[nodeId] = list;
    }

    return { nodes: visibleNodes, edges: visibleEdges, nodeCardsMap: filteredMap };
}

/** Parse snake_case/camelCase detail explorer filters from tool arguments. */
export function detailExplorerFiltersFromToolArgs(args: Record<string, unknown> | undefined | null): DetailExplorerFilters {
    const g = (k: string) => typeof args?.[k] === 'string' ? args[k] as string : '';
    return {
        filterNode: g('filterNode') || g('filter_node'),
        filterCard: g('filterCard') || g('filter_card'),
        filterProblem: g('filterProblem') || g('filter_problem'),
    };
}

export type FetchBaseOutlineOptions = {
    baseDocId?: number;
    filters: DetailExplorerFilters;
};

export async function fetchFilteredBaseDetail(
    domainId: string,
    options: FetchBaseOutlineOptions,
): Promise<{
    base: BaseDoc;
    nodes: BaseNode[];
    edges: BaseEdge[];
    nodeCardsMap: Record<string, CardDoc[]>;
    outlineExplorerFilters: DetailExplorerFilters;
} | null> {
    const base = options.baseDocId != null && Number.isFinite(options.baseDocId) && options.baseDocId > 0
        ? await BaseModel.get(domainId, options.baseDocId, document.TYPE_BASE)
        : await BaseModel.getByDomain(domainId);
    if (!base) return null;

    let nodes = base.nodes || [];
    let edges = base.edges || [];
    const allCards = await document.getMulti(
        domainId,
        TYPE_CARD,
        { baseDocId: Number(base.docId) },
    )
        .sort({ order: 1, cid: 1 })
        .toArray() as CardDoc[];
    let nodeCardsMap: Record<string, CardDoc[]> = {};
    for (const card of allCards) {
        if (!card.nodeId) continue;
        (nodeCardsMap[card.nodeId] ||= []).push(card);
    }
    for (const nodeId of Object.keys(nodeCardsMap)) {
        nodeCardsMap[nodeId].sort((a, b) => (a.order ?? 999999) - (b.order ?? 999999) || a.cid - b.cid);
    }

    const outlineExplorerFilters = options.filters;
    if (hasActiveDetailExplorerFilters(outlineExplorerFilters)) {
        const applied = applyDetailExplorerUrlFilters(nodes, edges, nodeCardsMap, outlineExplorerFilters);
        nodes = applied.nodes;
        edges = applied.edges;
        nodeCardsMap = applied.nodeCardsMap;
    }
    return { base, nodes, edges, nodeCardsMap, outlineExplorerFilters: trimDetailExplorerFiltersForClient(outlineExplorerFilters) };
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

/** Card + problem counts per baseDocId across the single main data tree. */
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
        const nodes = b.nodes || [];
        const edges = b.edges || [];
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

/** Base 内嵌 roadmap 画布（`BaseNode.type === 'roadmap'` 及其 canvas 子节点）。 */
const ROADMAP_NODE_KINDS = new Set(['main', 'sub', 'hook', 'text']);
const ROADMAP_LEGACY_KIND_MAP: Record<string, string> = {
    root: 'main',
    milestone: 'main',
    task: 'sub',
    decision: 'sub',
    release: 'sub',
};

export function roadmapNodeKindFromType(type?: string): string {
    const raw = String(type || '').trim();
    if (ROADMAP_NODE_KINDS.has(raw)) return raw;
    return ROADMAP_LEGACY_KIND_MAP[raw] || 'sub';
}

export function supportsRoadmapPracticeProblems(type?: string): boolean {
    const kind = roadmapNodeKindFromType(type);
    return kind === 'main' || kind === 'sub';
}

export function roadmapNodeTypeFromNode(node: BaseNode | undefined): string | undefined {
    const data = (node as { data?: { roadmapNodeType?: string } } | undefined)?.data;
    return data?.roadmapNodeType;
}

const ROADMAP_MAIN_NUMBER_PATTERN = /^\d+$/;
const ROADMAP_SUB_NUMBER_PATTERN = /^\d+\.\d+$/;

function isMainCanvasKind(type?: string): boolean {
    return roadmapNodeKindFromType(type) === 'main';
}

function isSubCanvasKind(type?: string): boolean {
    return roadmapNodeKindFromType(type) === 'sub';
}

function isValidRoadmapMainNumber(value: string): boolean {
    const trimmed = value.trim();
    if (!ROADMAP_MAIN_NUMBER_PATTERN.test(trimmed)) return false;
    const num = Number(trimmed);
    return Number.isInteger(num) && num >= 1;
}

function isValidRoadmapSubNumber(value: string): boolean {
    const trimmed = value.trim();
    if (!ROADMAP_SUB_NUMBER_PATTERN.test(trimmed)) return false;
    const [prefix, suffix] = trimmed.split('.');
    return isValidRoadmapMainNumber(prefix) && isValidRoadmapMainNumber(suffix);
}

export function roadmapNodeNumberSortKey(node: BaseNode | undefined): [number, number] | null {
    if (!node || !supportsRoadmapPracticeProblems(roadmapNodeTypeFromNode(node))) return null;
    const raw = String((node.data as { nodeNumber?: string } | undefined)?.nodeNumber || '').trim();
    if (isValidRoadmapMainNumber(raw)) return [Number(raw), 0];
    if (isValidRoadmapSubNumber(raw)) {
        const [prefix, suffix] = raw.split('.');
        return [Number(prefix), Number(suffix)];
    }
    return null;
}

export function compareRoadmapPracticeNodesByNumber(
    a: BaseNode | undefined,
    b: BaseNode | undefined,
): number {
    const ka = roadmapNodeNumberSortKey(a);
    const kb = roadmapNodeNumberSortKey(b);
    if (ka && kb) {
        if (ka[0] !== kb[0]) return ka[0] - kb[0];
        return ka[1] - kb[1];
    }
    if (ka && !kb) return -1;
    if (!ka && kb) return 1;
    return 0;
}

export function isRoadmapContainerBaseNode(node: BaseNode | undefined): boolean {
    return String(node?.type || '') === 'roadmap';
}

export function isRoadmapSubPracticeNode(node: BaseNode | undefined): boolean {
    return roadmapNodeKindFromType(roadmapNodeTypeFromNode(node)) === 'sub';
}

export function roadmapDagOrderFromNode(node: BaseNode | undefined): number | null {
    const key = roadmapNodeNumberSortKey(node);
    if (!key) return null;
    return key[0] * 10000 + key[1];
}

function roadmapCanvasChildIdSet(nodes: BaseNode[], edges: BaseEdge[], roadmapId: string): Set<string> {
    const ids = new Set<string>();
    for (const edge of edges) {
        if (edge.source === roadmapId) ids.add(edge.target);
    }
    return ids;
}

function validateRoadmapCanvasNumbers(nodes: BaseNode[], edges: BaseEdge[]): string[] {
    const errors: string[] = [];
    const roots = nodes.filter((node) => node.type === 'roadmap');
    for (const root of roots) {
        const childIds = roadmapCanvasChildIdSet(nodes, edges, root.id);
        const canvasNodes = nodes.filter((node) => childIds.has(node.id));
        const mainNumbers = new Set<string>();
        for (const node of canvasNodes) {
            const kind = roadmapNodeKindFromType(roadmapNodeTypeFromNode(node));
            if (kind !== 'main') continue;
            const raw = String((node.data as { nodeNumber?: string } | undefined)?.nodeNumber || '').trim();
            if (raw && isValidRoadmapMainNumber(raw)) mainNumbers.add(raw);
        }
        for (const node of canvasNodes) {
            const kind = roadmapNodeKindFromType(roadmapNodeTypeFromNode(node));
            const label = String(node.text || node.id);
            const raw = String((node.data as { nodeNumber?: string } | undefined)?.nodeNumber || '').trim();
            if (isMainCanvasKind(kind)) {
                if (!raw) {
                    errors.push(`主节点 "${label}" 缺少序号。`);
                    continue;
                }
                if (!isValidRoadmapMainNumber(raw)) {
                    errors.push(`主节点 "${label}" 序号必须是大于 0 的整数。`);
                }
                continue;
            }
            if (!isSubCanvasKind(kind)) continue;
            if (!raw) {
                errors.push(`子节点 "${label}" 缺少序号。`);
                continue;
            }
            if (!isValidRoadmapSubNumber(raw)) {
                errors.push(`子节点 "${label}" 序号必须是 x.y 格式。`);
                continue;
            }
            const prefix = raw.split('.')[0];
            if (!mainNumbers.has(prefix)) {
                errors.push(`子节点 "${label}" 序号前缀必须与某个主节点序号一致。`);
            }
        }
    }
    return errors;
}

type BatchNodeCreatePreview = {
    tempId?: string;
    text?: string;
    type?: string;
    x?: number;
    y?: number;
    order?: number;
    data?: Record<string, unknown>;
};

type BatchNodeUpdatePreview = {
    nodeId: string;
    text?: string;
    x?: number;
    y?: number;
    data?: Record<string, unknown>;
};

function previewBranchNodesAfterBatch(
    nodes: BaseNode[],
    batch: {
        nodeCreates?: BatchNodeCreatePreview[];
        nodeUpdates?: BatchNodeUpdatePreview[];
        nodeDeletes?: string[];
    },
): BaseNode[] {
    const deleteIds = new Set((batch.nodeDeletes || []).map(String));
    const byId = new Map<string, BaseNode>();
    for (const node of nodes) {
        if (deleteIds.has(node.id)) continue;
        byId.set(node.id, {
            ...node,
            data: node.data ? { ...node.data } : node.data,
        });
    }

    for (const create of batch.nodeCreates || []) {
        const id = create.tempId ? String(create.tempId) : '';
        if (!id) continue;
        const existing = byId.get(id);
        byId.set(id, {
            ...(existing || { id, text: '' }),
            id,
            text: create.text != null ? create.text : (existing?.text || ''),
            ...(create.type != null ? { type: create.type as BaseNode['type'] } : {}),
            ...(create.x != null ? { x: create.x } : {}),
            ...(create.y != null ? { y: create.y } : {}),
            ...(create.order != null ? { order: create.order } : {}),
            data: {
                ...(existing?.data || {}),
                ...(create.data || {}),
            },
        });
    }

    for (const update of batch.nodeUpdates || []) {
        const nodeId = update.nodeId ? String(update.nodeId) : '';
        if (!nodeId) continue;
        const existing = byId.get(nodeId) || { id: nodeId, text: '' };
        byId.set(nodeId, {
            ...existing,
            ...(update.text != null ? { text: update.text } : {}),
            ...(update.x != null ? { x: update.x } : {}),
            ...(update.y != null ? { y: update.y } : {}),
            data: {
                ...(existing.data || {}),
                ...(update.data || {}),
            },
        });
    }

    return Array.from(byId.values());
}

export function collectRoadmapBatchSaveNumberErrors(
    base: BaseDoc,
    batch: {
        nodeCreates?: BatchNodeCreatePreview[];
        nodeUpdates?: BatchNodeUpdatePreview[];
        nodeDeletes?: string[];
    },
): string[] {
    const nodes = base.nodes || [];
    const edges = base.edges || [];
    const previewNodes = previewBranchNodesAfterBatch(nodes, batch);
    return validateRoadmapCanvasNumbers(previewNodes, edges);
}

// @ts-ignore
global.Ejunz.model.base = BaseModel;
// @ts-ignore
global.Ejunz.model.card = CardModel;
export default { BaseModel, CardModel };


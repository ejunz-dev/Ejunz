import { Filter, ObjectId } from 'mongodb';
import type { BaseEdge, BaseNode, CardDoc, Problem, RoadmapDoc } from '../interface';
import { BaseModel, CardModel, getBranchData, setBranchData } from './base';
import * as document from './document';

export interface RoadmapCreateOptions {
    title?: string;
    rid?: string;
    content?: string;
    tag?: string[];
}

function readRid(raw: unknown): string | undefined {
    const rid = String(raw || '').trim();
    return rid || undefined;
}

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

function roadmapNodeTypeFromNode(node: BaseNode | undefined): string | undefined {
    const data = (node as { data?: { roadmapNodeType?: string } } | undefined)?.data;
    return data?.roadmapNodeType;
}

function practiceNodeIdSet(nodes: BaseNode[] | undefined): Set<string> {
    const ids = new Set<string>();
    for (const node of nodes || []) {
        if (supportsRoadmapPracticeProblems(roadmapNodeTypeFromNode(node))) {
            ids.add(String(node.id));
        }
    }
    return ids;
}

function mergeIncomingProblemsPreserveStoredTags(incoming: Problem[], stored?: Problem[] | null): Problem[] {
    if (!Array.isArray(stored) || stored.length === 0) return incoming;
    const byPid = new Map<string, Problem>();
    for (const row of stored) {
        const pid = row?.pid != null ? String(row.pid) : '';
        if (!pid) continue;
        byPid.set(pid, row);
    }
    return incoming.map((inc) => {
        const pid = inc?.pid != null ? String(inc.pid) : '';
        if (!pid || !byPid.has(pid)) return inc;
        const st = byPid.get(pid)!;
        const merged: Problem = { ...inc };
        if (Object.prototype.hasOwnProperty.call(st, 'tags')) {
            if (Array.isArray(st.tags) && st.tags.length >= 0) {
                merged.tags = [...st.tags];
            } else {
                delete (merged as { tags?: string[] }).tags;
            }
        } else {
            delete (merged as { tags?: string[] }).tags;
        }
        return merged;
    });
}

function cardBranchFilter(branch: string): Record<string, unknown> {
    if (branch === 'main') {
        return { $or: [{ branch: 'main' }, { branch: { $exists: false } }] };
    }
    return { branch };
}

export class RoadmapModel {
    static async generateNextDocId(domainId: string): Promise<number> {
        return BaseModel.generateNextDocId(domainId, document.TYPE_ROADMAP);
    }

    static async create(
        domainId: string,
        owner: number,
        title: string,
        content = '',
        ip?: string,
        options: RoadmapCreateOptions = {},
    ): Promise<{ docId: number }> {
        const finalTitle = (title || '').trim() || 'Roadmap';
        const rid = readRid(options.rid);
        const rootNode: Partial<BaseNode> = {
            text: finalTitle,
            x: 0,
            y: 0,
            level: 0,
            expanded: true,
            data: {
                roadmapNodeType: 'root',
                status: 'planned',
                priority: 'high',
                description: 'Start mapping milestones, releases, decisions, and dependencies here.',
            },
        };
        return BaseModel.create(
            domainId,
            owner,
            finalTitle,
            content || '',
            undefined,
            'main',
            ip,
            undefined,
            finalTitle,
            true,
            undefined,
            options.tag?.length ? options.tag : undefined,
            document.TYPE_ROADMAP,
            rootNode,
            {
                rid: rid || undefined,
                layout: {
                    type: 'hierarchical',
                    direction: 'LR',
                    spacing: { x: 260, y: 140 },
                },
                viewport: { x: 0, y: 0, zoom: 1 },
                theme: {
                    primaryColor: '#f0b65a',
                    backgroundColor: '#ffffff',
                },
            } as Partial<RoadmapDoc>,
        );
    }

    static async get(domainId: string, docId: number): Promise<RoadmapDoc | null> {
        return (await BaseModel.get(domainId, docId, document.TYPE_ROADMAP)) as unknown as RoadmapDoc | null;
    }

    static async getByRid(domainId: string, rid: string | number): Promise<RoadmapDoc | null> {
        const ridString = String(rid).trim();
        if (!ridString) return null;
        const list = await document.getMulti(domainId, document.TYPE_ROADMAP, { rid: ridString } as Filter<RoadmapDoc>).limit(1).toArray();
        return list.length > 0 ? (list[0] as RoadmapDoc) : null;
    }

    static async getAll(domainId: string, query: Filter<RoadmapDoc> = {}): Promise<RoadmapDoc[]> {
        return (await BaseModel.getAll(domainId, query as any, document.TYPE_ROADMAP)) as unknown as RoadmapDoc[];
    }

    static async update(domainId: string, docId: number, updates: Partial<RoadmapDoc>): Promise<void> {
        const updatePayload: Partial<RoadmapDoc> = {
            ...updates,
            updateAt: new Date(),
        };
        let unsetPayload: Record<string, 1> | undefined;
        if ('rid' in updates && updates.rid === undefined) {
            delete (updatePayload as any).rid;
            unsetPayload = { rid: 1 };
        }
        await document.set(domainId, document.TYPE_ROADMAP, docId, updatePayload, unsetPayload);
    }

    static async delete(domainId: string, docId: number): Promise<void> {
        await document.deleteOne(domainId, document.TYPE_ROADMAP, docId);
    }

    static async incrementViews(domainId: string, docId: number): Promise<void> {
        await BaseModel.incrementViews(domainId, docId, document.TYPE_ROADMAP);
    }

    static getBranchMeta(roadmap: RoadmapDoc, branch: string): {
        layout?: RoadmapDoc['layout'];
        viewport?: RoadmapDoc['viewport'];
        theme?: Record<string, any>;
    } {
        const branchName = branch || 'main';
        const metaMap = (roadmap as any).roadmapBranchMeta || {};
        const meta = metaMap[branchName] || {};
        return {
            layout: meta.layout ?? roadmap.layout,
            viewport: meta.viewport ?? roadmap.viewport,
            theme: meta.theme ?? (roadmap as any).theme,
        };
    }

    static setBranchMeta(
        roadmap: RoadmapDoc,
        branch: string,
        meta: {
            layout?: RoadmapDoc['layout'];
            viewport?: RoadmapDoc['viewport'];
            theme?: Record<string, any>;
        },
    ): void {
        const branchName = branch || 'main';
        if (!(roadmap as any).roadmapBranchMeta) {
            (roadmap as any).roadmapBranchMeta = {};
        }
        (roadmap as any).roadmapBranchMeta[branchName] = {
            ...(roadmap as any).roadmapBranchMeta[branchName],
            ...meta,
        };
    }

    static withGraph(roadmap: RoadmapDoc, branch?: string): RoadmapDoc {
        const effectiveBranch = branch || (roadmap as any).currentBranch || 'main';
        const branchData = getBranchData(roadmap as any, effectiveBranch);
        const meta = this.getBranchMeta(roadmap, effectiveBranch);
        const branchesArr: string[] = Array.isArray((roadmap as any).branches) ? (roadmap as any).branches : [];
        const branchSet = new Set(branchesArr);
        branchSet.add('main');
        const branchDataKeys = Object.keys((roadmap as any).branchData || {});
        for (const k of branchDataKeys) branchSet.add(k);
        const branches = Array.from(branchSet);
        branches.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
        return {
            ...roadmap,
            nodes: branchData.nodes || [],
            edges: branchData.edges || [],
            currentBranch: effectiveBranch,
            branches,
            layout: meta.layout,
            viewport: meta.viewport,
            theme: meta.theme,
        };
    }

    static async updateFull(
        domainId: string,
        docId: number,
        updates: Partial<RoadmapDoc>,
    ): Promise<void> {
        await BaseModel.updateFull(domainId, docId, updates, document.TYPE_ROADMAP);
    }

    static async saveGraph(
        domainId: string,
        docId: number,
        payload: {
            nodes?: BaseNode[];
            edges?: BaseEdge[];
            layout?: RoadmapDoc['layout'];
            viewport?: RoadmapDoc['viewport'];
            theme?: RoadmapDoc['theme'];
            branch?: string;
        },
    ): Promise<void> {
        const roadmap = await this.get(domainId, docId);
        if (!roadmap) throw new Error('Roadmap not found');

        let { nodes, edges, layout, viewport, theme } = payload;
        const branch = payload.branch || (roadmap as any).currentBranch || 'main';
        if (nodes && Array.isArray(nodes)) {
            nodes = nodes.filter((node) => {
                if (!node.id) return false;
                if (node.id.startsWith('temp-node-')) return false;
                return true;
            });
        }
        if (edges && Array.isArray(edges)) {
            edges = edges.filter((edge) => {
                if (!edge.id && !edge.source && !edge.target) return false;
                if (edge.id?.startsWith('temp-edge-')) return false;
                if (edge.source?.startsWith('temp-node-')) return false;
                if (edge.target?.startsWith('temp-node-')) return false;
                return true;
            });
        }

        const working = { ...roadmap } as RoadmapDoc;
        setBranchData(working as any, branch, nodes || [], edges || []);
        this.setBranchMeta(working, branch, { layout, viewport, theme });
        await this.updateFull(domainId, docId, {
            branchData: working.branchData,
            nodes: working.nodes,
            edges: working.edges,
            roadmapBranchMeta: (working as any).roadmapBranchMeta,
            layout,
            viewport,
            theme,
        } as Partial<RoadmapDoc>);
    }

    static async buildNodeCardsMap(
        domainId: string,
        docId: number,
        branch: string,
        nodes?: BaseNode[],
    ): Promise<Record<string, Array<Record<string, unknown>>>> {
        const practiceNodeIds = nodes?.length ? practiceNodeIdSet(nodes) : null;
        const filter: Record<string, unknown> = {
            baseDocId: docId,
            ...cardBranchFilter(branch || 'main'),
        };
        const cards = await document.getMulti(domainId, document.TYPE_CARD, filter).toArray() as CardDoc[];
        const map: Record<string, Array<Record<string, unknown>>> = {};
        for (const card of cards) {
            if (!card.nodeId) continue;
            if (!map[card.nodeId]) map[card.nodeId] = [];
            const includeProblems = !practiceNodeIds || practiceNodeIds.has(card.nodeId);
            map[card.nodeId].push({
                ...card,
                ...(includeProblems ? {} : { problems: [] }),
                docId: card.docId.toString(),
                updateAt: card.updateAt instanceof Date ? card.updateAt.toISOString() : card.updateAt,
                createdAt: card.createdAt instanceof Date ? card.createdAt.toISOString() : card.createdAt,
            });
        }
        for (const nodeId of Object.keys(map)) {
            map[nodeId].sort((a, b) => {
                const ao = Number(a.order ?? 0);
                const bo = Number(b.order ?? 0);
                if (ao !== bo) return ao - bo;
                return Number(a.cid ?? 0) - Number(b.cid ?? 0);
            });
        }
        return map;
    }

    static async applyCardMutations(
        domainId: string,
        docId: number,
        branch: string,
        owner: number,
        ip: string | undefined,
        nodes: BaseNode[] | undefined,
        cardCreates: Array<{
            tempId?: string;
            nodeId: string;
            title?: string;
            content?: string;
            problems?: Problem[];
        }> = [],
        cardUpdates: Array<{
            cardId: string;
            nodeId?: string;
            title?: string;
            content?: string;
            problems?: Problem[];
        }> = [],
    ): Promise<Record<string, string>> {
        const cardIdMap: Record<string, string> = {};
        const effectiveBranch = branch || 'main';
        const practiceNodeIds = practiceNodeIdSet(nodes);

        for (const create of cardCreates) {
            const nodeId = String(create.nodeId || '').trim();
            if (!nodeId || nodeId.startsWith('temp-node-')) continue;
            const problems = practiceNodeIds.has(nodeId) ? create.problems : undefined;
            const newId = await CardModel.create(
                domainId,
                docId,
                nodeId,
                owner,
                create.title || '题目卡片',
                create.content || '',
                ip,
                problems,
                undefined,
                effectiveBranch,
            );
            const idStr = newId.toString();
            if (create.tempId) cardIdMap[String(create.tempId)] = idStr;
        }

        for (const update of cardUpdates) {
            const cardId = String(update.cardId || '').trim();
            if (!cardId || cardId.startsWith('temp-card-') || !ObjectId.isValid(cardId)) continue;
            const oid = new ObjectId(cardId);
            const prev = await CardModel.get(domainId, oid);
            if (!prev || Number(prev.baseDocId) !== Number(docId)) continue;

            const payload: Partial<CardDoc> = {};
            if (update.title !== undefined) payload.title = update.title;
            if (update.content !== undefined) payload.content = update.content;
            if (update.problems !== undefined) {
                const nodeIdForCard = String(update.nodeId || prev.nodeId || '').trim();
                if (practiceNodeIds.has(nodeIdForCard)) {
                    payload.problems = mergeIncomingProblemsPreserveStoredTags(
                        update.problems,
                        prev.problems as Problem[] | undefined,
                    );
                }
            }
            if (Object.keys(payload).length === 0) continue;
            await CardModel.update(domainId, oid, payload);
        }

        return cardIdMap;
    }
}

export default RoadmapModel;

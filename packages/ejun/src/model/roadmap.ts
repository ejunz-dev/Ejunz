import { Filter } from 'mongodb';
import type { BaseEdge, BaseNode, RoadmapDoc } from '../interface';
import { BaseModel, getBranchData, setBranchData } from './base';
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
}

export default RoadmapModel;

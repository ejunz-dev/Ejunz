/**
 * Skill handlers：复用 Base 逻辑，仅通过 type 区分（Skills Base）
 */
import type { Context } from '../context';
import { param, Types } from '../service/server';
import { NotFoundError } from '../error';
import { PRIV } from '../model/builtin';
import { BaseModel } from '../model/base';
import type { BaseDoc, BaseNode, BaseEdge, CardDoc } from '../interface';
import * as document from '../model/document';
import {
    getBranchData,
    BaseCardHandler,
    BaseNodeHandler,
    BaseEdgeHandler,
    BaseDataHandler,
    BaseSaveHandler,
    BaseOutlineHandler,
    BaseOutlineOptions,
    BaseBatchSaveHandler,
    BatchSaveOptions,
    BaseEditorHandler,
    BaseEditorOptions,
} from './base';

async function getSkillsBase(domainId: string): Promise<BaseDoc> {
    const base = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' }).limit(1).toArray();
    if (base.length === 0) throw new NotFoundError('Skills Base not found');
    return base[0] as BaseDoc;
}

async function getSkillsBaseOrNull(domainId: string): Promise<BaseDoc | null> {
    const base = await document.getMulti(domainId, document.TYPE_BASE, { type: 'skill' }).limit(1).toArray();
    return base.length > 0 ? (base[0] as BaseDoc) : null;
}

class SkillCardHandler extends BaseCardHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc> {
        return getSkillsBase(domainId);
    }
}

class SkillNodeHandler extends BaseNodeHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc> {
        return getSkillsBase(domainId);
    }
}

class SkillEdgeHandler extends BaseEdgeHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc> {
        return getSkillsBase(domainId);
    }
}

class SkillDataHandler extends BaseDataHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc | null> {
        return getSkillsBaseOrNull(domainId);
    }

    protected override async createBase(domainId: string, branch: string): Promise<BaseDoc> {
        const { docId } = await BaseModel.create(
            domainId,
            this.user._id,
            'Skills',
            'Agent Skills 管理',
            undefined,
            branch,
            this.request.ip,
            undefined,
            undefined,
            'skill',
        );
        const base = await BaseModel.get(domainId, docId);
        if (!base) throw new Error('Failed to create Skills base');
        return base;
    }

    protected override getDefaultRootText(): string {
        return 'Skills';
    }

    protected override getCardFilter(base: BaseDoc): Record<string, unknown> {
        return { baseDocId: base.docId };
    }

    @param('branch', Types.String, true)
    override async get(domainId: string, branch?: string) {
        let base = await this.getBase(domainId);
        if (!base) base = await this.createBase(domainId, branch || 'main');
        const skillsBase = base;
        const currentBranch = branch || (skillsBase as any)?.currentBranch || 'main';
        const branchData = getBranchData(skillsBase, currentBranch);
        let nodes: BaseNode[] = branchData.nodes || [];
        let edges: BaseEdge[] = branchData.edges || [];
        const hasWrongData = nodes.length > 0 && nodes[0]?.text !== 'Skills';
        if (hasWrongData) {
            nodes = [];
            edges = [];
            await document.set(domainId, document.TYPE_BASE, skillsBase.docId, {
                [`branchData.${currentBranch}.nodes`]: [],
                [`branchData.${currentBranch}.edges`]: [],
            });
            await document.set(domainId, document.TYPE_BASE, skillsBase.docId, { nodes: [], edges: [] });
        }
        if (nodes.length === 0) {
            const rootNode: Omit<BaseNode, 'id'> = { text: 'Skills', level: 0 };
            await BaseModel.addNode(domainId, skillsBase.docId, rootNode, undefined, currentBranch);
            const updatedBase = await BaseModel.get(domainId, skillsBase.docId);
            if (updatedBase) {
                const updatedBranchData = getBranchData(updatedBase, currentBranch);
                nodes = updatedBranchData.nodes || [];
                edges = updatedBranchData.edges || [];
            }
        }
        const allCards = await document.getMulti(domainId, document.TYPE_CARD, this.getCardFilter(skillsBase))
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) nodeCardsMap[card.nodeId] = [];
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        this.response.body = {
            ...skillsBase,
            nodes,
            edges,
            currentBranch,
            nodeCardsMap,
            files: skillsBase.files || [],
        };
    }
}

class SkillSaveHandler extends BaseSaveHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc | null> {
        return getSkillsBaseOrNull(domainId);
    }

    protected override getDefaultTitle(): string {
        return 'Agent Skills 管理';
    }

    protected override getDefaultRootText(): string {
        return 'Skills';
    }

    protected override async createBase(domainId: string): Promise<BaseDoc> {
        const { docId } = await BaseModel.create(
            domainId,
            this.user._id,
            'Skills',
            'Agent Skills 管理',
            undefined,
            'main',
            this.request.ip,
            undefined,
            undefined,
            'skill',
        );
        const base = await BaseModel.get(domainId, docId);
        if (!base) throw new Error('Failed to create Skills base');
        return base;
    }

    protected override shouldSyncToGit(): boolean {
        return false;
    }
}

class SkillOutlineHandler extends BaseOutlineHandler {
    protected override getOutlineOptions(domainId: string, branch?: string): BaseOutlineOptions {
        return {
            template: 'base_outline.html',
            editorMode: 'skill',
            redirectRouteName: 'base_skill_outline_branch',
            getRequestedBranch: () => 'main',
            getBase: async (d) => {
                const list = await document.getMulti(d, document.TYPE_BASE, { type: 'skill' }).limit(1).toArray();
                return list[0] as BaseDoc | null;
            },
            createBase: async (d, requestedBranch) => {
                const { docId } = await BaseModel.create(
                    d,
                    this.user._id,
                    'Skills',
                    'Agent Skills 管理',
                    undefined,
                    requestedBranch,
                    this.request.ip,
                    undefined,
                    undefined,
                    'skill',
                );
                const base = await BaseModel.get(d, docId);
                if (!base) throw new Error('Failed to create Skills base');
                return base;
            },
            defaultRootText: 'Skills',
            cleanupBranchData: async (domainId, base, requestedBranch, nodes, edges) => {
                const hasWrongData = nodes.length > 0 && nodes[0]?.text !== 'Skills';
                if (!hasWrongData) return { nodes, edges };
                await document.set(domainId, document.TYPE_BASE, base.docId, {
                    [`branchData.${requestedBranch}.nodes`]: [],
                    [`branchData.${requestedBranch}.edges`]: [],
                });
                await document.set(domainId, document.TYPE_BASE, base.docId, { nodes: [], edges: [] });
                return { nodes: [], edges: [] };
            },
        };
    }
}

class SkillBatchSaveHandler extends BaseBatchSaveHandler {
    protected override getBatchSaveOptions(): BatchSaveOptions {
        return {
            type: 'skill',
            getBase: async (d) => {
                const list = await document.getMulti(d, document.TYPE_BASE, { type: 'skill' }).limit(1).toArray();
                return list[0] as BaseDoc | null;
            },
            createBase: async (d) => {
                const { docId } = await BaseModel.create(
                    d,
                    this.user._id,
                    'Skills',
                    'Agent Skills 管理',
                    undefined,
                    'main',
                    this.request.ip,
                    undefined,
                    undefined,
                    'skill',
                );
                const base = await BaseModel.get(d, docId);
                if (!base) throw new Error('Failed to create Skills base');
                return base;
            },
            getBranch: () => 'main',
        };
    }
}

class SkillEditorHandler extends BaseEditorHandler {
    protected override getEditorOptions(domainId: string, branch?: string): BaseEditorOptions {
        return {
            template: 'base_editor.html',
            editorMode: 'skill',
            redirectRouteName: 'base_skill_editor_branch',
            getRequestedBranch: () => 'main',
            getBase: async (d) => {
                const list = await document.getMulti(d, document.TYPE_BASE, { type: 'skill' }).limit(1).toArray();
                return list[0] as BaseDoc | null;
            },
            createBase: async (d, requestedBranch) => {
                const { docId } = await BaseModel.create(
                    d,
                    this.user._id,
                    'Skills',
                    'Agent Skills 管理',
                    undefined,
                    requestedBranch,
                    this.request.ip,
                    undefined,
                    undefined,
                    'skill',
                );
                const base = await BaseModel.get(d, docId);
                if (!base) throw new Error('Failed to create Skills base');
                return base;
            },
            defaultRootText: 'Skills',
            cleanupBranchData: async (domainId, base, requestedBranch, nodes, edges) => {
                const hasWrongData = nodes.length > 0 && nodes[0]?.text !== 'Skills';
                if (!hasWrongData) return { nodes, edges };
                await document.set(domainId, document.TYPE_BASE, base.docId, {
                    [`branchData.${requestedBranch}.nodes`]: [],
                    [`branchData.${requestedBranch}.edges`]: [],
                });
                await document.set(domainId, document.TYPE_BASE, base.docId, { nodes: [], edges: [] });
                return { nodes: [], edges: [] };
            },
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('base_skill_data', '/base/skill/data', SkillDataHandler);
    ctx.Route('base_skill_save', '/base/skill/save', SkillSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_skill_batch_save', '/base/skill/batch-save', SkillBatchSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_skill_card', '/base/skill/card', SkillCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_skill_card_update', '/base/skill/card/:cardId', SkillCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_skill_node', '/base/skill/node', SkillNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_skill_node_update', '/base/skill/node/:nodeId', SkillNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_skill_edge', '/base/skill/edge', SkillEdgeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_skill_outline', '/base/skill', SkillOutlineHandler);
    ctx.Route('base_skill_outline_branch', '/base/skill/branch/:branch', SkillOutlineHandler);
    ctx.Route('base_skill_editor', '/base/skill/editor', SkillEditorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_skill_editor_branch', '/base/skill/editor/branch/:branch', SkillEditorHandler, PRIV.PRIV_USER_PROFILE);
}

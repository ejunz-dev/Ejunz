import type { Context } from '../context';
import { param, Types } from '../service/server';
import { NotFoundError } from '../error';
import { PRIV } from '../model/builtin';
import { BaseModel } from '../model/base';
import type { BaseDoc } from '../interface';
import * as document from '../model/document';
import {
    readOptionalRequestBaseDocId,
    BaseCardHandler,
    BaseNodeHandler,
    BaseEdgeHandler,
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

class SkillCardHandler extends BaseCardHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc> {
        const specified = readOptionalRequestBaseDocId(this.request);
        if (specified) {
            const b = await BaseModel.get(domainId, specified);
            if (!b) throw new NotFoundError('Base not found');
            return b;
        }
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

    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const b = branch && String(branch).trim() ? branch.trim() : 'main';
        this.response.redirect = this.url('base_skill_outline_branch', { domainId, branch: b });
    }
}

export async function apply(ctx: Context) {
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

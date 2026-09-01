import { BaseModel } from '../../../model/base';
import { findRootNodeId } from '../shared';
import type { McpToolContext, ToolArgs } from '../../types';

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const text = String(args.text || '').trim();
    if (!text) throw new Error('text is required');
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const parentId = args.parentId ? String(args.parentId).trim() : findRootNodeId(base.nodes || [], base.edges || []);
    if (parentId && !(base.nodes || []).some((node) => node.id === parentId)) throw new Error(`Parent node not found: ${parentId}`);
    const result = await BaseModel.addNode(ctx.domainId, ctx.baseDocId, { text } as any, parentId, parentId);
    return { ok: true, nodeId: result.nodeId, edgeId: result.edgeId, parentId: parentId ?? null };
}

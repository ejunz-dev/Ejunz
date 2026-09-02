import { BaseModel } from '../../../model/base';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const nodeId = String(args.nodeId || '');
    const text = String(args.text || '');
    if (!nodeId) throw new Error('nodeId is required');

    const updates: Record<string, unknown> = { text };
    if (Object.prototype.hasOwnProperty.call(args, 'parentId')) {
        const parentId = String(args.parentId || '').trim();
        if (!parentId) throw new Error('parentId is required when provided');
        updates.parentId = parentId;
    }

    await BaseModel.updateNode(ctx.domainId, ctx.baseDocId, nodeId, updates as any);
    return {
        ok: true,
        nodeId,
        ...(updates.parentId ? { parentId: updates.parentId } : {}),
    };
}

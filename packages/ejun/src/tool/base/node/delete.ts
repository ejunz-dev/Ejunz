import { BaseModel } from '../../../model/base';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const nodeId = String(args.nodeId || '');
    if (!nodeId) throw new Error('nodeId is required');
    await BaseModel.deleteNode(ctx.domainId, ctx.baseDocId, nodeId);
    return { ok: true, nodeId };
}

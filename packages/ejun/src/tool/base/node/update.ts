import { BaseModel } from '../../../model/base';
import type { McpToolContext, ToolArgs } from '../../types';

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const nodeId = String(args.nodeId || '');
    const text = String(args.text || '');
    if (!nodeId) throw new Error('nodeId is required');
    await BaseModel.updateNode(ctx.domainId, ctx.baseDocId, nodeId, { text } as any);
    return { ok: true, nodeId };
}

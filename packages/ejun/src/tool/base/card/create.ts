import { CardModel, BaseModel } from '../../../model/base';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const nodeId = String(args.nodeId || '');
    const title = String(args.title || '').trim();
    if (!nodeId) throw new Error('nodeId is required');
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    if (!(base.nodes || []).some((node) => node.id === nodeId)) throw new Error(`Node not found: ${nodeId}`);
    if (!title) throw new Error('title is required');
    const docId = await CardModel.create(ctx.domainId, ctx.baseDocId, nodeId, ctx.owner, title, String(args.content || ''), undefined, undefined, undefined, undefined);
    return { ok: true, cardId: String(docId) };
}

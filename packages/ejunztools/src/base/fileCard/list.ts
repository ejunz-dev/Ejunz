import * as document from 'ejun/src/model/document';
import { BaseModel, CardModel } from 'ejun/src/model/base';
import type { CardDoc } from 'ejun/src/interface';
import { fileCardSummary } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const nodeId = String(args.nodeId || '');
    if (!nodeId) throw new Error('nodeId is required');
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    if (!(base.nodes || []).some((node) => node.id === nodeId)) throw new Error(`Node not found: ${nodeId}`);
    const cards = await CardModel.getByNodeId(ctx.domainId, ctx.baseDocId, nodeId);
    return cards.filter((card) => (card as CardDoc).cardType === 'file').map((card) => fileCardSummary(card));
}

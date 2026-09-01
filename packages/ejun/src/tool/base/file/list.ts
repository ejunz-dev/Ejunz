import * as document from '../../../model/document';
import { BaseModel, CardModel } from '../../../model/base';
import type { CardDoc } from '../../../interface';
import type { McpToolContext, ToolArgs } from '../../types';

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const nodeId = String(args.nodeId || '');
    if (!nodeId) throw new Error('nodeId is required');
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    if (!(base.nodes || []).some((node) => node.id === nodeId)) throw new Error(`Node not found: ${nodeId}`);
    const cards = await CardModel.getByNodeId(ctx.domainId, ctx.baseDocId, nodeId);
    return cards.filter((card) => (card as CardDoc).cardType === 'file').map((card) => ({
        cardId: String(card.docId),
        title: card.title,
        fileName: (card as CardDoc).fileName || '',
        fileType: (card as CardDoc).fileType || '',
        fileSize: (card as CardDoc).fileSize || 0,
        nodeId: card.nodeId,
    }));
}

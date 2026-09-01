import type { CardDoc } from '../../../interface';
import { requireCard } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    if ((card as CardDoc).cardType !== 'file') throw new Error(`Not a file-card: ${args.cardId}`);
    return {
        cardId: String(card.docId),
        title: card.title,
        fileName: (card as CardDoc).fileName || '',
        fileType: (card as CardDoc).fileType || '',
        fileSize: (card as CardDoc).fileSize || 0,
        nodeId: card.nodeId,
        content: card.content,
        downloadUrl: `/base/${ctx.baseDocId}/node/${card.nodeId}/file/${encodeURIComponent((card as CardDoc).fileName || '')}`,
    };
}

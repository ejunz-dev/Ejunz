import { CardModel } from '../../../model/base';
import storage from '../../../model/storage';
import type { CardDoc } from '../../../interface';
import { requireCard } from '../shared';
import type { McpToolContext, ToolArgs } from '../../types';

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    if ((card as CardDoc).cardType !== 'file') throw new Error(`Not a file-card: ${args.cardId}`);
    const fileName = (card as CardDoc).fileName;
    if (fileName) {
        const storagePath = `base/${ctx.domainId}/${ctx.baseDocId.toString()}/node/${card.nodeId}/${fileName}`;
        try { await storage.del([storagePath], ctx.owner); } catch { }
    }
    await CardModel.delete(ctx.domainId, card.docId);
    return { ok: true, cardId: String(args.cardId), deletedFile: !!fileName };
}

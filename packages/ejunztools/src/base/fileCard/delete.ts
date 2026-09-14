import { CardModel } from 'ejun/src/model/base';
import storage from 'ejun/src/model/storage';
import type { CardDoc } from 'ejun/src/interface';
import { fileStoragePath, requireCard } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    if ((card as CardDoc).cardType !== 'file') throw new Error(`Not a file-card: ${args.cardId}`);
    const fileName = (card as CardDoc).fileName;
    if (fileName) {
        const storagePath = fileStoragePath(ctx, card.nodeId, fileName);
        try { await storage.del([storagePath], ctx.owner); } catch { }
    }
    await CardModel.delete(ctx.domainId, card.docId);
    return { ok: true, cardId: String(args.cardId), deletedFile: !!fileName };
}

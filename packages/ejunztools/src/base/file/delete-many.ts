import { CardModel } from 'ejun/src/model/base';
import storage from 'ejun/src/model/storage';
import type { CardDoc } from 'ejun/src/interface';
import { MAX_CARDS_PER_CALL } from '../../catalog';
import { cardsById, fileStoragePath, idList } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const byId = await cardsById(ctx, cardIds);
    for (const cardId of cardIds) {
        const card = byId.get(cardId);
        if (!card) throw new Error(`Card not found: ${cardId}`);
        if ((card as CardDoc).cardType !== 'file') throw new Error(`Not a file-card: ${cardId}`);
    }

    const removed: string[] = [];
    let deletedFiles = 0;
    for (const cardId of cardIds) {
        const card = byId.get(cardId) as CardDoc;
        const fileName = card.fileName;
        if (fileName) {
            try {
                await storage.del([fileStoragePath(ctx, card.nodeId, fileName)], ctx.owner);
                deletedFiles += 1;
            } catch (error) {

            }
        }
        await CardModel.delete(ctx.domainId, card.docId);
        removed.push(cardId);
    }

    return {
        ok: true,
        baseId: ctx.baseDocId,
        removedCardIds: removed,
        removedCount: removed.length,
        deletedFiles,
        reads: { cards: 1 },
        writes: { files: deletedFiles, cards: removed.length },
    };
}

import { CardModel } from 'ejun/src/model/base';
import { MAX_CARDS_PER_CALL } from '../../catalog';
import { cardsById, idList, toObjectId } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const objectIds = cardIds.map((cardId) => toObjectId(cardId));
    const byId = await cardsById(ctx, cardIds);
    for (const cardId of cardIds) {
        if (!byId.has(cardId)) throw new Error(`Card not found: ${cardId}`);
    }

    await CardModel.deleteMany(ctx.domainId, objectIds);

    return {
        ok: true,
        baseId: ctx.baseDocId,
        removedCardIds: cardIds,
        removedCount: cardIds.length,
        reads: { cards: 1 },
        writes: { statements: 2 },
    };
}

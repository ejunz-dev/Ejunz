import { MAX_CARDS_PER_CALL } from '../../catalog';
import { cardsById, idList } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const byId = await cardsById(ctx, cardIds);

    const found: unknown[] = [];
    const missing: string[] = [];
    for (const [index, cardId] of cardIds.entries()) {
        const card = byId.get(cardId);
        if (!card) {
            missing.push(cardId);
            continue;
        }
        found.push({
            index,
            cardId: String(card.docId),
            title: card.title || '',
            content: card.content || '',
        });
    }

    return {
        ok: missing.length === 0,
        baseId: ctx.baseDocId,
        cardCount: found.length,
        cards: found,
        missingCardIds: missing,
        reads: { cards: 1 },
    };
}

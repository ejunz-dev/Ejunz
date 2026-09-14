import type { CardDoc } from 'ejun/src/interface';
import { MAX_CARDS_PER_CALL } from '../../catalog';
import { cardsById, fileCardDetail, idList } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const byId = await cardsById(ctx, cardIds);

    const files: unknown[] = [];
    const missing: { index: number; cardId: string; error: string }[] = [];
    for (const [index, cardId] of cardIds.entries()) {
        const card = byId.get(cardId);
        if (!card) {
            missing.push({ index, cardId, error: 'Card not found' });
            continue;
        }
        if ((card as CardDoc).cardType !== 'file') {
            missing.push({ index, cardId, error: `Not a file-card: ${cardId}` });
            continue;
        }
        files.push({ index, ...fileCardDetail(card, ctx.baseDocId) });
    }

    return {
        ok: missing.length === 0,
        baseId: ctx.baseDocId,
        fileCount: files.length,
        files,
        missing,
        reads: { cards: 1 },
    };
}

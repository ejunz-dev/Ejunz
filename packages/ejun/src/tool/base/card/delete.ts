import { CardModel } from '../../../model/base';
import { requireCard } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    await CardModel.delete(ctx.domainId, card.docId);
    return { ok: true, cardId: String(card.docId) };
}

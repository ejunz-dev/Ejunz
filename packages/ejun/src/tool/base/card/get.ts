import { requireCard } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    return {
        ok: true,
        cardId: String(card.docId),
        title: card.title || '',
        content: card.content || '',
    };
}

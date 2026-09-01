import { CardModel } from '../../../model/base';
import { requireCard } from '../shared';
import type { McpToolContext, ToolArgs } from '../../types';

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    const updates: Record<string, any> = {};
    if (typeof args.title === 'string') updates.title = args.title;
    if (typeof args.content === 'string') updates.content = args.content;
    if (!Object.keys(updates).length) throw new Error('Nothing to update (title or content required)');
    await CardModel.update(ctx.domainId, card.docId, updates);
    return { ok: true, cardId: String(card.docId) };
}

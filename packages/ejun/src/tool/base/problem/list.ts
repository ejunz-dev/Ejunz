import { requireCard, summarizeProblem } from '../shared';
import type { McpToolContext, ToolArgs } from '../../types';

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    const problems = card.problems || [];
    return { cardId: String(card.docId), count: problems.length, problems: problems.map(summarizeProblem) };
}

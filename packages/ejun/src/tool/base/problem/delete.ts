import { findProblemIndex, requireCard, saveCardProblems } from '../shared';
import type { McpToolContext, ToolArgs } from '../../types';

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    const pid = String(args.pid || '').trim();
    if (!pid) throw new Error('pid is required');
    const problems = card.problems || [];
    const index = findProblemIndex(problems, pid);
    if (index < 0) throw new Error(`Problem not found: ${pid}`);
    await saveCardProblems(ctx.domainId, card, problems.filter((_, itemIndex) => itemIndex !== index));
    return { ok: true, cardId: String(card.docId), pid };
}

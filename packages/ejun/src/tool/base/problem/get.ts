import { findProblemIndex, requireCard } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    const pid = String(args.pid || '').trim();
    if (!pid) throw new Error('pid is required');
    const problems = card.problems || [];
    const index = findProblemIndex(problems, pid);
    if (index < 0) throw new Error(`Problem not found: ${pid}`);
    return { cardId: String(card.docId), problem: problems[index] };
}

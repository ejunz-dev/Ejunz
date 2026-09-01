import { migrateRawProblem } from '../../../model/problem';
import { buildProblemRaw, findProblemIndex, parseProblemPayload, requireCard, saveCardProblems } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    const pid = String(args.pid || '').trim();
    if (!pid) throw new Error('pid is required');
    const payload = parseProblemPayload(args.problem);
    const problems = [...(card.problems || [])];
    const index = findProblemIndex(problems, pid);
    if (index < 0) throw new Error(`Problem not found: ${pid}`);
    const problem = migrateRawProblem(buildProblemRaw({ ...(problems[index] as unknown as Record<string, unknown>), ...payload }, pid));
    problems[index] = problem;
    await saveCardProblems(ctx.domainId, card, problems);
    return { ok: true, cardId: String(card.docId), pid, problem };
}

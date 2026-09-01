import { migrateRawProblem } from '../../../model/problem';
import { buildProblemRaw, newProblemPid, parseProblemPayload, requireCard, saveCardProblems } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const card = await requireCard(ctx, args.cardId);
    const payload = parseProblemPayload(args.problem);
    const pid = newProblemPid();
    const problem = migrateRawProblem(buildProblemRaw(payload, pid));
    await saveCardProblems(ctx.domainId, card, [...(card.problems || []), problem]);
    return { ok: true, cardId: String(card.docId), pid: problem.pid, problem };
}

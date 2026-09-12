import type { CardDoc, Problem } from 'ejun/src/interface';
import { migrateRawProblem } from 'ejun/src/model/problem';
import { MAX_PROBLEMS_PER_CALL } from '../../catalog';
import { asText, buildProblemRaw, newProblemPid, parseProblemPayload, requireCard, saveCardProblems } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

interface PlannedEntry {
    index: number;
    cardId: string;
    problems: Problem[];
}

function problemsOf(raw: unknown, label: string): Problem[] {
    if (!Array.isArray(raw) || !raw.length) throw new Error(`${label}.problems must be a non-empty array`);
    return raw.map((entry, index) => {
        try {
            return migrateRawProblem(buildProblemRaw(parseProblemPayload(entry), newProblemPid())) as unknown as Problem;
        } catch (error) {
            throw new Error(`${label}.problems[${index}]: ${(error as Error).message}`);
        }
    });
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, problems }');
    const planned: PlannedEntry[] = raw.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`entries[${index}] must be an object with cardId and problems`);
        const fields = entry as Record<string, unknown>;
        const cardId = asText(fields.cardId);
        if (!cardId) throw new Error(`entries[${index}].cardId is required`);
        return { index, cardId, problems: problemsOf(fields.problems, `entries[${index}]`) };
    });
    const total = planned.reduce((sum, entry) => sum + entry.problems.length, 0);
    if (total > MAX_PROBLEMS_PER_CALL) {
        throw new Error(`entries hold ${total} problems and one call adds ${MAX_PROBLEMS_PER_CALL}; split the work across calls`);
    }
    const seen = new Set<string>();
    for (const entry of planned) {
        if (seen.has(entry.cardId)) throw new Error(`entries[${entry.index}].cardId ${entry.cardId} appears twice; send one entry holding all of that card's problems`);
        seen.add(entry.cardId);
    }

    const cards: CardDoc[] = [];
    for (const entry of planned) cards.push(await requireCard(ctx, entry.cardId));

    const added: { index: number; cardId: string; added: string[]; total: number }[] = [];
    const refused: { index: number; cardId: string; error: string }[] = [];
    for (const [position, entry] of planned.entries()) {
        const card = cards[position];
        try {
            await saveCardProblems(ctx.domainId, card, [...(card.problems || []), ...entry.problems]);
            added.push({
                index: entry.index,
                cardId: entry.cardId,
                added: entry.problems.map((problem) => problem.pid),
                total: (card.problems || []).length + entry.problems.length,
            });
        } catch (error) {
            refused.push({ index: entry.index, cardId: entry.cardId, error: (error as Error).message });
        }
    }

    return {
        ok: refused.length === 0,
        baseId: ctx.baseDocId,
        problemCount: added.reduce((sum, entry) => sum + entry.added.length, 0),
        entries: added,
        refusedEntries: refused,
        writes: { cards: added.length },
    };
}

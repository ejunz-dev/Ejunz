import type { CardDoc, Problem } from 'ejun/src/interface';
import { migrateRawProblem } from 'ejun/src/model/problem';
import { MAX_PROBLEMS_PER_CALL } from '../../catalog';
import { asText, buildProblemRaw, cardsById, findProblemIndex, parseProblemPayload, saveCardProblems } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

interface PlannedUpdate {
    index: number;
    cardId: string;
    pid: string;
    payload: Record<string, unknown>;
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, pid, problem }');
    if (raw.length > MAX_PROBLEMS_PER_CALL) {
        throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_PROBLEMS_PER_CALL}; split the work across calls`);
    }

    const planned: PlannedUpdate[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`entries[${index}] must be an object with cardId, pid and problem`);
        const fields = entry as Record<string, unknown>;
        const cardId = asText(fields.cardId);
        if (!cardId) throw new Error(`entries[${index}].cardId is required`);
        const pid = asText(fields.pid);
        if (!pid) throw new Error(`entries[${index}].pid is required`);
        const key = `${cardId}:${pid}`;
        if (seen.has(key)) throw new Error(`entries[${index}] names ${pid} of card ${cardId} twice; send one entry per problem`);
        seen.add(key);
        planned.push({ index, cardId, pid, payload: parseProblemPayload(fields.problem) });
    }

    const byId = await cardsById(ctx, [...new Set(planned.map((entry) => entry.cardId))]);
    for (const entry of planned) {
        const card = byId.get(entry.cardId);
        if (!card) throw new Error(`Card not found: ${entry.cardId}`);
        if (findProblemIndex(card.problems || [], entry.pid) < 0) throw new Error(`Problem not found: ${entry.pid}`);
    }

    const updatesByCard = new Map<string, PlannedUpdate[]>();
    for (const entry of planned) {
        const list = updatesByCard.get(entry.cardId);
        if (list) list.push(entry);
        else updatesByCard.set(entry.cardId, [entry]);
    }

    const updated: { index: number; cardId: string; pid: string }[] = [];
    const refused: { index: number; cardId: string; pid: string; error: string }[] = [];
    let writes = 0;
    for (const [cardId, entries] of updatesByCard) {
        const card = byId.get(cardId) as CardDoc;
        const problems: Problem[] = [...(card.problems || [])];
        for (const entry of entries) {
            const position = findProblemIndex(problems, entry.pid);
            const merged = { ...(problems[position] as unknown as Record<string, unknown>), ...entry.payload };
            problems[position] = migrateRawProblem(buildProblemRaw(merged, entry.pid)) as unknown as Problem;
        }
        try {
            await saveCardProblems(ctx.domainId, card, problems);
            writes += 1;
            for (const entry of entries) updated.push({ index: entry.index, cardId, pid: entry.pid });
        } catch (error) {
            for (const entry of entries) refused.push({ index: entry.index, cardId, pid: entry.pid, error: (error as Error).message });
        }
    }

    return {
        ok: refused.length === 0,
        baseId: ctx.baseDocId,
        problemCount: updated.length,
        problems: updated.sort((left, right) => left.index - right.index),
        refusedEntries: refused,
        reads: { cards: 1 },
        writes: { cards: writes },
    };
}

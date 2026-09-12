import type { CardDoc, Problem } from 'ejun/src/interface';
import { MAX_PROBLEMS_PER_CALL } from '../../catalog';
import { asText, cardsById, findProblemIndex, saveCardProblems } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

interface PlannedEntry {
    index: number;
    cardId: string;
    pids: string[];
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, pids }');
    const planned: PlannedEntry[] = raw.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`entries[${index}] must be an object with cardId and pids`);
        const fields = entry as Record<string, unknown>;
        const cardId = asText(fields.cardId);
        if (!cardId) throw new Error(`entries[${index}].cardId is required`);
        const pids = Array.isArray(fields.pids) ? fields.pids.map((pid) => asText(pid)) : [];
        if (!pids.length || pids.some((pid) => !pid)) throw new Error(`entries[${index}].pids must be a non-empty array of ids`);
        return { index, cardId, pids: [...new Set(pids)] };
    });
    const seen = new Set<string>();
    for (const entry of planned) {
        if (seen.has(entry.cardId)) throw new Error(`entries[${entry.index}].cardId ${entry.cardId} appears twice; send one entry holding all of that card's problems`);
        seen.add(entry.cardId);
    }
    const total = planned.reduce((sum, entry) => sum + entry.pids.length, 0);
    if (total > MAX_PROBLEMS_PER_CALL) {
        throw new Error(`entries hold ${total} problems and one call removes ${MAX_PROBLEMS_PER_CALL}; split the work across calls`);
    }

    const byId = await cardsById(ctx, planned.map((entry) => entry.cardId));
    for (const entry of planned) {
        const card = byId.get(entry.cardId);
        if (!card) throw new Error(`Card not found: ${entry.cardId}`);
        for (const pid of entry.pids) {
            if (findProblemIndex(card.problems || [], pid) < 0) throw new Error(`Problem not found: ${pid}`);
        }
    }

    const removed: { index: number; cardId: string; removed: string[] }[] = [];
    const refused: { index: number; cardId: string; error: string }[] = [];
    let writes = 0;
    for (const entry of planned) {
        const card = byId.get(entry.cardId) as CardDoc;
        const problems: Problem[] = (card.problems || []).filter((problem) => !entry.pids.includes(String(problem.pid)));
        try {
            await saveCardProblems(ctx.domainId, card, problems);
            writes += 1;
            removed.push({ index: entry.index, cardId: entry.cardId, removed: entry.pids });
        } catch (error) {
            refused.push({ index: entry.index, cardId: entry.cardId, error: (error as Error).message });
        }
    }

    return {
        ok: refused.length === 0,
        baseId: ctx.baseDocId,
        removedCount: removed.reduce((sum, entry) => sum + entry.removed.length, 0),
        entries: removed.sort((left, right) => left.index - right.index),
        refusedEntries: refused,
        reads: { cards: 1 },
        writes: { cards: writes },
    };
}

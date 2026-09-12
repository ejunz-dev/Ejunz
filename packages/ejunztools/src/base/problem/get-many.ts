import { MAX_PROBLEMS_PER_CALL } from '../../catalog';
import { asText, cardsById, findProblemIndex } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

interface PlannedEntry {
    index: number;
    cardId: string;
    pid: string;
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, pid }');
    if (raw.length > MAX_PROBLEMS_PER_CALL) {
        throw new Error(`entries holds ${raw.length} entries and one call reads ${MAX_PROBLEMS_PER_CALL}; split the work across calls`);
    }
    const planned: PlannedEntry[] = raw.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`entries[${index}] must be an object with cardId and pid`);
        const fields = entry as Record<string, unknown>;
        const cardId = asText(fields.cardId);
        if (!cardId) throw new Error(`entries[${index}].cardId is required`);
        const pid = asText(fields.pid);
        if (!pid) throw new Error(`entries[${index}].pid is required`);
        return { index, cardId, pid };
    });
    const byId = await cardsById(ctx, [...new Set(planned.map((entry) => entry.cardId))]);

    const found: unknown[] = [];
    const missing: { index: number; cardId: string; pid: string; error: string }[] = [];
    for (const entry of planned) {
        const card = byId.get(entry.cardId);
        if (!card) {
            missing.push({ index: entry.index, cardId: entry.cardId, pid: entry.pid, error: 'Card not found' });
            continue;
        }
        const problems = card.problems || [];
        const position = findProblemIndex(problems, entry.pid);
        if (position < 0) {
            missing.push({ index: entry.index, cardId: entry.cardId, pid: entry.pid, error: `Problem not found: ${entry.pid}` });
            continue;
        }
        found.push({ index: entry.index, cardId: String(card.docId), pid: entry.pid, problem: problems[position] });
    }

    return {
        ok: missing.length === 0,
        baseId: ctx.baseDocId,
        problemCount: found.length,
        problems: found,
        missing,
        reads: { cards: 1 },
    };
}

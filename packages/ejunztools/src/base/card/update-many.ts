import { CardModel } from 'ejun/src/model/base';
import type { CardDoc } from 'ejun/src/interface';
import { MAX_CARDS_PER_CALL } from '../../catalog';
import { asText, cardsById } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

interface PlannedUpdate {
    index: number;
    cardId: string;
    fields: string[];
    update: { title?: string; content?: string };
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, title?, content? }');
    if (raw.length > MAX_CARDS_PER_CALL) {
        throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_CARDS_PER_CALL}; split the work across calls`);
    }

    const planned: PlannedUpdate[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`entries[${index}] must be an object with cardId`);
        const fields = entry as Record<string, unknown>;
        const cardId = asText(fields.cardId);
        if (!cardId) throw new Error(`entries[${index}].cardId is required`);
        if (seen.has(cardId)) throw new Error(`entries[${index}].cardId ${cardId} appears twice; send one entry per card`);
        seen.add(cardId);

        const update: { title?: string; content?: string } = {};
        const changed: string[] = [];
        for (const field of ['title', 'content'] as const) {
            if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
            if (typeof fields[field] !== 'string') throw new Error(`entries[${index}].${field} must be a string`);
            update[field] = fields[field] as string;
            changed.push(field);
        }
        if (!changed.length) throw new Error(`entries[${index}] names nothing to change; give title, content, or both`);
        planned.push({ index, cardId, fields: changed, update });
    }

    const byId = await cardsById(ctx, planned.map((entry) => entry.cardId));
    for (const entry of planned) {
        if (!byId.has(entry.cardId)) throw new Error(`Card not found: ${entry.cardId}`);
    }

    const updated: { index: number; cardId: string; changed: string[] }[] = [];
    const refused: { index: number; cardId: string; error: string }[] = [];
    for (const entry of planned) {
        const card = byId.get(entry.cardId) as CardDoc;
        try {
            await CardModel.update(ctx.domainId, card.docId, entry.update);
            updated.push({ index: entry.index, cardId: entry.cardId, changed: entry.fields });
        } catch (error) {
            refused.push({ index: entry.index, cardId: entry.cardId, error: (error as Error).message });
        }
    }

    return {
        ok: refused.length === 0,
        baseId: ctx.baseDocId,
        cardCount: updated.length,
        cards: updated,
        refusedCards: refused,
        reads: { cards: 1 },
        writes: { cards: updated.length },
    };
}

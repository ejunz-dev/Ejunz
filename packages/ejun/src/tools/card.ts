import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import type { CardDoc, Problem } from 'ejun/src/interface';
import { BaseModel, CardModel } from 'ejun/src/model/base';
import { migrateRawProblem } from 'ejun/src/model/problem';
import { MAX_CARDS_PER_CALL } from '../lib/tool-limits';
import { asText, buildProblemRaw, cardUrl, cardsById, idList, newProblemPid, parseProblemPayload, requireCard, toObjectId } from '../lib/tool-shared';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/registry';

export const inject = ['server'];

export const Create = Schema.object({
    nodeId: Schema.string().required().description('Owning existing node id.'),
    title: Schema.string().required().description('Card title.'),
    content: Schema.string().description('Markdown body (optional).'),
}).description('Create a new card (content block) under a node. Use an existing nodeId. Returns the card id and the URL that opens the Base at this card.');

export const Update = Schema.object({
    cardId: Schema.string().required().description('Card docId (hex).'),
    title: Schema.string().description('New title (optional).'),
    content: Schema.string().description('New markdown body (optional).'),
}).description('Update a card\'s title and/or markdown content by cardId. Use cardId. Returns the URL that opens the Base at this card.');

export const Get = Schema.object({
    cardId: Schema.string().required().description('Card docId (hex).'),
}).description('Read a card by cardId and return its title and markdown content. Also returns the URL that opens the Base at this card.');

export const Remove = Schema.object({
    cardId: Schema.string().required().description('Card docId (hex).'),
}).description('Delete a card by cardId. Use cardId.');

export const CreateMany = Schema.object({
    cards: Schema.array(Schema.object({
        nodeId: Schema.string().required().description('Existing node to attach the card to (required).'),
        title: Schema.string().required().description('Card title (required).'),
        content: Schema.string().description('Card markdown body (optional).'),
        tags: Schema.array(Schema.string()).description('Optional card tags.'),
        problems: Schema.array(Schema.any()).description('Practice problems stored on the card as it is created, each the same payload `base_problem_create` takes.'),
    })).min(1).max(MAX_CARDS_PER_CALL).required().description('Cards to create, in order.'),
}).description('Create several cards at once. `cards` is an array of `{ nodeId, title, content?, tags?, problems? }`, where `problems` holds the '
    + 'payloads `base_problem_create` takes, stored with the card as it is created. The Base is read once and every card is checked before the '
    + 'first insert, so a refused call inserts nothing. Each card is its own document and therefore one insert that carries its own problems, so '
    + 'no card is ever half-created; a failure the database itself reports part way through is named in `refusedCards` and `ok` is false. Use it '
    + `instead of calling \`base_card_create\` once per card. One call creates at most ${MAX_CARDS_PER_CALL} cards. `
    + 'Every created card carries the URL that opens the Base at it.');

export const GetMany = Schema.object({
    cardIds: Schema.array(Schema.string()).min(1).max(MAX_CARDS_PER_CALL).required().description('Card docIds to read, in order.'),
}).description('Read several cards of one Base in a single call, each reported exactly as `base_card_get` reports one. The cards come from one '
    + 'read of the card collection, so the call costs one read however many cards it names, instead of one read per card. A read changes '
    + `nothing, so a card this Base does not hold is listed in \`missingCardIds\` and \`ok\` is false. Use it instead of calling \`base_card_get\` once per card. One call reads at most ${MAX_CARDS_PER_CALL} cards.`);

export const UpdateMany = Schema.object({
    entries: Schema.array(Schema.object({
        cardId: Schema.string().required().description('Card to change (required).'),
        title: Schema.string().description('New card title (optional).'),
        content: Schema.string().description('New card markdown body (optional).'),
    })).min(1).max(MAX_CARDS_PER_CALL).required().description('One entry per card.'),
}).description('Update several cards of one Base in a single call: `entries` is an array of `{ cardId, title?, content? }`, and an entry must name '
    + 'at least one field. A card is its own document, so each card that changes is one write, and the call saves the reading and the checks: '
    + 'the cards are read once and an id that names no card of this Base refuses the whole call, so a refused call writes nothing. A failure the '
    + `database itself reports is named in \`refusedCards\` and \`ok\` is false. Use it instead of calling \`base_card_update\` once per card. One call updates at most ${MAX_CARDS_PER_CALL} cards, and every updated card carries the URL that opens the Base at it.`);

export const RemoveMany = Schema.object({
    cardIds: Schema.array(Schema.string()).min(1).max(MAX_CARDS_PER_CALL).required().description('Cards to remove.'),
}).description('Delete several cards of one Base in a single call. A card is its own document, so every named card goes with one delete of the '
    + 'card collection and one delete of its status rows, instead of two statements per card. The cards are read once first, and an id that '
    + 'names no card of this Base refuses the whole call, so a refused call deletes nothing. It removes what `base_card_delete` removes and '
    + `nothing else. Use it instead of calling \`base_card_delete\` once per card. One call removes at most ${MAX_CARDS_PER_CALL} cards.`);

function tagsOf(raw: unknown, label: string): string[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) throw new Error(`${label}: tags must be an array`);
    if (!raw.length) return undefined;
    return raw.map((tag) => String(tag));
}

function problemsOf(raw: unknown, label: string): Problem[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error(`${label}: problems must be an array`);
    return raw.map((entry, index) => {
        try {
            return migrateRawProblem(buildProblemRaw(parseProblemPayload(entry), newProblemPid())) as unknown as Problem;
        } catch (error) {
            throw new Error(`${label}: problems[${index}]: ${(error as Error).message}`);
        }
    });
}

export async function create(ctx: ToolContext, args: ToolArgs) {
    const nodeId = String(args.nodeId || '');
    const title = String(args.title || '').trim();
    if (!nodeId) throw new Error('nodeId is required');
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    if (!(base.nodes || []).some((node) => node.id === nodeId)) throw new Error(`Node not found: ${nodeId}`);
    if (!title) throw new Error('title is required');
    const docId = await CardModel.create(ctx.domainId, ctx.baseDocId, nodeId, ctx.owner, title, String(args.content || ''), undefined, undefined, undefined, undefined);
    return { ok: true, cardId: String(docId), nodeId, url: cardUrl(ctx, ctx.baseDocId, String(docId)) };
}

export async function update(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId);
    const updates: Record<string, any> = {};
    if (typeof args.title === 'string') updates.title = args.title;
    if (typeof args.content === 'string') updates.content = args.content;
    if (!Object.keys(updates).length) throw new Error('Nothing to update (title or content required)');
    await CardModel.update(ctx.domainId, card.docId, updates);
    return { ok: true, cardId: String(card.docId), url: cardUrl(ctx, ctx.baseDocId, String(card.docId)) };
}

export async function get(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId);
    return {
        ok: true,
        cardId: String(card.docId),
        title: card.title || '',
        content: card.content || '',
        url: cardUrl(ctx, ctx.baseDocId, String(card.docId)),
    };
}

export async function remove(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId);
    await CardModel.delete(ctx.domainId, card.docId);
    return { ok: true, cardId: String(card.docId) };
}

export async function createMany(ctx: ToolContext, args: ToolArgs) {
    const raw = args.cards;
    if (!Array.isArray(raw) || !raw.length) throw new Error('cards must be a non-empty array of { nodeId, title, ... }');
    if (raw.length > MAX_CARDS_PER_CALL) {
        throw new Error(`cards holds ${raw.length} entries and one call creates ${MAX_CARDS_PER_CALL}; split the work across calls`);
    }
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const nodeIds = new Set((base.nodes || []).map((node) => node.id));
    const planned = raw.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`cards[${index}] must be an object with nodeId and title`);
        const fields = entry as Record<string, unknown>;
        const label = `cards[${index}]`;
        const nodeId = asText(fields.nodeId);
        if (!nodeId) throw new Error(`${label}.nodeId is required`);
        if (!nodeIds.has(nodeId)) throw new Error(`${label}.nodeId ${nodeId} is not a node of this Base`);
        const title = asText(fields.title);
        if (!title) throw new Error(`${label}.title is required`);
        const tags = tagsOf(fields.tags, label);
        return {
            index,
            nodeId,
            title,
            content: fields.content === undefined || fields.content === null ? '' : String(fields.content),
            ...(tags ? { tags } : {}),
            problems: problemsOf(fields.problems, label),
        };
    });
    const positions = new Map<string, number>();
    for (const nodeId of new Set(planned.map((card) => card.nodeId))) {
        const existing = await CardModel.getByNodeId(ctx.domainId, ctx.baseDocId, nodeId);
        positions.set(nodeId, existing.reduce((max, card) => Math.max(max, card.order ?? -1), -1) + 1);
    }
    const created: { index: number; cardId: string; nodeId: string; title: string; order: number; problems: string[]; url: string }[] = [];
    const refused: { index: number; nodeId: string; title: string; error: string }[] = [];
    for (const card of planned) {
        const order = positions.get(card.nodeId) as number;
        positions.set(card.nodeId, order + 1);
        try {
            const cardId = await CardModel.create(
                ctx.domainId, ctx.baseDocId, card.nodeId, ctx.owner, card.title, card.content,
                undefined, card.problems.length ? card.problems : undefined, order,
                undefined, undefined, undefined, undefined, card.tags,
            );
            created.push({
                index: card.index,
                cardId: String(cardId),
                nodeId: card.nodeId,
                title: card.title,
                order,
                problems: card.problems.map((problem) => problem.pid),
                url: cardUrl(ctx, ctx.baseDocId, String(cardId)),
            });
        } catch (error) {
            refused.push({ index: card.index, nodeId: card.nodeId, title: card.title, error: (error as Error).message });
        }
    }
    return {
        ok: refused.length === 0,
        baseId: ctx.baseDocId,
        cardCount: created.length,
        cards: created,
        refusedCards: refused,
        writes: { cards: created.length },
    };
}

export async function getMany(ctx: ToolContext, args: ToolArgs) {
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const byId = await cardsById(ctx, cardIds);
    const found: unknown[] = [];
    const missing: string[] = [];
    for (const [index, cardId] of cardIds.entries()) {
        const card = byId.get(cardId);
        if (!card) {
            missing.push(cardId);
            continue;
        }
        found.push({
            index,
            cardId: String(card.docId),
            title: card.title || '',
            content: card.content || '',
            url: cardUrl(ctx, ctx.baseDocId, String(card.docId)),
        });
    }
    return {
        ok: missing.length === 0,
        baseId: ctx.baseDocId,
        cardCount: found.length,
        cards: found,
        missingCardIds: missing,
        reads: { cards: 1 },
    };
}

export async function updateMany(ctx: ToolContext, args: ToolArgs) {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, title?, content? }');
    if (raw.length > MAX_CARDS_PER_CALL) {
        throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_CARDS_PER_CALL}; split the work across calls`);
    }
    const planned: { index: number; cardId: string; fields: string[]; update: { title?: string; content?: string } }[] = [];
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
    const updated: { index: number; cardId: string; changed: string[]; url: string }[] = [];
    const refused: { index: number; cardId: string; error: string }[] = [];
    for (const entry of planned) {
        const card = byId.get(entry.cardId) as CardDoc;
        try {
            await CardModel.update(ctx.domainId, card.docId, entry.update);
            updated.push({ index: entry.index, cardId: entry.cardId, changed: entry.fields, url: cardUrl(ctx, ctx.baseDocId, entry.cardId) });
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

export async function removeMany(ctx: ToolContext, args: ToolArgs) {
    const cardIds = idList(args.cardIds, 'cardIds', MAX_CARDS_PER_CALL);
    const objectIds = cardIds.map((cardId) => toObjectId(cardId));
    const byId = await cardsById(ctx, cardIds);
    for (const cardId of cardIds) {
        if (!byId.has(cardId)) throw new Error(`Card not found: ${cardId}`);
    }
    await CardModel.deleteMany(ctx.domainId, objectIds);
    return {
        ok: true,
        baseId: ctx.baseDocId,
        removedCardIds: cardIds,
        removedCount: cardIds.length,
        reads: { cards: 1 },
        writes: { statements: 2 },
    };
}

export function apply(ctx: Context) {
    const opts = { source: 'base' as const, bindBase: 'session' as const };
    ctx.Tool('base_card_create', create, Create, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_card_update', update, Update, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_card_get', get, Get, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_card_delete', remove, Remove, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_card_create_many', createMany, CreateMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_card_get_many', getMany, GetMany, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_card_update_many', updateMany, UpdateMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_card_delete_many', removeMany, RemoveMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
}

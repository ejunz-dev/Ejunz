import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import type { CardDoc, Problem } from 'ejun/src/interface';
import { migrateRawProblem } from 'ejun/src/model/problem';
import { MAX_PROBLEMS_PER_CALL } from '../lib/tool-limits';
import {
    asText, buildProblemRaw, cardsById, findProblemIndex, newProblemPid,
    parseProblemPayload, problemUrl, requireCard, saveCardProblems, summarizeProblem,
} from '../lib/tool-shared';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/registry';

export const inject = ['server'];

export const List = Schema.object({
    cardId: Schema.string().required().description('Card docId (hex).'),
}).description('Problem = a practice exercise attached to a card (quiz, flip card, matching table, etc.). '
    + 'Lists every problem on one card: pid, type, title, a short content preview and the URL that opens the Base at each problem. Use cardId.');

export const Get = Schema.object({
    cardId: Schema.string().required().description('Card docId (hex).'),
    pid: Schema.string().required().description('Problem id from problem_list.'),
}).description('Read one practice problem in full by cardId + pid. Use pid from problem_list. Returns the URL that opens the Base at that problem.');

export const Create = Schema.object({
    cardId: Schema.string().required().description('Card docId (hex).'),
    problem: Schema.any().required().description('Problem payload. `type` defaults to single choice when omitted.'),
}).description('Add a practice problem to a card. Pass `problem` as a JSON object. '
    + 'Common fields: title (short sidebar label), stem, analysis, tags. '
    + 'type: single (default) | multi | true_false | flip | fill_blank | matching | super_flip | chain | ai_eval. '
    + 'single/multi: options[] + answer (index or index array). true_false: stem + answer 0|1. '
    + 'flip: faceA, faceB, optional hint. fill_blank: stem with ___ + answers[]. '
    + 'matching: columns[][] (≥2 cols, ≥2 rows) or legacy left/right. '
    + 'super_flip: headers[] + columns[][] (allows 1×1). chain: rows[] of {rowType:"flip"|"text", content:string}. ai_eval: stem + points[]. '
    + 'Returns the new pid and the URL that opens the Base at the new problem.');

export const Update = Schema.object({
    cardId: Schema.string().required().description('Card docId (hex).'),
    pid: Schema.string().required().description('Problem id from problem_list.'),
    problem: Schema.any().required().description('Fields to update.'),
}).description('Update an existing problem by pid. Pass `problem` with fields to change (merged with the stored row, then normalized). '
    + 'Include `type` only when changing the problem kind. Returns the URL that opens the Base at that problem.');

export const Remove = Schema.object({
    cardId: Schema.string().required().description('Card docId (hex).'),
    pid: Schema.string().required().description('Problem id from problem_list.'),
}).description('Delete a practice problem from a card by pid. Use pid from problem_list.');

export const CreateMany = Schema.object({
    entries: Schema.array(Schema.object({
        cardId: Schema.string().required().description('Existing card of this Base (required).'),
        problems: Schema.array(Schema.any()).min(1).required().description('Problems to append to that card, each the payload `base_problem_create` takes.'),
    })).min(1).required().description('One entry per card, each naming every problem that card receives.'),
}).description('Add problems to cards, several at once. `entries` is an array of `{ cardId, problems }`, where `problems` holds the payloads '
    + '`base_problem_create` takes. All the problems of one card land in one write of that card, so many problems cost one read and one write '
    + 'instead of one of each per problem, and a card never holds a partial set of what an entry sent it. Every problem is validated and every '
    + 'card is read before the first write, so a refused call changes nothing; a card the database itself refuses is named in `refusedEntries` '
    + `and \`ok\` is false. Use it instead of calling \`base_problem_create\` once per problem. One call adds at most ${MAX_PROBLEMS_PER_CALL} problems, `
    + 'and every added problem carries the URL that opens the Base at it.');

export const GetMany = Schema.object({
    entries: Schema.array(Schema.object({
        cardId: Schema.string().required().description('Card holding the problem (required).'),
        pid: Schema.string().required().description('Problem id (required).'),
    })).min(1).max(MAX_PROBLEMS_PER_CALL).required().description('One entry per problem to read.'),
}).description('Read several practice problems in a single call, each reported exactly as `base_problem_get` reports one. The cards holding them '
    + 'come from one read, so the call costs one read however many problems it names, instead of one read per problem. A read changes nothing, '
    + 'so a card or a problem this Base does not hold is listed in `missing` with its reason and `ok` is false. Each found problem carries the URL '
    + 'that opens the Base at it. Use it instead of calling `base_problem_get` once per problem.');

export const UpdateMany = Schema.object({
    entries: Schema.array(Schema.object({
        cardId: Schema.string().required().description('Card holding the problem (required).'),
        pid: Schema.string().required().description('Problem id (required).'),
        problem: Schema.any().required().description('Fields to change on that problem, merged into it (required).'),
    })).min(1).max(MAX_PROBLEMS_PER_CALL).required().description('One entry per problem.'),
}).description('Update several practice problems in a single call: `entries` is an array of `{ cardId, pid, problem }`, where `problem` holds the '
    + 'fields to change, as `base_problem_update` takes them. A card holds its problems, so every problem that changes on one card is written '
    + 'once: n problems over k cards cost one read and k writes instead of one of each per problem. Every payload is read and every named '
    + 'problem is checked before the first write, so a refused call changes nothing; a card the database itself refuses is named in '
    + `\`refusedEntries\`. Use it instead of calling \`base_problem_update\` once per problem. One call updates at most ${MAX_PROBLEMS_PER_CALL} problems, `
    + 'and every updated problem carries the URL that opens the Base at it.');

export const RemoveMany = Schema.object({
    entries: Schema.array(Schema.object({
        cardId: Schema.string().required().description('Card to change (required).'),
        pids: Schema.array(Schema.string()).min(1).required().description('Problem ids to remove from that card (required).'),
    })).min(1).required().description('One entry per card, naming every problem that card loses.'),
}).description('Delete several practice problems in a single call: `entries` is an array of `{ cardId, pids }`. A card holds its problems, so every '
    + 'problem removed from one card is written once: n problems over k cards cost one read and k writes instead of one of each per problem. '
    + 'Every card is read and every named problem is found before the first write, so a refused call changes nothing; a card the database itself '
    + `refuses is named in \`refusedEntries\`. Use it instead of calling \`base_problem_delete\` once per problem. One call removes at most ${MAX_PROBLEMS_PER_CALL} problems.`);

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

export async function list(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId);
    const problems = card.problems || [];
    return { cardId: String(card.docId), count: problems.length, problems: problems.map((problem) => summarizeProblem(ctx, card, problem)) };
}

export async function get(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId);
    const pid = String(args.pid || '').trim();
    if (!pid) throw new Error('pid is required');
    const problems = card.problems || [];
    const index = findProblemIndex(problems, pid);
    if (index < 0) throw new Error(`Problem not found: ${pid}`);
    return { cardId: String(card.docId), problem: problems[index], url: problemUrl(ctx, ctx.baseDocId, String(card.docId), pid) };
}

export async function create(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId);
    const payload = parseProblemPayload(args.problem);
    const pid = newProblemPid();
    const problem = migrateRawProblem(buildProblemRaw(payload, pid));
    await saveCardProblems(ctx.domainId, card, [...(card.problems || []), problem]);
    return { ok: true, cardId: String(card.docId), pid: problem.pid, problem, url: problemUrl(ctx, ctx.baseDocId, String(card.docId), String(problem.pid)) };
}

export async function update(ctx: ToolContext, args: ToolArgs) {
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
    return { ok: true, cardId: String(card.docId), pid, problem, url: problemUrl(ctx, ctx.baseDocId, String(card.docId), pid) };
}

export async function remove(ctx: ToolContext, args: ToolArgs) {
    const card = await requireCard(ctx, args.cardId);
    const pid = String(args.pid || '').trim();
    if (!pid) throw new Error('pid is required');
    const problems = card.problems || [];
    const index = findProblemIndex(problems, pid);
    if (index < 0) throw new Error(`Problem not found: ${pid}`);
    await saveCardProblems(ctx.domainId, card, problems.filter((_, itemIndex) => itemIndex !== index));
    return { ok: true, cardId: String(card.docId), pid };
}

export async function createMany(ctx: ToolContext, args: ToolArgs) {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, problems }');
    const planned = raw.map((entry, index) => {
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
    const added: { index: number; cardId: string; added: string[]; total: number; urls: string[] }[] = [];
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
                urls: entry.problems.map((problem) => problemUrl(ctx, ctx.baseDocId, entry.cardId, String(problem.pid))),
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

export async function getMany(ctx: ToolContext, args: ToolArgs) {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, pid }');
    if (raw.length > MAX_PROBLEMS_PER_CALL) {
        throw new Error(`entries holds ${raw.length} entries and one call reads ${MAX_PROBLEMS_PER_CALL}; split the work across calls`);
    }
    const planned = raw.map((entry, index) => {
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
        found.push({
            index: entry.index,
            cardId: String(card.docId),
            pid: entry.pid,
            problem: problems[position],
            url: problemUrl(ctx, ctx.baseDocId, String(card.docId), entry.pid),
        });
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

export async function updateMany(ctx: ToolContext, args: ToolArgs) {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, pid, problem }');
    if (raw.length > MAX_PROBLEMS_PER_CALL) {
        throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_PROBLEMS_PER_CALL}; split the work across calls`);
    }
    const planned: { index: number; cardId: string; pid: string; payload: Record<string, unknown> }[] = [];
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
    const updatesByCard = new Map<string, typeof planned>();
    for (const entry of planned) {
        const list = updatesByCard.get(entry.cardId);
        if (list) list.push(entry);
        else updatesByCard.set(entry.cardId, [entry]);
    }
    const updated: { index: number; cardId: string; pid: string; url: string }[] = [];
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
            for (const entry of entries) updated.push({ index: entry.index, cardId, pid: entry.pid, url: problemUrl(ctx, ctx.baseDocId, cardId, entry.pid) });
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

export async function removeMany(ctx: ToolContext, args: ToolArgs) {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { cardId, pids }');
    const planned = raw.map((entry, index) => {
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

export function apply(ctx: Context) {
    const opts = { source: 'base' as const, bindBase: 'session' as const };
    ctx.Tool('base_problem_list', list, List, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_problem_get', get, Get, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_problem_create', create, Create, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_problem_update', update, Update, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_problem_delete', remove, Remove, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_problem_create_many', createMany, CreateMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_problem_get_many', getMany, GetMany, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_problem_update_many', updateMany, UpdateMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_problem_delete_many', removeMany, RemoveMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
}

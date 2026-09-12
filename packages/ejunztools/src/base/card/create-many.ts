import type { Problem } from 'ejun/src/interface';
import { BaseModel, CardModel } from 'ejun/src/model/base';
import { migrateRawProblem } from 'ejun/src/model/problem';
import { MAX_CARDS_PER_CALL } from '../../catalog';
import { asText, buildProblemRaw, newProblemPid, parseProblemPayload } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

interface PlannedCard {
    index: number;
    nodeId: string;
    title: string;
    content: string;
    tags?: string[];
    problems: Problem[];
}

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

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.cards;
    if (!Array.isArray(raw) || !raw.length) throw new Error('cards must be a non-empty array of { nodeId, title, ... }');
    if (raw.length > MAX_CARDS_PER_CALL) {
        throw new Error(`cards holds ${raw.length} entries and one call creates ${MAX_CARDS_PER_CALL}; split the work across calls`);
    }
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const nodeIds = new Set((base.nodes || []).map((node) => node.id));

    const planned: PlannedCard[] = raw.map((entry, index) => {
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

    const created: { index: number; cardId: string; nodeId: string; title: string; order: number; problems: string[] }[] = [];
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
            created.push({ index: card.index, cardId: String(cardId), nodeId: card.nodeId, title: card.title, order, problems: card.problems.map((problem) => problem.pid) });
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

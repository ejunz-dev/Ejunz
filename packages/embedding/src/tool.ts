import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { Handler, post, Types } from 'ejun/src/service/server';
import { BadRequestError, NotFoundError } from 'ejun/src/error';
import { callToolViaWorker } from 'ejun/src/handler/worker';
import { PRIV } from 'ejun/src/model/builtin';
import type { CardDoc } from 'ejun/src/interface';
import { BaseModel } from 'ejun/src/model/base';
import * as document from 'ejun/src/model/document';
import { buildEmbeddingStatusView, enqueueEmbeddingIndex, loadEmbeddingIndexSnapshot } from './embedding';
import type { EmbeddingIndexMode } from './embedding';
import type { EmbeddingService } from './embedding/service';
import { buildParentMap, cardUrl, nodeUrl, pathLabelFor } from 'ejun/src/lib/tool-shared';
import type { ToolArgs, ToolContext } from 'ejun/src/lib/tool-types';
import type {} from 'ejun/src/service/registry';

export const inject = ['server'];

export const Search = Schema.object({
    query: Schema.string().required().description('Natural language query — describe what you are looking for (required).'),
    limit: Schema.number().min(1).max(50).description('Max results to return. Default 15, max 50.'),
    kind: Schema.union(['node', 'card'] as const).description('Restrict to "node" (headings) or "card" (content). Omit to search both.'),
}).description('Semantic (vector) search across node titles and card content. '
    + 'Searches by meaning rather than keyword — use this to find content conceptually related to your query. '
    + 'Results include a similarity `score` (0–1) and the matched text snippet. '
    + 'Use `kind` to restrict to "node" (headings only) or "card" (content only); omit for both. '
    + 'Each result carries the URL that opens the Base at the matched node or card.');

export const Status = Schema.object({
    baseId: Schema.number().step(1).min(1).description('Base to inspect (optional; defaults to the session\'s Base).'),
}).description('Report the vector (embedding) index of a Base: the queue state, how many vectors are stored and which model stamped them, '
    + 'and the gap against live nodes and cards (missing, stale, detached, orphaned). While a rebuild runs, `state.progress` gives its live phase '
    + 'and percentage. Use it before and after base_embedding_reindex, or to find content that semantic search cannot see. Defaults to the '
    + 'session\'s Base; pass `baseId` for another Base in the domain.');

export const Reindex = Schema.object({
    baseId: Schema.number().step(1).min(1).description('Base to re-index (optional; defaults to the session\'s Base).'),
    mode: Schema.union(['full_rebuild', 'incremental'] as const).description('Rebuild scope (default "full_rebuild").'),
    nodeIds: Schema.array(Schema.string()).description('Node ids to re-embed; required for mode "incremental" unless cardIds are given.'),
    cardIds: Schema.array(Schema.string()).description('Card docIds to re-embed; required for mode "incremental" unless nodeIds are given.'),
}).description('Queue a vector (embedding) rebuild for a Base and return as soon as it is queued; the rebuild then runs for as long as it needs, '
    + 'with no deadline, and base_embedding_status reports its live progress. `mode: "full_rebuild"` (the default) re-embeds every node title and '
    + 'card chunk and drops vectors whose content is gone; `mode: "incremental"` re-embeds only the given `nodeIds` / `cardIds`. Defaults to the '
    + 'session\'s Base; pass `baseId` for another Base in the domain.');

const MAX_SAMPLE_IDS = 20;

function summarize(text: string, max = 96): string {
    const flat = (text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cardHasIndexableText(card: CardDoc): boolean {
    return !!((card.title || '').trim() || (card.content || '').trim() || (card.problems || []).length);
}

function idList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const raw of value) {
        const id = String(raw ?? '').trim();
        if (id) seen.add(id);
    }
    return [...seen];
}

export async function search(ctx: ToolContext, args: ToolArgs) {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query is required');
    const contentIndex = (typeof (global as any).app?.get === 'function'
        ? (global as any).app.get('contentIndex')
        : undefined) as EmbeddingService | undefined;
    if (!contentIndex) throw new Error('Content index service is not loaded');
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
    const kind = String(args.kind || '').trim().toLowerCase();
    const requested = kind && (kind === 'node' || kind === 'card') ? Math.min(50, limit * 3) : limit;
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const raw = await contentIndex.searchSimilar(ctx.domainId, ctx.baseDocId, query, requested);
    const results = (kind && (kind === 'node' || kind === 'card') ? raw.filter((result) => result.kind === kind) : raw).slice(0, limit);
    const parentMap = buildParentMap(base.edges || []);
    const nodeById = new Map((base.nodes || []).map((node) => [node.id, node]));
    return {
        query,
        kind: kind || null,
        matchedCount: results.length,
        results: results.map((result, index) => ({
            rank: result.rank || index + 1,
            nodeId: result.nodeId,
            kind: result.kind,
            cardDocId: result.cardDocId || null,
            cardTitle: result.cardTitle || null,
            chunkIndex: result.chunkIndex ?? 0,
            path: pathLabelFor(result.nodeId, parentMap, nodeById) || null,
            text: result.text,
            score: Math.round(result.score * 10000) / 10000,
            semanticScore: Math.round((result.semanticScore ?? result.score) * 10000) / 10000,
            keywordScore: Math.round((result.keywordScore || 0) * 10000) / 10000,
            matchedTerms: Array.isArray(result.matchedTerms) ? result.matchedTerms : [],
            url: result.kind === 'card' && result.cardDocId
                ? cardUrl(ctx, ctx.baseDocId, String(result.cardDocId))
                : nodeUrl(ctx, ctx.baseDocId, result.nodeId),
        })),
    };
}

export async function status(ctx: ToolContext, _args: ToolArgs) {
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const [state, snapshot, cardDocs] = await Promise.all([
        buildEmbeddingStatusView(ctx.domainId, ctx.baseDocId),
        loadEmbeddingIndexSnapshot(ctx.domainId, ctx.baseDocId),
        document.getMulti(ctx.domainId, document.TYPE_CARD, { baseDocId: ctx.baseDocId }).toArray() as Promise<CardDoc[]>,
    ]);
    const liveNodes = new Map<string, string>();
    for (const node of base.nodes || []) {
        const text = (node.text || '').trim();
        if (text) liveNodes.set(node.id, text);
    }
    const missingNodes: { nodeId: string; text: string }[] = [];
    const staleNodes: { nodeId: string; text: string }[] = [];
    for (const [nodeId, text] of liveNodes) {
        const indexed = snapshot.nodes.get(nodeId);
        if (!indexed) missingNodes.push({ nodeId, text: summarize(text) });
        else if (indexed.text !== text) staleNodes.push({ nodeId, text: summarize(text) });
    }
    const orphanNodeIds = [...snapshot.nodes.keys()].filter((nodeId) => !liveNodes.has(nodeId));
    const missingCards: { cardId: string; nodeId: string; title: string }[] = [];
    const detachedCards: { cardId: string; nodeId: string; title: string }[] = [];
    const staleCards: { cardId: string; title: string; cardUpdatedAt: Date; indexedAt: Date }[] = [];
    const liveCardIds = new Set<string>();
    let emptyCards = 0;
    let indexableCards = 0;
    for (const card of cardDocs) {
        const cardId = String(card.docId);
        liveCardIds.add(cardId);
        if (!cardHasIndexableText(card)) {
            emptyCards++;
            continue;
        }
        indexableCards++;
        const indexed = snapshot.cards.get(cardId);
        if (!indexed) {
            const entry = { cardId, nodeId: card.nodeId, title: card.title || '' };
            if (liveNodes.has(card.nodeId)) missingCards.push(entry);
            else detachedCards.push(entry);
            continue;
        }
        if (card.updateAt && indexed.updatedAt < card.updateAt) {
            staleCards.push({
                cardId,
                title: card.title || '',
                cardUpdatedAt: card.updateAt,
                indexedAt: indexed.updatedAt,
            });
        }
    }
    const orphanCards = [...snapshot.cards.entries()]
        .filter(([cardId]) => !liveCardIds.has(cardId))
        .map(([cardId, held]) => ({ cardId, title: held.title }));
    const indexedNodes = [...liveNodes.keys()].filter((nodeId) => snapshot.nodes.has(nodeId)).length;
    return {
        ok: true,
        baseId: base.docId,
        baseTitle: base.title || '',
        state: {
            status: state.status,
            mode: state.mode,
            generation: state.generation,
            appliedGeneration: state.appliedGeneration,
            pendingWork: state.generation > state.appliedGeneration,
            progress: state.progress,
            indexedCount: state.indexedCount,
            lastError: state.lastError,
            updatedAt: state.updatedAt,
        },
        stored: {
            vectors: snapshot.vectors,
            nodeVectors: snapshot.nodeVectors,
            cardVectors: snapshot.cardVectors,
            cardCount: snapshot.cardCount,
            models: snapshot.models,
            dimensions: snapshot.dimensions,
            oldestUpdatedAt: snapshot.oldestUpdatedAt,
            newestUpdatedAt: snapshot.newestUpdatedAt,
        },
        coverage: {
            nodes: {
                live: liveNodes.size,
                indexed: indexedNodes,
                missing: missingNodes.length,
                stale: staleNodes.length,
                orphan: orphanNodeIds.length,
            },
            cards: {
                live: cardDocs.length,
                indexable: indexableCards,
                indexed: indexableCards - missingCards.length - detachedCards.length,
                missing: missingCards.length,
                detached: detachedCards.length,
                stale: staleCards.length,
                orphan: orphanCards.length,
                empty: emptyCards,
            },
        },
        samples: {
            missingNodes: missingNodes.slice(0, MAX_SAMPLE_IDS),
            staleNodes: staleNodes.slice(0, MAX_SAMPLE_IDS),
            orphanNodeIds: orphanNodeIds.slice(0, MAX_SAMPLE_IDS),
            missingCards: missingCards.slice(0, MAX_SAMPLE_IDS),
            detachedCards: detachedCards.slice(0, MAX_SAMPLE_IDS),
            staleCards: staleCards.slice(0, MAX_SAMPLE_IDS),
            orphanCards: orphanCards.slice(0, MAX_SAMPLE_IDS),
        },
    };
}

export async function reindex(ctx: ToolContext, args: ToolArgs) {
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const requestedMode = String(args.mode || 'full_rebuild').trim();
    const mode: EmbeddingIndexMode = requestedMode === 'incremental' ? 'incremental' : 'full_rebuild';
    const nodeIds = idList(args.nodeIds);
    const cardIds = idList(args.cardIds);
    if (mode === 'incremental' && !nodeIds.length && !cardIds.length) {
        return {
            ok: false,
            reason: 'incremental_requires_ids',
            message: 'mode=incremental needs nodeIds or cardIds. Use mode=full_rebuild to re-index the whole Base.',
        };
    }
    const taskId = await enqueueEmbeddingIndex({
        domainId: ctx.domainId,
        baseDocId: ctx.baseDocId,
        mode,
        nodeIds,
        cardDocIds: cardIds,
        owner: ctx.owner,
        reason: 'tool',
    });
    const view = await buildEmbeddingStatusView(ctx.domainId, ctx.baseDocId);
    return {
        ok: true,
        baseId: base.docId,
        baseTitle: base.title || '',
        mode,
        nodeIds,
        cardIds,
        taskId: taskId ? taskId.toString() : null,
        generation: view.generation,
        queued: !!taskId,
        status: {
            status: view.status,
            appliedGeneration: view.appliedGeneration,
            indexedCount: view.indexedCount,
            progress: view.progress,
            lastError: view.lastError,
            updatedAt: view.updatedAt,
        },
    };
}

class BaseSemanticSearchHandler extends Handler {
    @post('docId', Types.PositiveInt)
    @post('query', Types.String)
    @post('limit', Types.PositiveInt, true)
    async post(domainId: string, docId: number, query?: string, limit?: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (!query || !query.trim()) throw new BadRequestError('Query is required');
        const base = await BaseModel.get(domainId, docId);
        if (!base) throw new NotFoundError('Base not found');
        const result = await callToolViaWorker(this.ctx, 'semantic_search', {
            query: query.trim(),
            limit: Math.min(limit || 10, 50),
        }, domainId, undefined, this.user._id, undefined, 0, {
            baseDocId: docId,
            owner: this.user._id,
            toolType: 'system',
        });
        this.response.body = { results: result?.results || [] };
    }
}

export function apply(ctx: Context) {
    const session = { source: 'base' as const, bindBase: 'session' as const };
    const optional = { source: 'base' as const, bindBase: 'optional' as const };
    ctx.Tool('base_semantic_search', search, Search, session, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_semantic_search', '/base/semantic-search', BaseSemanticSearchHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_embedding_status', status, Status, optional, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_embedding_reindex', reindex, Reindex, { ...optional, mutating: true }, PRIV.PRIV_USER_PROFILE);
}

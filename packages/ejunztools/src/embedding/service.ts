/**
 * Embedding Service
 *
 * Lazily loads a local semantic embedding model (Xenova/all-MiniLM-L6-v2 via
 * @xenova/transformers) and generates vector embeddings for base editor
 * content after each save.  Embeddings are persisted in the
 * `base.embedding` MongoDB collection and can power semantic search later.
 *
 * Currently indexes two kinds of documents:
 *   - "node"   –  the node's title text (for quick heading-level matches)
 *   - "card"   –  the card's title + content + problem text (the real knowledge)
 *
 * The model (~80 MB) is downloaded on first use and cached locally via
 * Hugging Face's cache (~/.cache/huggingface/).
 */

import { ObjectId } from 'mongodb';
import { Context, Service } from 'ejun/src/context';
import { Logger } from 'ejun/src/logger';
import { BaseModel, CardModel, TYPE_CARD } from 'ejun/src/model/base';
import * as document from 'ejun/src/model/document';
import type { CardDoc } from 'ejun/src/interface';
import db from 'ejun/src/service/db';
import {
    buildEmbeddingIndexTaskFromDb,
    type EmbeddingIndexMode,
    type EmbeddingIndexTaskPayload,
} from './worker';
import {
    clamp01,
    extractKeywordTerms,
    KEYWORD_BLEND,
    scoreKeywordMatch,
    toTermMatcher,
} from './keyword';

declare module 'ejun/src/context' {
    interface Context {
        embedding: EmbeddingService;
    }
}

const logger = new Logger('embedding');
const COLLECTION = 'base.embedding';
/**
 * Sentence-embedding model used for every vector this service stores.
 *
 * This replaced `Xenova/all-MiniLM-L6-v2`, which is English-only: it collapses
 * unrelated Chinese strings onto identical vectors, so on a predominantly
 * Chinese knowledge base cosine similarity carried no signal and unrelated
 * titles scored exactly the same. Do not downgrade this back to a
 * non-multilingual model.
 *
 * Both models are 384 wide, so a stale vector cannot be recognised by its
 * dimension — see the `model` field on `EmbeddingDoc`.
 */
const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const BATCH_SIZE = 32;

// all-MiniLM-L6-v2 max 256 tokens.
// For mixed CN/EN content we stay well within limit at ~800 chars per chunk.
const CHUNK_MAX_CHARS = 800;
const CHUNK_OVERLAP_CHARS = 80;

/** A single stored embedding document. */
interface EmbeddingDoc {
    domainId: string;
    baseDocId: number;
    /** "node" for node title embedding; "card" for card content embedding */
    kind: 'node' | 'card';
    /** For both kinds: the nodeId this content belongs to */
    nodeId: string;
    /** Only for kind="card": the ObjectId string of the card document */
    cardDocId?: string;
    /** Only for kind="card": the card title for display */
    cardTitle?: string;
    /** 0-based chunk index when a card is split into multiple chunks */
    chunkIndex: number;
    /** The text that was embedded */
    text: string;
    embedding: number[];
    /**
     * Id of the model that produced `embedding`.
     *
     * Vectors from two different models are not comparable, and this model has
     * the same width as the one it replaced, so a stale vector is otherwise
     * indistinguishable from a current one. Writes always stamp this; search
     * filters on it, so a base that has not been re-indexed yet returns no
     * results rather than ranking incomparable vectors.
     */
    model: string;
    updatedAt: Date;
}

/** Stable identity for upsert / unique index (no branch). */
function embeddingLogicKey(doc: Pick<EmbeddingDoc, 'domainId' | 'baseDocId' | 'kind' | 'nodeId' | 'cardDocId' | 'chunkIndex'>) {
    return {
        domainId: doc.domainId,
        baseDocId: doc.baseDocId,
        kind: doc.kind,
        nodeId: doc.nodeId,
        cardDocId: doc.cardDocId || null,
        chunkIndex: doc.chunkIndex,
    };
}

export interface SearchResult {
    nodeId: string;
    kind: 'node' | 'card';
    cardDocId?: string;
    cardTitle?: string;
    /** 0-based chunk index when kind=card is split into chunks */
    chunkIndex: number;
    text: string;
    /** Final score after semantic similarity plus bounded keyword boost. */
    score: number;
    /** Raw cosine similarity from the embedding model. */
    semanticScore: number;
    /** Bounded exact-keyword boost used for technical terms in the query. */
    keywordScore: number;
    matchedTerms?: string[];
    rank: number;
}

function collectProblemText(value: unknown, out: string[], depth = 0) {
    if (value === undefined || value === null || depth > 4 || out.length > 120) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const s = String(value).trim();
        if (s) out.push(s);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectProblemText(item, out, depth + 1);
        return;
    }
    if (typeof value === 'object') {
        const preferred = ['title', 'stem', 'faceA', 'faceB', 'hint', 'analysis', 'tags', 'options', 'columns', 'left', 'right', 'points'];
        const obj = value as Record<string, unknown>;
        for (const key of preferred) {
            if (key in obj) collectProblemText(obj[key], out, depth + 1);
        }
    }
}

function buildCardSearchText(card: CardDoc): string {
    const parts: string[] = [];
    const title = (card.title || '').trim();
    const content = (card.content || '').trim();
    if (title) parts.push(`# ${title}`);
    if (content) parts.push(content);
    const problemText: string[] = [];
    for (const problem of card.problems || []) collectProblemText(problem, problemText);
    if (problemText.length) parts.push(problemText.join('\n'));
    return parts.join('\n\n').trim();
}

let currentEmbeddingService: EmbeddingService | undefined;

export function getEmbeddingService(): EmbeddingService | undefined {
    logger.info('[diag] getEmbeddingService called: hasCurrent=%s pid=%d NODE_APP_INSTANCE=%s',
        !!currentEmbeddingService,
        process.pid,
        process.env.NODE_APP_INSTANCE || '',
    );
    return currentEmbeddingService;
}

export class EmbeddingService extends Service {
    private pipe: any = null;
    private loadPromise: Promise<void> | null = null;
    private indexesReady = false;

    constructor(ctx: Context) {
        super(ctx, 'embedding');
        currentEmbeddingService = this;
        logger.info('Embedding service created (model loads on first use)');
        logger.info('[diag] EmbeddingService constructor: pid=%d NODE_APP_INSTANCE=%s ctxHasEmbedding=%s globalAppExists=%s',
            process.pid,
            process.env.NODE_APP_INSTANCE || '',
            (() => { try { return !!(ctx as any).embedding; } catch { return false; } })(),
            !!(global as any).app,
        );
    }

    /**
     * Split long text into overlapping chunks suitable for embedding.
     *
     * Splitting strategy (tiered, best-effort):
     *   1. Double newline (paragraph boundary)
     *   2. Single newline
     *   3. Sentence-ending punctuation （。！？.!?）
     *   4. Comma / semicolon
     *   5. Hard character count (last resort — no natural boundary found)
     */
    chunkText(text: string, maxLen = CHUNK_MAX_CHARS, overlap = CHUNK_OVERLAP_CHARS): string[] {
        text = text.trim();
        if (!text) return [];
        if (text.length <= maxLen) return [text];

        const chunks: string[] = [];
        let start = 0;
        while (start < text.length) {
            if (text.length - start <= maxLen) {
                chunks.push(text.slice(start).trim());
                break;
            }

            // Candidate end: first natural boundary within maxLen from `start`
            const end = this.findChunkBoundary(text, start, maxLen);
            chunks.push(text.slice(start, end).trim());
            start = end - overlap;
        }
        return chunks.filter(Boolean);
    }

    private findChunkBoundary(text: string, start: number, maxLen: number): number {
        const end = start + maxLen;
        if (end >= text.length) return text.length;

        const slice = text.slice(start, end);

        // 1) Double newline (paragraph)
        let idx = slice.lastIndexOf('\n\n');
        if (idx > maxLen * 0.3) return start + idx + 2;

        // 2) Single newline
        idx = slice.lastIndexOf('\n');
        if (idx > maxLen * 0.3) return start + idx + 1;

        // 3) Sentence-ending punctuation (优先 CJK，再英文)
        for (const sep of ['。', '！', '？', '\n', '. ', '! ', '? ']) {
            const j = slice.lastIndexOf(sep);
            if (j > maxLen * 0.3) return start + j + sep.length;
        }

        // 4) Comma / semicolon
        for (const sep of ['，', '；', ', ', '; ']) {
            const j = slice.lastIndexOf(sep);
            if (j > maxLen * 0.3) return start + j + sep.length;
        }

        // 5) Hard cut at maxLen
        return end;
    }

    /**
     * Generate a single embedding for the given text.
     */
    async embed(text: string): Promise<number[]> {
        await this.ensureModel();
        const result = await this.pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(result.data) as number[];
    }

    /**
     * Generate embeddings for a batch of texts.
     * Texts are processed in smaller sub-batches to cap peak memory.
     */
    async embedBatch(texts: string[]): Promise<number[][]> {
        if (!texts.length) return [];
        await this.ensureModel();

        const all: number[][] = [];
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const batch = texts.slice(i, i + BATCH_SIZE);
            const output = await this.pipe(batch, { pooling: 'mean', normalize: true });

            // output.tolist() returns number[][] when input is an array
            const list: number[][] = output.tolist();
            for (const vec of list) {
                all.push(vec);
            }
        }
        return all;
    }

    private collection() {
        return this.ctx.db.db.collection<EmbeddingDoc>(COLLECTION);
    }

    private async ensureEmbeddingIndexes() {
        if (this.indexesReady) return;
        this.indexesReady = true;
        try {
            await db.ensureIndexes(this.collection(), {
                name: 'base_embedding_logic_key',
                key: {
                    domainId: 1,
                    baseDocId: 1,
                    kind: 1,
                    nodeId: 1,
                    cardDocId: 1,
                    chunkIndex: 1,
                },
                unique: true,
            });
            await db.ensureIndexes(this.collection(), {
                name: 'base_embedding_base',
                key: { domainId: 1, baseDocId: 1 },
            });
            await db.ensureIndexes(this.collection(), {
                name: 'base_embedding_node',
                key: { domainId: 1, baseDocId: 1, nodeId: 1 },
            });
            await db.ensureIndexes(this.collection(), {
                name: 'base_embedding_card',
                key: { domainId: 1, baseDocId: 1, cardDocId: 1 },
            });
        } catch (err) {
            this.indexesReady = false;
            throw err;
        }
    }

    private async replaceDocs(
        filter: Record<string, unknown>,
        docs: EmbeddingDoc[],
    ) {
        await this.ensureEmbeddingIndexes();
        const coll = this.collection();
        // Compute-then-replace: only wipe the old slice after new vectors are ready.
        if (!docs.length) {
            await coll.deleteMany(filter);
            return;
        }
        const ops = docs.map((doc) => ({
            replaceOne: {
                filter: embeddingLogicKey(doc),
                replacement: doc,
                upsert: true,
            },
        }));
        for (let i = 0; i < ops.length; i += 500) {
            await coll.bulkWrite(ops.slice(i, i + 500), { ordered: false });
        }
        // Drop stale chunks when a card shrinks (or node text becomes empty → no docs).
        const keepKeys = new Set(docs.map((d) => JSON.stringify(embeddingLogicKey(d))));
        const existing = await coll.find(filter).project({
            domainId: 1, baseDocId: 1, kind: 1, nodeId: 1, cardDocId: 1, chunkIndex: 1,
        }).toArray();
        const staleIds: any[] = [];
        for (const doc of existing) {
            const key = JSON.stringify(embeddingLogicKey(doc as EmbeddingDoc));
            if (!keepKeys.has(key)) staleIds.push((doc as any)._id);
        }
        if (staleIds.length) {
            await coll.deleteMany({ _id: { $in: staleIds } });
        }
    }

    private async buildNodeDocs(
        domainId: string,
        baseDocId: number,
        entries: Array<{ nodeId: string; text: string }>,
        now = new Date(),
    ): Promise<EmbeddingDoc[]> {
        if (!entries.length) return [];
        const embeddings = await this.embedBatch(entries.map((e) => e.text));
        return entries.map((e, i) => ({
            domainId,
            baseDocId,
            kind: 'node' as const,
            nodeId: e.nodeId,
            chunkIndex: 0,
            text: e.text,
            embedding: embeddings[i],
            model: EMBEDDING_MODEL,
            updatedAt: now,
        }));
    }

    private async buildCardDocs(
        domainId: string,
        baseDocId: number,
        cards: CardDoc[],
        now = new Date(),
    ): Promise<EmbeddingDoc[]> {
        const chunks: Array<{
            nodeId: string;
            cardDocId: string;
            cardTitle: string;
            chunkIndex: number;
            text: string;
        }> = [];
        for (const card of cards) {
            const searchText = buildCardSearchText(card);
            if (!searchText) continue;
            const parts = this.chunkText(searchText);
            const title = (card.title || '').trim();
            const cardDocId = card.docId.toString();
            for (let ci = 0; ci < parts.length; ci++) {
                chunks.push({
                    nodeId: card.nodeId,
                    cardDocId,
                    cardTitle: title,
                    chunkIndex: ci,
                    text: parts[ci],
                });
            }
        }
        if (!chunks.length) return [];
        const embeddings = await this.embedBatch(chunks.map((c) => c.text));
        return chunks.map((c, i) => ({
            domainId,
            baseDocId,
            kind: 'card' as const,
            nodeId: c.nodeId,
            cardDocId: c.cardDocId,
            cardTitle: c.cardTitle,
            chunkIndex: c.chunkIndex,
            text: c.text,
            embedding: embeddings[i],
            model: EMBEDDING_MODEL,
            updatedAt: now,
        }));
    }

    private async loadCardsByIds(domainId: string, cardDocIds: string[]): Promise<CardDoc[]> {
        const oids = cardDocIds
            .map((id) => {
                try {
                    return ObjectId.isValid(id) ? new ObjectId(id) : null;
                } catch {
                    return null;
                }
            })
            .filter((id): id is ObjectId => !!id);
        if (!oids.length) return [];
        return document.getMulti(domainId, TYPE_CARD, { docId: { $in: oids } }).toArray() as Promise<CardDoc[]>;
    }

    /**
     * Full rebuild of all node + card embeddings for a Base.
     * Throws on failure so the worker can retry; old vectors stay until
     * the new set is written (delete happens only after successful embed,
     * except when the base is empty / missing).
     */
    async rebuildBaseContent(domainId: string, baseDocId: number): Promise<void> {
        const start = Date.now();
        await this.ensureEmbeddingIndexes();
        const base = await BaseModel.get(domainId, baseDocId);
        const coll = this.collection();
        if (!base) {
            await coll.deleteMany({ domainId, baseDocId });
            logger.warn('Base not found for vectorization; cleared embeddings: %s/%s', domainId, baseDocId);
            return;
        }

        const nodes = base.nodes || [];
        const now = new Date();
        const nodeEntries: { nodeId: string; text: string }[] = [];
        for (const node of nodes) {
            const t = node.text?.trim();
            if (t) nodeEntries.push({ nodeId: node.id, text: t });
        }

        const cardsByNode = nodes.length
            ? await CardModel.getByNodeIds(domainId, baseDocId, nodes.map((n) => n.id))
            : new Map<string, CardDoc[]>();
        const allCards: CardDoc[] = [];
        for (const list of cardsByNode.values()) allCards.push(...list);

        const nodeDocs = await this.buildNodeDocs(domainId, baseDocId, nodeEntries, now);
        const cardDocs = await this.buildCardDocs(domainId, baseDocId, allCards, now);
        const docs = [...nodeDocs, ...cardDocs];

        // Swap in the new full set only after embeddings are ready.
        if (!docs.length) {
            await coll.deleteMany({ domainId, baseDocId });
        } else {
            const ops = docs.map((doc) => ({
                replaceOne: {
                    filter: embeddingLogicKey(doc),
                    replacement: doc,
                    upsert: true,
                },
            }));
            for (let i = 0; i < ops.length; i += 500) {
                await coll.bulkWrite(ops.slice(i, i + 500), { ordered: false });
            }
            const keep = new Set(docs.map((d) => JSON.stringify(embeddingLogicKey(d))));
            const existing = await coll.find({ domainId, baseDocId }).project({
                domainId: 1, baseDocId: 1, kind: 1, nodeId: 1, cardDocId: 1, chunkIndex: 1,
            }).toArray();
            const stale = existing
                .filter((d) => !keep.has(JSON.stringify(embeddingLogicKey(d as EmbeddingDoc))))
                .map((d) => (d as any)._id);
            if (stale.length) await coll.deleteMany({ _id: { $in: stale } });
        }

        logger.debug(
            'Rebuilt %d nodes + %d card-chunks for %s/%s (%d ms)',
            nodeDocs.length, cardDocs.length,
            domainId, baseDocId,
            Date.now() - start,
        );
    }

    /** @deprecated Prefer rebuildBaseContent / processIndexTask; kept as compatible wrapper. */
    async vectorizeBaseContent(domainId: string, baseDocId: number): Promise<void> {
        await this.rebuildBaseContent(domainId, baseDocId);
    }

    /** Upsert embeddings for the given node IDs from current base.nodes text. */
    async updateNodeEmbeddings(domainId: string, baseDocId: number, nodeIds: string[]): Promise<void> {
        const ids = [...new Set(nodeIds.map((id) => String(id || '').trim()).filter(Boolean))];
        if (!ids.length) return;
        await this.ensureEmbeddingIndexes();
        const base = await BaseModel.get(domainId, baseDocId);
        if (!base) {
            await this.deleteNodeEmbeddings(domainId, baseDocId, ids);
            return;
        }
        const byId = new Map((base.nodes || []).map((n) => [n.id, n]));
        const entries: { nodeId: string; text: string }[] = [];
        const emptyIds: string[] = [];
        for (const nodeId of ids) {
            const node = byId.get(nodeId);
            const text = node?.text?.trim() || '';
            if (!node || !text) emptyIds.push(nodeId);
            else entries.push({ nodeId, text });
        }
        const docs = await this.buildNodeDocs(domainId, baseDocId, entries);
        for (const nodeId of ids) {
            const nodeDocs = docs.filter((d) => d.nodeId === nodeId);
            await this.replaceDocs({ domainId, baseDocId, kind: 'node', nodeId }, nodeDocs);
        }
        if (emptyIds.length) {
            await this.collection().deleteMany({
                domainId, baseDocId, kind: 'node', nodeId: { $in: emptyIds },
            });
        }
    }

    /** Delete node embeddings and all card embeddings under those nodes. */
    async deleteNodeEmbeddings(domainId: string, baseDocId: number, nodeIds: string[]): Promise<void> {
        const ids = [...new Set(nodeIds.map((id) => String(id || '').trim()).filter(Boolean))];
        if (!ids.length) return;
        await this.ensureEmbeddingIndexes();
        await this.collection().deleteMany({ domainId, baseDocId, nodeId: { $in: ids } });
    }

    /** Upsert card chunk embeddings for the given card document IDs. */
    async updateCardEmbeddings(domainId: string, baseDocId: number, cardDocIds: string[]): Promise<void> {
        const ids = [...new Set(cardDocIds.map((id) => String(id || '').trim()).filter(Boolean))];
        if (!ids.length) return;
        await this.ensureEmbeddingIndexes();
        const cards = await this.loadCardsByIds(domainId, ids);
        const found = new Set(cards.map((c) => c.docId.toString()));
        const docs = await this.buildCardDocs(domainId, baseDocId, cards);
        for (const cardDocId of ids) {
            const cardDocs = docs.filter((d) => d.cardDocId === cardDocId);
            await this.replaceDocs({ domainId, baseDocId, kind: 'card', cardDocId }, cardDocs);
        }
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length) {
            await this.collection().deleteMany({
                domainId, baseDocId, kind: 'card', cardDocId: { $in: missing },
            });
        }
    }

    async deleteCardEmbeddings(domainId: string, baseDocId: number, cardDocIds: string[]): Promise<void> {
        const ids = [...new Set(cardDocIds.map((id) => String(id || '').trim()).filter(Boolean))];
        if (!ids.length) return;
        await this.ensureEmbeddingIndexes();
        await this.collection().deleteMany({
            domainId, baseDocId, kind: 'card', cardDocId: { $in: ids },
        });
    }

    /**
     * Apply an incremental or full_rebuild index payload.
     * Always throws on failure for the worker retry path.
     */
    async processIndexTask(raw: EmbeddingIndexTaskPayload | Record<string, unknown>): Promise<{
        mode: EmbeddingIndexMode;
        domainId: string;
        baseDocId: number;
    }> {
        const payload = buildEmbeddingIndexTaskFromDb(raw);
        const { domainId, baseDocId, mode } = payload;
        if (!domainId) throw new Error('domainId is required');
        if (!Number.isFinite(baseDocId) || baseDocId <= 0) throw new Error('baseDocId is required');

        if (mode === 'full_rebuild') {
            await this.rebuildBaseContent(domainId, baseDocId);
            return { mode, domainId, baseDocId };
        }

        if (payload.deletedNodeIds.length) {
            await this.deleteNodeEmbeddings(domainId, baseDocId, payload.deletedNodeIds);
        }
        if (payload.deletedCardDocIds.length) {
            await this.deleteCardEmbeddings(domainId, baseDocId, payload.deletedCardDocIds);
        }
        if (payload.nodeIds.length) {
            await this.updateNodeEmbeddings(domainId, baseDocId, payload.nodeIds);
        }
        if (payload.cardDocIds.length) {
            await this.updateCardEmbeddings(domainId, baseDocId, payload.cardDocIds);
        }
        return { mode, domainId, baseDocId };
    }

    /**
     * Search for semantically similar content within a base.
     *
     * Searches both node-title entries and card-content entries.  Results are
     * ranked by cosine similarity.  Fine for knowledge bases with <10k entries.
     */
    /**
     * Search node titles and card content within one base.
     *
     * Ranking blends cosine similarity with the graded keyword score, computed
     * in memory over the base's vectors — a linear scan is fine at this scale.
     *
     * Only vectors stamped with the current `EMBEDDING_MODEL` are considered.
     * Vectors from another model are not comparable, and the model this one
     * replaced has the same width, so filtering by the stamp is the only thing
     * that prevents incomparable vectors from being ranked silently. A base that
     * has not been re-indexed therefore returns nothing rather than garbage.
     */
    async searchSimilar(
        domainId: string,
        baseDocId: number,
        query: string,
        limit: number = 15,
    ): Promise<SearchResult[]> {
        const queryVec = await this.embed(query);
        const coll = this.ctx.db.db.collection<EmbeddingDoc>(COLLECTION);
        const docs = await coll.find({ domainId, baseDocId, model: EMBEDDING_MODEL }).toArray();

        if (!docs.length) return [];

        const matchers = extractKeywordTerms(query).map(toTermMatcher);
        // `embed` and `embedBatch` both run the pipeline with `normalize: true`, so
        // every stored and query vector is unit length and the dot product is the
        // cosine. Dividing by the query magnitude keeps this correct even if a
        // stored vector is somehow not normalised.
        const queryMag = Math.sqrt(queryVec.reduce((sum, v) => sum + v * v, 0));
        const scored: SearchResult[] = [];

        docs.forEach((doc, order) => {
            const dot = doc.embedding.reduce((sum, v, i) => sum + v * queryVec[i], 0);
            const semanticScore = queryMag ? clamp01(dot / queryMag) : 0;
            const { keywordScore, matchedTerms } = scoreKeywordMatch(matchers, doc);
            // A blend, not a clamped sum: `Math.min(1, semantic + keyword)` used to
            // collapse every high-scoring document onto exactly 1 and destroy the
            // ordering between them. A convex blend stays strictly monotonic in
            // both components and cannot leave [0, 1].
            const score = semanticScore * (1 - KEYWORD_BLEND) + keywordScore * KEYWORD_BLEND;

            scored.push({
                nodeId: doc.nodeId,
                kind: doc.kind,
                cardDocId: doc.cardDocId,
                cardTitle: doc.cardTitle,
                chunkIndex: doc.chunkIndex,
                text: doc.text,
                score,
                semanticScore,
                keywordScore,
                matchedTerms,
                rank: order + 1,
            });
        });

        scored.sort((a, b) => b.score - a.score
            || b.keywordScore - a.keywordScore
            || b.semanticScore - a.semanticScore
            || a.rank - b.rank);

        // One long card is split into several chunks and would otherwise occupy
        // several ranks: keep the best-ranked chunk per card, then re-rank the
        // survivors so `rank` is contiguous and honour `limit` after grouping.
        const grouped: SearchResult[] = [];
        const seenCards = new Set<string>();
        for (const result of scored) {
            if (result.kind === 'card' && result.cardDocId) {
                if (seenCards.has(result.cardDocId)) continue;
                seenCards.add(result.cardDocId);
            }
            grouped.push(result);
            if (grouped.length >= limit) break;
        }
        grouped.forEach((r, i) => { r.rank = i + 1; });
        return grouped;
    }

    /** Lazy-load the ONNX embedding model (downloaded on first call). */
    private async ensureModel(): Promise<void> {
        if (this.pipe) return;
        if (this.loadPromise) await this.loadPromise;
        else {
            this.loadPromise = this.loadModel();
            await this.loadPromise;
        }
    }

    private async loadModel(): Promise<void> {
        const t0 = Date.now();
        try {
            const { pipeline } = await import('@xenova/transformers');
            this.pipe = await pipeline('feature-extraction', EMBEDDING_MODEL, {
                quantized: true,
            });
            logger.success('Embedding model "%s" loaded in %d ms', EMBEDDING_MODEL, Date.now() - t0);
        } catch (err) {
            this.loadPromise = null; // allow retry on next call
            logger.error('Failed to load embedding model "%s": %o', EMBEDDING_MODEL, err);
            throw err;
        }
    }
}

export async function apply(ctx: Context) {
    ctx.plugin(EmbeddingService);
}

export default EmbeddingService;

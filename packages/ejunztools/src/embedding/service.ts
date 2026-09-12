import { ObjectId } from 'mongodb';
import { Context, Service } from 'ejun/src/context';
import { Logger } from 'ejun/src/logger';
import { BaseModel, CardModel, TYPE_CARD } from 'ejun/src/model/base';
import * as document from 'ejun/src/model/document';
import type { CardDoc } from 'ejun/src/interface';
import db from 'ejun/src/service/db';
import {
    buildEmbeddingIndexTaskFromDb,
    setEmbeddingProgress,
    type EmbeddingIndexMode,
    type EmbeddingIndexTaskPayload,
    type EmbeddingProgressReporter,
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

const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const BATCH_SIZE = 32;

const CHUNK_MAX_CHARS = 800;
const CHUNK_OVERLAP_CHARS = 80;

interface EmbeddingDoc {
    domainId: string;
    baseDocId: number;
    kind: 'node' | 'card';
    nodeId: string;
    cardDocId?: string;
    cardTitle?: string;
    chunkIndex: number;
    text: string;
    embedding: number[];
    model: string;
    updatedAt: Date;
}

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
    chunkIndex: number;
    text: string;
    score: number;
    semanticScore: number;
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
        let idx = slice.lastIndexOf('\n\n');
        if (idx > maxLen * 0.3) return start + idx + 2;
        idx = slice.lastIndexOf('\n');
        if (idx > maxLen * 0.3) return start + idx + 1;
        for (const sep of ['。', '！', '？', '\n', '. ', '! ', '? ']) {
            const j = slice.lastIndexOf(sep);
            if (j > maxLen * 0.3) return start + j + sep.length;
        }
        for (const sep of ['，', '；', ', ', '; ']) {
            const j = slice.lastIndexOf(sep);
            if (j > maxLen * 0.3) return start + j + sep.length;
        }
        return end;
    }

    async embed(text: string): Promise<number[]> {
        await this.ensureModel();
        const result = await this.pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(result.data) as number[];
    }

    async embedBatch(texts: string[], onBatch?: (done: number, total: number) => void): Promise<number[][]> {
        if (!texts.length) return [];
        await this.ensureModel();
        const all: number[][] = [];
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const batch = texts.slice(i, i + BATCH_SIZE);
            const output = await this.pipe(batch, { pooling: 'mean', normalize: true });
            const list: number[][] = output.tolist();
            for (const vec of list) {
                all.push(vec);
            }
            onBatch?.(all.length, texts.length);
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
        onProgress?: EmbeddingProgressReporter,
    ): Promise<EmbeddingDoc[]> {
        if (!entries.length) return [];
        const embeddings = await this.embedBatch(
            entries.map((e) => e.text),
            onProgress && ((done, total) => onProgress('nodes', done, total)),
        );
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
        onProgress?: EmbeddingProgressReporter,
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
        const embeddings = await this.embedBatch(
            chunks.map((c) => c.text),
            onProgress && ((done, total) => onProgress('cards', done, total)),
        );
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

    async rebuildBaseContent(
        domainId: string,
        baseDocId: number,
        onProgress?: EmbeddingProgressReporter,
    ): Promise<void> {
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
        const nodeDocs = await this.buildNodeDocs(domainId, baseDocId, nodeEntries, now, onProgress);
        const cardDocs = await this.buildCardDocs(domainId, baseDocId, allCards, now, onProgress);
        const docs = [...nodeDocs, ...cardDocs];
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
                onProgress?.('writing', Math.min(i + 500, ops.length), ops.length);
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

    async vectorizeBaseContent(domainId: string, baseDocId: number): Promise<void> {
        await this.rebuildBaseContent(domainId, baseDocId);
    }

    async updateNodeEmbeddings(
        domainId: string,
        baseDocId: number,
        nodeIds: string[],
        onProgress?: EmbeddingProgressReporter,
    ): Promise<void> {
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
        const docs = await this.buildNodeDocs(domainId, baseDocId, entries, new Date(), onProgress);
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

    async deleteNodeEmbeddings(domainId: string, baseDocId: number, nodeIds: string[]): Promise<void> {
        const ids = [...new Set(nodeIds.map((id) => String(id || '').trim()).filter(Boolean))];
        if (!ids.length) return;
        await this.ensureEmbeddingIndexes();
        await this.collection().deleteMany({ domainId, baseDocId, nodeId: { $in: ids } });
    }

    async updateCardEmbeddings(
        domainId: string,
        baseDocId: number,
        cardDocIds: string[],
        onProgress?: EmbeddingProgressReporter,
    ): Promise<void> {
        const ids = [...new Set(cardDocIds.map((id) => String(id || '').trim()).filter(Boolean))];
        if (!ids.length) return;
        await this.ensureEmbeddingIndexes();
        const cards = await this.loadCardsByIds(domainId, ids);
        const found = new Set(cards.map((c) => c.docId.toString()));
        const docs = await this.buildCardDocs(domainId, baseDocId, cards, new Date(), onProgress);
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

    async processIndexTask(raw: EmbeddingIndexTaskPayload | Record<string, unknown>): Promise<{
        mode: EmbeddingIndexMode;
        domainId: string;
        baseDocId: number;
    }> {
        const payload = buildEmbeddingIndexTaskFromDb(raw);
        const { domainId, baseDocId, mode } = payload;
        if (!domainId) throw new Error('domainId is required');
        if (!Number.isFinite(baseDocId) || baseDocId <= 0) throw new Error('baseDocId is required');
        const onProgress: EmbeddingProgressReporter = (phase, done, total) => {
            void setEmbeddingProgress(domainId, baseDocId, payload.generation, {
                phase,
                done,
                total,
                updatedAt: new Date(),
            });
        };
        if (mode === 'full_rebuild') {
            await this.rebuildBaseContent(domainId, baseDocId, onProgress);
            return { mode, domainId, baseDocId };
        }
        if (payload.deletedNodeIds.length) {
            await this.deleteNodeEmbeddings(domainId, baseDocId, payload.deletedNodeIds);
        }
        if (payload.deletedCardDocIds.length) {
            await this.deleteCardEmbeddings(domainId, baseDocId, payload.deletedCardDocIds);
        }
        if (payload.nodeIds.length) {
            await this.updateNodeEmbeddings(domainId, baseDocId, payload.nodeIds, onProgress);
        }
        if (payload.cardDocIds.length) {
            await this.updateCardEmbeddings(domainId, baseDocId, payload.cardDocIds, onProgress);
        }
        return { mode, domainId, baseDocId };
    }

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
        const queryMag = Math.sqrt(queryVec.reduce((sum, v) => sum + v * v, 0));
        const scored: SearchResult[] = [];
        docs.forEach((doc, order) => {
            const dot = doc.embedding.reduce((sum, v, i) => sum + v * queryVec[i], 0);
            const semanticScore = queryMag ? clamp01(dot / queryMag) : 0;
            const { keywordScore, matchedTerms } = scoreKeywordMatch(matchers, doc);
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
            this.loadPromise = null;
            logger.error('Failed to load embedding model "%s": %o', EMBEDDING_MODEL, err);
            throw err;
        }
    }
}

export async function apply(ctx: Context) {
    ctx.plugin(EmbeddingService);
}

export default EmbeddingService;

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

import { Context, Service } from '../context';
import { Logger } from '../logger';
import { BaseModel, CardModel, getBranchData } from '../model/base';
import type { BaseDoc, CardDoc } from '../interface';

declare module '../context' {
    interface Context {
        embedding: EmbeddingService;
    }
}

const logger = new Logger('embedding');
const COLLECTION = 'base.embedding';
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 32;

// all-MiniLM-L6-v2 max 256 tokens.
// For mixed CN/EN content we stay well within limit at ~800 chars per chunk.
const CHUNK_MAX_CHARS = 800;
const CHUNK_OVERLAP_CHARS = 80;

/** A single stored embedding document. */
interface EmbeddingDoc {
    domainId: string;
    baseDocId: number;
    branch: string;
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
    updatedAt: Date;
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

type KeywordMatch = { keywordScore: number; matchedTerms: string[] };

function normalizeKeywordText(value: string): string {
    return (value || '').normalize('NFKC').toLowerCase();
}

function extractKeywordTerms(query: string): string[] {
    const normalized = normalizeKeywordText(query);
    const raw = normalized.match(/[a-z0-9][a-z0-9._/-]*/g) || [];
    const ignored = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with']);
    const terms: string[] = [];
    for (const term of raw) {
        const clean = term.replace(/^[/._-]+|[/._-]+$/g, '');
        if (!clean || ignored.has(clean)) continue;
        if (clean.length === 1) continue;
        if (clean.length === 2 && /^[a-z]+$/.test(clean) && !['ai', 'go', 'js'].includes(clean)) continue;
        if (!terms.includes(clean)) terms.push(clean);
    }
    return terms;
}

function termRegex(term: string): RegExp {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
}

function scoreKeywordMatch(terms: string[], doc: Pick<EmbeddingDoc, 'kind' | 'text' | 'cardTitle'>): KeywordMatch {
    if (!terms.length) return { keywordScore: 0, matchedTerms: [] };
    const title = normalizeKeywordText(doc.cardTitle || '');
    const text = normalizeKeywordText(doc.text || '');
    const matchedTerms: string[] = [];
    let score = 0;

    for (const term of terms) {
        const re = termRegex(term);
        let termScore = 0;
        if (title && re.test(title)) termScore += 0.24;
        if (text && re.test(text)) termScore += doc.kind === 'node' ? 0.28 : 0.18;
        if (termScore > 0) {
            matchedTerms.push(term);
            score += termScore;
        }
    }

    for (let i = 0; i < terms.length - 1; i++) {
        const phrase = `${terms[i]} ${terms[i + 1]}`;
        if (text.includes(phrase) || title.includes(phrase)) score += 0.08;
    }

    return { keywordScore: Math.min(0.35, score), matchedTerms };
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

    /**
     * Re-index the entire base for semantic search:
     *   1. Embed every node's title text (heading-level)
     *   2. Embed every card's title + content + problem text (knowledge-level)
     *
     * This is safe to call fire-and-forget from save handlers – errors are
     * logged and never thrown.
     */
    async vectorizeBaseContent(
        domainId: string,
        baseDocId: number,
        branch: string,
    ): Promise<void> {
        const start = Date.now();
        try {
            const base = await BaseModel.get(domainId, baseDocId);
            if (!base) {
                logger.warn('Base not found for vectorization: %s/%s', domainId, baseDocId);
                return;
            }

            const branchData = getBranchData(base, branch || 'main');
            const nodes = branchData.nodes || [];

            if (!nodes.length) {
                logger.debug('No nodes to vectorize for base %s/%s', domainId, baseDocId);
                return;
            }

            const coll = this.ctx.db.db.collection<EmbeddingDoc>(COLLECTION);
            const now = new Date();

            // ── 1. Embed node titles ──
            const nodeEntries: { nodeId: string; text: string }[] = [];
            for (const node of nodes) {
                const t = node.text?.trim();
                if (t) nodeEntries.push({ nodeId: node.id, text: t });
            }

            if (nodeEntries.length) {
                // Remove old node embeddings for this base before re-indexing
                await coll.deleteMany({ domainId, baseDocId, branch, kind: 'node' });

                const texts = nodeEntries.map((e) => e.text);
                const embeddings = await this.embedBatch(texts);
                const ops = nodeEntries.map((e, i) => ({
                    insertOne: {
                        document: {
                            domainId, baseDocId, branch,
                            kind: 'node' as const,
                            nodeId: e.nodeId,
                            chunkIndex: 0,
                            text: e.text,
                            embedding: embeddings[i],
                            updatedAt: now,
                        },
                    },
                }));
                for (let i = 0; i < ops.length; i += 500) {
                    await coll.bulkWrite(ops.slice(i, i + 500));
                }
            }

            // ── 2. Embed card content (with chunking) ──
            const cards = await CardModel.getByNodeIds(domainId, baseDocId, nodes.map((n) => n.id), branch);

            const cardChunks: Array<{
                nodeId: string;
                cardDocId: string;
                cardTitle: string;
                chunkIndex: number;
                text: string;
            }> = [];

            for (const [nodeId, cardList] of cards) {
                for (const card of cardList) {
                    const searchText = buildCardSearchText(card);
                    if (!searchText) continue;

                    const chunks = this.chunkText(searchText);
                    const title = (card.title || '').trim();
                    for (let ci = 0; ci < chunks.length; ci++) {
                        cardChunks.push({
                            nodeId,
                            cardDocId: card.docId.toString(),
                            cardTitle: title,
                            chunkIndex: ci,
                            text: chunks[ci],
                        });
                    }
                }
            }

            if (cardChunks.length) {
                // Remove old card embeddings for this base before re-indexing
                await coll.deleteMany({ domainId, baseDocId, branch, kind: 'card' });

                const texts = cardChunks.map((e) => e.text);
                const embeddings = await this.embedBatch(texts);
                const ops = cardChunks.map((e, i) => ({
                    insertOne: {
                        document: {
                            domainId, baseDocId, branch,
                            kind: 'card' as const,
                            nodeId: e.nodeId,
                            cardDocId: e.cardDocId,
                            cardTitle: e.cardTitle,
                            chunkIndex: e.chunkIndex,
                            text: e.text,
                            embedding: embeddings[i],
                            updatedAt: now,
                        },
                    },
                }));
                for (let i = 0; i < ops.length; i += 500) {
                    await coll.bulkWrite(ops.slice(i, i + 500));
                }
            }

            logger.debug(
                'Vectorized %d nodes + %d card-chunks for %s/%s (%d ms)',
                nodeEntries.length, cardChunks.length,
                domainId, baseDocId,
                Date.now() - start,
            );
        } catch (err) {
            logger.error('Vectorization failed for %s/%s: %o', domainId, baseDocId, err);
        }
    }

    /**
     * Search for semantically similar content within a base + branch.
     *
     * Searches both node-title entries and card-content entries.  Results are
     * ranked by cosine similarity.  Fine for knowledge bases with <10k entries.
     */
    async searchSimilar(
        domainId: string,
        baseDocId: number,
        branch: string,
        query: string,
        limit: number = 15,
    ): Promise<SearchResult[]> {
        const queryVec = await this.embed(query);
        const coll = this.ctx.db.db.collection<EmbeddingDoc>(COLLECTION);
        const docs = await coll.find({ domainId, baseDocId, branch }).toArray();

        if (!docs.length) return [];

        // Cosine similarity + bounded keyword rerank (no index needed for small datasets)
        const queryTerms = extractKeywordTerms(query);
        const scored: SearchResult[] = [];
        docs.forEach((doc, order) => {
            const dot = doc.embedding.reduce((sum, v, i) => sum + v * queryVec[i], 0);
            const magA = Math.sqrt(doc.embedding.reduce((sum, v) => sum + v * v, 0));
            const magB = Math.sqrt(queryVec.reduce((sum, v) => sum + v * v, 0));
            const semanticScore = magA && magB ? dot / (magA * magB) : 0;
            const { keywordScore, matchedTerms } = scoreKeywordMatch(queryTerms, doc);
            const score = Math.min(1, semanticScore + keywordScore);

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
        scored.forEach((r, i) => { r.rank = i + 1; });
        return scored.slice(0, limit);
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

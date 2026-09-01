import { BaseModel } from '../../model/base';
import * as document from '../../model/document';
import { buildParentMap, pathLabelFor } from './shared';
import type { ToolContext, ToolArgs } from '../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query is required');
    if (!ctx.embedding) throw new Error('Semantic search is not available (embedding service not loaded)');
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
    const kind = String(args.kind || '').trim().toLowerCase();
    const requested = kind && (kind === 'node' || kind === 'card') ? Math.min(50, limit * 3) : limit;
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const raw = await ctx.embedding.searchSimilar(ctx.domainId, ctx.baseDocId, query, requested);
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
        })),
    };
}

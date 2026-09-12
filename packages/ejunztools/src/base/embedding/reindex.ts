import { BaseModel } from 'ejun/src/model/base';
import * as document from 'ejun/src/model/document';
import { buildEmbeddingStatusView, enqueueEmbeddingIndex } from '../../embedding/worker';
import type { EmbeddingIndexMode } from '../../embedding/worker';
import type { ToolContext, ToolArgs } from '../../types';

function idList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const raw of value) {
        const id = String(raw ?? '').trim();
        if (id) seen.add(id);
    }
    return [...seen];
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
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
    const status = await buildEmbeddingStatusView(ctx.domainId, ctx.baseDocId);

    return {
        ok: true,
        baseId: base.docId,
        baseTitle: base.title || '',
        mode,
        nodeIds,
        cardIds,
        taskId: taskId ? taskId.toString() : null,
        generation: status.generation,
        queued: !!taskId,
        status: {
            status: status.status,
            appliedGeneration: status.appliedGeneration,
            indexedCount: status.indexedCount,
            progress: status.progress,
            lastError: status.lastError,
            updatedAt: status.updatedAt,
        },
    };
}

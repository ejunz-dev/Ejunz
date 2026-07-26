import Schema from 'schemastery';
import { Context } from '../context';
import {
    buildEmbeddingStatusView,
    enqueueEmbeddingFullRebuild,
    enqueueEmbeddingIndex,
} from '../service/embeddingWorker';

export function apply(ctx: Context) {
    ctx.addScript(
        'embeddingReindex',
        'Enqueue embedding index job for a base (default: full_rebuild)',
        Schema.object({
            domainId: Schema.string().required(),
            baseDocId: Schema.number().required(),
            mode: Schema.union(['full_rebuild', 'incremental'] as const).default('full_rebuild'),
            reason: Schema.string().default('cli'),
        }),
        async (args, report) => {
            const domainId = String(args.domainId).trim();
            const baseDocId = Number(args.baseDocId);
            if (!domainId || !Number.isFinite(baseDocId) || baseDocId <= 0) {
                report('invalid domainId / baseDocId');
                return false;
            }
            const taskId = args.mode === 'incremental'
                ? await enqueueEmbeddingIndex({
                    domainId,
                    baseDocId,
                    mode: 'incremental',
                    reason: args.reason || 'cli',
                })
                : await enqueueEmbeddingFullRebuild({
                    domainId,
                    baseDocId,
                    reason: args.reason || 'cli',
                });
            if (!taskId) {
                report('nothing queued (empty incremental delta?)');
                return false;
            }
            report(`queued task ${taskId.toString()} mode=${args.mode || 'full_rebuild'} for ${domainId}/${baseDocId}`);
            const status = await buildEmbeddingStatusView(domainId, baseDocId);
            report(JSON.stringify(status));
            return true;
        },
    );

    ctx.addScript(
        'embeddingStatus',
        'Show embedding index status for a base',
        Schema.object({
            domainId: Schema.string().required(),
            baseDocId: Schema.number().required(),
        }),
        async (args, report) => {
            const status = await buildEmbeddingStatusView(String(args.domainId).trim(), Number(args.baseDocId));
            report(JSON.stringify(status, null, 2));
            return true;
        },
    );
}

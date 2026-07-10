import task from '../model/task';
import { Logger } from '../logger';

const logger = new Logger('embeddingWorker');

export const EMBEDDING_TASK_TYPE = 'embedding';
export const EMBEDDING_VECTORIZE_SUBTYPE = 'vectorize_base';
export const EMBEDDING_VECTORIZE_WORKER_TASK = 'embedding_vectorize';
export const SEMANTIC_SEARCH_TOOL = 'semantic_search';

export async function enqueueEmbeddingVectorizeBase({
    domainId,
    baseDocId,
    branch,
    owner,
    reason,
}: {
    domainId: string;
    baseDocId: number;
    branch?: string;
    owner?: number;
    reason?: string;
}) {
    const baseBranch = (branch && String(branch).trim()) || 'main';
    await task.deleteMany({
        type: EMBEDDING_TASK_TYPE,
        subType: EMBEDDING_VECTORIZE_SUBTYPE,
        domainId,
        baseDocId,
        baseBranch,
    });
    const taskId = await task.add({
        type: EMBEDDING_TASK_TYPE,
        subType: EMBEDDING_VECTORIZE_SUBTYPE,
        domainId,
        baseDocId,
        baseBranch,
        owner,
        reason,
        priority: -100,
    });
    logger.debug('Queued embedding vectorization task %s for %s/%s:%s (%s)', taskId.toString(), domainId, baseDocId, baseBranch, reason || 'unspecified');
    return taskId;
}

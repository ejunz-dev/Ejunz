/**
 * Embedding index worker queue.
 *
 * Tasks are coalesced per Base (domainId + baseDocId). A persistent
 * `base.embedding_state` document tracks generation / lease / retry so that:
 *   - concurrent saves merge into one pending task
 *   - full_rebuild is never downgraded by incremental saves
 *   - findOneAndDelete claim + worker crash can be recovered from state
 */

import { hostname } from 'os';
import { ObjectId } from 'mongodb';
import { nanoid } from 'nanoid';
import task from '../model/task';
import db from './db';
import bus from './bus';
import { Logger } from '../logger';

const logger = new Logger('embeddingWorker');

export const EMBEDDING_TASK_TYPE = 'embedding';
export const EMBEDDING_INDEX_SUBTYPE = 'index';
export const EMBEDDING_INDEX_WORKER_TASK = 'embedding_index';
export const SEMANTIC_SEARCH_TOOL = 'semantic_search';

export type EmbeddingIndexMode = 'incremental' | 'full_rebuild';

export interface EmbeddingIndexDelta {
    nodeIds?: string[];
    deletedNodeIds?: string[];
    cardDocIds?: string[];
    deletedCardDocIds?: string[];
}

export function embeddingCoalesceKey(domainId: string, baseDocId: number): string {
    return `${domainId}:${baseDocId}`;
}

function uniqIds(values: Iterable<string> | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of values || []) {
        const id = String(raw || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

function mergeMode(current: EmbeddingIndexMode | undefined, next: EmbeddingIndexMode): EmbeddingIndexMode {
    if (current === 'full_rebuild' || next === 'full_rebuild') return 'full_rebuild';
    return 'incremental';
}

function backoffMs(attempt: number): number {
    return Math.min(15 * 60 * 1000, 1000 * (2 ** Math.max(0, attempt - 1)));
}

function emptyDelta(): Required<EmbeddingIndexDelta> {
    return {
        nodeIds: [],
        deletedNodeIds: [],
        cardDocIds: [],
        deletedCardDocIds: [],
    };
}

function normalizeDelta(delta: EmbeddingIndexDelta = {}): Required<EmbeddingIndexDelta> {
    return {
        nodeIds: uniqIds(delta.nodeIds),
        deletedNodeIds: uniqIds(delta.deletedNodeIds),
        cardDocIds: uniqIds(delta.cardDocIds),
        deletedCardDocIds: uniqIds(delta.deletedCardDocIds),
    };
}

function hasWork(mode: EmbeddingIndexMode, delta: Required<EmbeddingIndexDelta>): boolean {
    if (mode === 'full_rebuild') return true;
    return !!(
        delta.nodeIds.length
        || delta.deletedNodeIds.length
        || delta.cardDocIds.length
        || delta.deletedCardDocIds.length
    );
}

function mergeDelta(
    current: EmbeddingIndexDelta | undefined,
    incoming: Required<EmbeddingIndexDelta>,
    mode: EmbeddingIndexMode,
): Required<EmbeddingIndexDelta> {
    if (mode === 'full_rebuild') return emptyDelta();
    return {
        nodeIds: uniqIds([...(current?.nodeIds || []), ...incoming.nodeIds]),
        deletedNodeIds: uniqIds([...(current?.deletedNodeIds || []), ...incoming.deletedNodeIds]),
        cardDocIds: uniqIds([...(current?.cardDocIds || []), ...incoming.cardDocIds]),
        deletedCardDocIds: uniqIds([...(current?.deletedCardDocIds || []), ...incoming.deletedCardDocIds]),
    };
}

export interface EmbeddingIndexEnqueueInput extends EmbeddingIndexDelta {
    domainId: string;
    baseDocId: number;
    mode?: EmbeddingIndexMode;
    owner?: number;
    reason?: string;
}

export interface EmbeddingIndexTaskPayload extends EmbeddingIndexDelta {
    type: typeof EMBEDDING_TASK_TYPE;
    subType: typeof EMBEDDING_INDEX_SUBTYPE;
    coalesceKey: string;
    domainId: string;
    baseDocId: number;
    mode: EmbeddingIndexMode;
    nodeIds: string[];
    deletedNodeIds: string[];
    cardDocIds: string[];
    deletedCardDocIds: string[];
    generation: number;
    attempt: number;
    requestedAt: Date;
    owner?: number;
    reason?: string;
    priority: number;
}

export interface EmbeddingStateDoc {
    domainId: string;
    baseDocId: number;
    coalesceKey: string;
    generation: number;
    appliedGeneration: number;
    mode: EmbeddingIndexMode;
    nodeIds: string[];
    deletedNodeIds: string[];
    cardDocIds: string[];
    deletedCardDocIds: string[];
    attempt: number;
    leaseOwner?: string | null;
    leaseUntil?: Date | null;
    nextRetryAt?: Date | null;
    lastError?: string | null;
    pendingTaskId?: ObjectId | null;
    updatedAt: Date;
    requestedAt?: Date;
    owner?: number;
    reason?: string;
}

const STATE_COLLECTION = 'base.embedding_state';
const LEASE_MS = 10 * 60 * 1000;
const TASK_PRIORITY = -100;

const workerInstanceId = `${hostname()}:${process.pid}:${nanoid(6)}`;

function stateColl() {
    return db.db.collection<EmbeddingStateDoc>(STATE_COLLECTION);
}

async function ensureStateIndexes() {
    const coll = stateColl();
    await Promise.all([
        db.ensureIndexes(coll, {
            name: 'base_embedding_state_unique',
            key: { domainId: 1, baseDocId: 1 },
            unique: true,
        }),
        db.ensureIndexes(coll, {
            name: 'base_embedding_state_coalesce',
            key: { coalesceKey: 1 },
            unique: true,
        }),
        db.ensureIndexes(coll, {
            name: 'base_embedding_state_retry',
            key: { nextRetryAt: 1, leaseUntil: 1 },
        }),
    ]);
}

let indexesReady: Promise<void> | null = null;
function ready() {
    indexesReady ||= ensureStateIndexes().catch((err) => {
        indexesReady = null;
        throw err;
    });
    return indexesReady;
}

async function replacePendingTask(state: EmbeddingStateDoc): Promise<ObjectId> {
    const coalesceKey = state.coalesceKey;
    await task.deleteMany({
        type: EMBEDDING_TASK_TYPE,
        subType: EMBEDDING_INDEX_SUBTYPE,
        coalesceKey,
    });
    const payload: EmbeddingIndexTaskPayload = {
        type: EMBEDDING_TASK_TYPE,
        subType: EMBEDDING_INDEX_SUBTYPE,
        coalesceKey,
        domainId: state.domainId,
        baseDocId: state.baseDocId,
        mode: state.mode,
        nodeIds: state.mode === 'full_rebuild' ? [] : [...(state.nodeIds || [])],
        deletedNodeIds: state.mode === 'full_rebuild' ? [] : [...(state.deletedNodeIds || [])],
        cardDocIds: state.mode === 'full_rebuild' ? [] : [...(state.cardDocIds || [])],
        deletedCardDocIds: state.mode === 'full_rebuild' ? [] : [...(state.deletedCardDocIds || [])],
        generation: state.generation,
        attempt: state.attempt || 0,
        requestedAt: state.requestedAt || new Date(),
        owner: state.owner,
        reason: state.reason,
        priority: TASK_PRIORITY,
    };
    const taskId = await task.add(payload);
    await stateColl().updateOne(
        { domainId: state.domainId, baseDocId: state.baseDocId },
        { $set: { pendingTaskId: taskId, updatedAt: new Date() } },
    );
    return taskId;
}

/**
 * Enqueue (or coalesce into) an embedding index task for a Base.
 * No-op when incremental delta is empty.
 */
export async function enqueueEmbeddingIndex(input: EmbeddingIndexEnqueueInput): Promise<ObjectId | null> {
    await ready();
    const domainId = String(input.domainId || '').trim();
    const baseDocId = Number(input.baseDocId);
    if (!domainId) throw new Error('domainId is required');
    if (!Number.isFinite(baseDocId) || baseDocId <= 0) throw new Error('baseDocId is required');

    const mode = input.mode || 'incremental';
    const delta = normalizeDelta(input);
    if (!hasWork(mode, delta)) return null;

    const coalesceKey = embeddingCoalesceKey(domainId, baseDocId);
    const now = new Date();
    const coll = stateColl();
    const existing = await coll.findOne({ domainId, baseDocId });
    const nextMode = mergeMode(existing?.mode, mode);
    const nextDelta = mergeDelta(existing, delta, nextMode);
    const generation = (existing?.generation || 0) + 1;

    const state: EmbeddingStateDoc = {
        domainId,
        baseDocId,
        coalesceKey,
        generation,
        appliedGeneration: existing?.appliedGeneration || 0,
        mode: nextMode,
        nodeIds: nextDelta.nodeIds,
        deletedNodeIds: nextDelta.deletedNodeIds,
        cardDocIds: nextDelta.cardDocIds,
        deletedCardDocIds: nextDelta.deletedCardDocIds,
        attempt: 0,
        leaseOwner: null,
        leaseUntil: null,
        nextRetryAt: null,
        lastError: null,
        pendingTaskId: null,
        updatedAt: now,
        requestedAt: now,
        owner: input.owner ?? existing?.owner,
        reason: input.reason || existing?.reason,
    };

    await coll.updateOne(
        { domainId, baseDocId },
        { $set: state },
        { upsert: true },
    );

    const taskId = await replacePendingTask(state);
    notifyEmbeddingStatus(domainId, baseDocId);
    logger.debug(
        'Queued embedding index task %s for %s mode=%s gen=%d nodes=%d/+%d cards=%d/+%d (%s)',
        taskId.toString(),
        coalesceKey,
        nextMode,
        generation,
        nextDelta.nodeIds.length,
        nextDelta.deletedNodeIds.length,
        nextDelta.cardDocIds.length,
        nextDelta.deletedCardDocIds.length,
        input.reason || 'unspecified',
    );
    return taskId;
}

/** Convenience: enqueue a full rebuild for a Base. */
export async function enqueueEmbeddingFullRebuild(input: {
    domainId: string;
    baseDocId: number;
    owner?: number;
    reason?: string;
}): Promise<ObjectId | null> {
    return enqueueEmbeddingIndex({ ...input, mode: 'full_rebuild' });
}

export function isEmbeddingIndexTask(t: any): t is EmbeddingIndexTaskPayload & { _id?: ObjectId } {
    return t?.type === EMBEDDING_TASK_TYPE && t?.subType === EMBEDDING_INDEX_SUBTYPE;
}

export async function getEmbeddingState(domainId: string, baseDocId: number): Promise<EmbeddingStateDoc | null> {
    await ready();
    return stateColl().findOne({ domainId, baseDocId });
}

export interface EmbeddingStatusView {
    status: 'never' | 'queued' | 'indexing' | 'ready' | 'error';
    mode: EmbeddingIndexMode | null;
    generation: number;
    appliedGeneration: number;
    indexedCount: number;
    lastError: string | null;
    updatedAt: string | null;
}

const EMBEDDING_COLLECTION = 'base.embedding';

export async function buildEmbeddingStatusView(
    domainId: string,
    baseDocId: number,
): Promise<EmbeddingStatusView> {
    await ready();
    const [state, indexedCount] = await Promise.all([
        stateColl().findOne({ domainId, baseDocId }),
        db.db.collection(EMBEDDING_COLLECTION).countDocuments({ domainId, baseDocId }),
    ]);
    if (!state) {
        return {
            status: indexedCount > 0 ? 'ready' : 'never',
            mode: null,
            generation: 0,
            appliedGeneration: 0,
            indexedCount,
            lastError: null,
            updatedAt: null,
        };
    }

    const now = new Date();
    const pending = state.generation > (state.appliedGeneration || 0);
    const leaseActive = !!(
        state.leaseOwner
        && state.leaseUntil
        && state.leaseUntil > now
    );
    let status: EmbeddingStatusView['status'] = 'ready';
    if (pending && state.lastError) status = 'error';
    else if (pending && leaseActive) status = 'indexing';
    else if (pending) status = 'queued';
    else if (indexedCount === 0 && state.generation === 0) status = 'never';
    else status = 'ready';

    return {
        status,
        mode: state.mode || null,
        generation: state.generation || 0,
        appliedGeneration: state.appliedGeneration || 0,
        indexedCount,
        lastError: state.lastError || null,
        updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null,
    };
}

function notifyEmbeddingStatus(domainId: string, baseDocId: number) {
    try {
        (bus.broadcast as any)('base/embedding/status/update', domainId, baseDocId);
    } catch (err) {
        logger.warn('Failed to broadcast embedding status: %o', err);
    }
}

/**
 * Acquire a lease before processing a claimed task.
 * Returns null when the task is stale (a newer generation already exists).
 */
export async function acquireEmbeddingLease(
    payload: Pick<EmbeddingIndexTaskPayload, 'domainId' | 'baseDocId' | 'generation' | 'attempt'>,
    owner = workerInstanceId,
): Promise<EmbeddingStateDoc | null> {
    await ready();
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const coll = stateColl();
    const state = await coll.findOne({ domainId: payload.domainId, baseDocId: payload.baseDocId });
    if (!state) return null;
    if (state.generation !== payload.generation) {
        logger.debug(
            'Skip stale embedding task %s/%s gen=%d current=%d',
            payload.domainId, payload.baseDocId, payload.generation, state.generation,
        );
        return null;
    }
    if (
        state.leaseOwner
        && state.leaseUntil
        && state.leaseUntil > now
        && state.leaseOwner !== owner
    ) {
        throw new Error(`Embedding lease held by ${state.leaseOwner} until ${state.leaseUntil.toISOString()}`);
    }

    const res = await coll.findOneAndUpdate(
        {
            domainId: payload.domainId,
            baseDocId: payload.baseDocId,
            generation: payload.generation,
            $or: [
                { leaseOwner: null },
                { leaseOwner: { $exists: false } },
                { leaseOwner: owner },
                { leaseUntil: { $lte: now } },
                { leaseUntil: null },
                { leaseUntil: { $exists: false } },
            ],
        },
        {
            $set: {
                leaseOwner: owner,
                leaseUntil,
                pendingTaskId: null,
                attempt: payload.attempt || state.attempt || 0,
                updatedAt: now,
            },
        },
        { returnDocument: 'after' },
    );
    const doc = (res as any)?.value && (res as any).ok !== undefined ? (res as any).value : res;
    if (!doc || !doc.generation) {
        throw new Error('Failed to acquire embedding lease');
    }
    notifyEmbeddingStatus(payload.domainId, payload.baseDocId);
    return doc as EmbeddingStateDoc;
}

export async function renewEmbeddingLease(
    domainId: string,
    baseDocId: number,
    generation: number,
    owner = workerInstanceId,
): Promise<boolean> {
    await ready();
    const now = new Date();
    const res = await stateColl().updateOne(
        { domainId, baseDocId, generation, leaseOwner: owner },
        { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now } },
    );
    return res.modifiedCount > 0;
}

/**
 * Mark generation applied and clear pending delta when it still matches.
 * If a newer generation arrived while we worked, leave it pending.
 */
export async function completeEmbeddingIndex(
    payload: Pick<EmbeddingIndexTaskPayload, 'domainId' | 'baseDocId' | 'generation'>,
    owner = workerInstanceId,
): Promise<void> {
    await ready();
    const now = new Date();
    const coll = stateColl();
    const state = await coll.findOne({ domainId: payload.domainId, baseDocId: payload.baseDocId });
    if (!state) return;

    if (state.generation === payload.generation) {
        await coll.updateOne(
            { domainId: payload.domainId, baseDocId: payload.baseDocId, generation: payload.generation },
            {
                $set: {
                    appliedGeneration: payload.generation,
                    mode: 'incremental',
                    nodeIds: [],
                    deletedNodeIds: [],
                    cardDocIds: [],
                    deletedCardDocIds: [],
                    attempt: 0,
                    leaseOwner: null,
                    leaseUntil: null,
                    nextRetryAt: null,
                    lastError: null,
                    pendingTaskId: null,
                    updatedAt: now,
                },
            },
        );
        notifyEmbeddingStatus(payload.domainId, payload.baseDocId);
        return;
    }

    // Newer generation exists — release our lease only.
    await coll.updateOne(
        { domainId: payload.domainId, baseDocId: payload.baseDocId, leaseOwner: owner },
        {
            $set: {
                leaseOwner: null,
                leaseUntil: null,
                updatedAt: now,
            },
        },
    );
    notifyEmbeddingStatus(payload.domainId, payload.baseDocId);
}

/**
 * Record failure, schedule retry with exponential backoff, and re-queue.
 */
export async function failEmbeddingIndex(
    payload: Pick<EmbeddingIndexTaskPayload, 'domainId' | 'baseDocId' | 'generation' | 'attempt'>,
    error: unknown,
    owner = workerInstanceId,
): Promise<ObjectId | null> {
    await ready();
    const now = new Date();
    const attempt = (payload.attempt || 0) + 1;
    const nextRetryAt = new Date(now.getTime() + backoffMs(attempt));
    const message = error instanceof Error ? error.message : String(error || 'Embedding index failed');
    const coll = stateColl();
    const state = await coll.findOne({ domainId: payload.domainId, baseDocId: payload.baseDocId });
    if (!state) return null;

    // A newer generation already replaced this work — do not overwrite its schedule.
    if (state.generation !== payload.generation) {
        await coll.updateOne(
            { domainId: payload.domainId, baseDocId: payload.baseDocId, leaseOwner: owner },
            { $set: { leaseOwner: null, leaseUntil: null, updatedAt: now } },
        );
        return null;
    }

    // Another worker already holds a live lease for this generation — do not
    // clobber its progress (e.g. a CLI process that failed before acquiring).
    if (
        state.leaseOwner
        && state.leaseOwner !== owner
        && state.leaseUntil
        && state.leaseUntil > now
    ) {
        logger.warn(
            'Ignore embedding fail from non-owner %s/%s gen=%d (lease held by %s)',
            payload.domainId, payload.baseDocId, payload.generation, state.leaseOwner,
        );
        return null;
    }

    const updated: EmbeddingStateDoc = {
        ...state,
        attempt,
        nextRetryAt,
        lastError: message.slice(0, 2000),
        leaseOwner: null,
        leaseUntil: null,
        pendingTaskId: null,
        updatedAt: now,
    };
    await coll.updateOne(
        { domainId: payload.domainId, baseDocId: payload.baseDocId, generation: payload.generation },
        { $set: updated },
    );
    notifyEmbeddingStatus(payload.domainId, payload.baseDocId);

    // Re-queue immediately; consumer can still respect nextRetryAt via recover if needed.
    // Keep the task so workers can pick it up after backoff via recoverExpiredEmbeddingWork.
    logger.warn(
        'Embedding index failed for %s/%s gen=%d attempt=%d: %s (retry at %s)',
        payload.domainId, payload.baseDocId, payload.generation, attempt, message, nextRetryAt.toISOString(),
    );
    return null;
}

/**
 * Re-queue work that was claimed (task deleted) but never completed —
 * expired lease, or pending generation with no task document.
 */
export async function recoverExpiredEmbeddingWork(limit = 20): Promise<number> {
    await ready();
    const now = new Date();
    const coll = stateColl();
    const candidates = await coll.find({
        $expr: { $gt: ['$generation', '$appliedGeneration'] },
        $or: [
            { leaseUntil: { $lte: now } },
            { leaseUntil: null },
            { leaseUntil: { $exists: false } },
            { nextRetryAt: { $lte: now } },
        ],
    }).limit(limit).toArray();

    let recovered = 0;
    for (const state of candidates) {
        if (state.leaseOwner && state.leaseUntil && state.leaseUntil > now) continue;
        if (state.nextRetryAt && state.nextRetryAt > now) continue;

        const pending = state.pendingTaskId
            ? await task.get(state.pendingTaskId)
            : null;
        if (pending) continue;

        const sameKeyPending = await task.count({
            type: EMBEDDING_TASK_TYPE,
            subType: EMBEDDING_INDEX_SUBTYPE,
            coalesceKey: state.coalesceKey,
        });
        if (sameKeyPending > 0) continue;

        await replacePendingTask({
            ...state,
            leaseOwner: null,
            leaseUntil: null,
            nextRetryAt: null,
        });
        recovered++;
    }
    if (recovered) logger.info('Recovered %d embedding index task(s)', recovered);
    return recovered;
}

export function buildEmbeddingIndexTaskFromDb(t: any): EmbeddingIndexTaskPayload {
    const domainId = String(t.domainId || '');
    const baseDocId = Number(t.baseDocId);
    const mode: EmbeddingIndexMode = t.mode === 'full_rebuild' ? 'full_rebuild' : 'incremental';
    return {
        type: EMBEDDING_TASK_TYPE,
        subType: EMBEDDING_INDEX_SUBTYPE,
        coalesceKey: t.coalesceKey || embeddingCoalesceKey(domainId, baseDocId),
        domainId,
        baseDocId,
        mode,
        nodeIds: uniqIds(t.nodeIds),
        deletedNodeIds: uniqIds(t.deletedNodeIds),
        cardDocIds: uniqIds(t.cardDocIds),
        deletedCardDocIds: uniqIds(t.deletedCardDocIds),
        generation: Number(t.generation) || 0,
        attempt: Number(t.attempt) || 0,
        requestedAt: t.requestedAt instanceof Date ? t.requestedAt : new Date(t.requestedAt || Date.now()),
        owner: t.owner,
        reason: t.reason,
        priority: Number.isFinite(t.priority) ? t.priority : TASK_PRIORITY,
    };
}

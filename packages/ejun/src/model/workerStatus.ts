import db from '../service/db';

export const coll = db.collection('worker_status');

export type WorkerStatusInput = {
    workerId: string;
    workerName?: string;
    workerLabel?: string;
    workerKind?: string;
    workerVersion?: string;
    version?: string;
    host?: string;
    pid?: number;
    nodeAppInstance?: string;
    processWorkerId?: string;
    consuming?: boolean;
    concurrency?: number;
    processingCount?: number;
    activeTasks?: any[];
    reqCount?: number;
    lastTaskAt?: Date;
    startedAt?: Date;
    status?: string;
    paused?: boolean;
};

function cleanObject<T extends Record<string, any>>(input: T): Partial<T> {
    const output: Partial<T> = {};
    for (const key in input) {
        if (input[key] !== undefined) output[key] = input[key];
    }
    return output;
}

export async function upsertWorkerStatus(input: WorkerStatusInput) {
    const now = new Date();
    const $set = cleanObject({
        ...input,
        type: 'worker',
        workerVersion: input.workerVersion || input.version,
        updateAt: now,
    });
    delete ($set as any).version;
    delete ($set as any).startedAt;
    delete ($set as any).workerName;
    if (input.paused !== undefined) ($set as any).paused = input.paused;
    return coll.findOneAndUpdate(
        { type: 'worker', workerId: input.workerId },
        {
            $set,
            $setOnInsert: {
                startedAt: input.startedAt || now,
            },
        },
        { upsert: true, returnDocument: 'after' },
    );
}

export async function getWorkerControl(workerId: string) {
    if (!workerId) return null;
    return coll.findOne({ type: 'worker', workerId });
}

export async function isWorkerPaused(workerId: string) {
    const doc = await getWorkerControl(workerId);
    return !!doc?.paused;
}

export async function setWorkerPaused(workerId: string, paused: boolean, uid?: number, reason?: string) {
    const now = new Date();
    const $set: Record<string, any> = paused ? {
        paused: true,
        pauseRequestedAt: now,
        pauseRequestedBy: uid,
        pauseReason: reason || '',
    } : {
        paused: false,
        resumedAt: now,
        resumedBy: uid,
        pauseReason: '',
    };
    return coll.updateOne(
        { type: 'worker', workerId },
        { $set },
        { upsert: false },
    );
}

export async function markWorkerOffline(workerId: string) {
    if (!workerId) return;
    await coll.updateOne(
        { type: 'worker', workerId },
        {
            $set: {
                status: 'offline',
                consuming: false,
                processingCount: 0,
                activeTasks: [],
                lastDisconnectedAt: new Date(),
            },
        },
    );
}

export function cleanWorkerIds(workerIds: string[] | string) {
    const rawIds = Array.isArray(workerIds) ? workerIds : String(workerIds || '').split(',');
    return Array.from(new Set(rawIds.map((id) => String(id).trim()).filter(Boolean)));
}

export async function setWorkerName(workerIds: string[] | string, workerName?: string, uid?: number) {
    const ids = cleanWorkerIds(workerIds);
    if (!ids.length) throw new Error('Missing workerId');
    const name = String(workerName || '').trim();
    if (name.length > 128) throw new Error('Worker name is too long');
    const now = new Date();
    const update = name ? {
        $set: cleanObject({
            workerName: name,
            workerNameUpdatedAt: now,
            workerNameUpdatedBy: uid,
        }),
    } : {
        $set: cleanObject({
            workerNameUpdatedAt: now,
            workerNameUpdatedBy: uid,
        }),
        $unset: { workerName: '' },
    };
    return coll.updateMany({ type: 'worker', workerId: { $in: ids } }, update);
}

export async function getWorkersByIds(workerIds: string[] | string) {
    const ids = cleanWorkerIds(workerIds);
    if (!ids.length) return [];
    return coll.find({ type: 'worker', workerId: { $in: ids } }).toArray();
}

export async function removeWorkerStatus(workerId: string) {
    if (!workerId) return;
    await coll.deleteOne({ type: 'worker', workerId });
}

export async function removeWorkerStatuses(workerIds: string[] | string) {
    const ids = cleanWorkerIds(workerIds);
    if (!ids.length) return null;
    return coll.deleteMany({ type: 'worker', workerId: { $in: ids } });
}

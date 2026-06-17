import { Context } from '../context';
import { PRIV } from '../model/builtin';
import * as DocumentModel from '../model/document';
import DomainModel from '../model/domain';
import * as SettingModel from '../model/setting';
import UserModel from '../model/user';
import {
    cleanWorkerIds, coll as workerStatusColl, getWorkersByIds,
    removeWorkerStatuses, setWorkerName, setWorkerPaused, upsertWorkerStatus,
} from '../model/workerStatus';
import db from '../service/db';
import { Handler } from '../service/server';

const coll = db.collection('status');
const DEFAULT_OFFLINE_AFTER = 300000;
const WORKER_OFFLINE_AFTER = 60000;

async function getStatus() {
    const stats = [
        ...await coll.find({ type: { $ne: 'worker' } }).sort({ type: 1, updateAt: -1 }).toArray(),
        ...await workerStatusColl.find({ processWorkerId: { $exists: true, $ne: '' } }).sort({ updateAt: -1 }).toArray(),
    ];
    const now = Date.now();
    const offlineBuiltinWorkerIds: string[] = [];
    for (const stat of stats) {
        let desc = '';
        const offlineAfter = stat.type === 'worker' ? WORKER_OFFLINE_AFTER : DEFAULT_OFFLINE_AFTER;
        const online = new Date(stat.updateAt).getTime() > now - offlineAfter;
        if (stat.type === 'worker' && stat.workerKind === 'builtin' && !online) {
            if (stat.workerId) offlineBuiltinWorkerIds.push(stat.workerId);
            stat.__removeOfflineBuiltin = true;
            continue;
        }
        if (!online) desc = 'Offline';
        else if (stat.type === 'worker' && stat.paused) desc = 'Paused';
        else if (stat.type === 'worker' && stat.processingCount > 0) desc = 'Working';
        desc ||= 'Online';
        stat.isOnline = online;
        stat.status = desc;
    }
    if (offlineBuiltinWorkerIds.length) {
        await workerStatusColl.deleteMany({ type: 'worker', workerId: { $in: offlineBuiltinWorkerIds }, workerKind: 'builtin' });
    }
    return stats.filter((stat) => !stat.__removeOfflineBuiltin);
}

function workerGroupKey(worker) {
    if (worker.processWorkerId) return worker.processWorkerId;
    if (worker.host || worker.pid) return `${worker.host || 'unknown'}:${worker.pid || 'unknown'}:${worker.nodeAppInstance || ''}`;
    return String(worker.workerId || worker._id);
}

function aggregateWorkerStats(workers) {
    const groups = new Map<string, any[]>();
    for (const worker of workers) {
        const key = workerGroupKey(worker);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(worker);
    }
    return Array.from(groups.values()).map((rows) => {
        rows.sort((a, b) => new Date(b.updateAt).getTime() - new Date(a.updateAt).getTime());
        const primary = rows.find((row) => row.workerKind === 'agent_task') || rows[0];
        const onlineRows = rows.filter((row) => row.isOnline);
        const activeTasks = rows.flatMap((row) => row.activeTasks || []);
        const workerKinds = Array.from(new Set(rows.map((row) => row.workerKind).filter(Boolean)));
        const updateAt = rows.reduce((latest, row) => (
            new Date(row.updateAt).getTime() > new Date(latest).getTime() ? row.updateAt : latest
        ), rows[0].updateAt);
        const paused = !!onlineRows.length && onlineRows.every((row) => row.paused);
        const processingCount = rows.reduce((sum, row) => sum + (row.processingCount || 0), 0);
        const isOnline = onlineRows.length > 0;
        let status = 'Offline';
        if (isOnline && paused) status = 'Paused';
        else if (isOnline && processingCount > 0) status = 'Working';
        else if (isOnline) status = 'Online';
        return {
            ...primary,
            workerIds: Array.from(new Set(rows.map((row) => row.workerId).filter(Boolean))),
            workerKinds,
            workerKind: workerKinds.join(', '),
            workerName: primary.workerName || rows.find((row) => row.workerName)?.workerName,
            workerNameMixed: Array.from(new Set(rows.map((row) => row.workerName).filter(Boolean))).length > 1,
            workerVersion: primary.workerVersion || rows.find((row) => row.workerVersion)?.workerVersion,
            isOnline,
            paused,
            status,
            concurrency: rows.reduce((sum, row) => sum + (row.concurrency || 0), 0),
            processingCount,
            activeTasks,
            reqCount: rows.reduce((sum, row) => sum + (row.reqCount || 0), 0),
            updateAt,
            consumers: rows,
        };
    }).sort((a, b) => new Date(b.updateAt).getTime() - new Date(a.updateAt).getTime());
}

class StatusHandler extends Handler {
    async get() {
        const allStats = await getStatus();
        const stats = allStats.filter((stat) => stat.type !== 'worker');
        const workerStats = aggregateWorkerStats(allStats.filter((stat) => stat.type === 'worker'));
        const compilers = {};
        const warn = {};
        const result: Array<{ key: string[], message: string }> = [];
        // For each language, select the most common compiler message version,
        // then merge languages with the same message.
        for (const stat of stats) {
            if (!stat.battery?.hasBattery) stat.battery = 'No battery';
            else stat.battery = `${stat.battery.type} ${stat.battery.model} ${stat.battery.percent}%${stat.battery.isCharging ? ' Charging' : ''}`;
            if (stat.compilers) {
                for (const key in stat.compilers) {
                    if (!compilers[key]) compilers[key] ||= [];
                    const related = compilers[key].find((i) => i.message === stat.compilers[key]);
                    if (related) related.related.push(stat._id);
                    else {
                        compilers[key].push({
                            related: [stat._id],
                            message: stat.compilers[key],
                        });
                    }
                }
            }
        }
        for (const key in compilers) {
            compilers[key].sort((a, b) => b.related.length - a.related.length);
            const message = compilers[key][0].message;
            for (let i = 1; i < compilers[key].length; i++) {
                for (const id of compilers[key][i].related) {
                    warn[id] = true;
                }
            }
            const t = result.find((i) => i.message === message);
            if (t) t.key.push(key);
            else result.push({ key: [key], message });
        }
        const LANGS = SettingModel.langs;
        const languages = {};
        for (const key in LANGS) {
            if (LANGS[key].hidden) continue;
            languages[`${LANGS[key].display}(${key})`] = LANGS[key].compile || LANGS[key].execute;
        }
        this.response.body = { stats, workerStats, languages, compilers: result };
        this.response.template = 'status.html';
    }
}

class StatusWorkerEditHandler extends Handler {
    async post(args) {
        this.checkPriv(PRIV.PRIV_WORKER);
        const ids = cleanWorkerIds(args.workerIds || args.workerId || '');
        if (!ids.length) throw new Error('Missing workerId');
        if (args.deleteWorker === true || args.deleteWorker === 'true' || args.deleteWorker === '1' || args.deleteWorker === 'on') {
            const workers = await getWorkersByIds(ids);
            const now = Date.now();
            const onlineWorker = workers.find((worker) => new Date(worker.updateAt).getTime() > now - WORKER_OFFLINE_AFTER);
            if (onlineWorker) throw new Error('Cannot delete online worker');
            await removeWorkerStatuses(ids);
            this.response.body = { ok: 1 };
            return;
        }
        await setWorkerName(ids, args.workerName, this.user?._id);
        if (args.paused !== undefined) {
            const paused = args.paused === true || args.paused === 'true' || args.paused === '1' || args.paused === 'on';
            await Promise.all(ids.map((workerId) => setWorkerPaused(workerId, paused, this.user?._id, args.reason)));
        }
        this.response.body = { ok: 1 };
    }
}

class StatusUpdateHandler extends Handler {
    async post(args) {
        this.checkPriv(PRIV.PRIV_WORKER);
        const workerId = String(args.workerId || args.mid || '').trim();
        if (!workerId) throw new Error('Missing workerId');
        return upsertWorkerStatus({ ...args, workerId });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('status', '/status', StatusHandler);
    ctx.Route('status_update', '/status/update', StatusUpdateHandler);
    ctx.Route('status_worker_edit', '/status/worker/edit', StatusWorkerEditHandler, PRIV.PRIV_WORKER);
    await db.ensureIndexes(coll, { name: 'expire', key: { updateAt: 1 }, expireAfterSeconds: 24 * 2600 });
    await db.ensureIndexes(workerStatusColl, { name: 'worker_id', key: { type: 1, workerId: 1 } });
    await db.ensureIndexes(workerStatusColl, { name: 'process_worker_id', key: { processWorkerId: 1 } });
}
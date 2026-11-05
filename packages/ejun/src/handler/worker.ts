import { hostname } from 'os';
import { Context } from '../context';
import { Logger } from '../logger';
import * as setting from '../model/setting';
import * as builtin from '../model/builtin';
import {
    allocateWorkerId, markWorkerOffline, removeWorkerStatus, upsertWorkerStatus,
} from '../model/workerStatus';
import { ConnectionHandler, subscribe } from '../service/server';

const logger = new Logger('worker');
const WORKER_PROTOCOL = 'ejunz-worker-v1';

export class EjunzWorkerConnectionHandler extends ConnectionHandler {
    category = '#worker';
    workerId = '';
    workerName = '';
    workerLabel = '';
    workerVersion = '';
    workerSourceId = '';
    processWorkerId = '';
    heartbeatTimer?: ReturnType<typeof setInterval>;
    statusRegistered = false;
    startedAt = new Date();

    async prepare() {
        this.processWorkerId = `ws-${hostname()}-${this.request.ip || 'unknown'}`;
        this.workerId = this.processWorkerId;
        this.workerName = `worker@${this.request.ip || hostname()}`;
        this.workerLabel = this.workerName;
        this.workerVersion = process.env.EJUNZ_WORKER_VERSION || 'unknown';
        logger.info('Ejunz worker connected from %s', this.request.ip);
        this.heartbeatTimer = setInterval(() => this.updateWorkerStatus().catch(() => {}), 10000);
        this.send({ key: 'hello', protocol: WORKER_PROTOCOL, serverTime: new Date().toISOString() });
        this.sendServerConfig();
    }

    async updateWorkerStatus(extra: Record<string, any> = {}) {
        if (!this.statusRegistered) return;
        await upsertWorkerStatus({
            workerId: this.workerId,
            workerSourceId: this.workerSourceId,
            processWorkerId: this.processWorkerId,
            workerName: this.workerName,
            workerLabel: this.workerLabel || this.workerName,
            workerKind: 'websocket',
            workerVersion: this.workerVersion,
            host: extra.host || hostname(),
            pid: extra.pid || process.pid,
            consuming: false,
            concurrency: 1,
            processingCount: 0,
            activeTasks: [],
            reqCount: 0,
            startedAt: this.startedAt,
            status: 'online',
            ...extra,
        });
    }

    @subscribe('system/setting')
    sendServerConfig() {
        this.send({ key: 'server_config', language: setting.langs });
    }

    async message(raw: any) {
        const msg = typeof raw === 'string' && raw !== 'ping' ? JSON.parse(raw) : raw;
        if (msg === 'ping' || msg?.key === 'ping') {
            this.send('pong' as any);
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.key !== 'status') logger.info('Worker message: %s', msg.key);

        if (msg.key === 'config') {
            if (msg.protocol && msg.protocol !== WORKER_PROTOCOL) {
                logger.warn('Worker protocol mismatch: expected=%s got=%s', WORKER_PROTOCOL, msg.protocol);
            }
            const previousWorkerId = this.workerId;
            if (msg.processWorkerId) this.processWorkerId = String(msg.processWorkerId);
            this.workerSourceId = String(msg.workerId || this.workerSourceId || this.processWorkerId || '').trim();
            this.workerId = await allocateWorkerId('websocket', this.workerSourceId);
            if (msg.workerName) this.workerName = String(msg.workerName);
            if (msg.workerLabel) this.workerLabel = String(msg.workerLabel);
            if (msg.workerVersion || msg.version) this.workerVersion = String(msg.workerVersion || msg.version);
            this.statusRegistered = true;
            await this.updateWorkerStatus({
                status: 'online',
                protocol: msg.protocol || WORKER_PROTOCOL,
                host: msg.host,
                pid: msg.pid,
                nodeAppInstance: msg.nodeAppInstance,
            });
            if (previousWorkerId && previousWorkerId !== this.workerId) {
                await removeWorkerStatus(previousWorkerId);
            }
            if (this.workerSourceId && this.workerSourceId !== this.workerId) {
                await removeWorkerStatus(this.workerSourceId);
            }
            return;
        }

        if (msg.key === 'status') {
            const status = msg.status && typeof msg.status === 'object' ? msg.status : {};
            await this.updateWorkerStatus({
                ...status,
                status: status.status || 'online',
                host: msg.host || status.host,
                pid: msg.pid || status.pid,
            });
            return;
        }

    }

    async cleanup() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.statusRegistered) await markWorkerOffline(this.workerId);
        logger.info('Ejunz worker disconnected from %s', this.request.ip);
    }
}

export async function apply(ctx: Context) {
    ctx.Connection('worker_conn', '/worker/conn', EjunzWorkerConnectionHandler, builtin.PRIV.USER_PRIV_WORKER);
}

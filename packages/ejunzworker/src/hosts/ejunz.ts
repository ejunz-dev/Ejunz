import os from 'os';
import PQueue from 'p-queue';
import superagent from 'superagent';
import WebSocket from 'ws';
import type { LangConfig } from '@ejunz/common';
import { SystemError } from '../error';
import { Session } from '../interface';
import log from '../log';
import { executeWorkerTask, WorkerTaskReporter } from './builtin';

const WORKER_PROTOCOL = 'ejunz-worker-v1';

function workerVersion(config: any) {
    return process.env.EJUNZ_WORKER_VERSION || config.workerVersion || (() => {
        try {
            return require('../../package.json').version;
        } catch {
            return 'unknown';
        }
    })();
}

function normalizeTaskTypes(taskTypes: any) {
    if (!Array.isArray(taskTypes) || taskTypes.length === 0) return ['agent_task', 'tool_call', 'mcp_tool_call'];
    return taskTypes.map((i) => String(i));
}

function cookieToBearer(cookie: string) {
    const sid = String(cookie || '').match(/(?:^|;\s*)(?:sid|session|connect\.sid)=([^;]+)/)?.[1];
    return sid ? decodeURIComponent(sid) : '';
}

export default class Ejunz implements Session {
    workerWs?: WebSocket;
    language: Record<string, LangConfig> = {};
    private queue: PQueue = new PQueue({ concurrency: 1 });
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private disposed = false;
    private reconnectAttempts = 0;
    private reqCount = 0;
    private activeTasks = new Map<string, any>();
    private startedAt = new Date();

    constructor(public config) {
        this.config.detail ??= true;
        this.config.cookie ||= '';
        this.config.token ||= '';
        this.config.last_update_at ||= 0;
        this.config.taskTypes = normalizeTaskTypes(this.config.taskTypes);
        this.config.concurrency ||= this.config.toolcallConcurrency || 4;
        if (!this.config.server_url?.startsWith('http')) this.config.server_url = `http://${this.config.server_url}`;
        if (!this.config.server_url.endsWith('/')) this.config.server_url = `${this.config.server_url}/`;
        this.queue = new PQueue({ concurrency: this.config.concurrency });
    }

    get(url: string) {
        url = new URL(url, this.config.server_url).toString();
        const req = superagent.get(url).set('Cookie', this.config.cookie || '');
        if (this.config.token) req.set('Authorization', `Bearer ${this.config.token}`);
        return req;
    }

    post(url: string, data?: any) {
        url = new URL(url, this.config.server_url).toString();
        const req = superagent.post(url)
            .set('Cookie', this.config.cookie || '')
            .set('Accept', 'application/json');
        if (this.config.token) req.set('Authorization', `Bearer ${this.config.token}`);
        return data ? req.send(data) : req;
    }

    async init() {
        await this.setCookie(this.config.cookie || '');
        await this.ensureLogin();
    }

    async fetchFile<T extends string | null>(namespace: T, files: Record<string, string>): Promise<T extends null ? string : null> {
        throw new SystemError('fetchFile not supported by websocket worker');
    }

    async postFile(target: string, filename: string, file: string) {
        throw new SystemError('postFile not supported by websocket worker');
    }

    getLang(name: string, doThrow = true) {
        if (this.language[name]) return this.language[name];
        if (name === 'cpp' && this.language.cc) return this.language.cc;
        if (doThrow) throw new SystemError('Unsupported language {0}', [name]);
        return null;
    }

    getReporter(t: any) {
        return {
            next: () => {},
            end: () => {},
        };
    }

    private identity() {
        const fallbackName = this.config.host || os.hostname();
        const workerId = process.env.EJUNZ_WORKER_ID || this.config.workerId || fallbackName;
        return {
            protocol: WORKER_PROTOCOL,
            workerId,
            processWorkerId: workerId,
            workerLabel: process.env.EJUNZ_WORKER_LABEL || this.config.workerLabel || workerId,
            workerVersion: workerVersion(this.config),
            concurrency: this.config.concurrency,
            minPriority: this.config.minPriority,
            taskTypes: this.config.taskTypes,
            host: os.hostname(),
            pid: process.pid,
            nodeAppInstance: process.env.NODE_APP_INSTANCE,
        };
    }

    private wsUrl() {
        const url = new URL('worker/conn', this.config.server_url);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.toString();
    }

    private wsHeaders() {
        const headers: Record<string, string> = {};
        if (this.config.cookie) headers.Cookie = this.config.cookie;
        const bearer = this.config.token || cookieToBearer(this.config.cookie);
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        return headers;
    }

    private send(data: any) {
        if (this.workerWs?.readyState !== WebSocket.OPEN) return false;
        this.workerWs.send(typeof data === 'string' ? data : JSON.stringify(data));
        return true;
    }

    private runtimeStatus(extra: any = {}) {
        return {
            host: os.hostname(),
            pid: process.pid,
            nodeAppInstance: process.env.NODE_APP_INSTANCE,
            startedAt: this.startedAt,
            concurrency: this.config.concurrency,
            processingCount: this.activeTasks.size,
            activeTasks: Array.from(this.activeTasks.values()).slice(0, 20),
            reqCount: this.reqCount,
            ...extra,
        };
    }

    private sendStatus(extra: any = {}) {
        this.send({ key: 'status', status: this.runtimeStatus(extra) });
    }

    async connectWorker(queue?: PQueue) {
        if (queue) this.queue = queue;
        this.queue.concurrency = this.config.concurrency || this.queue.concurrency || 1;
        this.disposed = false;
        await this.ensureLogin();
        this.openWebSocket();
    }

    async consumeToolCall(queue: PQueue) {
        return this.connectWorker(queue);
    }

    private openWebSocket() {
        if (this.disposed) return;
        if (this.workerWs && (this.workerWs.readyState === WebSocket.CONNECTING || this.workerWs.readyState === WebSocket.OPEN)) return;

        const url = this.wsUrl();
        log.info(`[${this.config.host}] Connecting worker websocket: ${url}`);
        const ws = new WebSocket(url, { headers: this.wsHeaders() });
        this.workerWs = ws;

        ws.on('open', () => {
            this.reconnectAttempts = 0;
            log.info(`[${this.config.host}] Worker websocket connected`);
            this.send({ key: 'config', ...this.identity() });
            this.sendStatus({ status: 'online' });
            this.send({ key: 'start' });
            log.info(`[${this.config.host}] Worker websocket registered and start requested`);
            this.heartbeatTimer = setInterval(() => {
                this.send('ping');
                this.sendStatus({ status: 'online' });
            }, 10000);
        });

        ws.on('message', (data) => {
            const text = data.toString();
            if (text === 'ping') {
                this.send('pong');
                return;
            }
            if (text === 'pong') return;
            let msg: any;
            try {
                msg = JSON.parse(text);
            } catch (e: any) {
                log.warn(`[${this.config.host}] Invalid websocket message: ${e?.message || e}`);
                return;
            }
            this.handleMessage(msg).catch((e) => log.error(`[${this.config.host}] Failed to handle websocket message`, e));
        });

        ws.on('close', async (code, reason) => {
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
            log.warn(`[${this.config.host}] Worker websocket closed (${code}) ${reason?.toString?.() || ''}`);
            if (code === 401 || code === 403 || code === 4001 || code === 4003) {
                this.config.cookie = '';
                await this.ensureLogin().catch((e) => log.error(`[${this.config.host}] Re-login failed`, e));
            }
            this.scheduleReconnect();
        });

        ws.on('error', (err: any) => {
            const response = err?.response;
            const status = response?.statusCode || response?.status;
            const body = response?.body || response?.statusMessage;
            const detail = status ? ` status=${status}${body ? ` body=${body}` : ''}` : '';
            log.warn(`[${this.config.host}] Worker websocket error: ${err.message || err}${detail}`);
        });
    }

    private scheduleReconnect() {
        if (this.disposed) return;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts++);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.openWebSocket();
        }, delay);
    }

    private async handleMessage(msg: any) {
        if (msg.key === 'hello') {
            log.info(`[${this.config.host}] Server hello: protocol=${msg.protocol || 'unknown'}`);
            return;
        }
        if (msg.key === 'server_config') {
            this.language = msg.language || msg.lang || this.language;
            return;
        }
        if (msg.key !== 'task') return;
        const taskId = String(msg.taskId || msg.payload?._id || '');
        const taskType = String(msg.taskType || '');
        const payload = msg.payload || {};
        const activeTask = {
            taskId,
            taskType,
            recordId: payload.recordId?.toString?.() || payload.recordId,
            toolName: payload.toolName || payload.name,
            startedAt: new Date(),
        };
        this.activeTasks.set(taskId, activeTask);
        this.sendStatus();
        this.queue.add(async () => {
            const reporter = this.createReporter(taskId, taskType);
            try {
                log.info(`[${this.config.host}] Worker task started: ${taskType} ${taskId}`);
                await executeWorkerTask(taskType, payload, reporter, this.config);
                log.info(`[${this.config.host}] Worker task finished: ${taskType} ${taskId}`);
            } catch (e: any) {
                log.error(`[${this.config.host}] Worker task failed: ${taskType} ${taskId}`, e);
                await reporter.error({ message: e?.message || String(e), code: e?.code || 'WORKER_ERROR', stack: e?.stack });
            } finally {
                this.activeTasks.delete(taskId);
                this.reqCount++;
                this.sendStatus({ lastTaskAt: new Date() });
            }
        }).catch((e) => log.error(`[${this.config.host}] Queue task failed`, e));
    }

    private createReporter(taskId: string, taskType: string): WorkerTaskReporter {
        const send = (data: any) => {
            this.send({ taskId, ...data });
            return Promise.resolve();
        };
        return {
            accepted: (data?: any) => send({ key: 'task.accepted', ...data }),
            status: (data?: any) => send(taskType === 'agent_task'
                ? { key: 'agent.status', ...data }
                : { key: 'status', status: this.runtimeStatus(data) }),
            stream: (data?: any) => send({ key: 'agent.stream', ...data }),
            appendMessage: (message: any) => send({ key: 'agent.message.append', message }),
            patchMessage: (selector: any, set: any) => send({ key: 'agent.message.patch', selector, set }),
            toolResult: (data?: any) => send({ key: 'agent.tool_result', ...data }),
            complete: (data?: any) => {
                if (taskType === 'tool_call') return send({ key: 'tool_call.complete', ...data });
                if (taskType === 'mcp_tool_call') return send({ key: 'mcp_tool_call.complete', ...data });
                return send({ key: 'task.complete', ...data });
            },
            error: (error: any) => {
                if (taskType === 'tool_call') return send({ key: 'tool_call.error', error });
                if (taskType === 'mcp_tool_call') return send({ key: 'mcp_tool_call.error', error });
                return send({ key: 'task.error', error });
            },
        };
    }

    dispose() {
        this.disposed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.workerWs?.close?.();
        this.queue.clear();
    }

    async setCookie(cookie: string) {
        this.config.cookie = cookie || '';
    }

    async login() {
        log.info('[%s] Updating session', this.config.host);
        const res = await this.post('login', {
            uname: this.config.uname, password: this.config.password, rememberme: 'on',
        });
        const setCookie = res.headers['set-cookie'];
        await this.setCookie(Array.isArray(setCookie) ? setCookie.join(';') : setCookie || '');
    }

    async ensureLogin() {
        if (this.config.token || this.config.cookie) {
            try {
                await this.get('').set('Accept', 'application/json');
                return;
            } catch (e) {
                if (!this.config.uname || !this.config.password) throw e;
            }
        }
        await this.login();
    }
}

import { hostname } from 'os';
import { ObjectId } from 'mongodb';
import { Context } from '../context';
import {
    BadRequestError,
} from '../error';
import { Task } from '../interface';
import { Logger } from '../logger';
import * as builtin from '../model/builtin';
import { STATUS } from '../model/builtin';
import RecordModel, { AgentRecordMessage } from '../model/record';
import * as setting from '../model/setting';
import task, { Consumer } from '../model/task';
import {
    allocateWorkerId, isWorkerPaused, markWorkerOffline, removeWorkerStatus, upsertWorkerStatus,
} from '../model/workerStatus';
import bus from '../service/bus';
import {
    ConnectionHandler, Handler, post, subscribe, Types,
} from '../service/server';

const logger = new Logger('worker');

type AgentStreamSnapshot = {
    recordId: string;
    domainId: string;
    bubbleId?: string;
    content?: string;
    isNew?: boolean;
    updatedAt: number;
};

const agentStreamSnapshots = new Map<string, AgentStreamSnapshot>();

export function getAgentStreamSnapshot(domainId: string, recordId: string): AgentStreamSnapshot | undefined {
    const snapshot = agentStreamSnapshots.get(`${domainId}:${recordId}`);
    if (!snapshot) return undefined;
    // Streaming snapshots are only a live-subscription catch-up aid; avoid replaying stale completed content forever.
    if (Date.now() - snapshot.updatedAt > 5 * 60 * 1000) {
        agentStreamSnapshots.delete(`${domainId}:${recordId}`);
        return undefined;
    }
    return snapshot;
}

const WORKER_PROTOCOL = 'ejunz-worker-v1';
const DEFAULT_TASK_TYPES = ['agent_task', 'tool_call', 'mcp_tool_call'];

type EjunzWorkerTaskType = 'agent_task' | 'tool_call' | 'mcp_tool_call';

type WorkerMeta = {
    workerId: string;
    workerName: string;
    workerLabel: string;
    workerKind: string;
    workerVersion: string;
};

function toObjectId(value: unknown): ObjectId | null {
    if (value instanceof ObjectId) return value;
    if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value);
    return null;
}

function normalizeDate(value: unknown): Date {
    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d;
    }
    return new Date();
}

function taskWithoutId(t: Task): Omit<Task, '_id'> & { type: string } {
    const { _id, ...rest } = t as any;
    return rest;
}

function taskTypeFromDbTask(t: Task): EjunzWorkerTaskType | null {
    if (t.type === 'task') return 'agent_task';
    if (t.type === 'tool_call') return 'tool_call';
    if (t.type === 'mcp' && (t as any).subType === 'tool_call') return 'mcp_tool_call';
    return null;
}

function buildTaskQuery(taskTypes: string[], minPriority?: number) {
    const clauses: any[] = [];
    if (taskTypes.includes('agent_task')) clauses.push({ type: 'task' });
    if (taskTypes.includes('tool_call')) clauses.push({ type: 'tool_call' });
    if (taskTypes.includes('mcp_tool_call')) clauses.push({ type: 'mcp', subType: 'tool_call' });
    const query: any = clauses.length === 1 ? { ...clauses[0] } : { $or: clauses.length ? clauses : [{ type: '__never__' }] };
    if (Number.isFinite(minPriority)) query.priority = { $gt: minPriority };
    return query;
}

function cleanTaskTypes(taskTypes: unknown): string[] {
    if (!(taskTypes instanceof Array)) return DEFAULT_TASK_TYPES.slice();
    const allowed = new Set(DEFAULT_TASK_TYPES);
    const out = taskTypes.map((i) => String(i)).filter((i) => allowed.has(i));
    return out.length ? out : DEFAULT_TASK_TYPES.slice();
}

abstract class EjunzTaskCallbackContext {
    private resolve: (_: any) => void;
    protected finishPromise: Promise<any>;
    protected operationPromise = Promise.resolve(null);
    protected completed = false;

    constructor(
        public ctx: Context,
        public readonly dbTask: Task,
        public readonly taskType: EjunzWorkerTaskType,
        private readonly metaProvider: (taskType: EjunzWorkerTaskType) => WorkerMeta,
    ) {
        this.finishPromise = new Promise((resolve) => {
            this.resolve = resolve;
        });
    }

    get taskId() {
        return this.dbTask._id?.toString?.() || String(this.dbTask._id || '');
    }

    protected workerMeta() {
        return this.metaProvider(this.taskType);
    }

    protected finish(value: any = null) {
        if (this.completed) return;
        this.completed = true;
        this.resolve(value);
    }

    enqueue(op: () => Promise<void>) {
        this.operationPromise = this.operationPromise.then(op);
        return this.operationPromise;
    }

    abstract start(): Promise<void>;
    abstract accepted(body?: any): Promise<void>;
    abstract complete(body?: any): Promise<void>;
    abstract error(body?: any): Promise<void>;
    abstract reset(): Promise<void>;

    summary() {
        return {
            taskId: this.taskId,
            taskType: this.taskType,
            recordId: (this.dbTask as any).recordId?.toString?.(),
            toolName: (this.dbTask as any).toolName || (this.dbTask as any).name,
        };
    }

    then(onfulfilled?: (value: any) => void, onrejected?: (reason: any) => void) {
        return this.finishPromise.then(onfulfilled, onrejected);
    }
}

class AgentTaskCallbackContext extends EjunzTaskCallbackContext {
    private get domainId() {
        return (this.dbTask as any).domainId as string;
    }

    private get recordId() {
        return toObjectId((this.dbTask as any).recordId);
    }

    private withWorkerMeta(message: Partial<AgentRecordMessage>): AgentRecordMessage {
        const meta = this.workerMeta();
        return {
            role: message.role || 'assistant',
            content: message.content || '',
            timestamp: normalizeDate(message.timestamp),
            ...message,
            ...meta,
        } as AgentRecordMessage;
    }

    async start() {
        const rid = this.recordId;
        if (!rid) return;
        await RecordModel.updateAgentTask(this.domainId, rid, {
            status: STATUS.STATUS_TASK_FETCHED,
            ...this.workerMeta(),
        });
        await RecordModel.updateAgentTask(this.domainId, rid, {
            status: STATUS.STATUS_TASK_PROCESSING,
            ...this.workerMeta(),
        });
    }

    async accepted() {
        const rid = this.recordId;
        if (!rid) return;
        await RecordModel.updateAgentTask(this.domainId, rid, {
            status: STATUS.STATUS_TASK_PROCESSING,
            ...this.workerMeta(),
        });
    }

    appendMessage(message: Partial<AgentRecordMessage>) {
        return this.enqueue(async () => {
            const rid = this.recordId;
            if (!rid) return;
            await RecordModel.updateAgentTask(this.domainId, rid, {
                agentMessages: [this.withWorkerMeta(message)],
                ...this.workerMeta(),
            });
        });
    }

    patchMessage(selector: { bubbleId?: string }, set: Record<string, any>) {
        return this.enqueue(async () => {
            const rid = this.recordId;
            if (!rid || !selector?.bubbleId) return;
            const rdoc = await RecordModel.get(this.domainId, rid);
            const messages = rdoc?.agentMessages || [];
            let index = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].bubbleId === selector.bubbleId) {
                    index = i;
                    break;
                }
            }
            if (index < 0) return;
            const $set: any = {};
            const allowed = new Set([
                'content', 'timestamp', 'bubbleState', 'contentHash', 'toolName',
                'toolResult', 'tool_call_id', 'tool_calls', 'bubbleId',
            ]);
            for (const [key, value] of Object.entries(set || {})) {
                if (!allowed.has(key)) continue;
                $set[`agentMessages.${index}.${key}`] = key === 'timestamp' ? normalizeDate(value) : value;
            }
            const meta = this.workerMeta();
            $set[`agentMessages.${index}.workerId`] = meta.workerId;
            $set[`agentMessages.${index}.workerName`] = meta.workerName;
            $set[`agentMessages.${index}.workerLabel`] = meta.workerLabel;
            $set[`agentMessages.${index}.workerKind`] = meta.workerKind;
            $set[`agentMessages.${index}.workerVersion`] = meta.workerVersion;
            await RecordModel.rawAgentUpdate(this.domainId, rid, $set);
        });
    }

    stream(body: any) {
        const rid = this.recordId;
        if (!rid) return;
        const recordId = rid.toString();
        const streamData = {
            recordId,
            domainId: this.domainId,
            ...body,
        };
        agentStreamSnapshots.set(`${this.domainId}:${recordId}`, {
            ...streamData,
            updatedAt: Date.now(),
        });
        bus.broadcast('bubble/stream' as any, streamData);
    }

    status(body: any) {
        return this.enqueue(async () => {
            const rid = this.recordId;
            if (!rid) return;
            await RecordModel.updateAgentTask(this.domainId, rid, {
                status: Number.isFinite(body?.status) ? Number(body.status) : undefined,
                score: Number.isFinite(body?.score) ? Number(body.score) : undefined,
                time: Number.isFinite(body?.time) ? Number(body.time) : undefined,
                agentToolCallCount: Number.isFinite(body?.agentToolCallCount) ? Number(body.agentToolCallCount) : undefined,
                ...this.workerMeta(),
            });
        });
    }

    toolResult(body: any) {
        return this.enqueue(async () => {
            const rid = this.recordId;
            if (!rid) return;
            const message = this.withWorkerMeta({
                role: 'tool',
                content: body?.content ?? JSON.stringify(body?.result ?? body?.error ?? null),
                toolName: body?.toolName,
                toolResult: body?.result,
                tool_call_id: body?.tool_call_id,
                timestamp: normalizeDate(body?.timestamp),
            });
            await RecordModel.updateAgentTask(this.domainId, rid, {
                agentToolCallCount: Number.isFinite(body?.agentToolCallCount) ? Number(body.agentToolCallCount) : undefined,
                agentMessages: [message],
                ...this.workerMeta(),
            });
        });
    }

    async complete(body: any = {}) {
        await this.enqueue(async () => {
            const rid = this.recordId;
            if (!rid) return;
            await RecordModel.updateAgentTask(this.domainId, rid, {
                status: STATUS.STATUS_TASK_PENDING,
                time: Number.isFinite(body?.time) ? Number(body.time) : undefined,
                agentToolCallCount: Number.isFinite(body?.agentToolCallCount) ? Number(body.agentToolCallCount) : undefined,
                ...this.workerMeta(),
            });
            await RecordModel.updateAgentTask(this.domainId, rid, {
                status: Number.isFinite(body?.status) ? Number(body.status) : STATUS.STATUS_TASK_DELIVERED,
                score: Number.isFinite(body?.score) ? Number(body.score) : 100,
                ...this.workerMeta(),
            });
            agentStreamSnapshots.delete(`${this.domainId}:${rid.toString()}`);
            (bus.broadcast as any)('task/agent-completed', {
                recordId: rid.toString(),
                domainId: this.domainId,
                taskId: this.taskId,
            });
        });
        this.finish(null);
    }

    async error(body: any = {}) {
        await this.enqueue(async () => {
            const rid = this.recordId;
            if (!rid) return;
            const err = body?.error || body;
            agentStreamSnapshots.delete(`${this.domainId}:${rid.toString()}`);
            await RecordModel.updateAgentTask(this.domainId, rid, {
                status: Number.isFinite(body?.status) ? Number(body.status) : STATUS.STATUS_TASK_ERROR_SYSTEM,
                score: Number.isFinite(body?.score) ? Number(body.score) : 0,
                time: Number.isFinite(body?.time) ? Number(body.time) : undefined,
                agentError: {
                    message: err?.message || String(err || 'Worker task failed'),
                    code: err?.code || 'WORKER_ERROR',
                    stack: err?.stack,
                },
                ...this.workerMeta(),
            });
        });
        this.finish(null);
    }

    async reset() {
        if (this.completed) return;
        await this.enqueue(async () => {
            const rid = this.recordId;
            if (rid) {
                await RecordModel.updateAgentTask(this.domainId, rid, {
                    status: STATUS.STATUS_TASK_WAITING,
                    agentError: {
                        message: 'Worker disconnected before completing this task; the task was requeued.',
                        code: 'WORKER_DISCONNECTED',
                    },
                    ...this.workerMeta(),
                });
            }
            await task.add(taskWithoutId(this.dbTask));
        });
        this.finish(null);
    }
}

class ToolCallTaskCallbackContext extends EjunzTaskCallbackContext {
    async start() {}

    async accepted() {}

    async complete(body: any = {}) {
        await this.enqueue(async () => {
            const result = body?.result !== undefined ? body.result : body?.data;
            (bus.broadcast as any)('toolcall/complete', this.dbTask._id, result);
        });
        this.finish(null);
    }

    async error(body: any = {}) {
        await this.enqueue(async () => {
            const err = body?.error || body;
            (bus.broadcast as any)('toolcall/complete', this.dbTask._id, {
                error: true,
                message: err?.message || String(err || 'Tool call failed'),
                code: err?.code || 'WORKER_TOOL_CALL_ERROR',
            });
        });
        this.finish(null);
    }

    async reset() {
        if (this.completed) return;
        await this.enqueue(async () => {
            await task.add(taskWithoutId(this.dbTask));
        });
        this.finish(null);
    }
}

class McpToolCallCallbackContext extends EjunzTaskCallbackContext {
    async start() {}

    async accepted() {}

    private deliver(response: any) {
        const sessionId = (this.dbTask as any).sessionId;
        if (!sessionId) return;
        const data = typeof response === 'string' ? response : JSON.stringify(response);
        (bus.broadcast as any)('mcp/deliver', { sessionId, data });
    }

    async complete(body: any = {}) {
        await this.enqueue(async () => {
            this.deliver(body?.data || body?.response || body?.result);
        });
        this.finish(null);
    }

    async error(body: any = {}) {
        await this.enqueue(async () => {
            const err = body?.error || body;
            this.deliver({
                jsonrpc: '2.0',
                id: (this.dbTask as any).rpcId,
                result: {
                    content: [{ type: 'text', text: err?.message || String(err || 'MCP tool call failed') }],
                    isError: true,
                },
            });
        });
        this.finish(null);
    }

    async reset() {
        if (this.completed) return;
        await this.enqueue(async () => {
            await task.add(taskWithoutId(this.dbTask));
        });
        this.finish(null);
    }
}

export class EjunzWorkerConnectionHandler extends ConnectionHandler {
    category = '#worker';
    taskTypes = DEFAULT_TASK_TYPES.slice();
    minPriority?: number;
    query: any = buildTaskQuery(this.taskTypes);
    concurrency = 1;
    consumer: Consumer = null;
    tasks: Record<string, EjunzTaskCallbackContext> = {};
    workerId = '';
    workerName = '';
    workerLabel = '';
    workerVersion = '';
    workerSourceId = '';
    processWorkerId = '';
    heartbeatTimer?: ReturnType<typeof setInterval>;
    statusRegistered = false;
    reqCount = 0;
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

    private workerMeta(taskType: EjunzWorkerTaskType): WorkerMeta {
        return {
            workerId: this.workerId,
            workerName: this.workerName,
            workerLabel: this.workerLabel || this.workerName,
            workerKind: taskType,
            workerVersion: this.workerVersion,
        };
    }

    private activeTaskSummaries() {
        return Object.values(this.tasks).map((cb) => cb.summary()).slice(0, 20);
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
            consuming: !!this.consumer?.consuming,
            concurrency: this.concurrency,
            processingCount: Object.keys(this.tasks).length,
            activeTasks: this.activeTaskSummaries(),
            reqCount: this.reqCount,
            startedAt: this.startedAt,
            status: 'online',
            ...extra,
        });
    }

    @subscribe('system/setting')
    sendServerConfig() {
        this.send({ key: 'server_config', language: setting.langs });
    }

    private refreshQuery() {
        this.query = buildTaskQuery(this.taskTypes, this.minPriority);
        this.consumer?.setQuery(this.query);
    }

    private createCallbackContext(t: Task, taskType: EjunzWorkerTaskType) {
        if (taskType === 'agent_task') return new AgentTaskCallbackContext(this.ctx, t, taskType, this.workerMeta.bind(this));
        if (taskType === 'tool_call') return new ToolCallTaskCallbackContext(this.ctx, t, taskType, this.workerMeta.bind(this));
        return new McpToolCallCallbackContext(this.ctx, t, taskType, this.workerMeta.bind(this));
    }

    async newTask(t: Task) {
        const taskType = taskTypeFromDbTask(t);
        if (!taskType) {
            logger.warn('Ignoring unsupported worker task type: %o', { taskId: t._id?.toString?.(), type: t.type, subType: (t as any).subType });
            return;
        }
        const taskId = t._id.toString();
        const cb = this.createCallbackContext(t, taskType);
        this.tasks[taskId] = cb;
        try {
            await cb.start();
            await this.updateWorkerStatus({ lastTaskAt: new Date() });
            this.send({ key: 'task', taskId, taskType, payload: t });
            await cb;
            this.reqCount++;
        } finally {
            delete this.tasks[taskId];
            await this.updateWorkerStatus({ lastTaskAt: new Date() });
        }
    }

    async message(raw: any) {
        const msg = typeof raw === 'string' && raw !== 'ping' ? JSON.parse(raw) : raw;
        if (msg === 'ping' || msg?.key === 'ping') {
            this.send('pong' as any);
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (!['status', 'agent.stream'].includes(msg.key)) logger.info('Worker message: %s task=%s', msg.key, msg.taskId || '');

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
            if (Number.isSafeInteger(msg.concurrency) && msg.concurrency > 0) {
                this.concurrency = msg.concurrency;
                this.consumer?.setConcurrency(msg.concurrency);
            }
            if (Number.isFinite(msg.minPriority)) {
                this.minPriority = Number(msg.minPriority);
                this.refreshQuery();
            }
            this.taskTypes = cleanTaskTypes(msg.taskTypes);
            this.refreshQuery();
            this.statusRegistered = true;
            await this.updateWorkerStatus({
                status: 'online',
                taskTypes: this.taskTypes,
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
                taskTypes: this.taskTypes,
                host: msg.host || status.host,
                pid: msg.pid || status.pid,
            });
            return;
        }

        if (msg.key === 'start') {
            if (this.consumer) throw new BadRequestError('Worker daemon already started');
            this.consumer = task.consume(
                this.query,
                this.newTask.bind(this),
                false,
                this.concurrency,
                () => isWorkerPaused(this.workerId),
            );
            await this.updateWorkerStatus({ status: 'online' });
            logger.info('Ejunz worker started: workerId=%s concurrency=%d taskTypes=%o', this.workerId, this.concurrency, this.taskTypes);
            return;
        }

        const cb = this.tasks[msg.taskId];
        if (!cb) {
            logger.warn('Worker message for unknown task: key=%s taskId=%s', msg.key, msg.taskId);
            return;
        }

        if (msg.key === 'task.accepted') await cb.accepted(msg);
        else if (msg.key === 'agent.status' && cb instanceof AgentTaskCallbackContext) await cb.status(msg);
        else if (msg.key === 'agent.stream' && cb instanceof AgentTaskCallbackContext) cb.stream(msg);
        else if (msg.key === 'agent.message.append' && cb instanceof AgentTaskCallbackContext) await cb.appendMessage(msg.message || msg);
        else if (msg.key === 'agent.message.patch' && cb instanceof AgentTaskCallbackContext) await cb.patchMessage(msg.selector || { bubbleId: msg.bubbleId }, msg.set || msg.message || {});
        else if (msg.key === 'agent.tool_result' && cb instanceof AgentTaskCallbackContext) await cb.toolResult(msg);
        else if (msg.key === 'task.complete') await cb.complete(msg);
        else if (msg.key === 'task.error') await cb.error(msg);
        else if (msg.key === 'tool_call.complete') await cb.complete(msg);
        else if (msg.key === 'tool_call.error') await cb.error(msg);
        else if (msg.key === 'mcp_tool_call.complete') await cb.complete(msg);
        else if (msg.key === 'mcp_tool_call.error') await cb.error(msg);
    }

    async cleanup() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.consumer?.destroy();
        if (this.statusRegistered) await markWorkerOffline(this.workerId);
        logger.info('Ejunz worker disconnected from %s', this.request.ip);
        await Promise.all(Object.values(this.tasks).map((cb) => cb.reset().catch((e) => logger.error(e))));
    }
}

export async function callToolViaWorker(
    ctx: Context,
    toolName: string,
    args: any,
    domainId: string,
    agentId?: string,
    uid?: number,
    taskRecordId?: ObjectId,
    priority: number = 0,
    toolContext: {
        baseDocId?: number;
        baseBranch?: string;
        owner?: number;
        toolType?: string;
        token?: string;
        mcpId?: number;
    } = {},
): Promise<any> {
    const taskId = await task.add({
        type: 'tool_call',
        taskRecordId,
        toolName,
        args: toolName === 'schedule_create' && agentId && !(args || {}).agentId
            ? { ...(args || {}), __agentId: agentId }
            : args,
        domainId,
        agentId,
        uid,
        baseDocId: toolContext.baseDocId,
        baseBranch: toolContext.baseBranch,
        owner: toolContext.owner,
        toolType: toolContext.toolType,
        token: toolContext.token,
        mcpId: toolContext.mcpId,
        priority,
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            dispose();
            const err = new Error(`Tool call timeout: ${toolName}`);
            (err as any).code = 'TIMEOUT';
            reject(err);
        }, 30000);

        const handler = (completedTaskId: ObjectId, result: any) => {
            if (completedTaskId.toString() === taskId.toString()) {
                clearTimeout(timeout);
                dispose();
                if (result?.error) {
                    const err = new Error(result.message || 'Tool call failed');
                    (err as any).code = result.code || 'WORKER_TOOL_CALL_ERROR';
                    reject(err);
                } else resolve(result);
            }
        };
        const dispose = (bus as any).on('toolcall/complete', handler);
    });
}

export class ToolCallInternalHandler extends Handler {
    noCheckPermView = true;
    notUsage = true;

    @post('toolName', Types.String, true)
    @post('args', Types.Any, true)
    @post('baseDocId', Types.Int, true)
    @post('baseBranch', Types.String, true)
    @post('owner', Types.Int, true)
    @post('toolType', Types.String, true)
    @post('token', Types.String, true)
    @post('mcpId', Types.Int, true)
    async post(domainId: string, toolName: string, args: any, baseDocId?: number, baseBranch?: string, owner?: number, toolType?: string, token?: string, mcpId?: number) {
        const mcpClient = new (require('../model/agent').McpClient)();
        try {
            const callArgs = toolType === 'plugin_mcp' && mcpId ? { ...(args || {}), __mcpId: mcpId } : args;
            logger.info(
                'Internal worker tool call: tool=%s type=%s hasToken=%s baseDocId=%s baseBranch=%s owner=%s mcpId=%s',
                toolName, toolType || '', !!token, baseDocId || '', baseBranch || '', owner || '', mcpId || '',
            );
            const result = await mcpClient.callTool(toolName, callArgs, domainId, undefined, token, toolType, baseDocId, baseBranch, owner);
            this.response.body = { result };
        } catch (error: any) {
            this.response.body = {
                error: {
                    message: error.message || String(error),
                    code: error.code || 'UNKNOWN_ERROR',
                },
            };
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Connection('worker_conn', '/worker/conn', EjunzWorkerConnectionHandler, builtin.PRIV.PRIV_WORKER);
    ctx.Route('toolcall_internal', '/toolcall/internal', ToolCallInternalHandler, builtin.PRIV.PRIV_WORKER);
}

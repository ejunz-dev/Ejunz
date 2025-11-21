import { omit } from 'lodash';
import { ObjectId } from 'mongodb';
import {
    JudgeResultBody, TestCase,
} from '@ejunz/common';
import { Context } from '../context';
import {
    BadRequestError, ValidationError,
} from '../error';
import { RecordDoc, Task } from '../interface';
import { Logger } from '../logger';
import * as builtin from '../model/builtin';
import { STATUS } from '../model/builtin';
import record from '../model/record';
import * as setting from '../model/setting';
import task, { Consumer } from '../model/task';
import bus from '../service/bus';
import {
    ConnectionHandler, Handler, post, subscribe, Types,
} from '../service/server';

const logger = new Logger('worker');

function parseCaseResult(body: TestCase): Required<TestCase> {
    return {
        ...body,
        id: body.id || 0,
        subtaskId: body.subtaskId || 0,
        score: body.score || 0,
        message: body.message || '',
    };
}

function processPayload(body: Partial<JudgeResultBody>) {
    const $set: Partial<RecordDoc> = {};
    const $push: any = {};
    const $unset: any = {};
    const $inc: any = {};
    if (body.cases?.length) {
        const c = body.cases.map(parseCaseResult);
        $push.testCases = { $each: c };
    } else if (body.case) {
        const c = parseCaseResult(body.case);
        $push.testCases = c;
    }
    if (body.message) {
        $push.judgeTexts = body.message;
    }
    if (body.compilerText) {
        $push.compilerTexts = body.compilerText;
    }
    if (body.status) $set.status = body.status;
    if (Number.isFinite(body.score)) $set.score = Math.floor(body.score * 100) / 100;
    if (Number.isFinite(body.time)) $set.time = body.time;
    if (Number.isFinite(body.memory)) $set.memory = body.memory;
    if (body.progress !== undefined) $set.progress = body.progress;
    if (body.subtasks) $set.subtasks = body.subtasks;
    if (body.addProgress) $inc.progress = body.addProgress;
    return {
        $set, $push, $unset, $inc,
    };
}

export class WorkerResultCallbackContext {
    private resolve: (_: any) => void;
    private finishPromise: Promise<any>;
    private operationPromise = Promise.resolve(null);
    private relatedId = new ObjectId();
    private meta: any;

    constructor(public ctx: Context, public readonly task: Omit<Task, '_id'> & { type: string }) { // eslint-disable-line ts/no-shadow
        this.meta = task.meta || {};
        this.finishPromise = new Promise((resolve) => {
            this.resolve = resolve;
        });
    }

    async _next(body: Partial<JudgeResultBody>) {
        const {
            $set, $push, $unset, $inc,
        } = processPayload(body);
        if (this.meta?.rejudge === 'controlled') {
            await record.collHistory.updateOne({
                _id: this.relatedId,
            }, {
                $set, $push, $unset, $inc,
            }, { upsert: true });
        } else {
            const rdoc = await record.update(this.task.domainId, new ObjectId(this.task.rid as string), $set, $push, $unset, $inc);
            if (rdoc) this.ctx.broadcast('record/change', rdoc, $set, $push, body);
        }
    }

    static async next(domainId: string, rid: ObjectId, body: Partial<JudgeResultBody>) {
        const {
            $set, $push, $unset, $inc,
        } = processPayload(body);
        const rdoc = await record.update(domainId, rid, $set, $push, $unset, $inc);
        if (rdoc) bus.broadcast('record/change', rdoc, $set, $push, body);
    }

    next(body: Partial<JudgeResultBody>) {
        this.operationPromise = this.operationPromise.then(() => this._next(body));
        return this.operationPromise;
    }

    static async postWorker(rdoc: RecordDoc, context?: WorkerResultCallbackContext) {
        // Worker 完成后的处理逻辑
        await bus.broadcast('record/worker', rdoc, true, null, context);
    }

    async _end(body: Partial<JudgeResultBody>) {
        const { $set, $push } = processPayload(body);
        const $unset: any = { progress: '' };
        $set.judgeAt = new Date();
        $set.judger = body.judger ?? 1;

        if (this.meta?.rejudge === 'controlled') {
            await record.collHistory.updateOne({
                _id: this.relatedId,
            }, {
                $set, $push, $unset,
            }, { upsert: true });
            this.resolve(null);
            return;
        }

        const rdoc = await record.update(this.task.domainId, new ObjectId(this.task.rid as string), $set, $push, $unset);
        if (rdoc) {
            bus.broadcast('record/change', rdoc, null, null, body); // trigger a full update
            await WorkerResultCallbackContext.postWorker(rdoc, this);
        }
        this.resolve(rdoc);
    }

    static async end(domainId: string, rid: ObjectId, body: Partial<JudgeResultBody>) {
        const { $set, $push } = processPayload(body);
        const $unset: any = { progress: '' };
        $set.judgeAt = new Date();
        $set.judger = body.judger ?? 1;
        const rdoc = await record.update(domainId, rid, $set, $push, $unset);
        if (rdoc) {
            bus.broadcast('record/change', rdoc, null, null, body); // trigger a full update
            await WorkerResultCallbackContext.postWorker(rdoc);
        }
    }

    end(body?: Partial<JudgeResultBody>) {
        if (!body) this.resolve(null);
        else this.operationPromise = this.operationPromise.then(() => this._end(body));
        return this.operationPromise;
    }

    reset() {
        return this.operationPromise.then(async () => {
            const rdoc = await record.reset(this.task.domainId, this.task.rid, false);
            this.ctx.broadcast('record/change', rdoc);
            return task.add(this.task);
        });
    }

    then(onfulfilled?: (value: any) => void, onrejected?: (reason: any) => void) {
        return this.finishPromise.then(onfulfilled, onrejected);
    }
}

/** @deprecated use WorkerResultCallbackContext.postWorker instead */
export const postWorker = (rdoc: RecordDoc) => WorkerResultCallbackContext.postWorker(rdoc);

export class WorkerConnectionHandler extends ConnectionHandler {
    category = '#worker';
    query: any = { type: { $in: ['worker', 'generate'] } };
    concurrency = 1;
    consumer: Consumer = null;
    tasks: Record<string, WorkerResultCallbackContext> = {};

    async prepare() {
        logger.info('Worker daemon connected from ', this.request.ip);
        this.sendLanguageConfig();
    }

    @subscribe('system/setting')
    sendLanguageConfig() {
        this.send({ language: setting.langs });
    }

    async newTask(t: Task) {
        const rid = t.rid.toHexString();
        this.tasks[rid] = new WorkerResultCallbackContext(this.ctx, t);
        this.send({ task: t });
        this.tasks[rid].next({ status: STATUS.STATUS_TASK_FETCHED });
        await this.tasks[rid];
        delete this.tasks[rid];
    }

    async message(msg) {
        if (!['ping', 'prio', 'config', 'start'].includes(msg.key)) {
            const method = ['status', 'next'].includes(msg.key) ? 'debug' : 'info';
            const keys = method === 'debug' ? ['key'] : ['key', 'subtasks', 'cases'];
            logger[method]('%o', omit(msg, keys));
        }
        if (['next', 'end'].includes(msg.key)) {
            const t = this.tasks[msg.rid];
            if (!t) return;
            if (msg.key === 'next') t.next(msg);
            if (msg.key === 'end') t.end(msg.nop ? undefined : { judger: this.user._id, ...msg });
        } else if (msg.key === 'status') {
        } else if (msg.key === 'config') {
            if (Number.isSafeInteger(msg.prio)) {
                this.query.priority = { $gt: msg.prio };
                this.consumer?.setQuery(this.query);
            }
            if (Number.isSafeInteger(msg.concurrency) && msg.concurrency > 0) {
                this.concurrency = msg.concurrency;
                this.consumer?.setConcurrency(msg.concurrency);
            }
            if (msg.lang instanceof Array && msg.lang.every((i) => typeof i === 'string')) {
                this.query.lang = { $in: msg.lang };
                this.consumer?.setQuery(this.query);
            }
            if (msg.type instanceof Array && msg.type.every((i) => typeof i === 'string')) {
                this.query.type = { $in: msg.type };
                this.consumer?.setQuery(this.query);
            }
        } else if (msg.key === 'start') {
            if (this.consumer) throw new BadRequestError('Worker daemon already started');
            this.consumer = task.consume(this.query, this.newTask.bind(this), true, this.concurrency);
            logger.info('Worker daemon started');
        }
    }

    async cleanup() {
        this.consumer?.destroy();
        logger.info('Worker daemon disconnected from ', this.request.ip);
        await Promise.all(Object.values(this.tasks).map((cb) => cb.reset()));
    }
}

export class ToolCallResultCallbackContext {
    private resolve: (_: any) => void;
    private finishPromise: Promise<any>;
    private operationPromise = Promise.resolve(null);
    private result: any = null;

    constructor(public ctx: Context, public readonly task: Omit<Task, '_id'> & { type: string; taskRecordId?: ObjectId }) {
        this.finishPromise = new Promise((resolve) => {
            this.resolve = resolve;
        });
    }

    async _next(body: { result?: any; error?: any; status?: string }) {
        // 工具调用中间结果可以通过 next 传递
        if (body.result !== undefined) {
            this.result = body.result;
        }
        if (body.error !== undefined) {
            this.result = { error: true, ...body.error };
        }
    }

    next(body: { result?: any; error?: any; status?: string }) {
        this.operationPromise = this.operationPromise.then(() => this._next(body));
        return this.operationPromise;
    }

    async _end(body?: { result?: any; error?: any; status?: string }) {
        // 工具调用完成，返回结果
        const result = body?.result || body?.error || this.result || null;
        this.resolve(result);
        // 发送完成事件
        bus.broadcast('toolcall/complete', this.task._id, result);
    }

    end(body?: { result?: any; error?: any; status?: string }) {
        if (!body) this.resolve(this.result);
        else this.operationPromise = this.operationPromise.then(() => this._end(body));
        return this.operationPromise;
    }

    reset() {
        return this.operationPromise.then(async () => {
            // 重新添加任务
            return task.add(this.task);
        });
    }

    then(onfulfilled?: (value: any) => void, onrejected?: (reason: any) => void) {
        return this.finishPromise.then(onfulfilled, onrejected);
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
): Promise<any> {
    // 创建任务
    const taskId = await task.add({
        type: 'tool_call',
        taskRecordId,
        toolName,
        args,
        domainId,
        priority,
    });
    
    // 等待 worker 处理并返回结果
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            dispose();
            reject(new Error(`Tool call timeout: ${toolName}`));
        }, 30000);
        
        // 通过事件总线监听任务完成
        const handler = (completedTaskId: ObjectId, result: any) => {
            if (completedTaskId.toString() === taskId.toString()) {
                clearTimeout(timeout);
                dispose();
                if (result?.error) {
                    reject(new Error(result.message || 'Tool call failed'));
                } else {
                    resolve(result);
                }
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
    @post('domainId', Types.String, true)
    async post(domainId: string, toolName: string, args: any) {
        const mcpClient = new (require('../model/agent').McpClient)();
        try {
            const result = await mcpClient.callTool(toolName, args, domainId);
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
    ctx.Connection('worker_conn', '/worker/conn', WorkerConnectionHandler, builtin.PRIV.PRIV_JUDGE);
    ctx.Route('toolcall_internal', '/toolcall/internal', ToolCallInternalHandler, builtin.PRIV.PRIV_JUDGE);
}

/** @deprecated use WorkerResultCallbackContext.next instead */
export const next = (payload: any) => WorkerResultCallbackContext.next(payload.domainId, payload.rid, payload);
/** @deprecated use WorkerResultCallbackContext.end instead */
export const end = (payload: any) => WorkerResultCallbackContext.end(payload.domainId, payload.rid, payload);
/** @deprecated use WorkerResultCallbackContext.next instead */
apply.next = next;
/** @deprecated use WorkerResultCallbackContext.end instead */
apply.end = end;
/* eslint-disable no-await-in-loop */
import { createHash, randomUUID } from 'crypto';
import { hostname } from 'os';
import { ObjectId } from 'mongodb';
import { STATUS } from '@ejunz/common';
import type { Context as EjunzContext } from 'ejun';
import type { AgentRecordMessage } from 'ejun/src/model/record';
import superagent from 'superagent';
import logger from '../log';
import { getConfig } from '../config';
import { ToolCallTaskHandler } from '../toolcall';

export interface WorkerTaskReporter {
    accepted(data?: any): Promise<void>;
    status(data?: any): Promise<void>;
    stream(data?: any): Promise<void>;
    appendMessage(message: any): Promise<void>;
    patchMessage(selector: any, set: any): Promise<void>;
    toolResult(data?: any): Promise<void>;
    complete(data?: any): Promise<void>;
    error(error: any): Promise<void>;
}

function registerSystemToolsIfAvailable() {
    try {
        const { getLocalSystemToolCatalog, executeLocalSystemTool } = require('ejun/src/lib/localSystemTools');
        const { registerSystemToolCatalog, registerSystemToolExecutor } = require('ejun/src/lib/systemTools');
        const catalog = getLocalSystemToolCatalog();
        registerSystemToolCatalog(catalog);
        registerSystemToolExecutor(executeLocalSystemTool);
        logger.info('Core System Tools registered for worker (count=%d)', catalog.length);
    } catch (e: any) {
        logger.warn('Core System Tools not registered in worker: %s', e?.message || e);
    }
}

function normalizeToolParameters(raw: any) {
    const parameters = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    if (parameters.type !== 'object') parameters.type = 'object';
    if (!parameters.properties || typeof parameters.properties !== 'object' || Array.isArray(parameters.properties)) {
        parameters.properties = {};
    }
    if (!Array.isArray(parameters.required)) parameters.required = [];
    return parameters;
}

function toolsToApiFormat(tools: any[]) {
    return (tools || []).map((tool: any) => ({
        type: 'function',
        function: {
            name: tool.modelName || tool.name || '',
            description: tool.description || '',
            parameters: normalizeToolParameters(tool.inputSchema),
        },
    })).filter((tool: any) => tool.function.name);
}

function safeStringify(value: any, fallback: string = ''): string {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function normalizeContent(content: any): string {
    return safeStringify(content);
}

function messageSize(msg: any): number {
    if (!msg) return 0;
    let total = normalizeContent(msg.content).length;
    if (msg.tool_call_id) total += String(msg.tool_call_id).length;
    if (Array.isArray(msg.tool_calls)) total += safeStringify(msg.tool_calls).length;
    return total;
}

function normalizeToolCalls(toolCalls: any[]): any[] {
    return (toolCalls || []).map((tc: any) => {
        const id = String(tc?.id || '').trim();
        const name = String(tc?.function?.name || tc?.name || '').trim();
        const args = typeof tc?.function?.arguments === 'string'
            ? tc.function.arguments
            : typeof tc?.arguments === 'string'
                ? tc.arguments
                : safeStringify(tc?.arguments ?? tc?.function?.arguments ?? {}, '{}');
        if (!id || !name) return null;
        return {
            id,
            type: 'function',
            function: { name, arguments: args || '{}' },
        };
    }).filter(Boolean);
}

function groupMessagesForTruncation(messages: any[]): any[][] {
    const groups: any[][] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            const callIds = new Set(normalizeToolCalls(msg.tool_calls).map((tc: any) => tc.id));
            const group = [msg];
            let j = i + 1;
            while (j < messages.length && messages[j]?.role === 'tool') {
                const toolCallId = String(messages[j]?.tool_call_id || '');
                if (callIds.has(toolCallId)) group.push(messages[j]);
                j++;
            }
            groups.push(group);
            i = j - 1;
            continue;
        }
        groups.push([msg]);
    }
    return groups;
}

function truncateMessages(messages: any[], maxMessages: number = 20, maxChars: number = 8000): any[] {
    const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
    const otherMessages = systemMsg ? messages.slice(1) : messages;
    const groups = groupMessagesForTruncation(otherMessages);
    const selectedGroups: any[][] = [];
    let totalChars = systemMsg ? messageSize(systemMsg) : 0;
    let totalMessages = systemMsg ? 1 : 0;

    for (let i = groups.length - 1; i >= 0; i--) {
        const group = groups[i];
        const groupChars = group.reduce((sum, msg) => sum + messageSize(msg), 0);
        const groupMessages = group.length;
        const wouldExceedChars = totalChars + groupChars > maxChars;
        const wouldExceedMessages = totalMessages + groupMessages > maxMessages + (systemMsg ? 1 : 0);
        if ((wouldExceedChars || wouldExceedMessages) && selectedGroups.length > 0) break;
        selectedGroups.push(group);
        totalChars += groupChars;
        totalMessages += groupMessages;
    }

    const truncated = selectedGroups.reverse().flat();
    return systemMsg ? [systemMsg, ...truncated] : truncated;
}

function normalizeMessages(messages: any[]): any[] {
    const normalized: any[] = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg?.role) continue;

        if (msg.role === 'tool') continue;

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            const calls = normalizeToolCalls(msg.tool_calls);
            if (!calls.length) {
                const content = normalizeContent(msg.content);
                if (content) normalized.push({ role: 'assistant', content });
                continue;
            }

            const callIds = new Set(calls.map((tc: any) => tc.id));
            const seenToolIds = new Set<string>();
            const toolMessages: any[] = [];
            let j = i + 1;
            while (j < messages.length && messages[j]?.role === 'tool') {
                const toolMsg = messages[j];
                const toolCallId = String(toolMsg.tool_call_id || '');
                if (callIds.has(toolCallId) && !seenToolIds.has(toolCallId)) {
                    toolMessages.push({
                        role: 'tool',
                        content: normalizeContent(toolMsg.content),
                        tool_call_id: toolCallId,
                    });
                    seenToolIds.add(toolCallId);
                }
                j++;
            }

            const matchedCalls = calls.filter((tc: any) => seenToolIds.has(tc.id));
            if (matchedCalls.length) {
                normalized.push({
                    role: 'assistant',
                    content: normalizeContent(msg.content),
                    tool_calls: matchedCalls,
                });
                for (const toolMsg of toolMessages) {
                    if (matchedCalls.some((tc: any) => tc.id === toolMsg.tool_call_id)) normalized.push(toolMsg);
                }
            } else {
                const content = normalizeContent(msg.content);
                if (content) normalized.push({ role: 'assistant', content });
            }
            i = j - 1;
            continue;
        }

        if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
            normalized.push({ role: msg.role, content: normalizeContent(msg.content) });
        }
    }

    return normalized;
}

function messageOutline(messages: any[]) {
    return (messages || []).map((msg: any, index: number) => ({
        index,
        role: msg?.role,
        contentLength: normalizeContent(msg?.content).length,
        toolCallIds: Array.isArray(msg?.tool_calls) ? msg.tool_calls.map((tc: any) => tc?.id).filter(Boolean) : undefined,
        tool_call_id: msg?.tool_call_id,
    }));
}

function findExecutionTool(executionTools: any[], toolName: string): any | undefined {
    return (executionTools || []).find((tool) => tool?.name === toolName || tool?.modelName === toolName);
}

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

function getMcpClient() {
    return require('ejun/src/model/agent').McpClient;
}

function getRecordModel() {
    return require('ejun/src/model/record').default;
}

function getTaskModel() {
    return require('ejun/src/model/task').default;
}

function getWorkerStatusModel() {
    return require('ejun/src/model/workerStatus');
}

async function executeToolViaServer(config: any, task: any, executionTool: any, modelToolName: string, args: any) {
    const callTask = {
        domainId: task.domainId,
        toolName: executionTool?.name || modelToolName,
        args: executionTool?.type === 'plugin_mcp' && executionTool?.mcpId
            ? { ...(args || {}), __mcpId: executionTool.mcpId }
            : (modelToolName === 'schedule_create' && task.agentId && !(args || {}).agentId
                ? { ...(args || {}), __agentId: task.agentId }
                : (args || {})),
        baseDocId: task.context?.baseDocId,
        baseBranch: task.context?.baseBranch,
        owner: task.context?.owner || task.uid,
        toolType: executionTool?.type,
        token: executionTool?.token,
        mcpId: executionTool?.mcpId,
    };
    if (!config.server_url) {
        const McpClient = getMcpClient();
        const mcpClient = new McpClient();
        const result = await mcpClient.callTool(
            callTask.toolName,
            callTask.args,
            callTask.domainId,
            undefined,
            callTask.token,
            callTask.toolType,
            callTask.baseDocId,
            callTask.baseBranch,
            callTask.owner,
        );
        return result;
    }
    const handler = new ToolCallTaskHandler(config.server_url, config.cookie, config.token);
    let final: any = null;
    await handler.handle(callTask, async () => {}, async (data) => { final = data; });
    if (final?.error) throw Object.assign(new Error(final.error.message || 'Tool call failed'), final.error);
    return final?.result;
}

async function executeAgentTask(task: any, reporter: WorkerTaskReporter, config: any) {
    const { domainId, agentId, uid, message, history, context = {}, workflowConfig, _id: taskId } = task;
    if (!context.apiKey || !context.systemMessage || !context.apiUrl) throw new Error('Task missing required agent context');

    await reporter.accepted();
    await reporter.status({ status: STATUS.STATUS_TASK_PROCESSING });

    const startTime = Date.now();
    let chatHistory: any[] = [];
    try {
        chatHistory = typeof history === 'string' ? JSON.parse(history) : history || [];
    } catch (e) {
        logger.warn('Failed to parse history: %s', (e as Error).message);
    }

    const executionTools = Array.isArray(context.toolsForModel)
        ? context.toolsForModel
        : Array.isArray(context.tools) ? context.tools : [];
    let messagesForTurn = truncateMessages([
        ...chatHistory,
        { role: 'user', content: message },
    ]);
    const requestBody: any = {
        model: context.model || 'deepseek-chat',
        max_tokens: context.max_tokens || 1024,
        messages: [
            { role: 'system', content: context.systemMessage },
            ...normalizeMessages(messagesForTurn),
        ],
        stream: true,
    };
    if (executionTools.length) {
        requestBody.tools = toolsToApiFormat(executionTools);
        requestBody.tool_choice = 'auto';
        requestBody.parallel_tool_calls = false;
    }

    let toolCallCount = 0;
    let score = 100;
    let errorStatus: number | undefined;
    let hasStartedAssistantBubble = false;

    for (let iterations = 0; iterations < 10; iterations++) {
        let currentBubbleId: string | null = null;
        let accumulatedContent = '';
        let finishReason = '';
        let toolCalls: any[] = [];

        logger.info('Agent task model request outline', {
            recordId: taskId?.toString?.() || taskId,
            iteration: iterations,
            messageCount: requestBody.messages.length,
            messages: messageOutline(requestBody.messages),
        });

        await new Promise<void>((resolve, reject) => {
            const req = superagent.post(context.apiUrl)
                .set('Authorization', `Bearer ${context.apiKey}`)
                .set('content-type', 'application/json')
                .buffer(false)
                .send(requestBody)
                .timeout(120000)
                .parse((res, callback) => {
                    let responseStatus = res.status || 200;
                    res.setEncoding('utf8');
                    let buffer = '';
                    let rawResponse = '';

                    res.on('data', (chunk: string) => {
                        rawResponse += chunk;
                        buffer += chunk;
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            if (!line.trim() || !line.startsWith('data: ')) continue;
                            const data = line.slice(6).trim();
                            if (data === '[DONE]') continue;
                            if (!data) continue;
                            try {
                                const parsed = JSON.parse(data);
                                if (parsed.error) {
                                    reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                                    return;
                                }
                                const choice = parsed.choices?.[0];
                                const delta = choice?.delta;
                                if (delta?.content) {
                                    accumulatedContent += delta.content;
                                    if (!currentBubbleId) {
                                        currentBubbleId = !hasStartedAssistantBubble && context.assistantbubbleId
                                            ? context.assistantbubbleId
                                            : randomUUID();
                                        hasStartedAssistantBubble = true;
                                        const contentHash = createHash('md5').update('').digest('hex').substring(0, 16);
                                        reporter.stream({ bubbleId: currentBubbleId, content: '', isNew: true });
                                        reporter.appendMessage({
                                            role: 'assistant',
                                            content: '',
                                            timestamp: new Date(),
                                            bubbleId: currentBubbleId,
                                            bubbleState: 'streaming',
                                            contentHash,
                                        }).catch((e) => logger.warn('append assistant message failed: %s', e?.message || e));
                                    }
                                    reporter.stream({ bubbleId: currentBubbleId, content: accumulatedContent, isNew: false });
                                }
                                if (choice?.finish_reason) finishReason = choice.finish_reason;
                                if (delta?.tool_calls) {
                                    for (const toolCall of delta.tool_calls || []) {
                                        const idx = toolCall.index || 0;
                                        if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                        if (toolCall.id) toolCalls[idx].id = toolCall.id;
                                        if (toolCall.function?.name) toolCalls[idx].function.name = toolCall.function.name;
                                        if (toolCall.function?.arguments) toolCalls[idx].function.arguments += toolCall.function.arguments;
                                    }
                                }
                            } catch (e) {
                                logger.warn('Parse error in stream: %s', (e as Error).message);
                            }
                        }
                    });

                    res.on('end', () => {
                        if (responseStatus >= 400 && !accumulatedContent && !toolCalls.length && !finishReason) {
                            let errorMessage = `API request failed with status ${responseStatus}`;
                            let errorCode = 'API_BAD_RESPONSE';
                            const responseText = rawResponse.trim();
                            if (responseText) {
                                try {
                                    const parsed = JSON.parse(responseText);
                                    const parsedError = parsed?.error || parsed;
                                    errorMessage = parsedError?.message || parsed?.message || responseText;
                                    errorCode = parsedError?.code || parsed?.code || errorCode;
                                } catch {
                                    errorMessage = responseText;
                                }
                            }
                            const err: any = new Error(errorMessage);
                            err.status = responseStatus;
                            err.code = errorCode;
                            err.responseBody = responseText;
                            err.requestOutline = messageOutline(requestBody.messages);
                            callback(err, undefined);
                            reject(err);
                        } else {
                            callback(null, undefined);
                            resolve();
                        }
                    });
                    res.on('error', reject);
                });
            req.on('error', (err: any) => {
                err.requestOutline = err.requestOutline || messageOutline(requestBody.messages);
                reject(err);
            });
            req.end((err: any) => {
                if (!err) return;
                const responseBody = err?.response?.text || (err?.response?.body ? safeStringify(err.response.body) : '');
                if (responseBody) {
                    err.responseBody = responseBody;
                    try {
                        const parsed = JSON.parse(responseBody);
                        const parsedError = parsed?.error || parsed;
                        err.message = parsedError?.message || parsed?.message || err.message;
                        err.code = parsedError?.code || parsed?.code || err.code;
                    } catch {
                        err.message = responseBody || err.message;
                    }
                }
                err.status = err.status || err?.response?.status;
                err.requestOutline = err.requestOutline || messageOutline(requestBody.messages);
                reject(err);
            });
        });

        if (accumulatedContent && currentBubbleId) {
            const contentHash = createHash('md5').update(accumulatedContent || '').digest('hex').substring(0, 16);
            await reporter.patchMessage({ bubbleId: currentBubbleId }, {
                content: accumulatedContent,
                timestamp: new Date(),
                contentHash,
                bubbleState: 'completed',
            });
        }

        if (finishReason === 'tool_calls' && toolCalls.length > 0) {
            const toolCall = toolCalls[0];
            const toolCallId = toolCall.id || `call_${toolCallCount + 1}`;
            const persistedToolCalls = [{
                id: toolCallId,
                type: 'function',
                function: {
                    name: toolCall.function.name,
                    arguments: toolCall.function.arguments,
                },
            }];
            if (currentBubbleId) {
                await reporter.patchMessage({ bubbleId: currentBubbleId }, {
                    tool_calls: persistedToolCalls,
                    bubbleState: 'completed',
                });
            } else {
                currentBubbleId = !hasStartedAssistantBubble && context.assistantbubbleId
                    ? context.assistantbubbleId
                    : randomUUID();
                hasStartedAssistantBubble = true;
                const contentHash = createHash('md5').update('').digest('hex').substring(0, 16);
                await reporter.appendMessage({
                    role: 'assistant',
                    content: '',
                    timestamp: new Date(),
                    bubbleId: currentBubbleId,
                    bubbleState: 'completed',
                    contentHash,
                    tool_calls: persistedToolCalls,
                });
            }
            const toolName = toolCall.function?.name || '';
            const executionTool = findExecutionTool(executionTools, toolName);
            let toolArgs: any = {};
            try {
                toolArgs = JSON.parse(toolCall.function?.arguments || '{}');
            } catch {
                toolArgs = {};
            }

            toolCallCount++;
            let toolResult: any;
            try {
                toolResult = await executeToolViaServer(config, task, executionTool, toolName, toolArgs);
                if (toolResult === false || (typeof toolResult === 'object' && toolResult !== null && toolResult.success === false)) {
                    score = Math.max(0, score - 20);
                }
            } catch (e: any) {
                score = Math.max(0, score - 40);
                errorStatus = STATUS.STATUS_TASK_ERROR_SYSTEM;
                toolResult = {
                    error: true,
                    message: e?.message || String(e),
                    code: e?.code || 'UNKNOWN_ERROR',
                };
            }

            await reporter.toolResult({
                agentToolCallCount: toolCallCount,
                toolName,
                result: toolResult,
                content: JSON.stringify(toolResult),
                tool_call_id: toolCallId,
            });

            const assistantMsg = {
                role: 'assistant',
                content: accumulatedContent || null,
                tool_calls: [{
                    id: toolCallId,
                    type: 'function',
                    function: {
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments,
                    },
                }],
            };
            const toolMsg = { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: toolCallId };
            messagesForTurn = truncateMessages([
                ...messagesForTurn,
                assistantMsg,
                toolMsg,
            ]);
            requestBody.messages = [{ role: 'system', content: context.systemMessage }, ...normalizeMessages(messagesForTurn)];
            continue;
        }

        await reporter.complete({
            status: errorStatus || undefined,
            score,
            time: Date.now() - startTime,
            agentToolCallCount: toolCallCount,
            domainId,
            agentId,
            uid,
            taskId: taskId?.toString?.() || taskId,
            workflowConfig,
        });
        return;
    }

    throw new Error('Agent task exceeded maximum tool-call iterations');
}

async function executeToolCallTask(task: any, reporter: WorkerTaskReporter, config: any) {
    await reporter.accepted();
    if (!config.server_url) {
        const McpClient = getMcpClient();
        const mcpClient = new McpClient();
        try {
            await reporter.status({ status: 'running', toolName: task.toolName || task.name });
            const result = await mcpClient.callTool(
                task.toolName || task.name,
                task.args || {},
                task.domainId,
                undefined,
                task.token,
                task.toolType,
                task.baseDocId,
                task.baseBranch,
                task.owner,
            );
            await reporter.complete({ result });
        } catch (e: any) {
            await reporter.error({ message: e?.message || String(e), code: e?.code || 'WORKER_TOOL_CALL_ERROR', stack: e?.stack });
        }
        return;
    }
    const handler = new ToolCallTaskHandler(config.server_url, config.cookie, config.token);
    await handler.handle(
        task,
        async (data) => reporter.status(data),
        async (data) => {
            if (data?.error) await reporter.error(data.error);
            else await reporter.complete({ result: data?.result });
        },
    );
}

async function executeMcpToolCallTask(task: any, reporter: WorkerTaskReporter) {
    await reporter.accepted();
    let response: any;
    try {
        registerSystemToolsIfAvailable();
        const { executeSystemTool } = require('ejun/src/lib/systemTools');
        const result = await executeSystemTool(task.name, task.args || {});
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        response = {
            jsonrpc: '2.0',
            id: task.rpcId,
            result: { content: [{ type: 'text', text }], isError: false },
        };
    } catch (e: any) {
        response = {
            jsonrpc: '2.0',
            id: task.rpcId,
            result: { content: [{ type: 'text', text: e?.message || String(e) }], isError: true },
        };
    }
    await reporter.complete({ response });
}

export async function executeWorkerTask(taskType: string, task: any, reporter: WorkerTaskReporter, config: any = {}) {
    if (taskType === 'agent_task') return executeAgentTask(task, reporter, config);
    if (taskType === 'tool_call') return executeToolCallTask(task, reporter, config);
    if (taskType === 'mcp_tool_call') return executeMcpToolCallTask(task, reporter);
    throw new Error(`Unsupported worker task type: ${taskType}`);
}

type BuiltinWorkerMeta = {
    workerId: string;
    workerName: string;
    workerLabel: string;
    workerKind: string;
    workerVersion: string;
};

function taskTypeFromDbTask(t: any) {
    if (t.type === 'task') return 'agent_task';
    if (t.type === 'tool_call') return 'tool_call';
    if (t.type === 'mcp' && t.subType === 'tool_call') return 'mcp_tool_call';
    return null;
}

function builtinWorkerVersion() {
    return process.env.EJUNZ_WORKER_VERSION || (() => {
        try {
            return require('../../package.json').version;
        } catch {
            return 'unknown';
        }
    })();
}

let allocatedBuiltinWorkerId = '';

function configuredBuiltinWorkerSourceId() {
    return process.env.EJUNZ_WORKER_ID || getConfig('workerId') || '';
}

async function allocateBuiltinWorkerId(workerStatusModel: any, workerSourceId: string) {
    return workerStatusModel.allocateWorkerId('builtin', workerSourceId);
}

function builtinWorkerId() {
    return allocatedBuiltinWorkerId || '1';
}

function builtinWorkerMeta(taskType: string): BuiltinWorkerMeta {
    const workerId = builtinWorkerId();
    const workerLabel = process.env.EJUNZ_WORKER_LABEL || getConfig('workerLabel') || 'Builtin';
    return {
        workerId,
        workerName: workerLabel,
        workerLabel,
        workerKind: taskType,
        workerVersion: process.env.EJUNZ_WORKER_VERSION || getConfig('workerVersion') || builtinWorkerVersion(),
    };
}

function withWorkerMeta(message: Partial<AgentRecordMessage>, meta: BuiltinWorkerMeta): AgentRecordMessage {
    return {
        role: message.role || 'assistant',
        content: message.content || '',
        timestamp: normalizeDate(message.timestamp),
        ...message,
        ...meta,
    } as AgentRecordMessage;
}

function createBuiltinReporter(ctx: EjunzContext, dbTask: any, taskType: string, meta: BuiltinWorkerMeta): WorkerTaskReporter {
    const RecordModel = getRecordModel();
    const taskId = dbTask._id?.toString?.() || String(dbTask._id || '');
    const domainId = dbTask.domainId;
    const recordId = toObjectId(dbTask.recordId);
    const enqueue = (() => {
        let operation = Promise.resolve(null as any);
        return (op: () => Promise<void>) => {
            operation = operation.then(op);
            return operation;
        };
    })();
    const patchMessage = (selector: { bubbleId?: string }, set: Record<string, any>) => enqueue(async () => {
        if (!recordId || !selector?.bubbleId) return;
        const rdoc = await RecordModel.get(domainId, recordId);
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
        $set[`agentMessages.${index}.workerId`] = meta.workerId;
        $set[`agentMessages.${index}.workerName`] = meta.workerName;
        $set[`agentMessages.${index}.workerLabel`] = meta.workerLabel;
        $set[`agentMessages.${index}.workerKind`] = meta.workerKind;
        $set[`agentMessages.${index}.workerVersion`] = meta.workerVersion;
        await RecordModel.rawAgentUpdate(domainId, recordId, $set);
    });
    return {
        accepted: async () => {
            if (taskType !== 'agent_task' || !recordId) return;
            await RecordModel.updateAgentTask(domainId, recordId, {
                status: STATUS.STATUS_TASK_PROCESSING,
                ...meta,
            });
        },
        status: async (data?: any) => {
            if (taskType !== 'agent_task' || !recordId) return;
            await RecordModel.updateAgentTask(domainId, recordId, {
                status: Number.isFinite(data?.status) ? Number(data.status) : undefined,
                score: Number.isFinite(data?.score) ? Number(data.score) : undefined,
                time: Number.isFinite(data?.time) ? Number(data.time) : undefined,
                agentToolCallCount: Number.isFinite(data?.agentToolCallCount) ? Number(data.agentToolCallCount) : undefined,
                ...meta,
            });
        },
        stream: async (data?: any) => {
            if (taskType !== 'agent_task' || !recordId) return;
            (ctx.broadcast as any)('bubble/stream', {
                recordId: recordId.toString(),
                domainId,
                ...data,
            });
        },
        appendMessage: (message: any) => enqueue(async () => {
            if (taskType !== 'agent_task' || !recordId) return;
            await RecordModel.updateAgentTask(domainId, recordId, {
                agentMessages: [withWorkerMeta(message, meta)],
                ...meta,
            });
        }),
        patchMessage,
        toolResult: (data?: any) => enqueue(async () => {
            if (taskType !== 'agent_task' || !recordId) return;
            await RecordModel.updateAgentTask(domainId, recordId, {
                agentToolCallCount: Number.isFinite(data?.agentToolCallCount) ? Number(data.agentToolCallCount) : undefined,
                agentMessages: [withWorkerMeta({
                    role: 'tool',
                    content: data?.content ?? JSON.stringify(data?.result ?? data?.error ?? null),
                    toolName: data?.toolName,
                    toolResult: data?.result,
                    tool_call_id: data?.tool_call_id,
                    timestamp: normalizeDate(data?.timestamp),
                }, meta)],
                ...meta,
            });
        }),
        complete: async (data?: any) => {
            if (taskType === 'tool_call') {
                (ctx.broadcast as any)('toolcall/complete', dbTask._id, data?.result ?? data?.data);
                return;
            }
            if (taskType === 'mcp_tool_call') {
                const sessionId = dbTask.sessionId;
                if (!sessionId) return;
                const response = data?.data || data?.response || data?.result;
                (ctx.broadcast as any)('mcp/deliver', { sessionId, data: typeof response === 'string' ? response : JSON.stringify(response) });
                return;
            }
            if (!recordId) return;
            await RecordModel.updateAgentTask(domainId, recordId, {
                status: STATUS.STATUS_TASK_PENDING,
                time: Number.isFinite(data?.time) ? Number(data.time) : undefined,
                agentToolCallCount: Number.isFinite(data?.agentToolCallCount) ? Number(data.agentToolCallCount) : undefined,
                ...meta,
            });
            await RecordModel.updateAgentTask(domainId, recordId, {
                status: Number.isFinite(data?.status) ? Number(data.status) : STATUS.STATUS_TASK_DELIVERED,
                score: Number.isFinite(data?.score) ? Number(data.score) : 100,
                ...meta,
            });
            (ctx.broadcast as any)('task/agent-completed', {
                recordId: recordId.toString(),
                domainId,
                taskId,
            });
        },
        error: async (error: any) => {
            if (taskType === 'tool_call') {
                const err = error?.error || error;
                (ctx.broadcast as any)('toolcall/complete', dbTask._id, {
                    error: true,
                    message: err?.message || String(err || 'Tool call failed'),
                    code: err?.code || 'WORKER_TOOL_CALL_ERROR',
                });
                return;
            }
            if (taskType === 'mcp_tool_call') {
                const sessionId = dbTask.sessionId;
                if (!sessionId) return;
                const err = error?.error || error;
                (ctx.broadcast as any)('mcp/deliver', {
                    sessionId,
                    data: JSON.stringify({
                        jsonrpc: '2.0',
                        id: dbTask.rpcId,
                        result: {
                            content: [{ type: 'text', text: err?.message || String(err || 'MCP tool call failed') }],
                            isError: true,
                        },
                    }),
                });
                return;
            }
            if (!recordId) return;
            const err = error?.error || error;
            await RecordModel.updateAgentTask(domainId, recordId, {
                status: Number.isFinite(error?.status) ? Number(error.status) : STATUS.STATUS_TASK_ERROR_SYSTEM,
                score: Number.isFinite(error?.score) ? Number(error.score) : 0,
                time: Number.isFinite(error?.time) ? Number(error.time) : undefined,
                agentError: {
                    message: err?.message || String(err || 'Worker task failed'),
                    code: err?.code || 'WORKER_ERROR',
                    stack: err?.stack,
                    status: err?.status,
                    responseBody: err?.responseBody,
                    requestOutline: err?.requestOutline,
                },
                ...meta,
            });
        },
    };
}

export async function apply(ctx: EjunzContext) {
    registerSystemToolsIfAvailable();
    if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') return;

    const TaskModel = getTaskModel();
    const RecordModel = getRecordModel();
    const workerStatusModel = getWorkerStatusModel();
    const { coll: workerStatusColl, isWorkerPaused, removeWorkerStatus, upsertWorkerStatus } = workerStatusModel;
    const workerHost = hostname();
    const workerSourceId = configuredBuiltinWorkerSourceId() || `builtin:${workerHost}:${process.env.NODE_APP_INSTANCE || '0'}`;
    allocatedBuiltinWorkerId = await allocateBuiltinWorkerId(workerStatusModel, workerSourceId);
    const workerId = builtinWorkerId();
    const concurrency = getConfig('toolcallConcurrency') || 10;
    const activeTasks = new Map<string, any>();
    let reqCount = 0;
    const startedAt = new Date();
    let consumer: any;

    const updateStatus = async () => upsertWorkerStatus({
        workerId,
        workerSourceId,
        processWorkerId: workerId,
        workerName: process.env.EJUNZ_WORKER_LABEL || getConfig('workerLabel') || 'Builtin',
        workerLabel: process.env.EJUNZ_WORKER_LABEL || getConfig('workerLabel') || 'Builtin',
        workerKind: 'builtin',
        workerVersion: process.env.EJUNZ_WORKER_VERSION || getConfig('workerVersion') || builtinWorkerVersion(),
        host: workerHost,
        pid: process.pid,
        nodeAppInstance: process.env.NODE_APP_INSTANCE,
        consuming: !!consumer?.consuming,
        concurrency,
        processingCount: activeTasks.size,
        activeTasks: Array.from(activeTasks.values()).slice(0, 20),
        reqCount,
        startedAt,
        status: 'online',
    });

    const handleTask = async (t: any) => {
        const taskType = taskTypeFromDbTask(t);
        if (!taskType) return;
        const meta = builtinWorkerMeta(taskType);
        const taskId = t._id?.toString?.() || String(t._id || '');
        activeTasks.set(taskId, {
            taskId,
            taskType,
            recordId: t.recordId?.toString?.() || t.recordId,
            toolName: t.toolName || t.name,
            startedAt: new Date(),
        });
        await updateStatus();
        const reporter = createBuiltinReporter(ctx, t, taskType, meta);
        try {
            if (taskType === 'agent_task' && t.recordId) {
                const recordId = toObjectId(t.recordId);
                if (recordId) await RecordModel.updateAgentTask(t.domainId, recordId, {
                    status: STATUS.STATUS_TASK_FETCHED,
                    ...meta,
                });
            }
            await executeWorkerTask(taskType, t, reporter, {});
        } catch (e: any) {
            logger.error('Builtin worker task failed: taskType=%s taskId=%s', taskType, taskId);
            logger.error(e?.stack || e?.message || e);
            await reporter.error(e);
        } finally {
            activeTasks.delete(taskId);
            reqCount++;
            await updateStatus();
        }
    };

    await workerStatusColl.deleteMany({
        type: 'worker',
        workerKind: 'builtin',
        host: workerHost,
        nodeAppInstance: process.env.NODE_APP_INSTANCE,
        workerSourceId: { $ne: workerSourceId },
    });

    consumer = TaskModel.consume(
        { $or: [{ type: 'task' }, { type: 'tool_call' }, { type: 'mcp', subType: 'tool_call' }] },
        handleTask,
        false,
        concurrency,
        () => isWorkerPaused(workerId),
    );
    await updateStatus();
    const statusTimer = setInterval(() => updateStatus().catch(() => {}), 10000);
    logger.info('Ejunz builtin worker consumer started (concurrency=%d)', concurrency);
    return () => {
        clearInterval(statusTimer);
        consumer?.destroy?.();
        removeWorkerStatus(workerId).catch(() => {});
    };
}

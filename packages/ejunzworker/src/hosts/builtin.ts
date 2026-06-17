/* eslint-disable no-await-in-loop */
import { createHash, randomUUID } from 'crypto';
import { STATUS } from '@ejunz/common';
import superagent from 'superagent';
import logger from '../log';
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

function truncateMessages(messages: any[], maxMessages: number = 20, maxChars: number = 8000): any[] {
    if (messages.length <= maxMessages) {
        const totalChars = messages.reduce((sum, msg) => sum + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')).length, 0);
        if (totalChars <= maxChars) return messages;
    }

    const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
    const otherMessages = systemMsg ? messages.slice(1) : messages;
    const finalMessages: any[] = systemMsg ? [systemMsg] : [];
    let totalChars = systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content.length : JSON.stringify(systemMsg.content || '').length) : 0;

    for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
        totalChars += msgStr.length;
        if (totalChars > maxChars && finalMessages.length > (systemMsg ? 1 : 0)) break;
        finalMessages.push(msg);
        if (finalMessages.length > maxMessages + (systemMsg ? 1 : 0)) {
            if (systemMsg && finalMessages.length > maxMessages + 1) finalMessages.splice(1, 1);
            else if (!systemMsg && finalMessages.length > maxMessages) finalMessages.shift();
        }
    }

    return systemMsg ? [systemMsg, ...finalMessages.slice(1).reverse()] : finalMessages.reverse();
}

function normalizeMessages(messages: any[]): any[] {
    const normalized: any[] = [];
    const usedToolCallIds = new Set<string>();
    let lastAssistantToolCallIds: string[] = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const normalizedMsg: any = { role: msg.role, content: msg.content || '' };

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            lastAssistantToolCallIds = [];
            normalizedMsg.tool_calls = msg.tool_calls.map((tc: any) => {
                const toolCallId = tc.id || '';
                const toolCallName = tc.function?.name || tc.name || '';
                const toolCallArgs = typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments
                    : typeof tc.arguments === 'string'
                        ? tc.arguments
                        : JSON.stringify(tc.arguments || tc.function?.arguments || {});
                if (toolCallId) lastAssistantToolCallIds.push(toolCallId);
                return {
                    id: toolCallId,
                    type: 'function',
                    function: { name: toolCallName, arguments: toolCallArgs },
                };
            });
        }

        if (msg.role === 'tool') {
            let toolCallId: string | null = msg.tool_call_id || null;
            if (!toolCallId && lastAssistantToolCallIds.length > 0) toolCallId = lastAssistantToolCallIds[0];
            if (!toolCallId || usedToolCallIds.has(toolCallId)) continue;
            normalizedMsg.tool_call_id = toolCallId;
            usedToolCallIds.add(toolCallId);
            const index = lastAssistantToolCallIds.indexOf(toolCallId);
            if (index > -1) lastAssistantToolCallIds.splice(index, 1);
        }

        normalized.push(normalizedMsg);
    }

    return normalized;
}

function findExecutionTool(executionTools: any[], toolName: string): any | undefined {
    return (executionTools || []).find((tool) => tool?.name === toolName || tool?.modelName === toolName);
}

async function executeToolViaServer(config: any, task: any, executionTool: any, modelToolName: string, args: any) {
    const handler = new ToolCallTaskHandler(config.server_url, config.cookie, config.token);
    const callTask = {
        domainId: task.domainId,
        toolName: executionTool?.name || modelToolName,
        args: executionTool?.type === 'plugin_mcp' && executionTool?.mcpId
            ? { ...(args || {}), __mcpId: executionTool.mcpId }
            : (args || {}),
        baseDocId: task.context?.baseDocId,
        baseBranch: task.context?.baseBranch,
        owner: task.context?.owner || task.uid,
        toolType: executionTool?.type,
        token: executionTool?.token,
        mcpId: executionTool?.mcpId,
    };
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
    const requestBody: any = {
        model: context.model || 'deepseek-chat',
        max_tokens: context.max_tokens || 1024,
        messages: [
            { role: 'system', content: context.systemMessage },
            ...normalizeMessages(truncateMessages(chatHistory)),
            { role: 'user', content: message },
        ],
        stream: true,
    };
    if (executionTools.length) {
        requestBody.tools = toolsToApiFormat(executionTools);
        requestBody.tool_choice = 'auto';
        requestBody.parallel_tool_calls = false;
    }

    let messagesForTurn = truncateMessages(chatHistory);
    let toolCallCount = 0;
    let score = 100;
    let errorStatus: number | undefined;

    for (let iterations = 0; iterations < 10; iterations++) {
        let currentBubbleId: string | null = null;
        let accumulatedContent = '';
        let finishReason = '';
        let toolCalls: any[] = [];

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

                    res.on('data', (chunk: string) => {
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
                                        currentBubbleId = context.assistantbubbleId || randomUUID();
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
                            const err = new Error(`API request failed with status ${responseStatus}`);
                            callback(err, undefined);
                            reject(err);
                        } else {
                            callback(null, undefined);
                            resolve();
                        }
                    });
                    res.on('error', reject);
                });
            req.on('error', reject);
            req.end((err) => { if (err) reject(err); });
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
                tool_call_id: toolCall.id,
            });

            const assistantMsg = {
                role: 'assistant',
                content: accumulatedContent || null,
                tool_calls: [{
                    id: toolCall.id,
                    type: 'function',
                    function: {
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments,
                    },
                }],
            };
            const toolMsg = { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: toolCall.id };
            messagesForTurn = truncateMessages([
                ...messagesForTurn,
                { role: 'user', content: message },
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
    const handler = new ToolCallTaskHandler(config.server_url, config.cookie, config.token);
    await reporter.accepted();
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

export async function apply() {
    registerSystemToolsIfAvailable();
    logger.info('Ejunz worker plugin loaded; standalone task consumption is handled by /worker/conn WebSocket clients.');
}

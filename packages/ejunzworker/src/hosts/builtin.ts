// Ejunz Integration
/* eslint-disable no-await-in-loop */
import {
    Context as EjunzContext,
    TaskModel,
} from 'ejun';
import { McpClient } from 'ejun/src/model/agent';
import RecordModel from 'ejun/src/model/record';
import { getConfig } from '../config';
import logger from '../log';
import superagent from 'superagent';

export async function apply(ctx: EjunzContext) {
    ctx.effect(() => {
        const handleTask = async (t: any) => {
            const { recordId, domainId, agentId, uid, message, history, context, workflowConfig, _id: taskId } = t;
            logger.info('Processing task: agentId=%s, message=%s (taskId: %s)', agentId, message?.substring(0, 50), taskId?.toString());
            
            const startTime = Date.now();
            const STATUS = require('ejun/src/model/builtin').STATUS;
            
            try {
                await RecordModel.updateTask(domainId, recordId, {
                    status: STATUS.STATUS_TASK_FETCHED,
                });
                
                if (!context || !context.apiKey || !context.systemMessage) {
                    throw new Error('Task missing required context information');
                }
                
                await RecordModel.updateTask(domainId, recordId, {
                    status: STATUS.STATUS_TASK_PROCESSING,
                });
                
                let chatHistory: any[] = [];
                try {
                    chatHistory = typeof history === 'string' ? JSON.parse(history) : history || [];
                } catch (e) {
                    logger.warn('Failed to parse history:', e);
                }
                
                const { processAgentChatInternal } = require('ejun/src/handler/agent');
                
                const adoc = {
                    domainId,
                    aid: agentId,
                    content: context.agentContent || '',
                    memory: context.agentMemory || '',
                    mcpToolIds: [],
                    repoIds: [],
                };
                
                const request = require('superagent');
                const { McpClient } = require('ejun/src/model/agent');
                const mcpClient = new McpClient();
                
                const truncateMessages = (messages: any[], maxMessages: number = 20, maxChars: number = 8000): any[] => {
                    if (messages.length <= maxMessages) {
                        let totalChars = 0;
                        for (const msg of messages) {
                            const msgStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
                            totalChars += msgStr.length;
                        }
                        if (totalChars <= maxChars) {
                            return messages;
                        }
                    }
                    
                    const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
                    const otherMessages = systemMsg ? messages.slice(1) : messages;
                    
                    let totalChars = systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content.length : JSON.stringify(systemMsg.content || '').length) : 0;
                    const finalMessages: any[] = systemMsg ? [systemMsg] : [];
                    
                    for (let i = otherMessages.length - 1; i >= 0; i--) {
                        const msg = otherMessages[i];
                        const msgStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
                        totalChars += msgStr.length;
                        if (totalChars > maxChars && finalMessages.length > (systemMsg ? 1 : 0)) {
                            break;
                        }
                        finalMessages.push(msg);
                        if (finalMessages.length > maxMessages + (systemMsg ? 1 : 0)) {
                            if (systemMsg && finalMessages.length > maxMessages + 1) {
                                finalMessages.splice(1, 1);
                            } else if (!systemMsg && finalMessages.length > maxMessages) {
                                finalMessages.shift();
                            }
                        }
                    }
                    
                    if (systemMsg) {
                        return [systemMsg, ...finalMessages.slice(1).reverse()];
                    } else {
                        return finalMessages.reverse();
                    }
                };
                
                let limitedHistory = truncateMessages(chatHistory);
                
                // 清理和规范化历史消息格式，确保符合 API 要求
                const normalizeMessages = (messages: any[]): any[] => {
                    const normalized: any[] = [];
                    const usedToolCallIds = new Set<string>(); // 跟踪已使用的 tool_call_id
                    let lastAssistantToolCallIds: string[] = []; // 跟踪最近的 assistant 消息的所有 tool_call ids
                    
                    for (let i = 0; i < messages.length; i++) {
                        const msg = messages[i];
                        const normalizedMsg: any = {
                            role: msg.role,
                            content: msg.content || '',
                        };
                        
                        // 处理 assistant 消息的 tool_calls
                        if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
                            lastAssistantToolCallIds = []; // 重置，因为这是新的 assistant 消息
                            normalizedMsg.tool_calls = msg.tool_calls.map((tc: any) => {
                                let toolCallId = '';
                                let toolCallName = '';
                                let toolCallArgs = '';
                                
                                if (typeof tc === 'object' && tc.function) {
                                    // 已经是正确格式
                                    toolCallId = tc.id || '';
                                    toolCallName = tc.function.name || '';
                                    toolCallArgs = typeof tc.function.arguments === 'string' 
                                        ? tc.function.arguments 
                                        : JSON.stringify(tc.function.arguments || {});
                                } else if (typeof tc === 'object') {
                                    // 可能是简化的格式，需要转换
                                    toolCallId = tc.id || '';
                                    toolCallName = tc.name || tc.function?.name || '';
                                    toolCallArgs = typeof tc.arguments === 'string'
                                        ? tc.arguments
                                        : JSON.stringify(tc.arguments || tc.function?.arguments || {});
                                }
                                
                                // 保存所有 tool_call 的 id
                                if (toolCallId) {
                                    lastAssistantToolCallIds.push(toolCallId);
                                }
                                
                                return {
                                    id: toolCallId,
                                    type: 'function',
                                    function: {
                                        name: toolCallName,
                                        arguments: toolCallArgs,
                                    },
                                };
                            });
                        }
                        
                        // 处理 tool 角色的消息，确保有 tool_call_id 且不重复
                        if (msg.role === 'tool') {
                            let toolCallId: string | null = null;
                            
                            // 优先使用消息中的 tool_call_id
                            if (msg.tool_call_id) {
                                toolCallId = msg.tool_call_id;
                            } else if (lastAssistantToolCallIds.length > 0) {
                                // 如果没有，使用前一条 assistant 消息的第一个 tool_call id
                                toolCallId = lastAssistantToolCallIds[0];
                            } else {
                                // 如果都没有，尝试从前面查找最近的 assistant 消息的 tool_call id
                                for (let j = i - 1; j >= 0; j--) {
                                    const prevMsg = messages[j];
                                    if (prevMsg.role === 'assistant' && prevMsg.tool_calls && Array.isArray(prevMsg.tool_calls) && prevMsg.tool_calls.length > 0) {
                                        const firstToolCall = prevMsg.tool_calls[0];
                                        if (firstToolCall && firstToolCall.id) {
                                            toolCallId = firstToolCall.id;
                                            break;
                                        }
                                    }
                                }
                            }
                            
                            // 检查是否已经使用过这个 tool_call_id（去重）
                            if (toolCallId && usedToolCallIds.has(toolCallId)) {
                                logger.warn('Duplicate tool message detected for tool_call_id: %s, skipping', toolCallId);
                                continue; // 跳过重复的 tool 消息
                            }
                            
                            if (toolCallId) {
                                normalizedMsg.tool_call_id = toolCallId;
                                usedToolCallIds.add(toolCallId);
                                // 从 lastAssistantToolCallIds 中移除已使用的 id
                                const index = lastAssistantToolCallIds.indexOf(toolCallId);
                                if (index > -1) {
                                    lastAssistantToolCallIds.splice(index, 1);
                                }
                            } else {
                                logger.warn('Tool message missing tool_call_id at index %d, skipping', i);
                                continue; // 跳过没有 tool_call_id 的 tool 消息
                            }
                        }
                        
                        normalized.push(normalizedMsg);
                    }
                    
                    return normalized;
                };
                
                const normalizedHistory = normalizeMessages(limitedHistory);
                
                // 验证消息格式
                for (const msg of normalizedHistory) {
                    if (msg.role === 'assistant' && msg.tool_calls) {
                        for (const tc of msg.tool_calls) {
                            if (!tc.id || !tc.function || !tc.function.name) {
                                logger.warn('Invalid tool_call format: %s', JSON.stringify(tc));
                            }
                        }
                    }
                }
                
                const requestBody: any = {
                    model: context.model || 'deepseek-chat',
                    max_tokens: 1024,
                    messages: [
                        { role: 'system', content: context.systemMessage },
                        ...normalizedHistory,
                        { role: 'user', content: message },
                    ],
                    stream: true,
                };
                
                if (context.tools && context.tools.length > 0) {
                    requestBody.tools = context.tools.map((tool: any) => {
                        let parameters = tool.inputSchema || {};
                        if (typeof parameters !== 'object' || Array.isArray(parameters)) {
                            parameters = {};
                        }
                        if (!parameters.type) {
                            parameters.type = 'object';
                        }
                        if (!parameters.properties) {
                            parameters.properties = {};
                        }
                        if (!parameters.required) {
                            parameters.required = [];
                        }
                        return {
                            type: 'function',
                            function: {
                                name: tool.name || '',
                                description: tool.description || '',
                                parameters,
                            },
                        };
                    });
                }
                
                const systemMessage = context.systemMessage || '';
                const logMsg = `\n========== [Agent API Request - Worker Process] ==========\n` +
                    `Domain: ${domainId}\n` +
                    `Agent ID: ${agentId}\n` +
                    `Model: ${requestBody.model}\n` +
                    `System Message Length: ${systemMessage.length} chars (~${Math.ceil(systemMessage.length / 4)} tokens)\n` +
                    `--- System Message Content ---\n` +
                    `${systemMessage}\n` +
                    `--- End System Message ---\n` +
                    `History Messages: ${normalizedHistory.length}\n` +
                    `User Message: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}\n` +
                    `Total Messages: ${requestBody.messages.length}\n` +
                    `Tools Count: ${requestBody.tools?.length || 0}\n` +
                    `=========================================\n`;
                
                console.log(logMsg);
                logger.info('[Agent API Request - Worker]', {
                    domainId,
                    agentId,
                    model: requestBody.model,
                    systemMessageLength: systemMessage.length,
                    estimatedTokens: Math.ceil(systemMessage.length / 4),
                    historyMessages: normalizedHistory.length,
                    totalMessages: requestBody.messages.length,
                    toolsCount: requestBody.tools?.length || 0,
                    userMessagePreview: message.substring(0, 100),
                    systemMessagePreview: systemMessage.substring(0, 200) + (systemMessage.length > 200 ? '...' : '')
                });
                
                if (normalizedHistory.length > 0) {
                }
                
                let iterations = 0;
                const maxIterations = 10;
                let messagesForTurn = limitedHistory;
                let accumulatedContent = '';
                let toolCallCount = 0;
                let hasToolError = false;
                let errorStatus: number | null = null;
                let score = 100;
                
                let lastUpdateTime = 0;
                const UPDATE_THROTTLE_MS = 200;
                
                const updateRecordContent = async (content: string, toolCalls?: any[]) => {
                    const now = Date.now();
                    if (now - lastUpdateTime < UPDATE_THROTTLE_MS && content.length > 0) {
                        return;
                    }
                    lastUpdateTime = now;

                    try {
                        const currentRecord = await RecordModel.get(domainId, recordId);
                        const currentMessages = (currentRecord as any)?.agentMessages || [];

                        // Find the last assistant message in the current record
                        // This is the message we should update (for streaming)
                        let assistantMessageIndex = -1;
                        for (let i = currentMessages.length - 1; i >= 0; i--) {
                            if (currentMessages[i].role === 'assistant') {
                                assistantMessageIndex = i;
                                break;
                            }
                        }
                        
                        if (assistantMessageIndex >= 0) {
                            const existingMessage = currentMessages[assistantMessageIndex];
                            const updateData: any = {
                                [`agentMessages.${assistantMessageIndex}.content`]: content,
                                [`agentMessages.${assistantMessageIndex}.timestamp`]: new Date(),
                            };
                            
                            // Ensure bubbleId exists (should always exist, but handle edge case)
                            if (!existingMessage.bubbleId) {
                                const { randomUUID } = require('crypto');
                                const newbubbleId = randomUUID();
                                updateData[`agentMessages.${assistantMessageIndex}.bubbleId`] = newbubbleId;
                                logger.warn('Existing assistant message missing bubbleId, generated new one:', newbubbleId);
                            }
                            
                            if (toolCalls) {
                                updateData[`agentMessages.${assistantMessageIndex}.tool_calls`] = toolCalls;
                            }
                            await RecordModel.update(domainId, recordId, updateData);
                        } else {
                            const { randomUUID } = require('crypto');
                            const bubbleIdToUse = randomUUID();
                            
                            const assistantMsg: any = {
                                role: 'assistant',
                                content: content || '',
                                timestamp: new Date(),
                                bubbleId: bubbleIdToUse,
                            };
                            if (toolCalls) {
                                assistantMsg.tool_calls = toolCalls;
                            }
                            await RecordModel.update(domainId, recordId, undefined, {
                                agentMessages: { $each: [assistantMsg] },
                            } as any);
                        }
                    } catch (e) {
                        logger.error('Error in updateRecordContent:', e);
                    }
                };
                
                while (iterations < maxIterations) {
                    iterations++;
                    
                    let finishReason = '';
                    let toolCalls: any[] = [];
                    let streamFinished = false;
                    let streamResolve: (() => void) | null = null;
                    let streamReject: ((err: any) => void) | null = null;
                    
                    await new Promise<void>((resolve, reject) => {
                        streamResolve = resolve;
                        streamReject = reject;
                        
                        const req = superagent.post(context.apiUrl)
                            .set('Authorization', `Bearer ${context.apiKey}`)
                            .set('content-type', 'application/json')
                            .buffer(false)
                            .send(requestBody)
                            .timeout(120000)
                            .parse((res, callback) => {
                                let responseStatus = res.status || 200;
                                
                                // 检查状态码，如果是错误状态码，记录但不立即失败
                                if (responseStatus >= 400) {
                                    logger.warn('API response status: %d, but continuing to process stream', responseStatus);
                                }
                                
                                res.setEncoding('utf8');
                                let buffer = '';
                                
                                res.on('data', (chunk: string) => {
                                    if (streamFinished) return;
                                    
                                    buffer += chunk;
                                    const lines = buffer.split('\n');
                                    buffer = lines.pop() || '';
                                    
                                    for (const line of lines) {
                                        if (!line.trim() || !line.startsWith('data: ')) continue;
                                        const data = line.slice(6).trim();
                                        if (data === '[DONE]') {
                                            streamFinished = true;
                                            continue;
                                        }
                                        if (!data) continue;
                                        
                                        try {
                                            const parsed = JSON.parse(data);
                                            
                                            // 检查是否有错误信息
                                            if (parsed.error) {
                                                logger.error('API error in stream: %s', JSON.stringify(parsed.error));
                                                streamFinished = true;
                                                const error = new Error(parsed.error.message || JSON.stringify(parsed.error));
                                                callback(error, undefined);
                                                if (streamReject) {
                                                    streamReject(error);
                                                } else {
                                                    reject(error);
                                                }
                                                return;
                                            }
                                            
                                            const choice = parsed.choices?.[0];
                                            const delta = choice?.delta;
                                            
                                            if (delta?.content) {
                                                accumulatedContent += delta.content;
                                                updateRecordContent(accumulatedContent, toolCalls.length > 0 ? toolCalls : undefined).catch(() => {});
                                                
                                                // 如果是 workflow task 且需要 TTS，流式发送 TTS
                                                if (workflowConfig && workflowConfig.returnType === 'tts' && workflowConfig.clientId) {
                                                    (async () => {
                                                        try {
                                                            const { ClientConnectionHandler } = require('ejun/src/handler/client');
                                                            const clientHandler = ClientConnectionHandler.getConnection(workflowConfig.clientId);
                                                            if (clientHandler) {
                                                                await clientHandler.addTtsText(delta.content).catch((error: any) => {
                                                                    logger.warn('addTtsText failed in workflow: %s', error.message);
                                                                });
                                                            }
                                                        } catch (e) {
                                                            logger.warn('Failed to send TTS in workflow: %s', (e as Error).message);
                                                        }
                                                    })();
                                                }
                                            }
                                            
                                            if (choice?.finish_reason) {
                                                finishReason = choice.finish_reason;
                                                // 不立即处理，等待流完全结束
                                            }
                                            
                                            if (delta?.tool_calls) {
                                                for (const toolCall of delta.tool_calls || []) {
                                                    const idx = toolCall.index || 0;
                                                    if (idx === 0) {
                                                        if (!toolCalls[0]) toolCalls[0] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                                        if (toolCall.id) toolCalls[0].id = toolCall.id;
                                                        if (toolCall.function?.name) toolCalls[0].function.name = toolCall.function.name;
                                                        if (toolCall.function?.arguments) toolCalls[0].function.arguments += toolCall.function.arguments;
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            // 忽略解析错误
                                        }
                                    }
                                });
                                
                                res.on('end', () => {
                                    streamFinished = true;
                                    logger.info('Stream ended: status=%d, finish_reason=%s, accumulatedContent length=%d, toolCalls length=%d, content preview=%s', 
                                        responseStatus,
                                        finishReason, 
                                        accumulatedContent.length,
                                        toolCalls.length,
                                        accumulatedContent.substring(0, 100));
                                    
                                    // 只有在状态码 >= 400 且没有接收到任何有效数据时才报错
                                    if (responseStatus >= 400 && accumulatedContent.length === 0 && toolCalls.length === 0 && !finishReason) {
                                        const error = new Error(`API request failed with status ${responseStatus}`);
                                        callback(error, undefined);
                                        if (streamReject) {
                                            streamReject(error);
                                        } else {
                                            reject(error);
                                        }
                                    } else {
                                        callback(null, undefined);
                                        if (streamResolve) {
                                            streamResolve();
                                        }
                                    }
                                });
                                
                                res.on('error', (err) => {
                                    streamFinished = true;
                                    logger.error('Stream error: %s', err.message || String(err));
                                    if (streamReject) {
                                        streamReject(err);
                                    } else {
                                        reject(err);
                                    }
                                });
                            });
                        
                        req.on('error', (err: any) => {
                            streamFinished = true;
                            logger.error('Request error: %s', err.message || String(err));
                            if (streamReject) {
                                streamReject(err);
                            } else {
                                reject(err);
                            }
                        });
                        
                        req.end((err, res) => {
                            // req.end() 只处理网络层面的错误，HTTP 状态码错误在 res.on('end') 中处理
                            if (err && !streamFinished) {
                                // 只有在流还没有结束时才处理错误
                                // 如果流已经结束，说明数据已经处理完成，不需要再报错
                                streamFinished = true;
                                logger.error('Request network error: %s', err.message || String(err));
                                if (streamReject) {
                                    streamReject(err);
                                } else {
                                    reject(err);
                                }
                            }
                            // 注意：HTTP 状态码错误（如 400）会在 res.on('end') 中处理
                        });
                    });
                    
                    if (accumulatedContent || toolCalls.length > 0) {
                        await updateRecordContent(accumulatedContent, toolCalls.length > 0 ? toolCalls : undefined);
                        const currentRecord = await RecordModel.get(domainId, recordId);
                        const currentMessages = (currentRecord as any)?.agentMessages || [];
                        const lastMessage = currentMessages[currentMessages.length - 1];
                        if (lastMessage && lastMessage.role === 'assistant') {
                            if (lastMessage.content !== accumulatedContent || 
                                (toolCalls.length > 0 && JSON.stringify(lastMessage.tool_calls) !== JSON.stringify(toolCalls))) {
                                const finalUpdateData: any = {
                                    [`agentMessages.${currentMessages.length - 1}.content`]: accumulatedContent,
                                    [`agentMessages.${currentMessages.length - 1}.timestamp`]: new Date(),
                                };
                                // BACKEND GENERATES: Ensure bubbleId is always set
                                if (lastMessage.bubbleId) {
                                    // Preserve existing bubbleId
                                    finalUpdateData[`agentMessages.${currentMessages.length - 1}.bubbleId`] = lastMessage.bubbleId;
                                } else {
                                    // Generate new bubbleId if missing
                                    const { randomUUID } = require('crypto');
                                    const finalbubbleId = randomUUID();
                                    finalUpdateData[`agentMessages.${currentMessages.length - 1}.bubbleId`] = finalbubbleId;
                                }
                                if (toolCalls.length > 0) {
                                    finalUpdateData[`agentMessages.${currentMessages.length - 1}.tool_calls`] = toolCalls;
                                }
                                await RecordModel.update(domainId, recordId, finalUpdateData);
                            }
                        }
                    }
                    
                    logger.info('After stream: finish_reason=%s, accumulatedContent length=%d, toolCalls length=%d, content=%s', 
                        finishReason, 
                        accumulatedContent.length,
                        toolCalls.length,
                        accumulatedContent.substring(0, 200));
                    
                    const hasToolCalls = finishReason === 'tool_calls' && toolCalls.length > 0;
                    
                    if (hasToolCalls) {
                        const toolCall = toolCalls[0];
                        const toolName = toolCall.function?.name;
                        let toolArgs: any = {};
                        try {
                            toolArgs = JSON.parse(toolCall.function?.arguments || '{}');
                        } catch (e) {
                            toolArgs = {};
                        }
                        
                        // 优先从context中获取工具的token信息，以便直接调用
                        let toolToken: string | undefined = undefined;
                        let toolServerId: number | undefined = undefined;
                        if (context.tools && Array.isArray(context.tools)) {
                            const toolInfo = context.tools.find((t: any) => t.name === toolName);
                            if (toolInfo) {
                                if (toolInfo.token) {
                                    toolToken = toolInfo.token;
                                }
                                // 兼容旧的serverId方式
                                if (toolInfo.serverId) {
                                    toolServerId = toolInfo.serverId;
                                }
                            }
                        }
                        
                        toolCallCount++;
                        
                        let toolResult: any;
                        const STATUS = require('ejun/src/model/builtin').STATUS;
                        try {
                            toolResult = await mcpClient.callTool(toolName, toolArgs, domainId, toolServerId, toolToken);
                            
                            if (toolResult === false || (typeof toolResult === 'object' && toolResult !== null && toolResult.success === false)) {
                                score = Math.max(0, score - 20);
                                hasToolError = true;
                                errorStatus = STATUS.STATUS_TASK_ERROR_TOOL;
                                
                                await RecordModel.updateTask(domainId, recordId, {
                                    status: errorStatus,
                                    score,
                                    agentToolCallCount: toolCallCount,
                                    agentMessages: [{
                                        role: 'tool',
                                        content: JSON.stringify(toolResult),
                                        toolName,
                                        tool_call_id: toolCall.id,
                                        timestamp: new Date(),
                                    }],
                                });
                                
                                break;
                            }
                            
                            await RecordModel.updateTask(domainId, recordId, {
                                agentToolCallCount: toolCallCount,
                                agentMessages: [{
                                    role: 'tool',
                                    content: JSON.stringify(toolResult),
                                    toolName,
                                    tool_call_id: toolCall.id,
                                    timestamp: new Date(),
                                }],
                            });
                        } catch (toolError: any) {
                            hasToolError = true;
                            const errorMessage = toolError.message || String(toolError);
                            const errorCode = toolError.code || 'UNKNOWN_ERROR';
                            
                            if (errorMessage.includes('not found') || errorMessage.includes('找不到') || errorCode === 'TOOL_NOT_FOUND') {
                                errorStatus = STATUS.STATUS_TASK_ERROR_NOT_FOUND;
                            } else if (errorMessage.includes('timeout') || errorMessage.includes('超时') || errorCode === 'TIMEOUT') {
                                errorStatus = STATUS.STATUS_TASK_ERROR_TIMEOUT;
                            } else if (errorMessage.includes('network') || errorMessage.includes('网络') || errorCode === 'NETWORK_ERROR') {
                                errorStatus = STATUS.STATUS_TASK_ERROR_NETWORK;
                            } else if (errorMessage.includes('server') || errorMessage.includes('服务器') || errorCode === 'SERVER_ERROR') {
                                errorStatus = STATUS.STATUS_TASK_ERROR_SERVER;
                            } else if (errorMessage.includes('system') || errorMessage.includes('系统') || errorCode === 'SYSTEM_ERROR') {
                                errorStatus = STATUS.STATUS_TASK_ERROR_SYSTEM;
                            } else {
                                errorStatus = STATUS.STATUS_TASK_ERROR_UNKNOWN;
                            }
                            
                            score = Math.max(0, score - 40);
                            
                            toolResult = {
                                error: true,
                                message: errorMessage,
                                code: errorCode,
                            };
                            
                            await RecordModel.updateTask(domainId, recordId, {
                                status: errorStatus,
                                score,
                                agentToolCallCount: toolCallCount,
                                agentMessages: [{
                                    role: 'tool',
                                    content: JSON.stringify(toolResult),
                                    toolName,
                                    tool_call_id: toolCall.id,
                                    timestamp: new Date(),
                                }],
                            });
                            
                            break;
                        }
                        
                        // 构建工具调用后的消息，确保格式正确
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
                        
                        const toolMsg = {
                            role: 'tool',
                            content: JSON.stringify(toolResult),
                            tool_call_id: toolCall.id,
                        };
                        
                        messagesForTurn = [
                            ...messagesForTurn,
                            assistantMsg,
                            toolMsg,
                        ];
                        
                        messagesForTurn = truncateMessages(messagesForTurn);
                        
                        // 规范化消息格式
                        const normalizedMessagesForTurn = normalizeMessages(messagesForTurn);
                        
                        requestBody.messages = [
                            { role: 'system', content: context.systemMessage },
                            ...normalizedMessagesForTurn,
                        ];
                        
                        
                        accumulatedContent = '';
                    } else {
                        logger.info('Agent reply completed: finish_reason=%s, content length=%d, content=%s', 
                            finishReason, 
                            accumulatedContent.length,
                            accumulatedContent.substring(0, 200));
                        
                        if (accumulatedContent) {
                            const currentRecord = await RecordModel.get(domainId, recordId);
                            const currentMessages = (currentRecord as any)?.agentMessages || [];
                            const lastMessage = currentMessages[currentMessages.length - 1];
                            if (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.content !== accumulatedContent) {
                                if (lastMessage && lastMessage.role === 'assistant') {
                                    const updateData: any = {
                                        [`agentMessages.${currentMessages.length - 1}.content`]: accumulatedContent,
                                        [`agentMessages.${currentMessages.length - 1}.timestamp`]: new Date(),
                                    };
                                    // Preserve bubbleId if it exists
                                    if (lastMessage.bubbleId) {
                                        updateData[`agentMessages.${currentMessages.length - 1}.bubbleId`] = lastMessage.bubbleId;
                                    }
                                    await RecordModel.update(domainId, recordId, updateData);
                                } else {
                                    const { randomUUID } = require('crypto');
                                    await RecordModel.updateTask(domainId, recordId, {
                                        agentMessages: [{
                                            role: 'assistant',
                                            content: accumulatedContent,
                                            timestamp: new Date(),
                                            bubbleId: randomUUID(), // Generate bubbleId for new assistant message
                                        }],
                                    });
                                }
                            }
                        }
                        
                        const bus = require('ejun/src/service/bus').default;
                        bus.broadcast('task/agent-completed', {
                            recordId: recordId.toString(),
                            domainId,
                            taskId: taskId?.toString(),
                        });
                        
                        break;
                    }
                }
                
                const endTime = Date.now();
                const elapsedTime = endTime - startTime;
                
                await RecordModel.updateTask(domainId, recordId, {
                    status: STATUS.STATUS_TASK_PENDING,
                    time: elapsedTime,
                    agentToolCallCount: toolCallCount,
                });
                
                if (hasToolError && errorStatus) {
                    await RecordModel.updateTask(domainId, recordId, {
                        status: errorStatus,
                    });
                } else {
                    await RecordModel.updateTask(domainId, recordId, {
                        status: STATUS.STATUS_TASK_DELIVERED,
                        score: 100,
                });
                }
                
                logger.info('Task completed: %s, tool calls: %d, time: %dms, score: %d', taskId?.toString(), toolCallCount, elapsedTime, score);
            } catch (error: any) {
                logger.error('Task failed: %s, error: %s', taskId?.toString(), error.message);
                
                if (recordId) {
                    try {
                        const endTime = Date.now();
                        const elapsedTime = endTime - startTime;
                        const STATUS = require('ejun/src/model/builtin').STATUS;
                        await RecordModel.updateTask(domainId, recordId, {
                            status: STATUS.STATUS_TASK_ERROR_SYSTEM,
                            score: 0,
                            time: elapsedTime,
                            agentError: {
                                message: error.message || String(error),
                                code: error.code || 'UNKNOWN_ERROR',
                            },
                        });
                    } catch (e) {
                        logger.warn('Failed to update task record error:', e);
                    }
                }
            }
        };
        
        const taskConcurrency = getConfig('toolcallConcurrency') || 10;
        const taskConsumer = TaskModel.consume(
            { type: 'task' },
            handleTask,
            true,
            taskConcurrency,
        );
        
        logger.info('Task consumer started (concurrency: %d)', taskConcurrency);
        
        return () => {
            taskConsumer.destroy();
        };
    });
}

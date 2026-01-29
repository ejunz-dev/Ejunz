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

let taskConsumerInstance: any = null;
let isCreatingConsumer = false;

export async function apply(ctx: EjunzContext) {
    if (isCreatingConsumer) {
        let waitCount = 0;
        while (isCreatingConsumer && waitCount < 50) {
            await new Promise(resolve => setTimeout(resolve, 100));
            waitCount++;
        }
        if (isCreatingConsumer) {
            logger.error('Timeout waiting for consumer creation');
            return;
        }
    }
    
    if (taskConsumerInstance) {
        logger.warn('Task consumer already exists, destroying old instance');
        taskConsumerInstance.destroy();
        taskConsumerInstance = null;
    }
    
    ctx.effect(() => {
        const handleTask = async (t: any) => {
            if (!t) {
                logger.error('handleTask received null/undefined task');
                return;
            }
            
            const { recordId, domainId, agentId, uid, message, history, context, workflowConfig, _id: taskId } = t;
            
            const startTime = Date.now();
            const STATUS = require('ejun/src/model/builtin').STATUS;
            
            try {
                const currentRecord = await RecordModel.get(domainId, recordId);
                if (!currentRecord) {
                    logger.error('Record not found: recordId=%s, taskId=%s', recordId?.toString(), taskId?.toString());
                    throw new Error(`Record not found: ${recordId?.toString()}`);
                }
                
                const currentStatus = (currentRecord as any).status as number | undefined;
                if (currentStatus !== undefined && currentStatus !== STATUS.STATUS_TASK_WAITING) {
                    logger.warn('Task already being processed or completed: recordId=%s, taskId=%s, currentStatus=%d, skipping', 
                        recordId?.toString(), 
                        taskId?.toString(),
                        currentStatus);
                    return;
                }
                
                await RecordModel.updateTask(domainId, recordId, {
                    status: STATUS.STATUS_TASK_FETCHED,
                });
                
                if (!context || !context.apiKey || !context.systemMessage) {
                    logger.error('Task missing required context information', {
                        taskId: taskId?.toString(),
                        recordId: recordId?.toString(),
                        hasContext: !!context,
                        hasApiKey: !!context?.apiKey,
                        hasSystemMessage: !!context?.systemMessage,
                    });
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
                
                const normalizeMessages = (messages: any[]): any[] => {
                    const normalized: any[] = [];
                    const usedToolCallIds = new Set<string>();
                    let lastAssistantToolCallIds: string[] = [];
                    
                    for (let i = 0; i < messages.length; i++) {
                        const msg = messages[i];
                        const normalizedMsg: any = {
                            role: msg.role,
                            content: msg.content || '',
                        };
                        
                        if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
                            lastAssistantToolCallIds = [];
                            normalizedMsg.tool_calls = msg.tool_calls.map((tc: any) => {
                                let toolCallId = '';
                                let toolCallName = '';
                                let toolCallArgs = '';
                                
                                if (typeof tc === 'object' && tc.function) {
                                    toolCallId = tc.id || '';
                                    toolCallName = tc.function.name || '';
                                    toolCallArgs = typeof tc.function.arguments === 'string' 
                                        ? tc.function.arguments 
                                        : JSON.stringify(tc.function.arguments || {});
                                } else if (typeof tc === 'object') {
                                    toolCallId = tc.id || '';
                                    toolCallName = tc.name || tc.function?.name || '';
                                    toolCallArgs = typeof tc.arguments === 'string'
                                        ? tc.arguments
                                        : JSON.stringify(tc.arguments || tc.function?.arguments || {});
                                }
                                
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
                        
                        if (msg.role === 'tool') {
                            let toolCallId: string | null = null;
                            
                            if (msg.tool_call_id) {
                                toolCallId = msg.tool_call_id;
                            } else if (lastAssistantToolCallIds.length > 0) {
                                toolCallId = lastAssistantToolCallIds[0];
                            } else {
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
                            
                            if (toolCallId && usedToolCallIds.has(toolCallId)) {
                                logger.warn('Duplicate tool message detected for tool_call_id: %s, skipping', toolCallId);
                                continue;
                            }
                            
                            if (toolCallId) {
                                normalizedMsg.tool_call_id = toolCallId;
                                usedToolCallIds.add(toolCallId);
                                const index = lastAssistantToolCallIds.indexOf(toolCallId);
                                if (index > -1) {
                                    lastAssistantToolCallIds.splice(index, 1);
                                }
                            } else {
                                logger.warn('Tool message missing tool_call_id at index %d, skipping', i);
                                continue;
                            }
                        }
                        
                        normalized.push(normalizedMsg);
                    }
                    
                    return normalized;
                };
                
                const normalizedHistory = normalizeMessages(limitedHistory);
                
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
                
                while (iterations < maxIterations) {
                    iterations++;
                    
                    let currentBubbleId: string | null = null;
                    let bubbleStarted = false;
                    const updateRecordContent = async (content: string, toolCalls?: any[]) => {
                        try {
                            if (!currentBubbleId) {
                                const currentRecord = await RecordModel.get(domainId, recordId);
                                const currentMessages = (currentRecord as any)?.agentMessages || [];
                                const lastMessage = currentMessages[currentMessages.length - 1];
                                
                                if (lastMessage && lastMessage.role === 'assistant' && lastMessage.bubbleId) {
                                    currentBubbleId = lastMessage.bubbleId;
                                    bubbleStarted = true;
                                } else {
                                    const { randomUUID, createHash } = require('crypto');
                                    currentBubbleId = (context as any)?.assistantbubbleId || randomUUID();
                                    const contentHash = createHash('md5').update(content || '').digest('hex').substring(0, 16);
                                    
                                    const bus = require('ejun/src/service/bus').default;
                                    bus.broadcast('bubble/stream', {
                                        rid: recordId.toString(),
                                        domainId,
                                        bubbleId: currentBubbleId,
                                        content: '',
                                        isNew: true,
                                    });
                                    
                                    await RecordModel.updateTask(domainId, recordId, {
                                        agentMessages: [{
                                            role: 'assistant',
                                            content: content || '',
                                            timestamp: new Date(),
                                            bubbleId: currentBubbleId,
                                            bubbleState: 'streaming',
                                            contentHash: contentHash,
                                        }],
                                    });
                                    
                                    bubbleStarted = true;
                                }
                            }
                            
                            if (!currentBubbleId) {
                                logger.error('updateRecordContent: currentBubbleId is empty', {
                                    recordId: recordId.toString(),
                                    contentLength: content ? content.length : 0,
                                });
                                return;
                            }
                            
                            const bus = require('ejun/src/service/bus').default;
                            bus.broadcast('bubble/stream', {
                                rid: recordId.toString(),
                                domainId,
                                bubbleId: currentBubbleId,
                                content: content,
                                isNew: false,
                            });
                            
                        } catch (e) {
                            logger.error(`[气泡 ${currentBubbleId ? currentBubbleId.substring(0, 8) : 'unknown'}] updateRecordContent 错误:`, {
                                error: e,
                                recordId: recordId.toString(),
                                bubbleId: currentBubbleId,
                                contentLength: content ? content.length : 0,
                            });
                        }
                    };
                    
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
                                                updateRecordContent(accumulatedContent, toolCalls.length > 0 ? toolCalls : undefined).catch((err) => {
                                                    logger.error('updateRecordContent 调用失败', {
                                                        recordId: recordId.toString(),
                                                        error: err,
                                                    });
                                                });
                                                
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
                                        }
                                    }
                                });
                                
                                res.on('end', () => {
                                    streamFinished = true;
                                    
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
                            if (err && !streamFinished) {
                                streamFinished = true;
                                logger.error('Request network error: %s', err.message || String(err));
                                if (streamReject) {
                                    streamReject(err);
                                } else {
                                    reject(err);
                                }
                            }
                        });
                    });
                    
                    if (accumulatedContent) {
                        let finalBubbleId = currentBubbleId;
                        if (!finalBubbleId) {
                            const currentRecord = await RecordModel.get(domainId, recordId);
                            const currentMessages = (currentRecord as any)?.agentMessages || [];
                            const lastMessage = currentMessages[currentMessages.length - 1];
                            if (lastMessage && lastMessage.role === 'assistant' && lastMessage.bubbleId) {
                                finalBubbleId = lastMessage.bubbleId;
                            }
                        }
                        
                        if (finalBubbleId) {
                            const bus = require('ejun/src/service/bus').default;
                            bus.broadcast('bubble/stream', {
                                rid: recordId.toString(),
                                domainId,
                                bubbleId: finalBubbleId,
                                content: accumulatedContent,
                                isNew: false,
                            });
                        } else {
                            logger.warn('Cannot send final bubble_stream: no bubbleId available', { 
                                recordId: recordId.toString() 
                            });
                        }
                    }
                    
                    const hasToolCalls = finishReason === 'tool_calls' && toolCalls.length > 0;
                    
                    if (hasToolCalls) {
                        const toolCall = toolCalls[0];
                        if (accumulatedContent) {
                            const currentRecord = await RecordModel.get(domainId, recordId);
                            const currentMessages = (currentRecord as any)?.agentMessages || [];
                            let lastAssistantIndex = -1;
                            for (let k = currentMessages.length - 1; k >= 0; k--) {
                                if (currentMessages[k].role === 'assistant') {
                                    lastAssistantIndex = k;
                                    break;
                                }
                            }
                            if (lastAssistantIndex >= 0) {
                                const { createHash } = require('crypto');
                                const contentHash = createHash('md5').update(accumulatedContent || '').digest('hex').substring(0, 16);
                                const $setContent: any = {
                                    [`agentMessages.${lastAssistantIndex}.content`]: accumulatedContent,
                                    [`agentMessages.${lastAssistantIndex}.timestamp`]: new Date(),
                                    [`agentMessages.${lastAssistantIndex}.contentHash`]: contentHash,
                                    [`agentMessages.${lastAssistantIndex}.bubbleState`]: 'completed',
                                };
                                await RecordModel.update(domainId, recordId, $setContent);
                            }
                        }
                        const currentRecordForToolCalls = await RecordModel.get(domainId, recordId);
                        const messagesForToolCalls = (currentRecordForToolCalls as any)?.agentMessages || [];
                        let lastAssistantIdx = -1;
                        for (let k = messagesForToolCalls.length - 1; k >= 0; k--) {
                            if (messagesForToolCalls[k].role === 'assistant') {
                                lastAssistantIdx = k;
                                break;
                            }
                        }
                        if (lastAssistantIdx >= 0) {
                            const toolCallsForRecord = [{
                                id: toolCall.id,
                                type: 'function',
                                function: {
                                    name: toolCall.function?.name || '',
                                    arguments: toolCall.function?.arguments || '',
                                },
                            }];
                            await RecordModel.update(domainId, recordId, {
                                [`agentMessages.${lastAssistantIdx}.tool_calls`]: toolCallsForRecord,
                            } as any);
                        }
                        const toolName = toolCall.function?.name;
                        let toolArgs: any = {};
                        try {
                            toolArgs = JSON.parse(toolCall.function?.arguments || '{}');
                        } catch (e) {
                            toolArgs = {};
                        }
                        
                        let toolToken: string | undefined = undefined;
                        let toolServerId: number | undefined = undefined;
                        if (context.tools && Array.isArray(context.tools)) {
                            const toolInfo = context.tools.find((t: any) => t.name === toolName);
                            if (toolInfo) {
                                if (toolInfo.token) {
                                    toolToken = toolInfo.token;
                                }
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
                        const normalizedMessagesForTurn = normalizeMessages(messagesForTurn);
                        
                        requestBody.messages = [
                            { role: 'system', content: context.systemMessage },
                            ...normalizedMessagesForTurn,
                        ];
                        
                        
                        accumulatedContent = '';
                    } else {
                        if (accumulatedContent) {
                            const currentRecord = await RecordModel.get(domainId, recordId);
                            const currentMessages = (currentRecord as any)?.agentMessages || [];
                            const lastMessage = currentMessages[currentMessages.length - 1];
                            
                            const { createHash, randomUUID } = require('crypto');
                            const contentHash = createHash('md5').update(accumulatedContent || '').digest('hex').substring(0, 16);
                            const bubbleIdToUse = currentBubbleId || (lastMessage?.bubbleId) || randomUUID();
                            
                            if (lastMessage && lastMessage.role === 'assistant' && lastMessage.bubbleId === bubbleIdToUse) {
                                const updateData: any = {
                                    [`agentMessages.${currentMessages.length - 1}.content`]: accumulatedContent,
                                    [`agentMessages.${currentMessages.length - 1}.timestamp`]: new Date(),
                                    [`agentMessages.${currentMessages.length - 1}.contentHash`]: contentHash,
                                    [`agentMessages.${currentMessages.length - 1}.bubbleState`]: 'completed',
                                };
                                await RecordModel.update(domainId, recordId, updateData);
                            } else {
                                await RecordModel.updateTask(domainId, recordId, {
                                    agentMessages: [{
                                        role: 'assistant',
                                        content: accumulatedContent,
                                        timestamp: new Date(),
                                        bubbleId: bubbleIdToUse,
                                        bubbleState: 'completed',
                                        contentHash: contentHash,
                                    }],
                                });
                                logger.warn('Bubble completed but message not found, created new message', { 
                                    recordId: recordId.toString(), 
                                    bubbleId: bubbleIdToUse,
                                    contentLength: accumulatedContent.length,
                                });
                            }
                            
                            currentBubbleId = null;
                            bubbleStarted = false;
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
        
        if (taskConsumerInstance) {
            logger.warn('Task consumer already exists, destroying old instance');
            taskConsumerInstance.destroy();
            taskConsumerInstance = null;
        }
        
        if (isCreatingConsumer) {
            logger.error('Consumer is already being created, this should not happen');
            return;
        }
        
        isCreatingConsumer = true;
        let taskConsumer: any = null;
        
        try {
            taskConsumer = TaskModel.consume(
                { type: 'task' },
                handleTask,
                true,
                taskConcurrency,
            );
            
            taskConsumerInstance = taskConsumer;
            (taskConsumer as any).__instanceId = `${process.env.NODE_APP_INSTANCE}-${process.pid}-${Date.now()}`;
        } finally {
            isCreatingConsumer = false;
        }
        
        return () => {
            if (taskConsumerInstance === taskConsumer) {
                taskConsumerInstance = null;
            }
            if (taskConsumer) {
                taskConsumer.destroy();
            }
        };
    });
}

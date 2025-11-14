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
            const { recordId, domainId, agentId, uid, message, history, context, _id: taskId } = t;
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
                
                const requestBody: any = {
                    model: context.model || 'deepseek-chat',
                    max_tokens: 1024,
                    messages: [
                        { role: 'system', content: context.systemMessage },
                        ...limitedHistory,
                        { role: 'user', content: message },
                    ],
                    stream: true,
                };
                
                if (context.tools && context.tools.length > 0) {
                    requestBody.tools = context.tools.map((tool: any) => ({
                        type: 'function',
                        function: {
                            name: tool.name,
                            description: tool.description || '',
                            parameters: tool.inputSchema || {},
                        },
                    }));
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
                        const lastMessage = currentMessages[currentMessages.length - 1];
                        
                        if (lastMessage && lastMessage.role === 'assistant') {
                            // 更新最后一条 assistant 消息
                            const updateData: any = {
                                [`agentMessages.${currentMessages.length - 1}.content`]: content,
                                [`agentMessages.${currentMessages.length - 1}.timestamp`]: new Date(),
                            };
                            if (toolCalls) {
                                updateData[`agentMessages.${currentMessages.length - 1}.tool_calls`] = toolCalls;
                            }
                            await RecordModel.update(domainId, recordId, updateData);
                        } else {
                            const assistantMsg: any = {
                                role: 'assistant',
                                content: content || '',
                                timestamp: new Date(),
                            };
                            if (toolCalls) {
                                assistantMsg.tool_calls = toolCalls;
                            }
                            await RecordModel.update(domainId, recordId, undefined, {
                                agentMessages: assistantMsg,
                            } as any);
                        }
                    } catch (e) {
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
                                            const choice = parsed.choices?.[0];
                                            const delta = choice?.delta;
                                            
                                            if (delta?.content) {
                                                accumulatedContent += delta.content;
                                                updateRecordContent(accumulatedContent, toolCalls.length > 0 ? toolCalls : undefined).catch(() => {});
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
                                    logger.info('Stream ended: finish_reason=%s, accumulatedContent length=%d, toolCalls length=%d, content preview=%s', 
                                        finishReason, 
                                        accumulatedContent.length,
                                        toolCalls.length,
                                        accumulatedContent.substring(0, 100));
                                    callback(null, undefined);
                                    if (streamResolve) {
                                        streamResolve();
                                    }
                                });
                                
                                res.on('error', (err) => {
                                    streamFinished = true;
                                    if (streamReject) {
                                        streamReject(err);
                                    } else {
                                        reject(err);
                                    }
                                });
                            });
                        
                        req.end((err, res) => {
                            if (err) {
                                if (streamReject) {
                                    streamReject(err);
                                } else {
                                    reject(err);
                                }
                            }
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
                        
                        let toolServerId: number | undefined = undefined;
                        if (context.tools && Array.isArray(context.tools)) {
                            const toolInfo = context.tools.find((t: any) => t.name === toolName);
                            if (toolInfo && toolInfo.serverId) {
                                toolServerId = toolInfo.serverId;
                                logger.debug('Found serverId=%d for tool=%s from context', toolServerId, toolName);
                            }
                        }
                        
                        toolCallCount++;
                        
                        let toolResult: any;
                        const STATUS = require('ejun/src/model/builtin').STATUS;
                        try {
                            toolResult = await mcpClient.callTool(toolName, toolArgs, domainId, toolServerId);
                            
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
                        
                        messagesForTurn = [
                            ...messagesForTurn,
                            {
                                role: 'assistant',
                                content: accumulatedContent,
                                tool_calls: [toolCall],
                            },
                            {
                                role: 'tool',
                                content: JSON.stringify(toolResult),
                                tool_call_id: toolCall.id,
                            },
                        ];
                        
                        messagesForTurn = truncateMessages(messagesForTurn);
                        
                        requestBody.messages = [
                            { role: 'system', content: context.systemMessage },
                            ...messagesForTurn,
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
                                    await RecordModel.update(domainId, recordId, {
                                        [`agentMessages.${currentMessages.length - 1}.content`]: accumulatedContent,
                                        [`agentMessages.${currentMessages.length - 1}.timestamp`]: new Date(),
                                    });
                                } else {
                                    await RecordModel.updateTask(domainId, recordId, {
                                        agentMessages: [{
                                            role: 'assistant',
                                            content: accumulatedContent,
                                            timestamp: new Date(),
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

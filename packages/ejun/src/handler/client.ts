import { Context, Handler, Logger, param, Types, PRIV } from 'ejun';
import request from 'superagent';
import { McpClient } from '../model/client';

const ClientLogger = new Logger('client');

class McpStatusHandler extends Handler {
    async get() {
        const mcpClient = new McpClient();
        const tools = await mcpClient.getTools();
        this.response.body = { 
            connected: true, 
            toolCount: tools.length 
        };
    }
}

export class ClientHandler extends Handler {
    async get() {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const apiKey = (this.domain as any)['apiKey'] || '';
        const model = (this.domain as any)['model'] || 'deepseek-chat';
        const apiUrl = (this.domain as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';
        
        this.response.template = 'client.html';
        this.response.body = {
            apiKey,
            model,
            apiUrl,
        };
    }

    async post({ domainId }) {
        this.response.template = null;
        
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const message = this.request.body?.message;
        const history = this.request.body?.history || '[]';
        
        if (!message) {
            this.response.body = { error: 'Message cannot be empty' };
            return;
        }
        
        const apiKey = (this.domain as any)['apiKey'] || '';
        const model = (this.domain as any)['model'] || 'deepseek-chat';
        const apiUrl = (this.domain as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';
        
        if (!apiKey) {
            this.response.body = { error: 'API Key not configured' };
            return;
        }

        let chatHistory: ChatMessage[] = [];
        try {
            chatHistory = JSON.parse(history);
        } catch (e) {
        }

        const mcpClient = new McpClient();
        const tools = await mcpClient.getTools();
        
        chatHistory.push({ role: 'user', content: message });
        
        const systemMessage = tools.length > 0
            ? 'You have access to the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.inputSchema.properties || {}}`).join('\n')
            : 'You are a helpful AI assistant.';

        try {
            const requestBody: any = {
                model,
                max_tokens: 1024,
                messages: [
                    { role: 'system', content: systemMessage },
                    ...chatHistory,
                ],
            };

            if (tools.length > 0) {
                requestBody.tools = tools.map(tool => ({
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                    },
                }));
            }

            const response = await request.post(apiUrl)
                .send(requestBody)
                .set('Authorization', `Bearer ${apiKey}`)
                .set('content-type', 'application/json');


            let assistantMessage = response.body.choices[0].message.content || '';
            
            if (typeof assistantMessage !== 'string') {
                assistantMessage = typeof assistantMessage === 'object' 
                    ? JSON.stringify(assistantMessage)
                    : String(assistantMessage);
            }
            
            const finishReason = response.body.choices[0].finish_reason;
            
            if (finishReason === 'tool_calls') {
                const toolCalls = response.body.choices[0].message.tool_calls;
                if (toolCalls && toolCalls.length > 0) {
                    const toolCall = toolCalls[0];
                    const toolResult = await mcpClient.callTool(toolCall.function.name, JSON.parse(toolCall.function.arguments));
                    
                    ClientLogger.info('Tool returned:', { toolResult });
                    
                    const toolContent = JSON.stringify(toolResult);
                    
                    ClientLogger.info('Serialized tool content:', { toolContent });
                    
                    const assistantMessage: any = {
                        role: 'assistant',
                        tool_calls: toolCalls
                    };
                    
                    const toolMessage: any = {
                        role: 'tool',
                        content: toolContent,
                        tool_call_id: toolCall.id
                    };
                    
                    const messagesForTool = [
                        { role: 'system', content: systemMessage },
                        ...chatHistory,
                        assistantMessage,
                        toolMessage
                    ];
                    
                    ClientLogger.info('Sending tool result to AI:', { 
                        messageCount: messagesForTool.length,
                        toolContent: toolContent?.substring(0, 100),
                        assistantMsg: JSON.stringify(assistantMessage),
                        toolMsg: JSON.stringify(toolMessage)
                    });
                    
                    const toolResponse = await request.post(apiUrl)
                        .send({
                            model,
                            max_tokens: 1024,
                            messages: messagesForTool,
                        })
                        .set('Authorization', `Bearer ${apiKey}`)
                        .set('content-type', 'application/json');

                    let finalMessage = toolResponse.body.choices[0].message.content || '';
                    
                    if (typeof finalMessage !== 'string') {
                        finalMessage = typeof finalMessage === 'object'
                            ? JSON.stringify(finalMessage)
                            : String(finalMessage);
                    }

                    this.response.body = {
                        message: finalMessage,
                        history: JSON.stringify([
                            ...chatHistory,
                            { role: 'user', content: message },
                            { role: 'assistant', content: finalMessage },
                        ]),
                    };
                    return;
                }
            }

            this.response.body = {
                message: assistantMessage,
                history: JSON.stringify([
                    ...chatHistory,
                    { role: 'user', content: message },
                    { role: 'assistant', content: assistantMessage },
                ]),
            };
        } catch (error: any) {
            ClientLogger.error('AI Chat Error:', {
                message: error.message,
                response: error.response?.body,
                stack: error.stack,
            });
            this.response.body = { error: JSON.stringify(error.response?.body || error.message) };
        }
    }
}


export function apply(ctx: Context) {
    ctx.Route('client', '/client', ClientHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_mcp_status', '/client/mcp-tools/status', McpStatusHandler);
}


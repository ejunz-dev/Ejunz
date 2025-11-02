import {
    escapeRegExp,
} from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import type { Context } from '../context';
import {
    BadRequestError, ContestNotAttendedError, ContestNotEndedError, ContestNotFoundError, ContestNotLiveError,
    FileLimitExceededError, HackFailedError, NoProblemError, NotFoundError,
    PermissionError, ProblemAlreadyExistError, ProblemAlreadyUsedByContestError, ProblemConfigError,
    ProblemIsReferencedError, ProblemNotAllowLanguageError, ProblemNotAllowPretestError, ProblemNotFoundError,
    RecordNotFoundError, SolutionNotFoundError, ValidationError,DiscussionNotFoundError
} from '../error';
import {
    Handler, ConnectionHandler, param, post, query, route, Types,
} from '../service/server';
import Agent from '../model/agent';
import { PERM, PRIV, STATUS } from '../model/builtin';
import { AgentDoc } from '../interface';
import domain from '../model/domain';
import { User } from '../model/user';
import * as system from '../model/system';
import parser from '@ejunz/utils/lib/search';
import { RepoSearchOptions } from '../interface';
import user from '../model/user';
import request from 'superagent';
import { randomstring } from '@ejunz/utils';
import { McpClient, ChatMessage } from '../model/agent';
import { Logger } from '../logger';
import { PassThrough } from 'stream';

const AgentLogger = new Logger('agent');
export const parseCategory = (value: string) => value.replace(/，/g, ',').split(',').map((e) => e.trim());

function buildQuery(udoc: User) {
    const q: Filter<AgentDoc> = {};
    if (!udoc.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) {
        q.$or = [
            { hidden: false },
            { owner: udoc._id },
            { maintainer: udoc._id },
        ];
    }
    return q;
}

const defaultSearch = async (domainId: string, q: string, options?: RepoSearchOptions) => {
    const escaped = escapeRegExp(q.toLowerCase());
    const projection: (keyof AgentDoc)[] = ['domainId', 'docId', 'aid'];
    const $regex = new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gmi');
    const filter = { $or: [{ aid: { $regex } }, { title: { $regex } }, { tag: q }] };
    const adocs = await Agent.getMulti(domainId, filter, projection)
        .skip(options.skip || 0).limit(options.limit || system.get('pagination.problem')).toArray();
    if (!options.skip) {
        let adoc = await Agent.get(domainId, Number.isSafeInteger(+q) ? +q : q, projection);
        if (adoc) adocs.unshift(adoc);
        else if (/^R\d+$/.test(q)) {
            adoc = await Agent.get(domainId, +q.substring(1), projection);
            if (adoc) adocs.unshift(adoc);
        }
    }
    return {
        hits: Array.from(new Set(adocs.map((i) => `${i.domainId}/${i.docId}`))),
        total: Math.max(adocs.length, await Agent.count(domainId, filter)),
        countRelation: 'eq',
    };
};

export interface QueryContext {
    query: Filter<AgentDoc>;
    sort: string[];
    pcountRelation: string;
    parsed: ReturnType<typeof parser.parse>;
    category: string[];
    text: string;
    total: number;
    fail: boolean;
}

export class AgentMainHandler extends Handler {
    queryContext: QueryContext = {
        query: {},
        sort: [],
        pcountRelation: 'eq',
        parsed: null,
        category: [],
        text: '',
        total: 0,
        fail: false,
    };

    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('limit', Types.PositiveInt, true)
    @param('pjax', Types.Boolean)
    @param('quick', Types.Boolean)
    async get(domainId: string, page = 1, q = '', limit: number, pjax = false, quick = false) {
        this.response.template = 'agent_domain.html';
        if (!limit || limit > this.ctx.setting.get('pagination.problem') || page > 1) limit = this.ctx.setting.get('pagination.problem');
        

        this.queryContext.query = buildQuery(this.user);

        const query = this.queryContext.query;
        const psdict = {};
        const search = defaultSearch;
        const parsed = parser.parse(q, {
            keywords: ['category', 'difficulty'],
            offsets: false,
            alwaysArray: true,
            tokenize: true,
        });

        const category = parsed.category || [];
        const text = (parsed.text || []).join(' ');

        if (parsed.difficulty?.every((i) => Number.isSafeInteger(+i))) {
            query.difficulty = { $in: parsed.difficulty.map(Number) };
        }
        if (category.length) query.$and = category.map((tag) => ({ tag }));
        if (text) category.push(text);
        if (category.length) this.UiContext.extraTitleContent = category.join(',');

        let total = 0;
        if (text) {
            const result = await search(domainId, q, { skip: (page - 1) * limit, limit });
            total = result.total;
            this.queryContext.pcountRelation = result.countRelation;
            if (!result.hits.length) this.queryContext.fail = true;
            query.$and ||= [];
            query.$and.push({
                $or: result.hits.map((i) => {
                    const [did, docId] = i.split('/');
                    return { domainId: did, docId: +docId };
                }),
            });
            this.queryContext.sort = result.hits;
        }


        const sort = this.queryContext.sort;
        await (this.ctx as any).parallel('agent/list', query, this, sort);

        let [adocs, ppcount, pcount] = this.queryContext.fail
            ? [[], 0, 0]
            : await Agent.list(
                domainId, query, sort.length ? 1 : page, limit,
                quick ? ['title', 'aid', 'domainId', 'docId'] : undefined,
                this.user._id,
            );

        


        if (total) {
            pcount = total;
            ppcount = Math.ceil(total / limit);
        }
        if (sort.length) adocs = adocs.sort((a, b) => sort.indexOf(`${a.domainId}/${a.docId}`) - sort.indexOf(`${b.domainId}/${b.docId}`));
        if (text && pcount > adocs.length) pcount = adocs.length;

       

        if (pjax) {
            this.response.body = {
                title: this.renderTitle(this.translate('repo_domain')),
                fragments: (await Promise.all([
                    this.renderHTML('partials/repo_list.html', {
                        page, ppcount, pcount, adocs, psdict, qs: q,
                    }),
                    this.renderHTML('partials/repo_stat.html', { pcount, pcountRelation: this.queryContext.pcountRelation }),
                    this.renderHTML('partials/repo_lucky.html', { qs: q }),
                ])).map((i) => ({ html: i })),
            };
        } else {
            this.response.body = {
                page,
                pcount,
                ppcount,
                pcountRelation: this.queryContext.pcountRelation,
                adocs,
                psdict,
                qs: q,
            };
        }
    }
}   



class AgentMcpStatusHandler extends Handler {
    @param('aid', Types.String)
    async get(domainId: string, aid: string) {
        const mcpClient = new McpClient();
        const tools = await mcpClient.getTools();
        this.response.body = { 
            connected: true, 
            toolCount: tools.length 
        };
    }
}

export class AgentDetailHandler extends Handler {
    adoc?: AgentDoc;

    @param('aid', Types.String)
    async _prepare(domainId: string, aid: string) {
        if (!aid) return;

        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;

        this.adoc = await Agent.get(domainId, normalizedId);
        if (!this.adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }
        this.UiContext.extraTitleContent = this.adoc.title;
    }

    @param('aid', Types.String)
    async get(domainId: string, aid: string) {
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;


        const adoc = await Agent.get(domainId, normalizedId, Agent.PROJECTION_DETAIL);
        if (!adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }

        const udoc = await user.getById(domainId, adoc.owner);

        let apiUrl = system.get('server.url');
        if (apiUrl && apiUrl !== '/') {
            apiUrl = apiUrl.replace(/\/$/, '');
            apiUrl = `${apiUrl}/api/agent`;
        } else {
            const ctx = this.context.EjunzContext;
            const isSecure = (this.request.headers['x-forwarded-proto'] === 'https') 
                || (ctx.request && (ctx.request as any).secure)
                || false;
            const protocol = isSecure ? 'https' : 'http';
            const host = this.request.host || this.request.headers.host || 'localhost';
            apiUrl = `${protocol}://${host}/api/agent`;
        }

        this.response.template = 'agent_detail.html';
        this.response.body = {
            domainId,
            aid: adoc.aid, 
            adoc,
            udoc,
            apiUrl,
        };

    }

    @param('aid', Types.String)
    async postGenerateApiKey(domainId: string, aid: string) {
        this.response.template = null;
        
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
        const adoc = await Agent.get(domainId, normalizedId);
        
        if (!adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }

        if (!this.user.own(adoc) && !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            throw new PermissionError('Only owner or system administrator can manage API keys');
        }

        const apiKey = randomstring(32);
        await Agent.edit(domainId, adoc.aid, { apiKey });

        this.response.body = { apiKey };
    }

    @param('aid', Types.String)
    async postDeleteApiKey(domainId: string, aid: string) {
        this.response.template = null;
        
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
        const adoc = await Agent.get(domainId, normalizedId);
        
        if (!adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }

        if (!this.user.own(adoc) && !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            throw new PermissionError('Only owner or system administrator can manage API keys');
        }
        await Agent.edit(domainId, adoc.aid, { apiKey: null });

        this.response.body = { success: true };
    }

}

export class AgentChatHandler extends Handler {
    adoc?: AgentDoc;

    @param('aid', Types.String)
    async _prepare(domainId: string, aid: string) {
        if (!aid) return;

        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;

        this.adoc = await Agent.get(domainId, normalizedId);
        if (!this.adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }
        this.UiContext.extraTitleContent = `${this.adoc.title} - Chat`;
    }

    @param('aid', Types.String)
    async get(domainId: string, aid: string) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
        const adoc = await Agent.get(domainId, normalizedId);
        if (!adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }

        const udoc = await user.getById(domainId, adoc.owner);

        const apiKey = (this.domain as any)['apiKey'] || '';
        const aiModel = (this.domain as any)['model'] || 'deepseek-chat';
        const apiUrl = (this.domain as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';

        let wsUrl = `/agent/${adoc.aid}/chat-ws`;
        const host = this.domain?.host;
        if (domainId !== 'system' && (
            !this.request.host
            || (host instanceof Array
                ? (!host.includes(this.request.host))
                : this.request.host !== host)
        )) {
            wsUrl = `/d/${domainId}${wsUrl}`;
        }

        this.response.template = 'agent_chat.html';
        this.response.body = {
            domainId,
            aid: adoc.aid, 
            adoc,
            udoc,
            apiKey,
            aiModel,
            apiUrl,
            wsUrl,
        };
    }

    @param('aid', Types.String)
    async post(domainId: string, aid: string) {
        this.response.template = null;
        
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
        const adoc = await Agent.get(domainId, normalizedId);
        if (!adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }

        const message = this.request.body?.message;
        const history = this.request.body?.history || '[]';
        const stream = this.request.query?.stream === 'true' || this.request.body?.stream === true;
        
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
        
        const agentPrompt = adoc.content || '';
        let systemMessage = agentPrompt;
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji') && !systemMessage.includes('不使用表情')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              '\n\n【IMPORTANT RULES】You must strictly adhere to the following rules for tool calls:\n1. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n2. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n3. Each tool call response should be independent and focused solely on the current tool\'s result.\n4. After the last tool call completes, you should only reply with the last tool\'s result. Do NOT provide a comprehensive summary of all tools\' results (unless there are clear dependencies between tools that require integration).\n5. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n6. Tool calls proceed one by one sequentially: call one tool → immediately reply with that tool\'s result → decide if another tool is needed.\n7. If multiple tools are needed, proceed one by one: call the first tool → reply with the first tool\'s result → call the second tool → reply with the second tool\'s result, and so on. Each reply should be independent and focused on the current tool.';
            systemMessage = systemMessage + toolsInfo;
        }

        if (stream) {
            this.response.type = 'text/event-stream';
            this.response.addHeader('Cache-Control', 'no-cache');
            this.response.addHeader('Connection', 'keep-alive');
            this.response.addHeader('X-Accel-Buffering', 'no');
            this.context.response.type = 'text/event-stream';
            this.context.compress = false;
        }

        try {
            const requestBody: any = {
                model,
                max_tokens: 1024,
                messages: [
                    { role: 'system', content: systemMessage },
                    ...chatHistory,
                    { role: 'user', content: message },
                ],
                stream: stream,
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

            let messagesForTurn: any[] = [
                { role: 'system', content: systemMessage },
                ...chatHistory,
                { role: 'user', content: message },
            ];

            if (stream) {
                const res = this.context.res;
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                
                if (this.context.req.socket) {
                    this.context.req.socket.setNoDelay(true);
                    this.context.req.socket.setKeepAlive(true);
                }
                
                const streamResponse = new PassThrough({
                    highWaterMark: 0,
                    objectMode: false,
                });
                
                streamResponse.pipe(res);
                
                this.context.compress = false;
                (this.context.EjunzContext as any).request.websocket = true;
                this.response.body = null;
                this.context.body = null;
                
                let accumulatedContent = '';
                let finishReason = '';
                let toolCalls: any[] = [];
                let iterations = 0;
                const maxIterations = 5;
                let streamFinished = false;
                let waitingForToolCall = false;

                const processStream = async () => {
                    try {
                        AgentLogger.info('Starting stream request', { apiUrl, model, streamEnabled: requestBody.stream });
                        streamFinished = false;
                        waitingForToolCall = false;
                        
                        await new Promise<void>((resolve, reject) => {
                            const req = request.post(apiUrl)
                                .send(requestBody)
                                .set('Authorization', `Bearer ${apiKey}`)
                                .set('content-type', 'application/json')
                                .buffer(false)
                                .timeout(60000)
                                .parse((res, callback) => {
                                    res.setEncoding('utf8');
                                    let buffer = '';
                                    
                                    res.on('data', (chunk: string) => {
                                        if (streamResponse.destroyed || streamResponse.writableEnded || streamFinished) return;
                                        
                                        buffer += chunk;
                                        const lines = buffer.split('\n');
                                        buffer = lines.pop() || '';
                                        
                                        for (const line of lines) {
                                            if (!line.trim() || !line.startsWith('data: ')) continue;
                                            const data = line.slice(6).trim();
                                            if (data === '[DONE]') {
                                                if (waitingForToolCall) {
                                                    AgentLogger.info('Received [DONE] but waiting for tool call, ignoring');
                                                    callback(null, undefined);
                                                    return;
                                                }
                                                if (!streamResponse.destroyed && !streamResponse.writableEnded && !streamFinished) {
                                                    streamFinished = true;
                                                    streamResponse.write(`data: ${JSON.stringify({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                        ...chatHistory,
                                                        { role: 'user', content: message },
                                                        { role: 'assistant', content: accumulatedContent },
                                                    ]) })}\n\n`);
                                                    streamResponse.end();
                                                }
                                                callback(null, undefined);
                                                return;
                                            }
                                            if (!data) continue;
                                            
                                            try {
                                                const parsed = JSON.parse(data);
                                                const choice = parsed.choices?.[0];
                                                const delta = choice?.delta;
                                                
                                                if (delta?.content) {
                                                    accumulatedContent += delta.content;
                                                    if (!streamResponse.destroyed && !streamResponse.writableEnded && !streamFinished) {
                                                        const contentData = `data: ${JSON.stringify({ type: 'content', content: delta.content })}\n\n`;
                                                        streamResponse.write(contentData, 'utf8', () => {
                                                            AgentLogger.debug('Content chunk written:', delta.content.length, 'bytes');
                                                        });
                                                        AgentLogger.debug('Sent content chunk:', delta.content.length, 'bytes');
                                                    }
                                                }
                                                
                                                if (choice?.finish_reason) {
                                                    finishReason = choice.finish_reason;
                                                    if (finishReason === 'tool_calls') {
                                                        waitingForToolCall = true;
                                                        AgentLogger.info('Tool call detected, will continue sending accumulated content');
                                                    }
                                                    AgentLogger.info('Received finish_reason:', finishReason);
                                                }
                                                
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
                                                AgentLogger.warn('Parse error in stream:', e, data.substring(0, 100));
                                            }
                                        }
                                    });
                                    
                                    res.on('end', async () => {
                                        AgentLogger.info('Stream ended', { finishReason, iterations, accumulatedLength: accumulatedContent.length, streamFinished, waitingForToolCall });
                                        callback(null, undefined);
                                        
                                        if (!streamFinished || waitingForToolCall) {
                                            (async () => {
                                                try {
                                                    if (finishReason === 'tool_calls' && toolCalls.length > 0 && iterations < maxIterations) {
                                                        if (streamFinished) {
                                                            AgentLogger.info('Resetting streamFinished for tool call processing');
                                                            streamFinished = false;
                                                        }
                                                        
                                                        iterations++;
                                                        AgentLogger.info('Processing tool calls', { toolCallCount: toolCalls.length });
                                                        
                                                        if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                            // 只发送第一个工具的名称
                                                            const firstToolName = toolCalls[0]?.function?.name || 'unknown';
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call_start', tools: [firstToolName] })}\n\n`);
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call', tools: [firstToolName] })}\n\n`);
                                                        }
                                                        
                                                        const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                            id: tc.id || `call_${idx}`,
                                                            type: tc.type || 'function',
                                                            function: {
                                                                name: tc.function.name,
                                                                arguments: tc.function.arguments,
                                                            },
                                                        })) };
                                                        
                                                        // 一个工具一个回复模式：每次只调用第一个工具，然后立即让AI回复
                                                        const firstToolCall = assistantForTools.tool_calls[0];
                                                        
                                                        if (!firstToolCall) {
                                                            AgentLogger.warn('No tool call found in assistant message');
                                                            return;
                                                        }
                                                        
                                                        let parsedArgs: any = {};
                                                        try {
                                                            parsedArgs = JSON.parse(firstToolCall.function.arguments);
                                                        } catch (e) {
                                                            parsedArgs = {};
                                                        }
                                                        
                                                        AgentLogger.info(`Calling first tool: ${firstToolCall.function.name} (One-by-One Mode)`, parsedArgs);
                                                        
                                                        let toolResult: any;
                                                        try {
                                                            toolResult = await mcpClient.callTool(firstToolCall.function.name, parsedArgs);
                                                            AgentLogger.info(`Tool ${firstToolCall.function.name} returned`, { resultLength: JSON.stringify(toolResult).length });
                                                        } catch (toolError: any) {
                                                            AgentLogger.error(`Tool ${firstToolCall.function.name} failed:`, toolError);
                                                            toolResult = {
                                                                error: true,
                                                                message: toolError.message || String(toolError),
                                                                code: toolError.code || 'UNKNOWN_ERROR',
                                                            };
                                                        }
                                                        
                                                        const toolMsg = { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: firstToolCall.id };
                                                        
                                                        if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_result', tool: firstToolCall.function.name, result: toolResult })}\n\n`);
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call_complete' })}\n\n`);
                                                        }
                                                        
                                                        // 构建消息历史（只包含第一个工具调用和结果）
                                                        messagesForTurn = [
                                                            ...messagesForTurn,
                                                            { 
                                                                role: 'assistant', 
                                                                content: accumulatedContent, 
                                                                tool_calls: [firstToolCall] // 只包含已调用的工具
                                                            },
                                                            toolMsg,
                                                        ];
                                                        accumulatedContent = '';
                                                        finishReason = '';
                                                        toolCalls = [];
                                                        waitingForToolCall = false;
                                                        requestBody.messages = messagesForTurn;
                                                        requestBody.stream = true;
                                                        AgentLogger.info('Continuing stream after first tool call', { 
                                                            toolName: firstToolCall.function.name,
                                                            remainingTools: assistantForTools.tool_calls.length - 1
                                                        });
                                                        await processStream();
                                                    } else if (!streamFinished) {
                                                        streamFinished = true;
                                                        if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                                ...chatHistory,
                                                                { role: 'user', content: message },
                                                                { role: 'assistant', content: accumulatedContent },
                                                            ]) })}\n\n`);
                                                            streamResponse.end();
                                                        }
                                                    }
                                                    resolve();
                                                } catch (err: any) {
                                                    AgentLogger.error('Error in stream end handler:', err);
                                                    streamFinished = true;
                                                    waitingForToolCall = false;
                                                    if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                        streamResponse.write(`data: ${JSON.stringify({ type: 'error', error: err.message || String(err) })}\n\n`);
                                                        streamResponse.end();
                                                    }
                                                    resolve();
                                                }
                                            })();
                                        } else {
                                            resolve();
                                        }
                                    });
                                    
                                    res.on('error', (err: any) => {
                                        AgentLogger.error('Stream response error:', err);
                                        callback(err, undefined);
                                        reject(err);
                                    });
                                });
                            
                            req.on('error', (err: any) => {
                                AgentLogger.error('Stream request error:', err);
                                if (!streamResponse.destroyed) {
                                    streamResponse.write(`data: ${JSON.stringify({ type: 'error', error: err.message || String(err) })}\n\n`);
                                    streamResponse.end();
                                }
                                reject(err);
                            });
                            
                            req.end();
                        });
                    } catch (error: any) {
                        AgentLogger.error('Stream setup error:', error);
                        if (!streamResponse.destroyed) {
                            streamResponse.write(`data: ${JSON.stringify({ type: 'error', error: error.message || String(error) })}\n\n`);
                            streamResponse.end();
                        }
                    }
                };
                
                await processStream();
                return;
            }

            let currentResponse = await request.post(apiUrl)
                .send(requestBody)
                .set('Authorization', `Bearer ${apiKey}`)
                .set('content-type', 'application/json');

            let iterations = 0;
            const maxIterations = 5;

            while (true) {
                const choice = currentResponse.body.choices?.[0] || {};
                const finishReason = choice.finish_reason;
                const msg = choice.message || {};

                if (finishReason === 'tool_calls') {
                    const toolCalls = msg.tool_calls || [];
                    if (!toolCalls.length) break;

                    // 一个工具一个回复模式：每次只调用第一个工具
                    const firstToolCall = toolCalls[0];
                    if (!firstToolCall) break;

                    let parsedArgs: any = {};
                    try {
                        parsedArgs = typeof firstToolCall.function?.arguments === 'string'
                            ? JSON.parse(firstToolCall.function.arguments)
                            : firstToolCall.function?.arguments || {};
                    } catch (e) {
                        parsedArgs = {};
                    }
                    
                    AgentLogger.info(`Calling first tool: ${firstToolCall.function?.name} (One-by-One Mode)`);
                    const toolResult = await mcpClient.callTool(firstToolCall.function?.name, parsedArgs);
                    AgentLogger.info('Tool returned:', { toolResult });
                    
                    const toolMsg = { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: firstToolCall.id };
                    
                    const assistantForTools: any = { 
                        role: 'assistant', 
                        content: msg.content || '',
                        tool_calls: [firstToolCall] // 只包含已调用的工具
                    };

                    messagesForTurn = [
                        ...messagesForTurn,
                        assistantForTools,
                        toolMsg,
                    ];

                    iterations += 1;
                    if (iterations >= maxIterations) break;

                    currentResponse = await request.post(apiUrl)
                        .send({
                            model,
                            max_tokens: 1024,
                            messages: messagesForTurn,
                            tools: requestBody.tools,
                        })
                        .set('Authorization', `Bearer ${apiKey}`)
                        .set('content-type', 'application/json');
                    continue;
                }

                let finalContent = msg.content || '';
                if (typeof finalContent !== 'string') {
                    finalContent = typeof finalContent === 'object' ? JSON.stringify(finalContent) : String(finalContent);
                }

                this.response.body = {
                    message: finalContent,
                    history: JSON.stringify([
                        ...chatHistory,
                        { role: 'user', content: message },
                        { role: 'assistant', content: finalContent },
                    ]),
                };
                return;
            }

            const fallbackMsg = currentResponse.body?.choices?.[0]?.message?.content || '';
            const msgStr = typeof fallbackMsg === 'string' ? fallbackMsg : JSON.stringify(fallbackMsg || '');
            this.response.body = {
                message: msgStr,
                history: JSON.stringify([
                    ...chatHistory,
                    { role: 'user', content: message },
                    { role: 'assistant', content: msgStr },
                ]),
            };
        } catch (error: any) {
            AgentLogger.error('AI Chat Error:', {
                message: error.message,
                response: error.response?.body,
                stack: error.stack,
            });
            if (stream) {
                const streamResponse = this.response.body as PassThrough;
                if (streamResponse && !streamResponse.destroyed) {
                    streamResponse.write(`data: ${JSON.stringify({ type: 'error', error: JSON.stringify(error.response?.body || error.message) })}\n\n`);
                    streamResponse.end();
                }
            } else {
                this.response.body = { error: JSON.stringify(error.response?.body || error.message) };
            }
        }
    }
}

export class AgentChatConnectionHandler extends ConnectionHandler {
    adoc?: AgentDoc;

    @param('aid', Types.String)
    async prepare(domainId: string, aid: string) {
        try {
            await this.checkPriv(PRIV.PRIV_USER_PROFILE);
            
            if (!aid) {
                AgentLogger.warn('WebSocket connection rejected: Agent ID is required');
                this.close(4000, 'Agent ID is required');
                return;
            }

            const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
            this.adoc = await Agent.get(domainId, normalizedId);
            if (!this.adoc) {
                AgentLogger.warn('WebSocket connection rejected: Agent not found', { aid: normalizedId, domainId });
                this.close(4000, `Agent not found: ${normalizedId}`);
                return;
            }

            AgentLogger.info('WebSocket connection established for agent chat', { aid, domainId });
            this.send({ type: 'connected', message: 'WebSocket connection established' });
            AgentLogger.info('WebSocket prepare completed successfully', { aid, domainId });
        } catch (error: any) {
            AgentLogger.error('Error in WebSocket prepare:', error);
            try {
                this.send({ type: 'error', error: error.message || String(error) });
            } catch (e) {
                // ignore
            }
            try {
                this.close(4000, error.message || String(error));
            } catch (e) {
                // ignore
            }
        }
    }

    async message(msg: any) {
        AgentLogger.info('Received WebSocket message', { hasAdoc: !!this.adoc, msgType: typeof msg });
        
        if (!this.adoc) {
            AgentLogger.warn('WebSocket message rejected: Agent not found');
            this.send({ type: 'error', error: 'Agent not found' });
            return;
        }

        let messageText: string;
        let historyData: any;
        
        if (typeof msg === 'string') {
            try {
                const parsed = JSON.parse(msg);
                messageText = parsed.message;
                historyData = parsed.history;
            } catch (e) {
                AgentLogger.warn('Failed to parse message as JSON string', e);
                this.send({ type: 'error', error: 'Invalid message format' });
                return;
            }
        } else if (typeof msg === 'object' && msg !== null) {
            messageText = msg.message;
            historyData = msg.history;
        } else {
            AgentLogger.warn('Invalid message type', typeof msg);
            this.send({ type: 'error', error: 'Invalid message format' });
            return;
        }
        
        const message = messageText;
        const history = historyData;
        if (!message) {
            this.send({ type: 'error', error: 'Message cannot be empty' });
            return;
        }

        const domainId = (this.domain as any)?.domainId || this.request.params?.domainId || '';
        const apiKey = (this.domain as any)['apiKey'] || '';
        const model = (this.domain as any)['model'] || 'deepseek-chat';
        const apiUrl = (this.domain as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';

        if (!apiKey) {
            this.send({ type: 'error', error: 'API Key not configured' });
            return;
        }

        let chatHistory: ChatMessage[] = [];
        try {
            chatHistory = Array.isArray(history) ? history : JSON.parse(history || '[]');
        } catch (e) {
            // ignore parse error
        }

        const mcpClient = new McpClient();
        const tools = await mcpClient.getTools();
        
        const agentPrompt = this.adoc.content || '';
        let systemMessage = agentPrompt;
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji') && !systemMessage.includes('不使用表情')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              '\n\n【IMPORTANT RULES】You must strictly adhere to the following rules for tool calls:\n1. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n2. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n3. Each tool call response should be independent and focused solely on the current tool\'s result.\n4. After the last tool call completes, you should only reply with the last tool\'s result. Do NOT provide a comprehensive summary of all tools\' results (unless there are clear dependencies between tools that require integration).\n5. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n6. Tool calls proceed one by one sequentially: call one tool → immediately reply with that tool\'s result → decide if another tool is needed.\n7. If multiple tools are needed, proceed one by one: call the first tool → reply with the first tool\'s result → call the second tool → reply with the second tool\'s result, and so on. Each reply should be independent and focused on the current tool.';
            systemMessage = systemMessage + toolsInfo;
        }

        try {
            const requestBody: any = {
                model,
                max_tokens: 1024,
                messages: [
                    { role: 'system', content: systemMessage },
                    ...chatHistory,
                    { role: 'user', content: message },
                ],
                stream: true,
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

            let messagesForTurn: any[] = [
                { role: 'system', content: systemMessage },
                ...chatHistory,
                { role: 'user', content: message },
            ];

            let accumulatedContent = '';
            let finishReason = '';
            let toolCalls: any[] = [];
            let iterations = 0;
            const maxIterations = 5;
            let streamFinished = false;
            let waitingForToolCall = false;

            const processStream = async () => {
                try {
                    AgentLogger.info('Starting WebSocket stream request', { apiUrl, model });
                    streamFinished = false;
                    waitingForToolCall = false;
                    
                    await new Promise<void>((resolve, reject) => {
                        const req = request.post(apiUrl)
                            .send(requestBody)
                            .set('Authorization', `Bearer ${apiKey}`)
                            .set('content-type', 'application/json')
                            .buffer(false)
                            .timeout(60000)
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
                                            if (waitingForToolCall) {
                                                AgentLogger.info('Received [DONE] but waiting for tool call, ignoring (WS)');
                                                callback(null, undefined);
                                                return;
                                            }
                                            streamFinished = true;
                                            this.send({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                ...chatHistory,
                                                { role: 'user', content: message },
                                                { role: 'assistant', content: accumulatedContent },
                                            ]) });
                                            callback(null, undefined);
                                            return;
                                        }
                                        if (!data) continue;
                                        
                                        try {
                                            const parsed = JSON.parse(data);
                                            const choice = parsed.choices?.[0];
                                            const delta = choice?.delta;
                                            
                                            if (delta?.content) {
                                                accumulatedContent += delta.content;
                                                this.send({ type: 'content', content: delta.content });
                                            }
                                            
                                            if (choice?.finish_reason) {
                                                finishReason = choice.finish_reason;
                                                if (finishReason === 'tool_calls') {
                                                    waitingForToolCall = true;
                                                    AgentLogger.info('Tool call detected (WS)');
                                                }
                                            }
                                            
                                            if (delta?.tool_calls) {
                                                for (const toolCall of delta.tool_calls || []) {
                                                    // 强制只保留第一个工具调用（index=0），丢弃其他工具调用
                                                    // 这是为了确保每次只执行一个工具
                                                    if (toolCall.index === 0 || toolCalls.length === 0) {
                                                        const idx = toolCall.index || 0;
                                                        if (idx === 0) {
                                                            if (!toolCalls[0]) toolCalls[0] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                                            if (toolCall.id) toolCalls[0].id = toolCall.id;
                                                            if (toolCall.function?.name) toolCalls[0].function.name = toolCall.function.name;
                                                            if (toolCall.function?.arguments) toolCalls[0].function.arguments += toolCall.function.arguments;
                                                        }
                                                    } else {
                                                        // 忽略其他工具调用（index > 0）
                                                        AgentLogger.info(`Ignoring additional tool call (index ${toolCall.index}), only processing first tool (Stream)`);
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            AgentLogger.warn('Parse error in stream (WS):', e);
                                        }
                                    }
                                });
                                
                                res.on('end', async () => {
                                    AgentLogger.info('Stream ended (WS)', { finishReason, iterations, accumulatedLength: accumulatedContent.length, waitingForToolCall });
                                    callback(null, undefined);
                                    
                                    if (!streamFinished || waitingForToolCall) {
                                        (async () => {
                                            try {
                                                if (finishReason === 'tool_calls' && toolCalls.length > 0 && iterations < maxIterations) {
                                                    if (streamFinished) {
                                                        streamFinished = false;
                                                    }
                                                    
                                                    iterations++;
                                                    AgentLogger.info('Processing tool calls (WS)', { toolCallCount: toolCalls.length });
                                                    
                                                    // 只发送第一个工具的名称
                                                    const firstToolName = toolCalls[0]?.function?.name || 'unknown';
                                                    this.send({ type: 'tool_call_start', tools: [firstToolName] });
                                                    
                                                    const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                        id: tc.id || `call_${idx}`,
                                                        type: tc.type || 'function',
                                                        function: {
                                                            name: tc.function.name,
                                                            arguments: tc.function.arguments,
                                                        },
                                                    })) };
                                                    
                                                    // 一个工具一个回复模式：每次只调用第一个工具，然后立即让AI回复
                                                    const firstToolCall = assistantForTools.tool_calls[0];
                                                    
                                                    if (!firstToolCall) {
                                                        AgentLogger.warn('No tool call found in assistant message (WS)');
                                                        return;
                                                    }
                                                    
                                                    let parsedArgs: any = {};
                                                    try {
                                                        parsedArgs = JSON.parse(firstToolCall.function.arguments);
                                                    } catch (e) {
                                                        parsedArgs = {};
                                                    }
                                                    
                                                    AgentLogger.info(`Calling first tool: ${firstToolCall.function.name} (WS - One-by-One Mode)`, parsedArgs);
                                                    
                                                    let toolResult: any;
                                                    try {
                                                        toolResult = await mcpClient.callTool(firstToolCall.function.name, parsedArgs);
                                                        AgentLogger.info(`Tool ${firstToolCall.function.name} returned (WS)`, { resultLength: JSON.stringify(toolResult).length });
                                                    } catch (toolError: any) {
                                                        AgentLogger.error(`Tool ${firstToolCall.function.name} failed (WS):`, toolError);
                                                        toolResult = {
                                                            error: true,
                                                            message: toolError.message || String(toolError),
                                                            code: toolError.code || 'UNKNOWN_ERROR',
                                                        };
                                                    }
                                                    
                                                    const toolMsg = { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: firstToolCall.id };
                                                    
                                                    this.send({ type: 'tool_result', tool: firstToolCall.function.name, result: toolResult });
                                                    this.send({ type: 'tool_call_complete' });
                                                    
                                                    // 构建消息历史（只包含第一个工具调用和结果）
                                                    messagesForTurn = [
                                                        ...messagesForTurn,
                                                        { 
                                                            role: 'assistant', 
                                                            content: accumulatedContent, 
                                                            tool_calls: [firstToolCall] // 只包含已调用的工具
                                                        },
                                                        toolMsg,
                                                    ];
                                                    accumulatedContent = '';
                                                    finishReason = '';
                                                    toolCalls = [];
                                                    waitingForToolCall = false;
                                                    requestBody.messages = messagesForTurn;
                                                    requestBody.stream = true;
                                                    AgentLogger.info('Continuing stream after first tool call (WS)', { 
                                                        toolName: firstToolCall.function.name,
                                                        remainingTools: assistantForTools.tool_calls.length - 1
                                                    });
                                                    await processStream();
                                                } else if (!streamFinished) {
                                                    streamFinished = true;
                                                    this.send({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                        ...chatHistory,
                                                        { role: 'user', content: message },
                                                        { role: 'assistant', content: accumulatedContent },
                                                    ]) });
                                                }
                                                resolve();
                                            } catch (err: any) {
                                                AgentLogger.error('Error in stream end handler (WS):', err);
                                                this.send({ type: 'error', error: err.message || String(err) });
                                                resolve();
                                            }
                                        })();
                                    } else {
                                        resolve();
                                    }
                                });
                                
                                res.on('error', (err: any) => {
                                    AgentLogger.error('Stream response error (WS):', err);
                                    callback(err, undefined);
                                    reject(err);
                                });
                            });
                        
                        req.on('error', (err: any) => {
                            AgentLogger.error('Stream request error (WS):', err);
                            this.send({ type: 'error', error: err.message || String(err) });
                            reject(err);
                        });
                        
                        req.end();
                    });
                } catch (error: any) {
                    AgentLogger.error('Stream setup error (WS):', error);
                    this.send({ type: 'error', error: error.message || String(error) });
                }
            };
            
            await processStream();
        } catch (error: any) {
            AgentLogger.error('AI Chat Error (WS):', error);
            this.send({ type: 'error', error: JSON.stringify(error.response?.body || error.message) });
        }
    }
}

export class AgentStreamConnectionHandler extends ConnectionHandler {
    noCheckPermView = true;
    adoc?: AgentDoc;

    private logSend(data: any) {
        AgentLogger.info('[Stream WS Response]', JSON.stringify(data, null, 2));
        this.send(data);
    }

    @param('aid', Types.String)
    async prepare(domainId: string, aid: string) {
        try {
            if (!aid) {
                AgentLogger.warn('WebSocket stream connection rejected: Agent ID is required');
                this.close(4000, 'Agent ID is required');
                return;
            }

            const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
            this.adoc = await Agent.get(domainId, normalizedId);
            if (!this.adoc) {
                AgentLogger.warn('WebSocket stream connection rejected: Agent not found', { aid: normalizedId, domainId });
                this.close(4000, `Agent not found: ${normalizedId}`);
                return;
            }

            AgentLogger.info('Public WebSocket stream connection established', { aid, domainId });
            this.logSend({ type: 'connected', message: 'WebSocket stream connection established' });
        } catch (error: any) {
            AgentLogger.error('Error in WebSocket stream prepare:', error);
            try {
                this.logSend({ type: 'error', error: error.message || String(error) });
            } catch (e) {
            }
            try {
                this.close(4000, error.message || String(error));
            } catch (e) {
            }
        }
    }

    async message(msg: any) {
        AgentLogger.info('Received WebSocket stream message', { hasAdoc: !!this.adoc, msgType: typeof msg, msg: JSON.stringify(msg) });
        
        if (!this.adoc) {
            AgentLogger.warn('WebSocket stream message rejected: Agent not found');
            this.logSend({ type: 'error', error: 'Agent not found' });
            return;
        }

        let messageText: string;
        let historyData: any;
        
        if (typeof msg === 'string') {
            try {
                const parsed = JSON.parse(msg);
                messageText = parsed.message;
                historyData = parsed.history;
            } catch (e) {
                AgentLogger.warn('Failed to parse message as JSON string', e);
                this.logSend({ type: 'error', error: 'Invalid message format' });
                return;
            }
        } else if (typeof msg === 'object' && msg !== null) {
            messageText = msg.message;
            historyData = msg.history;
        } else {
            AgentLogger.warn('Invalid message type', typeof msg);
            this.logSend({ type: 'error', error: 'Invalid message format' });
            return;
        }
        
        const message = messageText;
        const history = historyData;
        if (!message) {
            this.logSend({ type: 'error', error: 'Message cannot be empty' });
            return;
        }

        const domainId = this.adoc.domainId;
        const domainInfo = await domain.get(domainId);
        if (!domainInfo) {
            this.logSend({ type: 'error', error: 'Domain not found' });
            return;
        }

        const aiApiKey = (domainInfo as any)['apiKey'] || '';
        const model = (domainInfo as any)['model'] || 'deepseek-chat';
        const apiUrl = (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';

        if (!aiApiKey) {
            this.logSend({ type: 'error', error: 'AI API Key not configured' });
            return;
        }

        let chatHistory: ChatMessage[] = [];
        try {
            chatHistory = Array.isArray(history) ? history : JSON.parse(history || '[]');
        } catch (e) {
        }

        const mcpClient = new McpClient();
        const tools = await mcpClient.getTools();
        
        const agentPrompt = this.adoc.content || '';
        let systemMessage = agentPrompt;
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji') && !systemMessage.includes('不使用表情')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              '\n\n【IMPORTANT RULES】You must strictly adhere to the following rules for tool calls:\n1. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n2. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n3. Each tool call response should be independent and focused solely on the current tool\'s result.\n4. After the last tool call completes, you should only reply with the last tool\'s result. Do NOT provide a comprehensive summary of all tools\' results (unless there are clear dependencies between tools that require integration).\n5. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n6. Tool calls proceed one by one sequentially: call one tool → immediately reply with that tool\'s result → decide if another tool is needed.\n7. If multiple tools are needed, proceed one by one: call the first tool → reply with the first tool\'s result → call the second tool → reply with the second tool\'s result, and so on. Each reply should be independent and focused on the current tool.';
            systemMessage = systemMessage + toolsInfo;
        }

        try {
            const requestBody: any = {
                model,
                max_tokens: 1024,
                messages: [
                    { role: 'system', content: systemMessage },
                    ...chatHistory,
                    { role: 'user', content: message },
                ],
                stream: true,
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

            let messagesForTurn: any[] = [
                { role: 'system', content: systemMessage },
                ...chatHistory,
                { role: 'user', content: message },
            ];

            let accumulatedContent = '';
            let finishReason = '';
            let toolCalls: any[] = [];
            let iterations = 0;
            const maxIterations = 5;
            let streamFinished = false;
            let waitingForToolCall = false;

            const processStream = async () => {
                try {
                    AgentLogger.info('Starting public stream request', { apiUrl, model });
                    streamFinished = false;
                    waitingForToolCall = false;
                    
                    await new Promise<void>((resolve, reject) => {
                        const req = request.post(apiUrl)
                            .send(requestBody)
                            .set('Authorization', `Bearer ${aiApiKey}`)
                            .set('content-type', 'application/json')
                            .buffer(false)
                            .timeout(60000)
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
                                            if (waitingForToolCall) {
                                                // 工具调用前，先发送已累积的初始内容（如果有的话）
                                                // 内容已经在 delta.content 时实时发送了，这里只需要标记完成
                                                AgentLogger.info('Received [DONE] while waiting for tool call, will process tool calls (Stream)');
                                                callback(null, undefined);
                                                return;
                                            }
                                            streamFinished = true;
                                            this.logSend({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                ...chatHistory,
                                                { role: 'user', content: message },
                                                { role: 'assistant', content: accumulatedContent },
                                            ]) });
                                            callback(null, undefined);
                                            return;
                                        }
                                        if (!data) continue;
                                        
                                        try {
                                            const parsed = JSON.parse(data);
                                            const choice = parsed.choices?.[0];
                                            const delta = choice?.delta;
                                            
                                            if (delta?.content) {
                                                accumulatedContent += delta.content;
                                                this.logSend({ type: 'content', content: delta.content });
                                            }
                                            
                                            if (choice?.finish_reason) {
                                                finishReason = choice.finish_reason;
                                                if (finishReason === 'tool_calls') {
                                                    waitingForToolCall = true;
                                                    AgentLogger.info('Tool call detected (Stream), will process immediately');
                                                    
                                                    // 等待工具调用参数收集完成（tool_calls参数可能还在流式传输中）
                                                    // 但我们不在这里处理，让res.on('end')处理，确保所有tool_calls都收集完毕
                                                }
                                            }
                                            
                                            if (delta?.tool_calls) {
                                                for (const toolCall of delta.tool_calls || []) {
                                                    // 强制只保留第一个工具调用（index=0），丢弃其他工具调用
                                                    // 这是为了确保每次只执行一个工具
                                                    if (toolCall.index === 0 || toolCalls.length === 0) {
                                                        const idx = toolCall.index || 0;
                                                        if (idx === 0) {
                                                            if (!toolCalls[0]) toolCalls[0] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                                            if (toolCall.id) toolCalls[0].id = toolCall.id;
                                                            if (toolCall.function?.name) toolCalls[0].function.name = toolCall.function.name;
                                                            if (toolCall.function?.arguments) toolCalls[0].function.arguments += toolCall.function.arguments;
                                                        }
                                                    } else {
                                                        // 忽略其他工具调用（index > 0）
                                                        AgentLogger.info(`Ignoring additional tool call (index ${toolCall.index}), only processing first tool (Stream)`);
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            AgentLogger.warn('Parse error in stream (Stream):', e);
                                        }
                                    }
                                });
                                
                                res.on('end', async () => {
                                    AgentLogger.info('Stream ended (Stream)', { finishReason, iterations, accumulatedLength: accumulatedContent.length, waitingForToolCall, toolCallsCount: toolCalls.length });
                                    callback(null, undefined);
                                    
                                    // 如果检测到工具调用，立即处理第一个工具
                                    if (waitingForToolCall && toolCalls.length > 0 && iterations < maxIterations) {
                                        (async () => {
                                            try {
                                                iterations++;
                                                AgentLogger.info('Processing first tool call (Stream) - One-by-One Mode', { toolCallCount: toolCalls.length, accumulatedContentLength: accumulatedContent.length });
                                                
                                                // 只发送第一个工具的名称，而不是所有工具
                                                const firstToolName = toolCalls[0]?.function?.name || 'unknown';
                                                this.logSend({ type: 'tool_call_start', tools: [firstToolName] });
                                                
                                                const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                    id: tc.id || `call_${idx}`,
                                                    type: tc.type || 'function',
                                                    function: {
                                                        name: tc.function.name,
                                                        arguments: tc.function.arguments,
                                                    },
                                                })) };
                                                
                                                // 一个工具一个回复模式：每次只调用第一个工具，然后立即让AI回复
                                                const firstToolCall = assistantForTools.tool_calls[0];
                                                
                                                if (!firstToolCall) {
                                                    AgentLogger.warn('No tool call found in assistant message (Stream)');
                                                    return;
                                                }
                                                
                                                let parsedArgs: any = {};
                                                try {
                                                    parsedArgs = JSON.parse(firstToolCall.function.arguments);
                                                } catch (e) {
                                                    parsedArgs = {};
                                                }
                                                
                                                AgentLogger.info(`Calling first tool: ${firstToolCall.function.name} (Stream - One-by-One Mode)`);
                                                
                                                // Send message before executing each tool
                                                this.logSend({ type: 'content', content: `Calling ${firstToolCall.function.name} tool...\n\n` });
                                                
                                                // 执行工具调用
                                                let toolResult: any;
                                                try {
                                                    toolResult = await mcpClient.callTool(firstToolCall.function.name, parsedArgs);
                                                    AgentLogger.info(`Tool ${firstToolCall.function.name} returned (Stream)`, { resultLength: JSON.stringify(toolResult).length });
                                                    
                                                    // 工具完成后立即发送结果
                                                    this.logSend({ 
                                                        type: 'tool_result', 
                                                        tool: firstToolCall.function.name, 
                                                        result: toolResult
                                                    });
                                                    
                                                } catch (toolError: any) {
                                                    // 工具调用失败
                                                    AgentLogger.error(`Tool ${firstToolCall.function.name} failed (Stream):`, toolError);
                                                    toolResult = {
                                                        error: true,
                                                        message: toolError.message || String(toolError),
                                                        code: toolError.code || 'UNKNOWN_ERROR',
                                                    };
                                                    
                                                    // 立即发送错误结果
                                                    this.logSend({ 
                                                        type: 'tool_result', 
                                                        tool: firstToolCall.function.name, 
                                                        result: toolResult,
                                                        error: true
                                                    });
                                                }
                                                
                                                // 创建工具结果消息（只包含第一个工具的结果）
                                                const toolMsg = { 
                                                    role: 'tool', 
                                                    content: JSON.stringify(toolResult), 
                                                    tool_call_id: firstToolCall.id 
                                                };
                                                
                                                // 发送工具调用完成信号（单个工具）
                                                this.logSend({ type: 'tool_call_complete' });
                                                
                                                // 构建消息历史（只包含第一个工具调用和结果）
                                                // 这样AI可以根据第一个工具的结果决定是否需要继续调用其他工具
                                                messagesForTurn = [
                                                    ...messagesForTurn,
                                                    { 
                                                        role: 'assistant', 
                                                        content: accumulatedContent, 
                                                        tool_calls: [firstToolCall] // 只包含已调用的工具
                                                    },
                                                    toolMsg,
                                                ];
                                                
                                                const previousContent = accumulatedContent;
                                                accumulatedContent = '';
                                                finishReason = '';
                                                toolCalls = [];
                                                waitingForToolCall = false;
                                                requestBody.messages = messagesForTurn;
                                                requestBody.stream = true;
                                                
                                                AgentLogger.info('Continuing stream after first tool call (Stream)', { 
                                                    previousContentLength: previousContent.length, 
                                                    toolName: firstToolCall.function.name,
                                                    remainingTools: assistantForTools.tool_calls.length - 1
                                                });
                                                
                                                // 立即继续流式传输，让 AI 基于第一个工具结果继续输出
                                                // AI可以决定是否需要继续调用其他工具
                                                await processStream();
                                            } catch (err: any) {
                                                AgentLogger.error('Error processing tool call (Stream):', err);
                                                this.logSend({ type: 'error', error: err.message || String(err) });
                                            }
                                        })();
                                        resolve();
                                        return;
                                    }
                                    
                                    // 如果没有工具调用，正常结束
                                    if (!waitingForToolCall && !streamFinished) {
                                        streamFinished = true;
                                        this.logSend({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                            ...chatHistory,
                                            { role: 'user', content: message },
                                            { role: 'assistant', content: accumulatedContent },
                                        ]) });
                                    }
                                    resolve();
                                });
                                
                                res.on('error', (err: any) => {
                                    AgentLogger.error('Stream response error (Stream):', err);
                                    callback(err, undefined);
                                    reject(err);
                                });
                            });
                        
                        req.on('error', (err: any) => {
                            AgentLogger.error('Stream request error (Stream):', err);
                            this.logSend({ type: 'error', error: err.message || String(err) });
                            reject(err);
                        });
                        
                        req.end();
                    });
                } catch (error: any) {
                    AgentLogger.error('Stream setup error (Stream):', error);
                    this.logSend({ type: 'error', error: error.message || String(error) });
                }
            };
            
            await processStream();
        } catch (error: any) {
            AgentLogger.error('AI Stream Error:', error);
            this.logSend({ type: 'error', error: JSON.stringify(error.response?.body || error.message) });
        }
    }
}

export class AgentApiConnectionHandler extends ConnectionHandler {
    adoc?: AgentDoc;
    apiKey?: string;

    async prepare() {
        try {
            const apiKeyHeader = this.request.headers['x-api-key'];
            const apiKeyAuth = this.request.headers['authorization'];
            const apiKeyQuery = this.request.query?.apiKey as string;
            
            let apiKey: string | undefined;
            if (apiKeyHeader) {
                apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
            } else if (apiKeyAuth) {
                const authStr = Array.isArray(apiKeyAuth) ? apiKeyAuth[0] : apiKeyAuth;
                apiKey = authStr.replace(/^Bearer /i, '');
            } else if (apiKeyQuery) {
                apiKey = apiKeyQuery;
            }
            
            if (!apiKey) {
                AgentLogger.warn('WebSocket API connection rejected: API Key is required');
                this.close(4000, 'API Key is required');
                return;
            }

            this.apiKey = apiKey;
            this.adoc = await Agent.getByApiKey(apiKey);
            if (!this.adoc) {
                AgentLogger.warn('WebSocket API connection rejected: Invalid API Key');
                this.close(4000, 'Invalid API Key');
                return;
            }

            AgentLogger.info('WebSocket API connection established', { aid: this.adoc.aid, domainId: this.adoc.domainId });
            this.send({ type: 'connected', message: 'WebSocket API connection established' });
        } catch (error: any) {
            AgentLogger.error('Error in WebSocket API prepare:', error);
            try {
                this.send({ type: 'error', error: error.message || String(error) });
            } catch (e) {
            }
            try {
                this.close(4000, error.message || String(error));
            } catch (e) {
            }
        }
    }

    async message(msg: any) {
        AgentLogger.info('Received WebSocket API message', { hasAdoc: !!this.adoc, msgType: typeof msg });
        
        if (!this.adoc) {
            AgentLogger.warn('WebSocket API message rejected: Agent not found');
            this.send({ type: 'error', error: 'Agent not found' });
            return;
        }

        let messageText: string;
        let historyData: any;
        
        if (typeof msg === 'string') {
            try {
                const parsed = JSON.parse(msg);
                messageText = parsed.message;
                historyData = parsed.history;
            } catch (e) {
                AgentLogger.warn('Failed to parse message as JSON string', e);
                this.send({ type: 'error', error: 'Invalid message format' });
                return;
            }
        } else if (typeof msg === 'object' && msg !== null) {
            messageText = msg.message;
            historyData = msg.history;
        } else {
            AgentLogger.warn('Invalid message type', typeof msg);
            this.send({ type: 'error', error: 'Invalid message format' });
            return;
        }
        
        const message = messageText;
        const history = historyData;
        if (!message) {
            this.send({ type: 'error', error: 'Message cannot be empty' });
            return;
        }

        const domainId = this.adoc.domainId;
        const domainInfo = await domain.get(domainId);
        if (!domainInfo) {
            this.send({ type: 'error', error: 'Domain not found' });
            return;
        }

        const aiApiKey = (domainInfo as any)['apiKey'] || '';
        const model = (domainInfo as any)['model'] || 'deepseek-chat';
        const apiUrl = (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';

        if (!aiApiKey) {
            this.send({ type: 'error', error: 'AI API Key not configured' });
            return;
        }

        let chatHistory: ChatMessage[] = [];
        try {
            chatHistory = Array.isArray(history) ? history : JSON.parse(history || '[]');
        } catch (e) {
        }

        const mcpClient = new McpClient();
        const tools = await mcpClient.getTools();
        
        const agentPrompt = this.adoc.content || '';
        let systemMessage = agentPrompt;
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji') && !systemMessage.includes('不使用表情')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              '\n\n【IMPORTANT RULES】You must strictly adhere to the following rules for tool calls:\n1. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n2. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n3. Each tool call response should be independent and focused solely on the current tool\'s result.\n4. After the last tool call completes, you should only reply with the last tool\'s result. Do NOT provide a comprehensive summary of all tools\' results (unless there are clear dependencies between tools that require integration).\n5. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n6. Tool calls proceed one by one sequentially: call one tool → immediately reply with that tool\'s result → decide if another tool is needed.\n7. If multiple tools are needed, proceed one by one: call the first tool → reply with the first tool\'s result → call the second tool → reply with the second tool\'s result, and so on. Each reply should be independent and focused on the current tool.';
            systemMessage = systemMessage + toolsInfo;
        }

        try {
            const requestBody: any = {
                model,
                max_tokens: 1024,
                messages: [
                    { role: 'system', content: systemMessage },
                    ...chatHistory,
                    { role: 'user', content: message },
                ],
                stream: true,
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

            let messagesForTurn: any[] = [
                { role: 'system', content: systemMessage },
                ...chatHistory,
                { role: 'user', content: message },
            ];

            let accumulatedContent = '';
            let finishReason = '';
            let toolCalls: any[] = [];
            let iterations = 0;
            const maxIterations = 5;
            let streamFinished = false;
            let waitingForToolCall = false;

            const processStream = async () => {
                try {
                    AgentLogger.info('Starting WebSocket API stream request', { apiUrl, model });
                    streamFinished = false;
                    waitingForToolCall = false;
                    
                    await new Promise<void>((resolve, reject) => {
                        const req = request.post(apiUrl)
                            .send(requestBody)
                            .set('Authorization', `Bearer ${aiApiKey}`)
                            .set('content-type', 'application/json')
                            .buffer(false)
                            .timeout(60000)
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
                                            if (waitingForToolCall) {
                                                AgentLogger.info('Received [DONE] but waiting for tool call, ignoring (API WS)');
                                                callback(null, undefined);
                                                return;
                                            }
                                            streamFinished = true;
                                            this.send({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                ...chatHistory,
                                                { role: 'user', content: message },
                                                { role: 'assistant', content: accumulatedContent },
                                            ]) });
                                            callback(null, undefined);
                                            return;
                                        }
                                        if (!data) continue;
                                        
                                        try {
                                            const parsed = JSON.parse(data);
                                            const choice = parsed.choices?.[0];
                                            const delta = choice?.delta;
                                            
                                            if (delta?.content) {
                                                accumulatedContent += delta.content;
                                                this.send({ type: 'content', content: delta.content });
                                            }
                                            
                                            if (choice?.finish_reason) {
                                                finishReason = choice.finish_reason;
                                                if (finishReason === 'tool_calls') {
                                                    waitingForToolCall = true;
                                                    AgentLogger.info('Tool call detected (API WS)');
                                                }
                                            }
                                            
                                            if (delta?.tool_calls) {
                                                for (const toolCall of delta.tool_calls || []) {
                                                    // 强制只保留第一个工具调用（index=0），丢弃其他工具调用
                                                    // 这是为了确保每次只执行一个工具
                                                    if (toolCall.index === 0 || toolCalls.length === 0) {
                                                        const idx = toolCall.index || 0;
                                                        if (idx === 0) {
                                                            if (!toolCalls[0]) toolCalls[0] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                                            if (toolCall.id) toolCalls[0].id = toolCall.id;
                                                            if (toolCall.function?.name) toolCalls[0].function.name = toolCall.function.name;
                                                            if (toolCall.function?.arguments) toolCalls[0].function.arguments += toolCall.function.arguments;
                                                        }
                                                    } else {
                                                        // 忽略其他工具调用（index > 0）
                                                        AgentLogger.info(`Ignoring additional tool call (index ${toolCall.index}), only processing first tool (Stream)`);
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            AgentLogger.warn('Parse error in stream (API WS):', e);
                                        }
                                    }
                                });
                                
                                res.on('end', async () => {
                                    AgentLogger.info('Stream ended (API WS)', { finishReason, iterations, accumulatedLength: accumulatedContent.length, waitingForToolCall });
                                    callback(null, undefined);
                                    
                                    if (!streamFinished || waitingForToolCall) {
                                        (async () => {
                                            try {
                                                if (finishReason === 'tool_calls' && toolCalls.length > 0 && iterations < maxIterations) {
                                                    if (streamFinished) {
                                                        streamFinished = false;
                                                    }
                                                    
                                                    iterations++;
                                                    AgentLogger.info('Processing tool calls (API WS)', { toolCallCount: toolCalls.length });
                                                    
                                                    // 只发送第一个工具的名称
                                                    const firstToolName = toolCalls[0]?.function?.name || 'unknown';
                                                    this.send({ type: 'tool_call_start', tools: [firstToolName] });
                                                    
                                                    const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                        id: tc.id || `call_${idx}`,
                                                        type: tc.type || 'function',
                                                        function: {
                                                            name: tc.function.name,
                                                            arguments: tc.function.arguments,
                                                        },
                                                    })) };
                                                    
                                                    // 一个工具一个回复模式：每次只调用第一个工具，然后立即让AI回复
                                                    const firstToolCall = assistantForTools.tool_calls[0];
                                                    
                                                    if (!firstToolCall) {
                                                        AgentLogger.warn('No tool call found in assistant message (API WS)');
                                                        return;
                                                    }
                                                    
                                                    let parsedArgs: any = {};
                                                    try {
                                                        parsedArgs = JSON.parse(firstToolCall.function.arguments);
                                                    } catch (e) {
                                                        parsedArgs = {};
                                                    }
                                                    
                                                    AgentLogger.info(`Calling first tool: ${firstToolCall.function.name} (API WS - One-by-One Mode)`, parsedArgs);
                                                    
                                                    let toolResult: any;
                                                    try {
                                                        toolResult = await mcpClient.callTool(firstToolCall.function.name, parsedArgs);
                                                        AgentLogger.info(`Tool ${firstToolCall.function.name} returned (API WS)`, { resultLength: JSON.stringify(toolResult).length });
                                                    } catch (toolError: any) {
                                                        AgentLogger.error(`Tool ${firstToolCall.function.name} failed (API WS):`, toolError);
                                                        toolResult = {
                                                            error: true,
                                                            message: toolError.message || String(toolError),
                                                            code: toolError.code || 'UNKNOWN_ERROR',
                                                        };
                                                    }
                                                    
                                                    const toolMsg = { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: firstToolCall.id };
                                                    
                                                    this.send({ type: 'tool_result', tool: firstToolCall.function.name, result: toolResult });
                                                    this.send({ type: 'tool_call_complete' });
                                                    
                                                    // 构建消息历史（只包含第一个工具调用和结果）
                                                    messagesForTurn = [
                                                        ...messagesForTurn,
                                                        { 
                                                            role: 'assistant', 
                                                            content: accumulatedContent, 
                                                            tool_calls: [firstToolCall] // 只包含已调用的工具
                                                        },
                                                        toolMsg,
                                                    ];
                                                    accumulatedContent = '';
                                                    finishReason = '';
                                                    toolCalls = [];
                                                    waitingForToolCall = false;
                                                    requestBody.messages = messagesForTurn;
                                                    requestBody.stream = true;
                                                    AgentLogger.info('Continuing stream after first tool call (API WS)', { 
                                                        toolName: firstToolCall.function.name,
                                                        remainingTools: assistantForTools.tool_calls.length - 1
                                                    });
                                                    await processStream();
                                                } else if (!streamFinished) {
                                                    streamFinished = true;
                                                    this.send({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                        ...chatHistory,
                                                        { role: 'user', content: message },
                                                        { role: 'assistant', content: accumulatedContent },
                                                    ]) });
                                                }
                                                resolve();
                                            } catch (err: any) {
                                                AgentLogger.error('Error in stream end handler (API WS):', err);
                                                this.send({ type: 'error', error: err.message || String(err) });
                                                resolve();
                                            }
                                        })();
                                    } else {
                                        resolve();
                                    }
                                });
                                
                                res.on('error', (err: any) => {
                                    AgentLogger.error('Stream response error (API WS):', err);
                                    callback(err, undefined);
                                    reject(err);
                                });
                            });
                        
                        req.on('error', (err: any) => {
                            AgentLogger.error('Stream request error (API WS):', err);
                            this.send({ type: 'error', error: err.message || String(err) });
                            reject(err);
                        });
                        
                        req.end();
                    });
                } catch (error: any) {
                    AgentLogger.error('Stream setup error (API WS):', error);
                    this.send({ type: 'error', error: error.message || String(error) });
                }
            };
            
            await processStream();
        } catch (error: any) {
            AgentLogger.error('AI Chat Error (API WS):', error);
            this.send({ type: 'error', error: JSON.stringify(error.response?.body || error.message) });
        }
    }
}

export class AgentApiHandler extends Handler {
    noCheckPermView = true;
    allowCors = true;
    
    async all() {
        this.response.template = null;
        
        const apiKey = this.request.headers['x-api-key'] 
            || this.request.headers['authorization']?.replace(/^Bearer /i, '')
            || this.request.query?.apiKey as string
            || this.request.body?.apiKey;
        
        if (!apiKey) {
            this.response.body = { error: 'API Key is required' };
            this.response.status = 401;
            return;
        }

        const adoc = await Agent.getByApiKey(apiKey);
        if (!adoc) {
            this.response.body = { error: 'Invalid API Key' };
            this.response.status = 401;
            return;
        }

        const domainInfo = await domain.get(adoc.domainId);
        if (!domainInfo) {
            this.response.body = { error: 'Domain not found' };
            this.response.status = 500;
            return;
        }

        const message = this.request.body?.message;
        const history = this.request.body?.history || '[]';
        const stream = this.request.query?.stream === 'true' || this.request.body?.stream === true;
        
        if (!message) {
            this.response.body = { error: 'Message cannot be empty' };
            this.response.status = 400;
            return;
        }

        const aiApiKey = (domainInfo as any)['apiKey'] || '';
        const model = (domainInfo as any)['model'] || 'deepseek-chat';
        const apiUrl = (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';
        
        if (!aiApiKey) {
            this.response.body = { error: 'AI API Key not configured' };
            this.response.status = 500;
            return;
        }

        let chatHistory: ChatMessage[] = [];
        try {
            chatHistory = JSON.parse(history);
        } catch (e) {
            // ignore parse error
        }

        const mcpClient = new McpClient();
        const tools = await mcpClient.getTools();
        
        const agentPrompt = adoc.content || '';
        let systemMessage = agentPrompt;
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji') && !systemMessage.includes('不使用表情')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              '\n\n【IMPORTANT RULES】You must strictly adhere to the following rules for tool calls:\n1. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n2. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n3. Each tool call response should be independent and focused solely on the current tool\'s result.\n4. After the last tool call completes, you should only reply with the last tool\'s result. Do NOT provide a comprehensive summary of all tools\' results (unless there are clear dependencies between tools that require integration).\n5. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n6. Tool calls proceed one by one sequentially: call one tool → immediately reply with that tool\'s result → decide if another tool is needed.\n7. If multiple tools are needed, proceed one by one: call the first tool → reply with the first tool\'s result → call the second tool → reply with the second tool\'s result, and so on. Each reply should be independent and focused on the current tool.';
            systemMessage = systemMessage + toolsInfo;
        }

        if (stream) {
            this.response.type = 'text/event-stream';
            this.response.addHeader('Cache-Control', 'no-cache');
            this.response.addHeader('Connection', 'keep-alive');
            this.response.addHeader('X-Accel-Buffering', 'no');
            this.context.response.type = 'text/event-stream';
            this.context.compress = false;
        }

        try {
            const requestBody: any = {
                model,
                max_tokens: 1024,
                messages: [
                    { role: 'system', content: systemMessage },
                    ...chatHistory,
                    { role: 'user', content: message },
                ],
                stream: stream,
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

            let messagesForTurn: any[] = [
                { role: 'system', content: systemMessage },
                ...chatHistory,
                { role: 'user', content: message },
            ];

            if (stream) {
                const res = this.context.res;
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                
                if (this.context.req.socket) {
                    this.context.req.socket.setNoDelay(true);
                    this.context.req.socket.setKeepAlive(true);
                }
                
                const streamResponse = new PassThrough({
                    highWaterMark: 0,
                    objectMode: false,
                });
                
                streamResponse.pipe(res);
                
                this.context.compress = false;
                (this.context.EjunzContext as any).request.websocket = true;
                this.response.body = null;
                this.context.body = null;
                
                let accumulatedContent = '';
                let finishReason = '';
                let toolCalls: any[] = [];
                let iterations = 0;
                const maxIterations = 5;
                let streamFinished = false;
                let waitingForToolCall = false;

                const processStream = async () => {
                    try {
                        AgentLogger.info('Starting stream request (API)', { apiUrl, model, streamEnabled: requestBody.stream });
                        streamFinished = false;
                        waitingForToolCall = false;
                        
                        await new Promise<void>((resolve, reject) => {
                            const req = request.post(apiUrl)
                                .send(requestBody)
                                .set('Authorization', `Bearer ${aiApiKey}`)
                                .set('content-type', 'application/json')
                                .buffer(false)
                                .timeout(60000)
                                .parse((res, callback) => {
                                    res.setEncoding('utf8');
                                    let buffer = '';
                                    
                                    res.on('data', (chunk: string) => {
                                        if (streamResponse.destroyed || streamResponse.writableEnded || streamFinished) return;
                                        
                                        buffer += chunk;
                                        const lines = buffer.split('\n');
                                        buffer = lines.pop() || '';
                                        
                                        for (const line of lines) {
                                            if (!line.trim() || !line.startsWith('data: ')) continue;
                                            const data = line.slice(6).trim();
                                            if (data === '[DONE]') {
                                                if (waitingForToolCall) {
                                                    AgentLogger.info('Received [DONE] but waiting for tool call, ignoring (API)');
                                                    callback(null, undefined);
                                                    return;
                                                }
                                                if (!streamResponse.destroyed && !streamResponse.writableEnded && !streamFinished) {
                                                    streamFinished = true;
                                                    streamResponse.write(`data: ${JSON.stringify({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                        ...chatHistory,
                                                        { role: 'user', content: message },
                                                        { role: 'assistant', content: accumulatedContent },
                                                    ]) })}\n\n`);
                                                    streamResponse.end();
                                                }
                                                callback(null, undefined);
                                                return;
                                            }
                                            if (!data) continue;
                                            
                                            try {
                                                const parsed = JSON.parse(data);
                                                const choice = parsed.choices?.[0];
                                                const delta = choice?.delta;
                                                
                                                if (delta?.content) {
                                                    accumulatedContent += delta.content;
                                                    if (!streamResponse.destroyed && !streamResponse.writableEnded && !streamFinished) {
                                                        const contentData = `data: ${JSON.stringify({ type: 'content', content: delta.content })}\n\n`;
                                                        streamResponse.write(contentData, 'utf8', () => {
                                                            AgentLogger.debug('Content chunk written:', delta.content.length, 'bytes');
                                                        });
                                                        AgentLogger.debug('Sent content chunk:', delta.content.length, 'bytes');
                                                    }
                                                }
                                                
                                                if (choice?.finish_reason) {
                                                    finishReason = choice.finish_reason;
                                                    if (finishReason === 'tool_calls') {
                                                        waitingForToolCall = true;
                                                        AgentLogger.info('Tool call detected, will continue sending accumulated content (API)');
                                                    }
                                                    AgentLogger.info('Received finish_reason:', finishReason);
                                                }
                                                
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
                                                AgentLogger.warn('Parse error in stream (API):', e, data.substring(0, 100));
                                            }
                                        }
                                    });
                                    
                                    res.on('end', async () => {
                                        AgentLogger.info('Stream ended (API)', { finishReason, iterations, accumulatedLength: accumulatedContent.length, streamFinished, waitingForToolCall });
                                        callback(null, undefined);
                                        
                                        if (!streamFinished || waitingForToolCall) {
                                            (async () => {
                                                try {
                                                    if (finishReason === 'tool_calls' && toolCalls.length > 0 && iterations < maxIterations) {
                                                        if (streamFinished) {
                                                            AgentLogger.info('Resetting streamFinished for tool call processing (API)');
                                                            streamFinished = false;
                                                        }
                                                        
                                                        iterations++;
                                                        AgentLogger.info('Processing tool calls (API)', { toolCallCount: toolCalls.length });
                                                        
                                                        if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                            // 只发送第一个工具的名称
                                                            const firstToolName = toolCalls[0]?.function?.name || 'unknown';
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call_start', tools: [firstToolName] })}\n\n`);
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call', tools: [firstToolName] })}\n\n`);
                                                        }
                                                        
                                                        const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                            id: tc.id || `call_${idx}`,
                                                            type: tc.type || 'function',
                                                            function: {
                                                                name: tc.function.name,
                                                                arguments: tc.function.arguments,
                                                            },
                                                        })) };
                                                        
                                                        // 一个工具一个回复模式：每次只调用第一个工具，然后立即让AI回复
                                                        const firstToolCall = assistantForTools.tool_calls[0];
                                                        
                                                        if (!firstToolCall) {
                                                            AgentLogger.warn('No tool call found in assistant message (API)');
                                                            return;
                                                        }
                                                        
                                                        let parsedArgs: any = {};
                                                        try {
                                                            parsedArgs = JSON.parse(firstToolCall.function.arguments);
                                                        } catch (e) {
                                                            parsedArgs = {};
                                                        }
                                                        
                                                        AgentLogger.info(`Calling first tool: ${firstToolCall.function.name} (API - One-by-One Mode)`, parsedArgs);
                                                        
                                                        let toolResult: any;
                                                        try {
                                                            toolResult = await mcpClient.callTool(firstToolCall.function.name, parsedArgs);
                                                            AgentLogger.info(`Tool ${firstToolCall.function.name} returned (API)`, { resultLength: JSON.stringify(toolResult).length });
                                                        } catch (toolError: any) {
                                                            AgentLogger.error(`Tool ${firstToolCall.function.name} failed (API):`, toolError);
                                                            toolResult = {
                                                                error: true,
                                                                message: toolError.message || String(toolError),
                                                                code: toolError.code || 'UNKNOWN_ERROR',
                                                            };
                                                        }
                                                        
                                                        const toolMsg = { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: firstToolCall.id };
                                                        
                                                        if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_result', tool: firstToolCall.function.name, result: toolResult })}\n\n`);
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call_complete' })}\n\n`);
                                                        }
                                                        
                                                        // 构建消息历史（只包含第一个工具调用和结果）
                                                        messagesForTurn = [
                                                            ...messagesForTurn,
                                                            { 
                                                                role: 'assistant', 
                                                                content: accumulatedContent, 
                                                                tool_calls: [firstToolCall] // 只包含已调用的工具
                                                            },
                                                            toolMsg,
                                                        ];
                                                        accumulatedContent = '';
                                                        finishReason = '';
                                                        toolCalls = [];
                                                        waitingForToolCall = false;
                                                        requestBody.messages = messagesForTurn;
                                                        requestBody.stream = true;
                                                        AgentLogger.info('Continuing stream after first tool call (API)', { 
                                                            toolName: firstToolCall.function.name,
                                                            remainingTools: assistantForTools.tool_calls.length - 1
                                                        });
                                                        await processStream();
                                                    } else if (!streamFinished) {
                                                        streamFinished = true;
                                                        if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                                ...chatHistory,
                                                                { role: 'user', content: message },
                                                                { role: 'assistant', content: accumulatedContent },
                                                            ]) })}\n\n`);
                                                            streamResponse.end();
                                                        }
                                                    }
                                                    resolve();
                                                } catch (err: any) {
                                                    AgentLogger.error('Error in stream end handler (API):', err);
                                                    streamFinished = true;
                                                    waitingForToolCall = false;
                                                    if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                        streamResponse.write(`data: ${JSON.stringify({ type: 'error', error: err.message || String(err) })}\n\n`);
                                                        streamResponse.end();
                                                    }
                                                    resolve();
                                                }
                                            })();
                                        } else {
                                            resolve();
                                        }
                                    });
                                    
                                    res.on('error', (err: any) => {
                                        AgentLogger.error('Stream response error (API):', err);
                                        callback(err, undefined);
                                        reject(err);
                                    });
                                });
                            
                            req.on('error', (err: any) => {
                                AgentLogger.error('Stream request error (API):', err);
                                if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                    streamResponse.write(`data: ${JSON.stringify({ type: 'error', error: err.message || String(err) })}\n\n`);
                                    streamResponse.end();
                                }
                                reject(err);
                            });
                            
                            req.end();
                        });
                    } catch (error: any) {
                        AgentLogger.error('Stream setup error (API):', error);
                        if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                            streamResponse.write(`data: ${JSON.stringify({ type: 'error', error: error.message || String(error) })}\n\n`);
                            streamResponse.end();
                        }
                    }
                };
                
                await processStream();
                return;
            }

            let currentResponse = await request.post(apiUrl)
                .send(requestBody)
                .set('Authorization', `Bearer ${aiApiKey}`)
                .set('content-type', 'application/json');

            let iterations = 0;
            const maxIterations = 5;

            while (true) {
                const choice = currentResponse.body.choices?.[0] || {};
                const finishReason = choice.finish_reason;
                const msg = choice.message || {};

                if (finishReason === 'tool_calls') {
                    const toolCalls = msg.tool_calls || [];
                    if (!toolCalls.length) break;

                    // 一个工具一个回复模式：每次只调用第一个工具
                    const firstToolCall = toolCalls[0];
                    if (!firstToolCall) break;

                    let parsedArgs: any = {};
                    try {
                        parsedArgs = typeof firstToolCall.function?.arguments === 'string'
                            ? JSON.parse(firstToolCall.function.arguments)
                            : firstToolCall.function?.arguments || {};
                    } catch (e) {
                        parsedArgs = {};
                    }
                    
                    AgentLogger.info(`Calling first tool: ${firstToolCall.function?.name} (One-by-One Mode)`);
                    const toolResult = await mcpClient.callTool(firstToolCall.function?.name, parsedArgs);
                    AgentLogger.info('Tool returned:', { toolResult });
                    
                    const toolMsg = { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: firstToolCall.id };
                    
                    const assistantForTools: any = { 
                        role: 'assistant', 
                        content: msg.content || '',
                        tool_calls: [firstToolCall] // 只包含已调用的工具
                    };

                    messagesForTurn = [
                        ...messagesForTurn,
                        assistantForTools,
                        toolMsg,
                    ];

                    iterations += 1;
                    if (iterations >= maxIterations) break;

                    currentResponse = await request.post(apiUrl)
                        .send({
                            model,
                            max_tokens: 1024,
                            messages: messagesForTurn,
                            tools: requestBody.tools,
                        })
                        .set('Authorization', `Bearer ${aiApiKey}`)
                        .set('content-type', 'application/json');
                    continue;
                }

                let finalContent = msg.content || '';
                if (typeof finalContent !== 'string') {
                    finalContent = typeof finalContent === 'object' ? JSON.stringify(finalContent) : String(finalContent);
                }

                this.response.body = {
                    message: finalContent,
                    history: JSON.stringify([
                        ...chatHistory,
                        { role: 'user', content: message },
                        { role: 'assistant', content: finalContent },
                    ]),
                };
                return;
            }

            const fallbackMsg = currentResponse.body?.choices?.[0]?.message?.content || '';
            const msgStr = typeof fallbackMsg === 'string' ? fallbackMsg : JSON.stringify(fallbackMsg || '');
            this.response.body = {
                message: msgStr,
                history: JSON.stringify([
                    ...chatHistory,
                    { role: 'user', content: message },
                    { role: 'assistant', content: msgStr },
                ]),
            };
        } catch (error: any) {
            AgentLogger.error('AI Chat Error:', {
                message: error.message,
                response: error.response?.body,
                stack: error.stack,
            });
            if (stream) {
                let streamResponse = this.response.body as PassThrough;
                if (!streamResponse || !(streamResponse instanceof PassThrough)) {
                    streamResponse = new PassThrough();
                    this.response.body = streamResponse;
                    this.context.body = streamResponse;
                }
                if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                    streamResponse.write(`data: ${JSON.stringify({ type: 'error', error: JSON.stringify(error.response?.body || error.message) })}\n\n`);
                    streamResponse.end();
                }
            } else {
                this.response.body = { error: JSON.stringify(error.response?.body || error.message) };
                this.response.status = 500;
            }
        }
    }
}

export class AgentEditHandler extends Handler {


    adoc: AgentDoc | null = null; 
    
    @param('aid', Types.String, true)
    async get(domainId: string, aid: string) {
        const agent = await Agent.get(domainId, aid);

        if (!agent) {
            console.warn(`[AgentEditHandler.get] No adoc found, skipping agent_edit.`);
            this.response.template = 'agent_edit.html';
            this.response.body = { adoc: null };
            return;
        }
        const udoc = await user.getById(domainId, agent.owner);

        this.response.template = 'agent_edit.html';
        this.response.body = {
            adoc: agent,
            tag: agent.tag,
            udoc,
        };
        this.UiContext.extraTitleContent = agent.title;
    }
    

    @param('title', Types.Title)
    @param('content', Types.Content)
    @post('tag', Types.Content, true, null, parseCategory)
    async postCreate(
        domainId: string,
        title: string,
        content: string,
        tag: string[] = [],
    ) {
        await this.limitRate('add_agent', 3600, 60);

        const domainInfo = await domain.get(domainId);
        if (!domainInfo) {
            throw new NotFoundError('Domain not found.');
        }

        const docId = await Agent.generateNextDocId(domainId);

        const aid = await Agent.addWithId(
            domainId,
            docId,
            this.user._id,
            title,
            content,
            this.request.ip,
            { tag: tag ?? [] }
        );
        
        this.response.body = { aid };
        this.response.redirect = this.url('agent_detail', { uid: this.user._id, aid });
    }
    
    @param('aid', Types.String)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @post('tag', Types.Content, true, null, parseCategory)
    async postUpdate(domainId: string, aid: string, title: string, content: string, tag: string[] = []) {
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
    
    
        const agent = await Agent.get(domainId, normalizedId);
        if (!agent) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}=${normalizedId}`);
        }
    
        const agentAid = agent.aid;
        const updatedAgent = await Agent.edit(domainId, agentAid, { title, content, tag: tag ?? [] });
    
    
        this.response.body = { aid: agentAid };
        this.response.redirect = this.url('agent_detail', { uid: this.user._id, aid: agentAid });
    }
    

}



export async function apply(ctx: Context) {
    ctx.Route('agent_domain', '/agent', AgentMainHandler);
    ctx.Route('agent_create', '/agent/create', AgentEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('agent_detail', '/agent/:aid', AgentDetailHandler);
    ctx.Route('agent_chat', '/agent/:aid/chat', AgentChatHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('agent_chat_ws', '/agent/:aid/chat-ws', AgentChatConnectionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('agent_edit', '/agent/:aid/edit', AgentEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('agent_mcp_status', '/agent/:aid/mcp-tools/status', AgentMcpStatusHandler);
    ctx.Route('agent_api', '/api/agent', AgentApiHandler);
    ctx.Connection('agent_api_ws', '/api/agent/chat-ws', AgentApiConnectionHandler);
    ctx.Connection('agent_stream_ws', '/api/agent/:aid/stream', AgentStreamConnectionHandler);
}
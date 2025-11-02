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
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n');
            systemMessage = agentPrompt + toolsInfo;
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
                                                            const toolNames = toolCalls.map(tc => tc.function?.name || 'unknown').filter(Boolean);
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call_start', tools: toolNames })}\n\n`);
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call', tools: toolNames })}\n\n`);
                                                        }
                                                        
                                                        const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                            id: tc.id || `call_${idx}`,
                                                            type: tc.type || 'function',
                                                            function: {
                                                                name: tc.function.name,
                                                                arguments: tc.function.arguments,
                                                            },
                                                        })) };
                                                        const toolMsgs: any[] = [];
                                                        for (const toolCall of assistantForTools.tool_calls) {
                                                            let parsedArgs: any = {};
                                                            try {
                                                                parsedArgs = JSON.parse(toolCall.function.arguments);
                                                            } catch (e) {
                                                                parsedArgs = {};
                                                            }
                                                            AgentLogger.info(`Calling tool: ${toolCall.function.name}`, parsedArgs);
                                                            const toolResult = await mcpClient.callTool(toolCall.function.name, parsedArgs);
                                                            AgentLogger.info(`Tool ${toolCall.function.name} returned`, { resultLength: JSON.stringify(toolResult).length });
                                                            toolMsgs.push({ role: 'tool', content: JSON.stringify(toolResult), tool_call_id: toolCall.id });
                                                            
                                                            if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                                streamResponse.write(`data: ${JSON.stringify({ type: 'tool_result', tool: toolCall.function.name, result: toolResult })}\n\n`);
                                                            }
                                                        }
                                                        
                                                        if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call_complete' })}\n\n`);
                                                        }
                                                        
                                                        messagesForTurn = [
                                                            ...messagesForTurn,
                                                            assistantForTools,
                                                            ...toolMsgs,
                                                        ];
                                                        accumulatedContent = '';
                                                        finishReason = '';
                                                        toolCalls = [];
                                                        waitingForToolCall = false;
                                                        requestBody.messages = messagesForTurn;
                                                        requestBody.stream = true;
                                                        AgentLogger.info('Continuing stream after tool call');
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

                    const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls };
                    const toolMsgs: any[] = [];
                    for (const toolCall of toolCalls) {
                        let parsedArgs: any = {};
                        try {
                            parsedArgs = typeof toolCall.function?.arguments === 'string'
                                ? JSON.parse(toolCall.function.arguments)
                                : toolCall.function?.arguments || {};
                        } catch (e) {
                            parsedArgs = {};
                        }
                        const toolResult = await mcpClient.callTool(toolCall.function?.name, parsedArgs);
                        AgentLogger.info('Tool returned:', { toolResult });
                        toolMsgs.push({ role: 'tool', content: JSON.stringify(toolResult), tool_call_id: toolCall.id });
                    }

                    messagesForTurn = [
                        ...messagesForTurn,
                        assistantForTools,
                        ...toolMsgs,
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
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n');
            systemMessage = agentPrompt + toolsInfo;
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
                                                    const idx = toolCall.index || 0;
                                                    if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                                    if (toolCall.id) toolCalls[idx].id = toolCall.id;
                                                    if (toolCall.function?.name) toolCalls[idx].function.name = toolCall.function.name;
                                                    if (toolCall.function?.arguments) toolCalls[idx].function.arguments += toolCall.function.arguments;
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
                                                    
                                                    const toolNames = toolCalls.map(tc => tc.function?.name || 'unknown').filter(Boolean);
                                                    this.send({ type: 'tool_call_start', tools: toolNames });
                                                    
                                                    const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                        id: tc.id || `call_${idx}`,
                                                        type: tc.type || 'function',
                                                        function: {
                                                            name: tc.function.name,
                                                            arguments: tc.function.arguments,
                                                        },
                                                    })) };
                                                    const toolMsgs: any[] = [];
                                                    for (const toolCall of assistantForTools.tool_calls) {
                                                        let parsedArgs: any = {};
                                                        try {
                                                            parsedArgs = JSON.parse(toolCall.function.arguments);
                                                        } catch (e) {
                                                            parsedArgs = {};
                                                        }
                                                        AgentLogger.info(`Calling tool: ${toolCall.function.name} (WS)`, parsedArgs);
                                                        const toolResult = await mcpClient.callTool(toolCall.function.name, parsedArgs);
                                                        AgentLogger.info(`Tool ${toolCall.function.name} returned (WS)`, { resultLength: JSON.stringify(toolResult).length });
                                                        toolMsgs.push({ role: 'tool', content: JSON.stringify(toolResult), tool_call_id: toolCall.id });
                                                        
                                                        this.send({ type: 'tool_result', tool: toolCall.function.name, result: toolResult });
                                                    }
                                                    
                                                    this.send({ type: 'tool_call_complete' });
                                                    
                                                    messagesForTurn = [
                                                        ...messagesForTurn,
                                                        assistantForTools,
                                                        ...toolMsgs,
                                                    ];
                                                    accumulatedContent = '';
                                                    finishReason = '';
                                                    toolCalls = [];
                                                    waitingForToolCall = false;
                                                    requestBody.messages = messagesForTurn;
                                                    requestBody.stream = true;
                                                    AgentLogger.info('Continuing stream after tool call (WS)');
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
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n');
            systemMessage = agentPrompt + toolsInfo;
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
                                                            const toolNames = toolCalls.map(tc => tc.function?.name || 'unknown').filter(Boolean);
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call_start', tools: toolNames })}\n\n`);
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call', tools: toolNames })}\n\n`);
                                                        }
                                                        
                                                        const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                            id: tc.id || `call_${idx}`,
                                                            type: tc.type || 'function',
                                                            function: {
                                                                name: tc.function.name,
                                                                arguments: tc.function.arguments,
                                                            },
                                                        })) };
                                                        const toolMsgs: any[] = [];
                                                        for (const toolCall of assistantForTools.tool_calls) {
                                                            let parsedArgs: any = {};
                                                            try {
                                                                parsedArgs = JSON.parse(toolCall.function.arguments);
                                                            } catch (e) {
                                                                parsedArgs = {};
                                                            }
                                                            AgentLogger.info(`Calling tool: ${toolCall.function.name}`, parsedArgs);
                                                            const toolResult = await mcpClient.callTool(toolCall.function.name, parsedArgs);
                                                            AgentLogger.info(`Tool ${toolCall.function.name} returned`, { resultLength: JSON.stringify(toolResult).length });
                                                            toolMsgs.push({ role: 'tool', content: JSON.stringify(toolResult), tool_call_id: toolCall.id });
                                                            
                                                            if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                                streamResponse.write(`data: ${JSON.stringify({ type: 'tool_result', tool: toolCall.function.name, result: toolResult })}\n\n`);
                                                            }
                                                        }
                                                        
                                                        if (!streamResponse.destroyed && !streamResponse.writableEnded) {
                                                            streamResponse.write(`data: ${JSON.stringify({ type: 'tool_call_complete' })}\n\n`);
                                                        }
                                                        
                                                        messagesForTurn = [
                                                            ...messagesForTurn,
                                                            assistantForTools,
                                                            ...toolMsgs,
                                                        ];
                                                        accumulatedContent = '';
                                                        finishReason = '';
                                                        toolCalls = [];
                                                        waitingForToolCall = false;
                                                        requestBody.messages = messagesForTurn;
                                                        requestBody.stream = true;
                                                        AgentLogger.info('Continuing stream after tool call (API)');
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

                    const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls };
                    const toolMsgs: any[] = [];
                    for (const toolCall of toolCalls) {
                        let parsedArgs: any = {};
                        try {
                            parsedArgs = typeof toolCall.function?.arguments === 'string'
                                ? JSON.parse(toolCall.function.arguments)
                                : toolCall.function?.arguments || {};
                        } catch (e) {
                            parsedArgs = {};
                        }
                        const toolResult = await mcpClient.callTool(toolCall.function?.name, parsedArgs);
                        AgentLogger.info('Tool returned:', { toolResult });
                        toolMsgs.push({ role: 'tool', content: JSON.stringify(toolResult), tool_call_id: toolCall.id });
                    }

                    messagesForTurn = [
                        ...messagesForTurn,
                        assistantForTools,
                        ...toolMsgs,
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
}
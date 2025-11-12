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
import system from '../model/system';
import parser from '@ejunz/utils/lib/search';
import { RepoSearchOptions } from '../interface';
import user from '../model/user';
import request from 'superagent';
import { randomstring } from '@ejunz/utils';
import { McpClient, ChatMessage } from '../model/agent';
import { Logger } from '../logger';
import { PassThrough } from 'stream';
import McpServerModel, { McpToolModel } from '../model/mcp';
import * as document from '../model/document';
import { RepoModel } from '../model/repo';
import NodeModel from '../model/node';

const AgentLogger = new Logger('agent');
export const parseCategory = (value: string) => value.replace(/，/g, ',').split(',').map((e) => e.trim());

/**
 * Auto-update agent memory
 * Focuses on recording agent work rules, tool usage patterns, and user guidance
 */
async function updateAgentMemory(
    domainId: string,
    adoc: AgentDoc,
    chatHistory: ChatMessage[],
    lastUserMessage: string,
    lastAssistantMessage: string,
): Promise<void> {
    try {
        const domainInfo = await domain.get(domainId);
        if (!domainInfo) {
            AgentLogger.warn('Domain not found for memory update', { domainId });
            return;
        }

        const aiApiKey = (domainInfo as any)['apiKey'] || '';
        const model = (domainInfo as any)['model'] || 'deepseek-chat';
        const apiUrl = (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';

        if (!aiApiKey) {
            AgentLogger.warn('AI API Key not configured, skipping memory update');
            return;
        }

        const currentMemory = adoc.memory || '';
        const recentHistory = chatHistory.slice(-15);
        
        const detectLanguage = (text: string): 'zh' | 'en' | 'other' => {
            if (/[\u4e00-\u9fa5]/.test(text)) {
                return 'zh';
            }
            return 'en';
        };
        let detectedLanguage: 'zh' | 'en' = 'en';
        for (let i = recentHistory.length - 1; i >= 0; i--) {
            if (recentHistory[i].role === 'user') {
                const lang = detectLanguage(recentHistory[i].content);
                if (lang === 'zh' || lang === 'en') {
                    detectedLanguage = lang;
                    break;
                }
            }
        }
        if (lastUserMessage) {
            const lang = detectLanguage(lastUserMessage);
            if (lang === 'zh' || lang === 'en') {
                detectedLanguage = lang;
            }
        }
        
        const toolUsageInfo: string[] = [];
        const userGuidance: Array<{ question?: string; guidance: string }> = [];
        
        const guidanceKeywords = detectedLanguage === 'zh' 
            ? /(需要|应该|必须|记得|下次|不要|避免|规则|方法|方式|要|不要|禁止|应该要|需要要)/
            : /(need|should|must|remember|next time|don't|avoid|rule|method|way|prefer|preference|require|when|if.*then)/i;
        
        for (let i = 0; i < recentHistory.length; i++) {
            const msg = recentHistory[i];
            
            if (msg.role === 'user') {
                const content = msg.content.toLowerCase();
                if (content.match(guidanceKeywords)) {
                    let relatedQuestion: string | undefined;
                    if (i > 0) {
                        if (recentHistory[i - 1].role === 'assistant') {
                            for (let j = i - 2; j >= 0 && j >= i - 5; j--) {
                                if (recentHistory[j].role === 'user') {
                                    relatedQuestion = recentHistory[j].content;
                                    break;
                                }
                            }
                        } else if (recentHistory[i - 1].role === 'user') {
                            relatedQuestion = recentHistory[i - 1].content;
                        }
                    }
                    
                    userGuidance.push({
                        question: relatedQuestion,
                        guidance: msg.content
                    });
                }
            }
            
            if (msg.role === 'assistant' && (msg as any).tool_calls) {
                const toolCalls = (msg as any).tool_calls;
                for (const tc of toolCalls) {
                    toolUsageInfo.push(`Used tool: ${tc.function?.name}, args: ${JSON.stringify(tc.function?.arguments || {})}`);
                }
            }
            
            if (msg.role === 'tool') {
                try {
                    const result = JSON.parse(msg.content);
                    if (result.error) {
                        toolUsageInfo.push(`Tool call error: ${msg.content}`);
                    }
                } catch (e) {
                }
            }
        }

        const userLabel = detectedLanguage === 'zh' ? 'User' : 'User';
        const assistantLabel = detectedLanguage === 'zh' ? 'Assistant' : 'Assistant';
        const toolLabel = detectedLanguage === 'zh' ? 'Tool result' : 'Tool result';
        const toolCallLabel = detectedLanguage === 'zh' ? 'called tools' : 'called tools';
        
        const conversationSummary = recentHistory.map(msg => {
            if (msg.role === 'user') return `${userLabel}: ${msg.content}`;
            if (msg.role === 'assistant') {
                let content = `${assistantLabel}: ${msg.content}`;
                if ((msg as any).tool_calls) {
                    const toolNames = (msg as any).tool_calls.map((tc: any) => tc.function?.name).filter(Boolean);
                    if (toolNames.length > 0) {
                        content += ` [${toolCallLabel}: ${toolNames.join(', ')}]`;
                    }
                }
                return content;
            }
            if (msg.role === 'tool') return `${toolLabel}: ${msg.content.substring(0, 200)}...`;
            return '';
        }).filter(Boolean).join('\n');

        const agentContent = adoc.content || '';
        
        const languageInstruction = 'Please generate the work rules memory in English. If the existing memory is in another language, convert it to English and maintain consistency.';
        
        const memoryPrompt = `You are an agent work rules management assistant. Your task is to extract and update the agent's work rules memory based on conversation history.

Agent's Role Definition (content):
${agentContent || '(No role definition)'}

Current Work Rules Memory:
${currentMemory || '(No rules memory yet)'}

Recent Conversation History (last 15 messages):
${conversationSummary}

Detected Tool Usage:
${toolUsageInfo.length > 0 ? toolUsageInfo.join('\n') : 'No tools used in this conversation'}

Detected User Guidance:
${userGuidance.length > 0 ? userGuidance.map(g => {
    if (g.question) {
        return `Question: ${g.question}\nGuidance: ${g.guidance}`;
    }
    return `Guidance: ${g.guidance}`;
}).join('\n\n') : 'No obvious guidance in this conversation'}

Latest Conversation:
User: ${lastUserMessage}
Assistant: ${lastAssistantMessage}

Please update the agent's work rules memory based on the above information. The memory should focus on:
1. **Question-Guidance Mapping**: When a user provides explicit guidance for a specific question, must record "When user asks xxx, should xxx". This is the most important record item to ensure that next time the user asks the same question, strictly follow the user's guidance.
2. **Tool Usage Rules**: Under what circumstances should which tool be called, how to call it (e.g., "When user asks xxx, need to call xxx tool's xxx method")
3. **Workflow Guidance**: Workflows, methods, and rules explicitly mentioned by the user
4. **Error Avoidance**: Errors corrected by the user, ensure they won't be repeated next time (e.g., "Don't xxx, should xxx")
5. **User Preferences**: Work preferences and requirements explicitly expressed by the user

Important Principles:
- **Question-Guidance Mapping Priority**: If the user provides guidance for a specific question (e.g., "When user asks xxx, you should xxx"), must clearly record this correspondence, format: "When user asks [question keywords]: [user's guidance]".
- **Strictly Execute User Guidance**: Once user guidance for a specific question is recorded, next time when encountering the same or similar question, must strictly follow the guidance, do not deviate.
- **No Conflict with Role Definition**: Work rules memory is a supplement and refinement to the role definition (content), should not conflict with it. Do not change the agent's basic role positioning.
- **Only Record Explicit Rules and Guidance**: Do not record general conversation content
- **If User Explicitly Guides or Corrects Agent Behavior, Must Record**
- **If No New Work Rules or Guidance in Conversation, Keep Existing Memory Unchanged or Only Minor Optimization**
- **Memory Should Be Structured Rule List** for agent reference in subsequent conversations
- **If User Guidance Conflicts with Role Definition**: Prioritize role definition, but can annotate user preferences in memory (e.g., "User prefers xxx, but without affecting role positioning")
- **Language Consistency**: ${languageInstruction}

Directly output the updated work rules memory, use concise and clear format (can use lists or bullet points), use English, do not add any explanation or prefix.`;

        const systemMessage = 'You are a professional agent work rules management assistant, specializing in extracting and organizing agent work rules, tool usage patterns, and user guidance from conversations to generate clear and concise work rules memory.';
        
        const response = await request.post(apiUrl)
            .send({
                model,
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: memoryPrompt },
                ],
                max_tokens: 800,
                temperature: 0.5,
            })
            .set('Authorization', `Bearer ${aiApiKey}`)
            .set('content-type', 'application/json');

        const newMemory = response.body?.choices?.[0]?.message?.content?.trim() || '';
        
        if (newMemory && newMemory !== currentMemory) {
            await Agent.edit(domainId, adoc.aid, { memory: newMemory });
            AgentLogger.info('Agent memory updated', { aid: adoc.aid, memoryLength: newMemory.length });
        }
    } catch (error: any) {
        AgentLogger.error('Failed to update agent memory', error);
    }
}

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
                title: this.renderTitle(this.translate('agent_domain')),
                fragments: (await Promise.all([
                    this.renderHTML('partials/agent_list.html', {
                        page, ppcount, pcount, adocs, psdict, qs: q,
                    }),
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



// Internal interface: Core logic for Agent Chat processing
// Used by Agent API and client connections
export interface AgentChatEventCallbacks {
    onContent?: (content: string) => void;
    onToolCall?: (tools: any[]) => void | Promise<void>;
    onToolResult?: (tool: string, result: any) => void;
    onDone?: (message: string, history: string) => void;
    onError?: (error: string) => void;
}

export async function processAgentChatInternal(
    adoc: AgentDoc,
    message: string,
    history: ChatMessage[] | string,
    callbacks: AgentChatEventCallbacks,
): Promise<void> {
    try {
        const domainInfo = await domain.get(adoc.domainId);
        if (!domainInfo) {
            callbacks.onError?.('Domain not found');
            return;
        }

        const aiApiKey = (domainInfo as any)['apiKey'] || '';
        const model = (domainInfo as any)['model'] || 'deepseek-chat';
        const apiUrl = (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';

        if (!aiApiKey) {
            callbacks.onError?.('AI API Key not configured');
            return;
        }

        let chatHistory: ChatMessage[] = [];
        if (typeof history === 'string') {
            try {
                chatHistory = JSON.parse(history);
            } catch (e) {
                // ignore parse error
            }
        } else {
            chatHistory = history;
        }

        AgentLogger.info('processAgentChatInternal: Getting assigned tools', { 
            domainId: adoc.domainId, 
            mcpToolIds: adoc.mcpToolIds?.length || 0,
            mcpToolIdsArray: adoc.mcpToolIds?.map(id => id.toString()) || [],
            repoIds: adoc.repoIds?.length || 0,
            repoIdsArray: adoc.repoIds || []
        });
        const tools = await getAssignedTools(adoc.domainId, adoc.mcpToolIds, adoc.repoIds);
        AgentLogger.info('processAgentChatInternal: Got tools', { 
            toolCount: tools.length, 
            toolNames: tools.map(t => t.name),
            tools: tools.map(t => ({ name: t.name, hasSchema: !!t.inputSchema }))
        });
        
        if (tools.length === 0) {
            AgentLogger.warn('processAgentChatInternal: No tools found!', {
                domainId: adoc.domainId,
                mcpToolIds: adoc.mcpToolIds?.length || 0,
                agentId: adoc.aid
            });
        }
        
        const mcpClient = new McpClient();

        const agentPrompt = adoc.content || '';
        let systemMessage = agentPrompt;

        const truncateMemory = (memory: string, maxLength: number = 2000): string => {
            if (!memory || memory.length <= maxLength) {
                return memory;
            }
            return memory.substring(0, maxLength) + '\n\n[... Memory truncated, keeping most important rules ...]';
        };
        if (adoc.memory) {
            const truncatedMemory = truncateMemory(adoc.memory);
            systemMessage += `\n\n---\n【Work Rules Memory - Supplementary Guidelines】\n${truncatedMemory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. For example, if the memory says "When user asks xxx, should xxx", you must follow that exactly when the user asks that question.\n\nNote: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
        }

        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }

        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              `\n\n【CRITICAL - YOU MUST READ THIS FIRST】\n**MANDATORY: SPEAK BEFORE TOOL CALLS**\nBefore calling ANY tool, you MUST first output a message explaining what you are about to do. This is MANDATORY and NON-NEGOTIABLE.\n\nExample workflow:\n1. User asks: "Find the switch"\n2. You MUST first output: "Let me help you find the switch device..." (or similar)\n3. THEN call the tool (e.g., zigbee_list_devices)\n4. After tool returns, output the results\n\nIf you call a tool WITHOUT first explaining what you are doing, you are violating the rules. The conversation should feel natural - you speak first, then act, then speak about the results.\n\n【TOOL USAGE STRATEGY - CRITICAL】\n1. **Proactive Multi-Tool Problem Solving**: When a user's question requires multiple tools or steps to fully answer, you MUST actively call tools in sequence until you have enough information. Do not stop after the first tool if the problem clearly needs more.\n2. **Knowledge Base Search Priority**: When users ask questions about information, documentation, stored knowledge, or specific topics, ALWAYS use the search_repo tool first to check if the information exists in the knowledge base. Even if you think you might know the answer, search the knowledge base to ensure accuracy and completeness.\n3. **Sequential Tool Execution**: The system executes one tool at a time. After each tool completes, you receive the result and can immediately call the next tool if needed.\n4. **Complete Before Responding**: When solving complex problems, gather ALL necessary information through tool calls BEFORE giving your final answer to the user. Only reply after you have completed the tool chain needed to answer the question.\n5. **Tool Chaining Examples**:\n   - User: "Do I have classes tomorrow?" → You should: (1) FIRST say "Let me check tomorrow's schedule..." (2) call get_current_time to know what day tomorrow is, (3) call search_repo to check if there's schedule/calendar info in knowledge base, (4) then provide complete answer\n   - User: "View files in repo" → You should: (1) FIRST say "Let me search for files in the knowledge base..." (2) call search_repo to find relevant repo entries, (3) if found, analyze content, (4) present comprehensive results\n   - User asks about any topic → You should: (1) FIRST say what you will do, (2) THEN search knowledge base using search_repo, (3) analyze results, (4) if needed, call other tools, (5) provide answer based on all information gathered\n6. **When to Stop Tool Chain**: Only stop calling tools when: (a) you have enough information to fully answer the question, (b) you need user clarification, or (c) no more relevant tools are available.\n7. **System Behavior**: The system processes tools one-by-one automatically. After each tool result, you decide whether to call another tool or provide the answer.\n\n**KEY PRINCIPLE**: Be proactive and thorough. Always search the knowledge base first when users ask about information. If a question needs multiple tools, call them all before responding. Do not make the user ask multiple times or give incomplete answers.\n\n【IMPORTANT RULES - BOTTOM-LEVEL FUNDAMENTAL RULES】You must strictly adhere to the following rules for tool calls:\n1. **ALWAYS speak first before calling tools (MANDATORY)**: When you need to call a tool, you MUST first output and stream a message to the user explaining what you are about to do. Examples:\n   Examples: "Let me search the knowledge base..." / "Let me find the switch devices..." / "Let me check the relevant information..."\n   This message MUST be streamed BEFORE you call the tool. This gives the user immediate feedback and makes the conversation feel natural and responsive. ONLY AFTER you have explained what you are doing should you call the tool. Calling a tool without first speaking is STRICTLY FORBIDDEN.\n2. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n3. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n4. Each tool call response should be independent and focused solely on the current tool's result.\n5. After the last tool call completes, you should only reply with the last tool's result. Do NOT provide a comprehensive summary of all tools' results (unless there are clear dependencies between tools that require integration).\n6. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n7. Tool calls proceed one by one sequentially: first explain what you will do → call one tool → immediately reply with that tool's result → decide if another tool is needed.\n8. If multiple tools are needed, proceed one by one: explain what you will do → call the first tool → reply with the first tool's result → explain what you will do next → call the second tool → reply with the second tool's result, and so on. Each reply should be independent and focused on the current tool.`;
            systemMessage = systemMessage + toolsInfo;
        }

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
                    // 如果超过最大消息数，移除最旧的消息（保留系统消息）
                    if (systemMsg && finalMessages.length > maxMessages + 1) {
                        finalMessages.splice(1, 1);
                    } else if (!systemMsg && finalMessages.length > maxMessages) {
                        finalMessages.shift();
                    }
                }
            }
            
            // 反转回正确的顺序（系统消息在前，然后是其他消息）
            if (systemMsg) {
                return [systemMsg, ...finalMessages.slice(1).reverse()];
            } else {
                return finalMessages.reverse();
            }
        };
        
        // 限制历史消息长度，避免请求体过大
        // 保留最近的 20 条消息，或者总字符数不超过 8000
        let limitedHistory = [...chatHistory];
        const maxHistoryMessages = 20;
        const maxHistoryChars = 8000;
        
        if (limitedHistory.length > maxHistoryMessages) {
            limitedHistory = limitedHistory.slice(-maxHistoryMessages);
        }
        
        let totalChars = systemMessage.length + message.length;
        const finalHistory: any[] = [];
        for (let i = limitedHistory.length - 1; i >= 0; i--) {
            const msg = limitedHistory[i];
            const msgStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
            totalChars += msgStr.length;
            if (totalChars > maxHistoryChars) {
                break;
            }
            finalHistory.unshift(msg);
        }
        
        const requestBody: any = {
            model,
            max_tokens: 1024,
            messages: truncateMessages([
                { role: 'system', content: systemMessage },
                ...finalHistory,
                { role: 'user', content: message },
            ]),
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
            AgentLogger.info('processAgentChatInternal: Added tools to request', { toolCount: requestBody.tools.length });
        } else {
            AgentLogger.warn('processAgentChatInternal: No tools available', { domainId: adoc.domainId, mcpToolIds: adoc.mcpToolIds?.length || 0 });
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
                AgentLogger.info('Starting stream request (internal)', { 
                    apiUrl, 
                    model, 
                    toolCount: tools.length,
                    hasTools: tools.length > 0,
                    requestBodyHasTools: !!requestBody.tools
                });
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
                                            callback(null, undefined);
                                            return;
                                        }
                                        streamFinished = true;
                                        const finalHistory = JSON.stringify([
                                            ...chatHistory,
                                            { role: 'user', content: message },
                                            { role: 'assistant', content: accumulatedContent },
                                        ]);
                                        callbacks.onDone?.(accumulatedContent, finalHistory);
                                        
                                        if (adoc && accumulatedContent) {
                                            updateAgentMemory(
                                                adoc.domainId,
                                                adoc,
                                                chatHistory,
                                                message,
                                                accumulatedContent,
                                            ).catch(err => AgentLogger.error('Failed to update memory in background', err));
                                        }
                                        resolve();
                                        return;
                                    }
                                    if (!data) continue;

                                    try {
                                        const parsed = JSON.parse(data);
                                        const choice = parsed.choices?.[0];
                                        const delta = choice?.delta;

                                        if (delta?.content) {
                                            accumulatedContent += delta.content;
                                            callbacks.onContent?.(delta.content);
                                        }

                                        if (choice?.finish_reason) {
                                            finishReason = choice.finish_reason;
                                            AgentLogger.info('processAgentChatInternal: finish_reason detected', { finishReason });
                                            if (finishReason === 'tool_calls') {
                                                waitingForToolCall = true;
                                                AgentLogger.info('processAgentChatInternal: Waiting for tool call');
                                            }
                                        }

                                        if (delta?.tool_calls) {
                                            AgentLogger.info('processAgentChatInternal: tool_calls delta detected', { toolCallsCount: delta.tool_calls?.length || 0 });
                                            for (const toolCall of delta.tool_calls || []) {
                                                const idx = toolCall.index || 0;
                                                if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                                if (toolCall.id) toolCalls[idx].id = toolCall.id;
                                                if (toolCall.function?.name) toolCalls[idx].function.name = toolCall.function.name;
                                                if (toolCall.function?.arguments) toolCalls[idx].function.arguments += toolCall.function.arguments;
                                                AgentLogger.debug('processAgentChatInternal: Processing tool call', { index: idx, name: toolCall.function?.name });
                                            }
                                        }
                                    } catch (e) {
                                        AgentLogger.warn('Parse error in stream (internal):', e);
                                    }
                                }
                            });

                            res.on('end', async () => {
                                AgentLogger.info('Stream ended (internal)', { finishReason, iterations, accumulatedLength: accumulatedContent.length, streamFinished, waitingForToolCall });
                                callback(null, undefined);

                                AgentLogger.info('processAgentChatInternal: Stream end handler', { streamFinished, waitingForToolCall, finishReason, toolCallsLength: toolCalls.length, iterations });
                                if (!streamFinished || waitingForToolCall) {
                                    (async () => {
                                        try {
                                            AgentLogger.info('processAgentChatInternal: Checking tool calls', { finishReason, toolCallsLength: toolCalls.length, iterations, maxIterations });
                                            if (finishReason === 'tool_calls' && toolCalls.length > 0 && iterations < maxIterations) {
                                                if (streamFinished) {
                                                    streamFinished = false;
                                                }

                                                iterations++;
                                                AgentLogger.info('Processing tool calls (internal)', { toolCallCount: toolCalls.length });

                                                const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                    id: tc.id || `call_${idx}`,
                                                    type: tc.type || 'function',
                                                    function: {
                                                        name: tc.function.name,
                                                        arguments: tc.function.arguments,
                                                    },
                                                })) };

                                                const firstToolCall = assistantForTools.tool_calls[0];

                                                if (!firstToolCall) {
                                                    AgentLogger.warn('No tool call found in assistant message (internal)');
                                                    return;
                                                }

                                                const firstToolName = firstToolCall.function.name;
                                                const toolCallResult = callbacks.onToolCall?.([firstToolName]);
                                                // Support async onToolCall (e.g., waiting for TTS playback)
                                                if (toolCallResult instanceof Promise) {
                                                    await toolCallResult;
                                                }

                                                let parsedArgs: any = {};
                                                try {
                                                    parsedArgs = JSON.parse(firstToolCall.function.arguments);
                                                } catch (e) {
                                                    parsedArgs = {};
                                                }

                                                AgentLogger.info(`Calling first tool: ${firstToolName} (internal - One-by-One Mode)`, parsedArgs);

                                                let toolResult: any;
                                                try {
                                                    const toolArgs = firstToolName.match(/^repo_\d+_/) 
                                                        ? { ...parsedArgs, __agentId: (adoc as any).aid || (adoc as any)._id?.toString() || 'unknown', __agentName: (adoc as any).name || 'agent' }
                                                        : parsedArgs;
                                                    toolResult = await mcpClient.callTool(firstToolName, toolArgs, adoc.domainId);
                                                    AgentLogger.info(`Tool ${firstToolName} returned (internal)`, { resultLength: JSON.stringify(toolResult).length });
                                                } catch (toolError: any) {
                                                    AgentLogger.error(`Tool ${firstToolName} failed (internal):`, toolError);
                                                    toolResult = {
                                                        error: true,
                                                        message: toolError.message || String(toolError),
                                                        code: toolError.code || 'UNKNOWN_ERROR',
                                                    };
                                                }

                                                callbacks.onToolResult?.(firstToolName, toolResult);

                                                const toolMsg = { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: firstToolCall.id };

                                                let updatedMessages = [
                                                    ...messagesForTurn,
                                                    {
                                                        role: 'assistant',
                                                        content: accumulatedContent,
                                                        tool_calls: [firstToolCall] // 只包含已调用的工具
                                                    },
                                                    toolMsg,
                                                ];
                                                
                                                messagesForTurn = truncateMessages(updatedMessages);
                                                accumulatedContent = '';
                                                finishReason = '';
                                                toolCalls = [];
                                                waitingForToolCall = false;
                                                requestBody.messages = messagesForTurn;
                                                requestBody.stream = true;
                                                AgentLogger.info('Continuing stream after first tool call (internal)', {
                                                    toolName: firstToolName,
                                                    remainingTools: assistantForTools.tool_calls.length - 1
                                                });
                                                await processStream();
                                            } else if (!streamFinished) {
                                                streamFinished = true;
                                                const finalHistory = JSON.stringify([
                                                    ...chatHistory,
                                                    { role: 'user', content: message },
                                                    { role: 'assistant', content: accumulatedContent },
                                                ]);
                                                callbacks.onDone?.(accumulatedContent, finalHistory);
                                                
                                                if (adoc && accumulatedContent) {
                                                    updateAgentMemory(
                                                        adoc.domainId,
                                                        adoc,
                                                        chatHistory,
                                                        message,
                                                        accumulatedContent,
                                                    ).catch(err => AgentLogger.error('Failed to update memory in background', err));
                                                }
                                            }
                                            resolve();
                                        } catch (err: any) {
                                            AgentLogger.error('Error in stream end handler (internal):', err);
                                            streamFinished = true;
                                            waitingForToolCall = false;
                                            callbacks.onError?.(err.message || String(err));
                                            resolve();
                                        }
                                    })();
                                } else {
                                    resolve();
                                }
                            });

                            res.on('error', (err: any) => {
                                AgentLogger.error('Stream response error (internal):', err);
                                callback(err, undefined);
                                reject(err);
                            });
                        });

                    req.on('error', (err: any) => {
                        AgentLogger.error('Stream request error (internal):', err);
                        callbacks.onError?.(err.message || String(err));
                        reject(err);
                    });

                    req.end();
                });
            } catch (error: any) {
                AgentLogger.error('Stream setup error (internal):', error);
                callbacks.onError?.(error.message || String(error));
            }
        };

        await processStream();
    } catch (error: any) {
        AgentLogger.error('AI Chat Error (internal):', {
            message: error.message,
            response: error.response?.body,
            stack: error.stack,
        });
        callbacks.onError?.(error.message || String(error));
    }
}

// Enhanced to also fetch from real-time MCP connections to ensure all tools are available
// If mcpToolIds is empty, returns all available tools from database (since tools are synced from MCP servers to DB)
// Also includes tools from repos specified in repoIds
async function getAssignedTools(domainId: string, mcpToolIds?: ObjectId[], repoIds?: number[]): Promise<any[]> {
    const allToolIds = new Set<string>();
    
    if (mcpToolIds) {
        for (const toolId of mcpToolIds) {
            allToolIds.add(toolId.toString());
        }
    }
    
    if (repoIds && repoIds.length > 0) {
        AgentLogger.info('getAssignedTools: Getting tools from repos', { repoIds });
        try {
            const { createDefaultRepoMcpTools } = await import('./repo');
            const { default: McpServerModel } = await import('../model/mcp');
            
            for (const rpid of repoIds) {
                const repo = await RepoModel.getRepoByRpid(domainId, rpid);
                if (repo && repo.mcpServerId) {
                    try {
                        const server = await McpServerModel.getByServerId(domainId, repo.mcpServerId);
                        if (server) {
                            await createDefaultRepoMcpTools(domainId, repo.mcpServerId, server.docId, rpid, repo.owner);
                        }
                    } catch (error: any) {
                        AgentLogger.warn('getAssignedTools: Failed to ensure default tools for repo %d: %s', rpid, error.message);
                    }
                    
                    const tools = await McpToolModel.getByServer(domainId, repo.mcpServerId);
                    for (const tool of tools) {
                        allToolIds.add(tool.docId.toString());
                    }
                    AgentLogger.info('getAssignedTools: Found %d tools from repo %d (serverId: %d)', 
                        tools.length, rpid, repo.mcpServerId);
                }
            }
        } catch (error: any) {
            AgentLogger.warn('getAssignedTools: Failed to get tools from repos: %s', error.message);
        }
    }
    
    const finalToolIds: ObjectId[] = Array.from(allToolIds).map(id => new ObjectId(id));
    
    if (finalToolIds.length === 0) {
        AgentLogger.info('getAssignedTools: No toolIds specified, fetching all available tools from database');
        try {
            // First try to get from database (tools are synced from MCP servers)
            const servers = await McpServerModel.getByDomain(domainId);
            const allTools: any[] = [];
            for (const server of servers) {
                const tools = await McpToolModel.getByServer(domainId, server.serverId);
                for (const tool of tools) {
                    allTools.push({
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                    });
                }
            }
            AgentLogger.info('getAssignedTools: Got all tools from database', { 
                toolCount: allTools.length, 
                toolNames: allTools.map(t => t.name),
                serverCount: servers.length
            });
            
            // Also try to get from real-time connections to merge any new tools
            try {
                const mcpClient = new McpClient();
                const realtimeTools = await mcpClient.getTools();
                if (realtimeTools.length > 0) {
                    AgentLogger.info('getAssignedTools: Also found realtime tools', { 
                        realtimeCount: realtimeTools.length 
                    });
                    // Merge realtime tools with database tools (realtime takes priority)
                    const toolMap = new Map<string, any>();
                    // First add database tools
                    for (const tool of allTools) {
                        toolMap.set(tool.name, tool);
                    }
                    // Then add/override with realtime tools
                    for (const tool of realtimeTools) {
                        toolMap.set(tool.name, {
                            name: tool.name,
                            description: tool.description || '',
                            inputSchema: tool.inputSchema || null,
                        });
                    }
                    return Array.from(toolMap.values());
                }
            } catch (realtimeError: any) {
                AgentLogger.debug('Failed to fetch realtime tools (non-critical): %s', realtimeError.message);
            }
            
            return allTools;
        } catch (dbError: any) {
            AgentLogger.warn('Failed to fetch all tools from database: %s', dbError.message);
            // Last resort: try realtime connections
            try {
                const mcpClient = new McpClient();
                const realtimeTools = await mcpClient.getTools();
                AgentLogger.info('getAssignedTools: Got tools from realtime (fallback)', { 
                    toolCount: realtimeTools.length 
                });
                return realtimeTools.map(tool => ({
                    name: tool.name,
                    description: tool.description || '',
                    inputSchema: tool.inputSchema || null,
                }));
            } catch (realtimeError: any) {
                AgentLogger.warn('Failed to fetch tools from realtime (fallback): %s', realtimeError.message);
                return [];
            }
        }
    }
    
    // First, get tools from database and build a map by tool name
    const dbToolsMap = new Map<string, any>();
    const assignedToolNames = new Set<string>();
    
    for (const toolId of finalToolIds) {
        try {
            const tool = await document.get(domainId, document.TYPE_MCP_TOOL, toolId);
            if (tool) {
                dbToolsMap.set(tool.name, {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                });
                assignedToolNames.add(tool.name);
            }
        } catch (error) {
            AgentLogger.warn('Invalid tool ID: %s', toolId.toString());
        }
    }
    
    // Also fetch from real-time MCP connections to get tools that might not be in DB yet
    // or to get more up-to-date tool definitions
    try {
        const mcpClient = new McpClient();
        const realtimeTools = await mcpClient.getTools();
        
        // Merge realtime tools with database tools
        // Priority: realtime tools (more up-to-date) > database tools
        const finalTools: any[] = [];
        const processedNames = new Set<string>();
        
        // First, add realtime tools that match assigned tool names
        for (const realtimeTool of realtimeTools) {
            if (assignedToolNames.has(realtimeTool.name)) {
                finalTools.push({
                    name: realtimeTool.name,
                    description: realtimeTool.description || '',
                    inputSchema: realtimeTool.inputSchema || null,
                });
                processedNames.add(realtimeTool.name);
            }
        }
        
        // Then, add database tools that weren't found in realtime (fallback)
        for (const [toolName, dbTool] of dbToolsMap) {
            if (!processedNames.has(toolName)) {
                finalTools.push(dbTool);
            }
        }
        
        AgentLogger.info('getAssignedTools: dbTools=%d, realtimeTools=%d, matchedTools=%d, finalTools=%d', 
            dbToolsMap.size, realtimeTools.length, processedNames.size, finalTools.length);
        AgentLogger.info('getAssignedTools: details', {
            dbToolNames: Array.from(dbToolsMap.keys()),
            realtimeToolNames: realtimeTools.map(t => t.name),
            assignedToolNames: Array.from(assignedToolNames),
            finalToolNames: finalTools.map(t => t.name)
        });
        
        return finalTools;
    } catch (error: any) {
        AgentLogger.warn('Failed to fetch realtime tools, using DB tools only: %s', error.message);
        // Fallback to database tools only
        return Array.from(dbToolsMap.values());
    }
}

class AgentMcpStatusHandler extends Handler {
    @param('aid', Types.String)
    async get(domainId: string, aid: string) {
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
        const adoc = await Agent.get(domainId, normalizedId);
        if (!adoc) {
            this.response.body = { connected: false, toolCount: 0 };
            return;
        }
        
        const tools = await getAssignedTools(domainId, adoc.mcpToolIds, adoc.repoIds);
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

        const allMcpTools: any[] = [];
        try {
            const servers = await McpServerModel.getByDomain(domainId);
            for (const server of servers) {
                const tools = await McpToolModel.getByServer(domainId, server.serverId);
                for (const tool of tools) {
                    allMcpTools.push({
                        _id: tool._id,
                        toolId: tool.toolId,
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                        serverId: tool.serverId,
                        serverName: server.name,
                    });
                }
            }
        } catch (error: any) {
            AgentLogger.error('Failed to load MCP tools: %s', error.message);
        }

        const assignedToolIds = (adoc.mcpToolIds || []).map(id => id.toString());

        this.response.template = 'agent_detail.html';
        this.response.body = {
            domainId,
            aid: adoc.aid, 
            adoc,
            udoc,
            apiUrl,
            allMcpTools,
            assignedToolIds,
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

    @param('aid', Types.String)
    @post('toolIds', Types.ArrayOf(Types.String), true)
    async postAssignTools(domainId: string, aid: string, toolIds?: string[]) {
        this.response.template = null;
        
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
        const adoc = await Agent.get(domainId, normalizedId);
        
        if (!adoc) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}: ${normalizedId}`);
        }

        if (!this.user.own(adoc) && !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            throw new PermissionError('Only owner or system administrator can assign tools');
        }

        const validToolIds: ObjectId[] = [];
        if (toolIds && Array.isArray(toolIds)) {
            for (const toolIdStr of toolIds) {
                try {
                    const toolId = new ObjectId(toolIdStr);
                    const tool = await document.get(domainId, document.TYPE_MCP_TOOL, toolId);
                    if (tool) {
                        validToolIds.push(toolId);
                    }
                } catch (error) {
                    AgentLogger.warn('Invalid tool ID: %s', toolIdStr);
                }
            }
        }

        await Agent.edit(domainId, adoc.aid, { mcpToolIds: validToolIds });

        this.response.body = { 
            success: true, 
            message: `Assigned ${validToolIds.length} tools`,
            toolCount: validToolIds.length
        };
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

        const assignedToolIds = new Set((adoc.mcpToolIds || []).map(id => id.toString()));

        const repoServerIdMap = new Map<number, number>(); // mcpServerId -> rpid
        const allRepos: any[] = [];
        try {
            const repos = await RepoModel.getAllRepos(domainId);
            for (const repo of repos) {
                allRepos.push({
                    rpid: repo.rpid,
                    title: repo.title,
                    mcpServerId: repo.mcpServerId,
                });
                if (repo.mcpServerId) {
                    repoServerIdMap.set(repo.mcpServerId, repo.rpid);
                }
            }
        } catch (error: any) {
            AgentLogger.error('Failed to load repos: %s', error.message);
        }

        const providerServers: any[] = [];
        const nodeServers: any[] = []; // 暂时为空
        const repoServers: any[] = [];

        try {
            const servers = await McpServerModel.getByDomain(domainId);
            for (const server of servers) {
                const allTools = await McpToolModel.getByServer(domainId, server.serverId);
                const assignedTools = allTools.filter(tool => assignedToolIds.has(tool._id.toString()));
                
                if (assignedTools.length > 0) {
                    let serverType = (server as any).type;
                    
                    if (!serverType) {
                        const associatedRpid = repoServerIdMap.get(server.serverId);
                        if (associatedRpid !== undefined) {
                            serverType = 'repo';
                            McpServerModel.update(domainId, server.serverId, { type: 'repo' }).catch(err => {
                                AgentLogger.warn('Failed to update server type (chat): %s', err.message);
                            });
                        } else {
                            const nameMatch = server.name.match(/^repo-(\d+)-/);
                            if (nameMatch) {
                                const inferredRpid = parseInt(nameMatch[1], 10);
                                const repo = allRepos.find(r => r.rpid === inferredRpid);
                                if (repo) {
                                    serverType = 'repo';
                                    McpServerModel.update(domainId, server.serverId, { type: 'repo' }).catch(err => {
                                        AgentLogger.warn('Failed to update server type (chat): %s', err.message);
                                    });
                                } else {
                                    serverType = 'provider'; // 默认
                                }
                            } else {
                                serverType = 'provider'; // 默认
                            }
                        }
                    }
                    
                    // repo 类型的服务器是内部服务，始终为 connected
                    const status = serverType === 'repo' ? 'connected' : 'disconnected';
                    
                    const serverData = {
                        serverId: server.serverId,
                        name: server.name,
                        description: server.description,
                        status: status, // repo 类型为 connected，其他为 disconnected
                        toolsCount: assignedTools.length,
                        tools: assignedTools.map(tool => ({
                            _id: tool._id,
                            toolId: tool.toolId,
                            name: tool.name,
                            description: tool.description,
                            inputSchema: tool.inputSchema,
                        })),
                    };
                    
                    if (serverType === 'repo') {
                        const associatedRpid = repoServerIdMap.get(server.serverId);
                        let rpid = associatedRpid;
                        if (rpid === undefined) {
                            const nameMatch = server.name.match(/^repo-(\d+)-/);
                            if (nameMatch) {
                                rpid = parseInt(nameMatch[1], 10);
                            }
                        }
                        const repo = rpid ? allRepos.find(r => r.rpid === rpid) : null;
                        repoServers.push({
                            ...serverData,
                            rpid: rpid || 0,
                            repoTitle: repo?.title || (rpid ? `Repo ${rpid}` : server.name),
                            type: 'repo',
                        });
                    } else if (serverType === 'node') {
                        nodeServers.push({
                            ...serverData,
                            type: 'node',
                        });
                    } else {
                        providerServers.push({
                            ...serverData,
                            type: 'provider',
                        });
                    }
                }
            }
        } catch (error: any) {
            AgentLogger.error('Failed to load MCP servers and tools: %s', error.message);
        }

        const serversWithTools = [...providerServers, ...nodeServers, ...repoServers];

        // WebSocket URL for MCP status updates
        let mcpStatusWsUrl = `/mcp/status/ws/all`;
        if (domainId !== 'system' && (
            !this.request.host
            || (host instanceof Array
                ? (!host.includes(this.request.host))
                : this.request.host !== host)
        )) {
            mcpStatusWsUrl = `/d/${domainId}${mcpStatusWsUrl}`;
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
            serversWithTools, // 向后兼容
            providerServers,
            nodeServers,
            repoServers,
            mcpStatusWsUrl,
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

        const tools = await getAssignedTools(domainId, adoc.mcpToolIds, adoc.repoIds);
        const mcpClient = new McpClient();
        
        const agentPrompt = adoc.content || '';
        let systemMessage = agentPrompt;
        
        const truncateMemory = (memory: string, maxLength: number = 2000): string => {
            if (!memory || memory.length <= maxLength) {
                return memory;
            }
            return memory.substring(0, maxLength) + '\n\n[... Memory truncated, keeping most important rules ...]';
        };
        if (adoc.memory) {
            const truncatedMemory = truncateMemory(adoc.memory);
            systemMessage += `\n\n---\n【Work Rules Memory - Supplementary Guidelines】\n${truncatedMemory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. For example, if the memory says "When user asks xxx, should xxx", you must follow that exactly when the user asks that question.\n\nNote: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
        }
        
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              '\n\n【IMPORTANT RULES - BOTTOM-LEVEL FUNDAMENTAL RULES】You must strictly adhere to the following rules for tool calls:\n1. **ALWAYS speak first before calling tools**: When you need to call a tool, you MUST first stream a message to the user explaining what you are about to do (e.g., "Let me search the knowledge base", "Let me check the relevant information"). This gives the user immediate feedback and makes the conversation feel natural and responsive. Only after you have explained what you are doing should you call the tool.\n2. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n3. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n4. Each tool call response should be independent and focused solely on the current tool\'s result.\n5. After the last tool call completes, you should only reply with the last tool\'s result. Do NOT provide a comprehensive summary of all tools\' results (unless there are clear dependencies between tools that require integration).\n6. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n7. Tool calls proceed one by one sequentially: first explain what you will do → call one tool → immediately reply with that tool\'s result → decide if another tool is needed.\n8. If multiple tools are needed, proceed one by one: explain what you will do → call the first tool → reply with the first tool\'s result → explain what you will do next → call the second tool → reply with the second tool\'s result, and so on. Each reply should be independent and focused on the current tool.';
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
                const maxIterations = 50; // 增加迭代次数限制，避免过早停止
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
                                                if (adoc && accumulatedContent) {
                                                    updateAgentMemory(
                                                        domainId,
                                                        adoc,
                                                        chatHistory,
                                                        message,
                                                        accumulatedContent,
                                                    ).catch(err => AgentLogger.error('Failed to update memory in background', err));
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
                                                            toolResult = await mcpClient.callTool(firstToolCall.function.name, parsedArgs, domainId);
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
            const maxIterations = 50; // 增加迭代次数限制，避免过早停止

            while (true) {
                const choice = currentResponse.body.choices?.[0] || {};
                const finishReason = choice.finish_reason;
                const msg = choice.message || {};

                if (finishReason === 'tool_calls') {
                    const toolCalls = msg.tool_calls || [];
                    if (!toolCalls.length) break;

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
                    const toolResult = await mcpClient.callTool(firstToolCall.function?.name, parsedArgs, domainId);
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
                if (adoc && finalContent) {
                    updateAgentMemory(
                        domainId,
                        adoc,
                        chatHistory,
                        message,
                        finalContent,
                    ).catch(err => AgentLogger.error('Failed to update memory in background', err));
                }
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
            if (adoc && msgStr) {
                updateAgentMemory(
                    domainId,
                    adoc,
                    chatHistory,
                    message,
                    msgStr,
                ).catch(err => AgentLogger.error('Failed to update memory in background', err));
            }
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

        const domainId = this.adoc.domainId;
        const domainInfo = await domain.get(domainId);
        if (!domainInfo) {
            this.send({ type: 'error', error: 'Domain not found' });
            return;
        }

        const apiKey = (domainInfo as any)['apiKey'] || '';
        const model = (domainInfo as any)['model'] || 'deepseek-chat';
        const apiUrl = (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';

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

        const tools = await getAssignedTools(this.domain._id, this.adoc.mcpToolIds);
        const mcpClient = new McpClient();
        
        const agentPrompt = this.adoc.content || '';
        let systemMessage = agentPrompt;
        
        // 限制 memory 长度的辅助函数
        const truncateMemory = (memory: string, maxLength: number = 2000): string => {
            if (!memory || memory.length <= maxLength) {
                return memory;
            }
            return memory.substring(0, maxLength) + '\n\n[... Memory truncated, keeping most important rules ...]';
        };

        // 添加工作规则记忆
        // 限制 memory 长度，避免请求体过大（最多 2000 字符）
        if (this.adoc.memory) {
            const truncatedMemory = truncateMemory(this.adoc.memory);
            systemMessage += `\n\n---\n【Work Rules Memory - Supplementary Guidelines】\n${truncatedMemory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. For example, if the memory says "When user asks xxx, should xxx", you must follow that exactly when the user asks that question.\n\nNote: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
        }
        
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              `\n\n【CRITICAL - YOU MUST READ THIS FIRST】\n**MANDATORY: SPEAK BEFORE TOOL CALLS**\nBefore calling ANY tool, you MUST first output a message explaining what you are about to do. This is MANDATORY and NON-NEGOTIABLE.\n\nExample workflow:\n1. User asks: "Find the switch"\n2. You MUST first output: "Let me help you find the switch device..." (or similar)\n3. THEN call the tool (e.g., zigbee_list_devices)\n4. After tool returns, output the results\n\nIf you call a tool WITHOUT first explaining what you are doing, you are violating the rules. The conversation should feel natural - you speak first, then act, then speak about the results.\n\n【TOOL USAGE STRATEGY - CRITICAL】\n1. **Proactive Multi-Tool Problem Solving**: When a user's question requires multiple tools or steps to fully answer, you MUST actively call tools in sequence until you have enough information. Do not stop after the first tool if the problem clearly needs more.\n2. **Knowledge Base Search Priority**: When users ask questions about information, documentation, stored knowledge, or specific topics, ALWAYS use the search_repo tool first to check if the information exists in the knowledge base. Even if you think you might know the answer, search the knowledge base to ensure accuracy and completeness.\n3. **Sequential Tool Execution**: The system executes one tool at a time. After each tool completes, you receive the result and can immediately call the next tool if needed.\n4. **Complete Before Responding**: When solving complex problems, gather ALL necessary information through tool calls BEFORE giving your final answer to the user. Only reply after you have completed the tool chain needed to answer the question.\n5. **Tool Chaining Examples**:\n   - User: "Do I have classes tomorrow?" → You should: (1) FIRST say "Let me check tomorrow's schedule..." (2) call get_current_time to know what day tomorrow is, (3) call search_repo to check if there's schedule/calendar info in knowledge base, (4) then provide complete answer\n   - User: "View files in repo" → You should: (1) FIRST say "Let me search for files in the knowledge base..." (2) call search_repo to find relevant repo entries, (3) if found, analyze content, (4) present comprehensive results\n   - User asks about any topic → You should: (1) FIRST say what you will do, (2) THEN search knowledge base using search_repo, (3) analyze results, (4) if needed, call other tools, (5) provide answer based on all information gathered\n6. **When to Stop Tool Chain**: Only stop calling tools when: (a) you have enough information to fully answer the question, (b) you need user clarification, or (c) no more relevant tools are available.\n7. **System Behavior**: The system processes tools one-by-one automatically. After each tool result, you decide whether to call another tool or provide the answer.\n\n**KEY PRINCIPLE**: Be proactive and thorough. Always search the knowledge base first when users ask about information. If a question needs multiple tools, call them all before responding. Do not make the user ask multiple times or give incomplete answers.\n\n【IMPORTANT RULES - BOTTOM-LEVEL FUNDAMENTAL RULES】You must strictly adhere to the following rules for tool calls:\n1. **ALWAYS speak first before calling tools (MANDATORY)**: When you need to call a tool, you MUST first output and stream a message to the user explaining what you are about to do. Examples:\n   Examples: "Let me search the knowledge base..." / "Let me find the switch devices..." / "Let me check the relevant information..."\n   This message MUST be streamed BEFORE you call the tool. This gives the user immediate feedback and makes the conversation feel natural and responsive. ONLY AFTER you have explained what you are doing should you call the tool. Calling a tool without first speaking is STRICTLY FORBIDDEN.\n2. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n3. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n4. Each tool call response should be independent and focused solely on the current tool's result.\n5. After the last tool call completes, you should only reply with the last tool's result. Do NOT provide a comprehensive summary of all tools' results (unless there are clear dependencies between tools that require integration).\n6. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n7. Tool calls proceed one by one sequentially: first explain what you will do → call one tool → immediately reply with that tool's result → decide if another tool is needed.\n8. If multiple tools are needed, proceed one by one: explain what you will do → call the first tool → reply with the first tool's result → explain what you will do next → call the second tool → reply with the second tool's result, and so on. Each reply should be independent and focused on the current tool.`;
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
            const maxIterations = 50; // 增加迭代次数限制，避免过早停止
            let streamFinished = false;
            let waitingForToolCall = false;

            const processStream = async () => {
                try {
                    AgentLogger.info('Starting WebSocket stream request', { apiUrl, model, iterations, streamFinished, waitingForToolCall });
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
                                            if (this.adoc && accumulatedContent) {
                                                updateAgentMemory(
                                                    this.adoc.domainId,
                                                    this.adoc,
                                                    chatHistory,
                                                    message,
                                                    accumulatedContent,
                                                ).catch(err => AgentLogger.error('Failed to update memory in background', err));
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
                                                this.send({ type: 'content', content: delta.content });
                                            }
                                            
                                            if (choice?.finish_reason) {
                                                finishReason = choice.finish_reason;
                                                if (finishReason === 'tool_calls') {
                                                    waitingForToolCall = true;
                                                    AgentLogger.info('Tool call detected (WS)', { 
                                                        hasContent: !!accumulatedContent && accumulatedContent.trim().length > 0,
                                                        contentLength: accumulatedContent.length 
                                                    });
                                                    // AI应该已经在流式输出中说明了要做什么，这里只需要记录
                                                    if (!accumulatedContent || !accumulatedContent.trim()) {
                                                        AgentLogger.warn('AI called tool without providing context message first (WS)');
                                                    }
                                                }
                                            }
                                            
                                            if (delta?.tool_calls) {
                                                for (const toolCall of delta.tool_calls || []) {
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
                                                AgentLogger.info('Stream end handler check (WS)', { 
                                                    finishReason, 
                                                    toolCallsLength: toolCalls.length, 
                                                    iterations, 
                                                    maxIterations,
                                                    streamFinished,
                                                    waitingForToolCall
                                                });
                                                
                                                if (finishReason === 'tool_calls' && toolCalls.length > 0 && iterations < maxIterations) {
                                                    if (streamFinished) {
                                                        streamFinished = false;
                                                    }
                                                    
                                                    iterations++;
                                                    AgentLogger.info('Processing tool calls (WS)', { toolCallCount: toolCalls.length, iterations, maxIterations });
                                                    
                                                    const firstToolName = toolCalls[0]?.function?.name || 'unknown';
                                                    // 为每次工具调用生成唯一 ID，以便 UI 可以显示多次调用
                                                    const toolCallId = `${firstToolName}-${iterations}-${Date.now()}`;
                                                    this.send({ type: 'tool_call_start', tools: [firstToolName], toolCallId, iteration: iterations });
                                                    
                                                    const assistantForTools: any = { role: 'assistant', tool_calls: toolCalls.map((tc, idx) => ({
                                                        id: tc.id || `call_${idx}`,
                                                        type: tc.type || 'function',
                                                        function: {
                                                            name: tc.function.name,
                                                            arguments: tc.function.arguments,
                                                        },
                                                    })) };
                                                    
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
                                                    
                                                    AgentLogger.info(`Calling first tool: ${firstToolCall.function.name} (WS - One-by-One Mode)`, { parsedArgs, domainId });
                                                    
                                                    let toolResult: any;
                                                    try {
                                                        toolResult = await mcpClient.callTool(firstToolCall.function.name, parsedArgs, domainId);
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
                                                    
                                                    this.send({ type: 'tool_result', tool: firstToolCall.function.name, result: toolResult, toolCallId, iteration: iterations });
                                                    this.send({ type: 'tool_call_complete' });
                                                    
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
                                                    try {
                                                        await processStream();
                                                    } catch (streamError: any) {
                                                        AgentLogger.error('Error in processStream continuation (WS):', streamError);
                                                        this.send({ type: 'error', error: streamError.message || String(streamError) });
                                                        streamFinished = true;
                                                        waitingForToolCall = false;
                                                    }
                                                } else {
                                                    AgentLogger.info('Ending stream (WS)', { 
                                                        reason: iterations >= maxIterations ? 'max_iterations' : 'no_tool_calls',
                                                        iterations,
                                                        maxIterations,
                                                        finishReason,
                                                        toolCallsLength: toolCalls.length,
                                                        accumulatedLength: accumulatedContent.length
                                                    });
                                                    
                                                    if (!streamFinished) {
                                                        streamFinished = true;
                                                        this.send({ type: 'done', message: accumulatedContent, history: JSON.stringify([
                                                            ...chatHistory,
                                                            { role: 'user', content: message },
                                                            { role: 'assistant', content: accumulatedContent },
                                                        ]) });
                                                    }
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
                    AgentLogger.error('Stream setup error stack (WS):', error.stack);
                    this.send({ type: 'error', error: error.message || String(error) });
                    streamFinished = true;
                    waitingForToolCall = false;
                }
            };
            
            try {
                await processStream();
            } catch (error: any) {
                AgentLogger.error('Fatal error in processStream (WS):', error);
                AgentLogger.error('Fatal error stack (WS):', error.stack);
                this.send({ type: 'error', error: error.message || String(error) });
            }
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

        const tools = await getAssignedTools(domainId, this.adoc.mcpToolIds);
        const mcpClient = new McpClient();
        
        const agentPrompt = this.adoc.content || '';
        let systemMessage = agentPrompt;
        
        // 限制 memory 长度的辅助函数
        const truncateMemory = (memory: string, maxLength: number = 2000): string => {
            if (!memory || memory.length <= maxLength) {
                return memory;
            }
            return memory.substring(0, maxLength) + '\n\n[... Memory truncated, keeping most important rules ...]';
        };

        // 添加工作规则记忆
        // 限制 memory 长度，避免请求体过大（最多 2000 字符）
        if (this.adoc.memory) {
            const truncatedMemory = truncateMemory(this.adoc.memory);
            systemMessage += `\n\n---\n【Work Rules Memory - Supplementary Guidelines】\n${truncatedMemory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. For example, if the memory says "When user asks xxx, should xxx", you must follow that exactly when the user asks that question.\n\nNote: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
        }
        
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              `\n\n【CRITICAL - YOU MUST READ THIS FIRST】\n**MANDATORY: SPEAK BEFORE TOOL CALLS**\nBefore calling ANY tool, you MUST first output a message explaining what you are about to do. This is MANDATORY and NON-NEGOTIABLE.\n\nExample workflow:\n1. User asks: "Find the switch"\n2. You MUST first output: "Let me help you find the switch device..." (or similar)\n3. THEN call the tool (e.g., zigbee_list_devices)\n4. After tool returns, output the results\n\nIf you call a tool WITHOUT first explaining what you are doing, you are violating the rules. The conversation should feel natural - you speak first, then act, then speak about the results.\n\n【TOOL USAGE STRATEGY - CRITICAL】\n1. **Proactive Multi-Tool Problem Solving**: When a user's question requires multiple tools or steps to fully answer, you MUST actively call tools in sequence until you have enough information. Do not stop after the first tool if the problem clearly needs more.\n2. **Knowledge Base Search Priority**: When users ask questions about information, documentation, stored knowledge, or specific topics, ALWAYS use the search_repo tool first to check if the information exists in the knowledge base. Even if you think you might know the answer, search the knowledge base to ensure accuracy and completeness.\n3. **Sequential Tool Execution**: The system executes one tool at a time. After each tool completes, you receive the result and can immediately call the next tool if needed.\n4. **Complete Before Responding**: When solving complex problems, gather ALL necessary information through tool calls BEFORE giving your final answer to the user. Only reply after you have completed the tool chain needed to answer the question.\n5. **Tool Chaining Examples**:\n   - User: "Do I have classes tomorrow?" → You should: (1) FIRST say "Let me check tomorrow's schedule..." (2) call get_current_time to know what day tomorrow is, (3) call search_repo to check if there's schedule/calendar info in knowledge base, (4) then provide complete answer\n   - User: "View files in repo" → You should: (1) FIRST say "Let me search for files in the knowledge base..." (2) call search_repo to find relevant repo entries, (3) if found, analyze content, (4) present comprehensive results\n   - User asks about any topic → You should: (1) FIRST say what you will do, (2) THEN search knowledge base using search_repo, (3) analyze results, (4) if needed, call other tools, (5) provide answer based on all information gathered\n6. **When to Stop Tool Chain**: Only stop calling tools when: (a) you have enough information to fully answer the question, (b) you need user clarification, or (c) no more relevant tools are available.\n7. **System Behavior**: The system processes tools one-by-one automatically. After each tool result, you decide whether to call another tool or provide the answer.\n\n**KEY PRINCIPLE**: Be proactive and thorough. Always search the knowledge base first when users ask about information. If a question needs multiple tools, call them all before responding. Do not make the user ask multiple times or give incomplete answers.\n\n【IMPORTANT RULES - BOTTOM-LEVEL FUNDAMENTAL RULES】You must strictly adhere to the following rules for tool calls:\n1. **ALWAYS speak first before calling tools (MANDATORY)**: When you need to call a tool, you MUST first output and stream a message to the user explaining what you are about to do. Examples:\n   Examples: "Let me search the knowledge base..." / "Let me find the switch devices..." / "Let me check the relevant information..."\n   This message MUST be streamed BEFORE you call the tool. This gives the user immediate feedback and makes the conversation feel natural and responsive. ONLY AFTER you have explained what you are doing should you call the tool. Calling a tool without first speaking is STRICTLY FORBIDDEN.\n2. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n3. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n4. Each tool call response should be independent and focused solely on the current tool's result.\n5. After the last tool call completes, you should only reply with the last tool's result. Do NOT provide a comprehensive summary of all tools' results (unless there are clear dependencies between tools that require integration).\n6. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n7. Tool calls proceed one by one sequentially: first explain what you will do → call one tool → immediately reply with that tool's result → decide if another tool is needed.\n8. If multiple tools are needed, proceed one by one: explain what you will do → call the first tool → reply with the first tool's result → explain what you will do next → call the second tool → reply with the second tool's result, and so on. Each reply should be independent and focused on the current tool.`;
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
            const maxIterations = 50; // 增加迭代次数限制，避免过早停止
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
                                                    AgentLogger.info('Tool call detected (Stream), will process immediately', { 
                                                        hasContent: !!accumulatedContent && accumulatedContent.trim().length > 0,
                                                        contentLength: accumulatedContent.length 
                                                    });
                                                    // AI应该已经在流式输出中说明了要做什么，这里只需要记录
                                                    if (!accumulatedContent || !accumulatedContent.trim()) {
                                                        AgentLogger.warn('AI called tool without providing context message first (Stream)');
                                                    }
                                                    
                                                    // 等待工具调用参数收集完成（tool_calls参数可能还在流式传输中）
                                                    // 但我们不在这里处理，让res.on('end')处理，确保所有tool_calls都收集完毕
                                                }
                                            }
                                            
                                            if (delta?.tool_calls) {
                                                for (const toolCall of delta.tool_calls || []) {
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
                                                
                                                const firstToolCall = toolCalls[0];
                                                
                                                if (!firstToolCall || !firstToolCall.function?.name) {
                                                    AgentLogger.warn('No valid tool call found in assistant message (Stream)');
                                                    return;
                                                }
                                                
                                                const firstToolName = firstToolCall.function.name;
                                                this.logSend({ type: 'tool_call_start', tools: [firstToolName] });
                                                
                                                // 构建 assistant 消息，只包含第一个工具调用
                                                const assistantForTools: any = { 
                                                    role: 'assistant', 
                                                    tool_calls: [{
                                                        id: firstToolCall.id || 'call_0',
                                                        type: firstToolCall.type || 'function',
                                                        function: {
                                                            name: firstToolCall.function.name,
                                                            arguments: firstToolCall.function.arguments,
                                                        },
                                                    }]
                                                };
                                                
                                                let parsedArgs: any = {};
                                                try {
                                                    parsedArgs = JSON.parse(firstToolCall.function.arguments);
                                                } catch (e) {
                                                    parsedArgs = {};
                                                }
                                                
                                                AgentLogger.info(`Calling first tool: ${firstToolCall.function.name} (Stream - One-by-One Mode)`);
                                                
                                                // Execute tool call (no content message sent to avoid TTS speaking it)
                                                // Execute tool call
                                                let toolResult: any;
                                                try {
                                                    toolResult = await mcpClient.callTool(firstToolCall.function.name, parsedArgs, domainId);
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
                                                
                                                // Create tool result message (only contains the first tool's result)
                                                const toolMsg = { 
                                                    role: 'tool', 
                                                    content: JSON.stringify(toolResult), 
                                                    tool_call_id: firstToolCall.id || assistantForTools.tool_calls[0].id
                                                };
                                                
                                                // Send tool call complete signal (single tool)
                                                this.logSend({ type: 'tool_call_complete' });
                                                
                                                // Build message history (only contains the first tool call and result)
                                                // This allows AI to decide whether to continue calling other tools based on the first tool's result
                                                messagesForTurn = [
                                                    ...messagesForTurn,
                                                    { 
                                                        role: 'assistant', 
                                                        content: accumulatedContent, 
                                                        tool_calls: assistantForTools.tool_calls // Only contains the executed tool
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
                                                    toolName: firstToolCall.function.name
                                                });
                                                
                                                // Immediately continue streaming to let AI continue output based on first tool result
                                                // AI can decide whether to continue calling other tools
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

        const tools = await getAssignedTools(domainId, this.adoc.mcpToolIds);
        const mcpClient = new McpClient();
        
        const agentPrompt = this.adoc.content || '';
        let systemMessage = agentPrompt;
        
        // 限制 memory 长度的辅助函数
        const truncateMemory = (memory: string, maxLength: number = 2000): string => {
            if (!memory || memory.length <= maxLength) {
                return memory;
            }
            return memory.substring(0, maxLength) + '\n\n[... Memory truncated, keeping most important rules ...]';
        };

        // 添加工作规则记忆
        // 限制 memory 长度，避免请求体过大（最多 2000 字符）
        if (this.adoc.memory) {
            const truncatedMemory = truncateMemory(this.adoc.memory);
            systemMessage += `\n\n---\n【Work Rules Memory - Supplementary Guidelines】\n${truncatedMemory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. For example, if the memory says "When user asks xxx, should xxx", you must follow that exactly when the user asks that question.\n\nNote: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
        }
        
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              `\n\n【CRITICAL - YOU MUST READ THIS FIRST】\n**MANDATORY: SPEAK BEFORE TOOL CALLS**\nBefore calling ANY tool, you MUST first output a message explaining what you are about to do. This is MANDATORY and NON-NEGOTIABLE.\n\nExample workflow:\n1. User asks: "Find the switch"\n2. You MUST first output: "Let me help you find the switch device..." (or similar)\n3. THEN call the tool (e.g., zigbee_list_devices)\n4. After tool returns, output the results\n\nIf you call a tool WITHOUT first explaining what you are doing, you are violating the rules. The conversation should feel natural - you speak first, then act, then speak about the results.\n\n【TOOL USAGE STRATEGY - CRITICAL】\n1. **Proactive Multi-Tool Problem Solving**: When a user's question requires multiple tools or steps to fully answer, you MUST actively call tools in sequence until you have enough information. Do not stop after the first tool if the problem clearly needs more.\n2. **Knowledge Base Search Priority**: When users ask questions about information, documentation, stored knowledge, or specific topics, ALWAYS use the search_repo tool first to check if the information exists in the knowledge base. Even if you think you might know the answer, search the knowledge base to ensure accuracy and completeness.\n3. **Sequential Tool Execution**: The system executes one tool at a time. After each tool completes, you receive the result and can immediately call the next tool if needed.\n4. **Complete Before Responding**: When solving complex problems, gather ALL necessary information through tool calls BEFORE giving your final answer to the user. Only reply after you have completed the tool chain needed to answer the question.\n5. **Tool Chaining Examples**:\n   - User: "Do I have classes tomorrow?" → You should: (1) FIRST say "Let me check tomorrow's schedule..." (2) call get_current_time to know what day tomorrow is, (3) call search_repo to check if there's schedule/calendar info in knowledge base, (4) then provide complete answer\n   - User: "View files in repo" → You should: (1) FIRST say "Let me search for files in the knowledge base..." (2) call search_repo to find relevant repo entries, (3) if found, analyze content, (4) present comprehensive results\n   - User asks about any topic → You should: (1) FIRST say what you will do, (2) THEN search knowledge base using search_repo, (3) analyze results, (4) if needed, call other tools, (5) provide answer based on all information gathered\n6. **When to Stop Tool Chain**: Only stop calling tools when: (a) you have enough information to fully answer the question, (b) you need user clarification, or (c) no more relevant tools are available.\n7. **System Behavior**: The system processes tools one-by-one automatically. After each tool result, you decide whether to call another tool or provide the answer.\n\n**KEY PRINCIPLE**: Be proactive and thorough. Always search the knowledge base first when users ask about information. If a question needs multiple tools, call them all before responding. Do not make the user ask multiple times or give incomplete answers.\n\n【IMPORTANT RULES - BOTTOM-LEVEL FUNDAMENTAL RULES】You must strictly adhere to the following rules for tool calls:\n1. **ALWAYS speak first before calling tools (MANDATORY)**: When you need to call a tool, you MUST first output and stream a message to the user explaining what you are about to do. Examples:\n   Examples: "Let me search the knowledge base..." / "Let me find the switch devices..." / "Let me check the relevant information..."\n   This message MUST be streamed BEFORE you call the tool. This gives the user immediate feedback and makes the conversation feel natural and responsive. ONLY AFTER you have explained what you are doing should you call the tool. Calling a tool without first speaking is STRICTLY FORBIDDEN.\n2. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n3. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n4. Each tool call response should be independent and focused solely on the current tool's result.\n5. After the last tool call completes, you should only reply with the last tool's result. Do NOT provide a comprehensive summary of all tools' results (unless there are clear dependencies between tools that require integration).\n6. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n7. Tool calls proceed one by one sequentially: first explain what you will do → call one tool → immediately reply with that tool's result → decide if another tool is needed.\n8. If multiple tools are needed, proceed one by one: explain what you will do → call the first tool → reply with the first tool's result → explain what you will do next → call the second tool → reply with the second tool's result, and so on. Each reply should be independent and focused on the current tool.`;
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
            const maxIterations = 50; // 增加迭代次数限制，避免过早停止
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
                                            if (this.adoc && accumulatedContent) {
                                                updateAgentMemory(
                                                    this.adoc.domainId,
                                                    this.adoc,
                                                    chatHistory,
                                                    message,
                                                    accumulatedContent,
                                                ).catch(err => AgentLogger.error('Failed to update memory in background', err));
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
                                                this.send({ type: 'content', content: delta.content });
                                            }
                                            
                                            if (choice?.finish_reason) {
                                                finishReason = choice.finish_reason;
                                                if (finishReason === 'tool_calls') {
                                                    waitingForToolCall = true;
                                                    AgentLogger.info('Tool call detected (API WS)', { 
                                                        hasContent: !!accumulatedContent && accumulatedContent.trim().length > 0,
                                                        contentLength: accumulatedContent.length 
                                                    });
                                                    // AI应该已经在流式输出中说明了要做什么，这里只需要记录
                                                    if (!accumulatedContent || !accumulatedContent.trim()) {
                                                        AgentLogger.warn('AI called tool without providing context message first (API WS)');
                                                    }
                                                }
                                            }
                                            
                                            if (delta?.tool_calls) {
                                                for (const toolCall of delta.tool_calls || []) {
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
                                                        toolResult = await mcpClient.callTool(firstToolCall.function.name, parsedArgs, domainId);
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

        const tools = await getAssignedTools(adoc.domainId, adoc.mcpToolIds);
        const mcpClient = new McpClient();
        
        const agentPrompt = adoc.content || '';
        let systemMessage = agentPrompt;
        
        const truncateMemory = (memory: string, maxLength: number = 2000): string => {
            if (!memory || memory.length <= maxLength) {
                return memory;
            }
            return memory.substring(0, maxLength) + '\n\n[... Memory truncated, keeping most important rules ...]';
        };
        if (adoc.memory) {
            const truncatedMemory = truncateMemory(adoc.memory);
            systemMessage += `\n\n---\n【Work Rules Memory - Supplementary Guidelines】\n${truncatedMemory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. For example, if the memory says "When user asks xxx, should xxx", you must follow that exactly when the user asks that question.\n\nNote: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
        }
        
        // Prohibit using emojis
        if (systemMessage && !systemMessage.includes('do not use emoji')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }
        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              `\n\n【CRITICAL - YOU MUST READ THIS FIRST】\n**MANDATORY: SPEAK BEFORE TOOL CALLS**\nBefore calling ANY tool, you MUST first output a message explaining what you are about to do. This is MANDATORY and NON-NEGOTIABLE.\n\nExample workflow:\n1. User asks: "Find the switch"\n2. You MUST first output: "Let me help you find the switch device..." (or similar)\n3. THEN call the tool (e.g., zigbee_list_devices)\n4. After tool returns, output the results\n\nIf you call a tool WITHOUT first explaining what you are doing, you are violating the rules. The conversation should feel natural - you speak first, then act, then speak about the results.\n\n【TOOL USAGE STRATEGY - CRITICAL】\n1. **Proactive Multi-Tool Problem Solving**: When a user's question requires multiple tools or steps to fully answer, you MUST actively call tools in sequence until you have enough information. Do not stop after the first tool if the problem clearly needs more.\n2. **Knowledge Base Search Priority**: When users ask questions about information, documentation, stored knowledge, or specific topics, ALWAYS use the search_repo tool first to check if the information exists in the knowledge base. Even if you think you might know the answer, search the knowledge base to ensure accuracy and completeness.\n3. **Sequential Tool Execution**: The system executes one tool at a time. After each tool completes, you receive the result and can immediately call the next tool if needed.\n4. **Complete Before Responding**: When solving complex problems, gather ALL necessary information through tool calls BEFORE giving your final answer to the user. Only reply after you have completed the tool chain needed to answer the question.\n5. **Tool Chaining Examples**:\n   - User: "Do I have classes tomorrow?" → You should: (1) FIRST say "Let me check tomorrow's schedule..." (2) call get_current_time to know what day tomorrow is, (3) call search_repo to check if there's schedule/calendar info in knowledge base, (4) then provide complete answer\n   - User: "View files in repo" → You should: (1) FIRST say "Let me search for files in the knowledge base..." (2) call search_repo to find relevant repo entries, (3) if found, analyze content, (4) present comprehensive results\n   - User asks about any topic → You should: (1) FIRST say what you will do, (2) THEN search knowledge base using search_repo, (3) analyze results, (4) if needed, call other tools, (5) provide answer based on all information gathered\n6. **When to Stop Tool Chain**: Only stop calling tools when: (a) you have enough information to fully answer the question, (b) you need user clarification, or (c) no more relevant tools are available.\n7. **System Behavior**: The system processes tools one-by-one automatically. After each tool result, you decide whether to call another tool or provide the answer.\n\n**KEY PRINCIPLE**: Be proactive and thorough. Always search the knowledge base first when users ask about information. If a question needs multiple tools, call them all before responding. Do not make the user ask multiple times or give incomplete answers.\n\n【IMPORTANT RULES - BOTTOM-LEVEL FUNDAMENTAL RULES】You must strictly adhere to the following rules for tool calls:\n1. **ALWAYS speak first before calling tools (MANDATORY)**: When you need to call a tool, you MUST first output and stream a message to the user explaining what you are about to do. Examples:\n   Examples: "Let me search the knowledge base..." / "Let me find the switch devices..." / "Let me check the relevant information..."\n   This message MUST be streamed BEFORE you call the tool. This gives the user immediate feedback and makes the conversation feel natural and responsive. ONLY AFTER you have explained what you are doing should you call the tool. Calling a tool without first speaking is STRICTLY FORBIDDEN.\n2. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n3. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n4. Each tool call response should be independent and focused solely on the current tool's result.\n5. After the last tool call completes, you should only reply with the last tool's result. Do NOT provide a comprehensive summary of all tools' results (unless there are clear dependencies between tools that require integration).\n6. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n7. Tool calls proceed one by one sequentially: first explain what you will do → call one tool → immediately reply with that tool's result → decide if another tool is needed.\n8. If multiple tools are needed, proceed one by one: explain what you will do → call the first tool → reply with the first tool's result → explain what you will do next → call the second tool → reply with the second tool's result, and so on. Each reply should be independent and focused on the current tool.`;
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
                const maxIterations = 50; // 增加迭代次数限制，避免过早停止
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
                                                if (adoc && accumulatedContent) {
                                                    updateAgentMemory(
                                                        adoc.domainId,
                                                        adoc,
                                                        chatHistory,
                                                        message,
                                                        accumulatedContent,
                                                    ).catch(err => AgentLogger.error('Failed to update memory in background', err));
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
                                                            const toolArgs = firstToolCall.function.name.match(/^repo_\d+_/) 
                                                                ? { ...parsedArgs, __agentId: (adoc as any).aid || (adoc as any)._id?.toString() || 'unknown', __agentName: (adoc as any).name || 'agent' }
                                                                : parsedArgs;
                                                            toolResult = await mcpClient.callTool(firstToolCall.function.name, toolArgs, adoc.domainId);
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
                                                        if (adoc && accumulatedContent) {
                                                            updateAgentMemory(
                                                                adoc.domainId,
                                                                adoc,
                                                                chatHistory,
                                                                message,
                                                                accumulatedContent,
                                                            ).catch(err => AgentLogger.error('Failed to update memory in background', err));
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
            const maxIterations = 50; // 增加迭代次数限制，避免过早停止

            while (true) {
                const choice = currentResponse.body.choices?.[0] || {};
                const finishReason = choice.finish_reason;
                const msg = choice.message || {};

                if (finishReason === 'tool_calls') {
                    const toolCalls = msg.tool_calls || [];
                    if (!toolCalls.length) break;

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
                    // 如果是 repo 工具，传递 agentId 和 agentName
                    const toolArgs = firstToolCall.function?.name?.match(/^repo_\d+_/) 
                        ? { ...parsedArgs, __agentId: (adoc as any).aid || (adoc as any)._id?.toString() || 'unknown', __agentName: (adoc as any).name || 'agent' }
                        : parsedArgs;
                    const toolResult = await mcpClient.callTool(firstToolCall.function?.name, toolArgs, adoc.domainId);
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
                if (adoc && finalContent) {
                    updateAgentMemory(
                        adoc.domainId,
                        adoc,
                        chatHistory,
                        message,
                        finalContent,
                    ).catch(err => AgentLogger.error('Failed to update memory in background', err));
                }
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
            if (adoc && msgStr) {
                updateAgentMemory(
                    adoc.domainId,
                    adoc,
                    chatHistory,
                    message,
                    msgStr,
                ).catch(err => AgentLogger.error('Failed to update memory in background', err));
            }
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
            this.response.body = { 
                adoc: null, 
                providerServers: [],
                nodeServers: [],
                repoServers: [],
                assignedToolIds: [],
                allRepos: [],
                assignedRepoIds: [],
                allNodes: [],
            };
            return;
        }
        const udoc = await user.getById(domainId, agent.owner);

        // 获取所有可用的repo列表，并建立 mcpServerId -> rpid 的映射
        const allRepos: any[] = [];
        const repoServerIdMap = new Map<number, number>(); // mcpServerId -> rpid
        try {
            const repos = await RepoModel.getAllRepos(domainId);
            for (const repo of repos) {
                const mcpServerId = (repo as any).mcpServerId;
                allRepos.push({
                    rpid: repo.rpid,
                    title: repo.title,
                    mcpServerId: mcpServerId,
                });
                if (mcpServerId && typeof mcpServerId === 'number') {
                    repoServerIdMap.set(mcpServerId, repo.rpid);
                    AgentLogger.debug('Mapped repo server: serverId=%d -> rpid=%d', mcpServerId, repo.rpid);
                } else {
                    AgentLogger.debug('Repo %d has no mcpServerId or invalid value: %s', repo.rpid, mcpServerId);
                }
            }
            AgentLogger.info('Loaded %d repos, %d with mcpServerId', repos.length, repoServerIdMap.size);
        } catch (error: any) {
            AgentLogger.error('Failed to load repos: %s', error.message);
        }

        // 获取所有可用的node列表（用于 node 类型的 MCP 工具）
        const allNodes: any[] = [];
        try {
            const nodes = await NodeModel.getByDomain(domainId);
            for (const node of nodes) {
                allNodes.push({
                    nodeId: node.nodeId,
                    name: node.name,
                    description: node.description,
                    status: node.status,
                });
            }
        } catch (error: any) {
            AgentLogger.error('Failed to load nodes: %s', error.message);
        }

        const assignedToolIds = (agent.mcpToolIds || []).map(id => id.toString());

        // 按类型组织 MCP 工具：provider、repo、node
        const providerServers: any[] = []; // 外部 MCP 服务
        const nodeServers: any[] = []; // node 提供的 MCP 工具
        const repoServers: any[] = []; // repo 的 MCP 工具

        try {
            const servers = await McpServerModel.getByDomain(domainId);
            AgentLogger.info('Processing %d MCP servers for agent edit', servers.length);
            
            for (const server of servers) {
                AgentLogger.debug('Processing server: serverId=%d, name=%s, type=%s', 
                    server.serverId, server.name, (server as any).type || 'undefined');
                
                const tools = await McpToolModel.getByServer(domainId, server.serverId);
                const serverTools = tools.map(tool => ({
                    _id: tool._id,
                    toolId: tool.toolId,
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    serverId: tool.serverId,
                    serverName: server.name,
                }));

                // 使用服务器的 type 字段进行分类
                let serverType = (server as any).type;
                
                // 根据服务器类型设置状态：repo 类型是内部服务，始终为 connected
                const status = serverType === 'repo' ? 'connected' : 'disconnected';
                
                // 如果 type 字段不存在，尝试推断并更新
                if (!serverType) {
                    const associatedRpid = repoServerIdMap.get(server.serverId);
                    if (associatedRpid !== undefined) {
                        // 从 repoServerIdMap 推断为 repo 类型
                        serverType = 'repo';
                        // 异步更新服务器类型（不阻塞当前请求）
                        McpServerModel.update(domainId, server.serverId, { type: 'repo' }).catch(err => {
                            AgentLogger.warn('Failed to update server type: %s', err.message);
                        });
                    } else {
                        // 尝试从名称推断
                        const nameMatch = server.name.match(/^repo-(\d+)-/);
                        if (nameMatch) {
                            const inferredRpid = parseInt(nameMatch[1], 10);
                            const repo = allRepos.find(r => r.rpid === inferredRpid);
                            if (repo) {
                                serverType = 'repo';
                                // 异步更新服务器类型
                                McpServerModel.update(domainId, server.serverId, { type: 'repo' }).catch(err => {
                                    AgentLogger.warn('Failed to update server type: %s', err.message);
                                });
                            } else {
                                serverType = 'provider'; // 默认
                            }
                        } else {
                            serverType = 'provider'; // 默认
                        }
                    }
                }
                
                if (serverType === 'repo') {
                    // 这是 repo 的 MCP 服务器
                    const associatedRpid = repoServerIdMap.get(server.serverId);
                    // 如果 repoServerIdMap 中没有，尝试从名称推断
                    let rpid = associatedRpid;
                    if (rpid === undefined) {
                        const nameMatch = server.name.match(/^repo-(\d+)-/);
                        if (nameMatch) {
                            rpid = parseInt(nameMatch[1], 10);
                        }
                    }
                    const repo = rpid ? allRepos.find(r => r.rpid === rpid) : null;
                    repoServers.push({
                        serverId: server.serverId,
                        serverName: server.name,
                        serverDescription: server.description,
                        status: status, // 不查询实时状态，仅用于显示
                        rpid: rpid || 0,
                        repoTitle: repo?.title || (rpid ? `Repo ${rpid}` : server.name),
                        tools: serverTools,
                    });
                } else if (serverType === 'node') {
                    // 这是 node 的 MCP 服务器
                    nodeServers.push({
                        serverId: server.serverId,
                        serverName: server.name,
                        serverDescription: server.description,
                        status: status, // 不查询实时状态，仅用于显示
                        tools: serverTools,
                    });
                } else {
                    // 这是外部 provider 的 MCP 服务器（默认）
                    providerServers.push({
                        serverId: server.serverId,
                        serverName: server.name,
                        serverDescription: server.description,
                        status: status, // 不查询实时状态，仅用于显示
                        tools: serverTools,
                    });
                    AgentLogger.debug('Added provider server: serverId=%d, name=%s, tools=%d', 
                        server.serverId, server.name, serverTools.length);
                }
            }
            
            AgentLogger.info('Agent edit: providerServers=%d, nodeServers=%d, repoServers=%d', 
                providerServers.length, nodeServers.length, repoServers.length);
        } catch (error: any) {
            AgentLogger.error('Failed to load MCP tools: %s', error.message);
            AgentLogger.error('Error stack: %s', error.stack);
        }

        // 获取已选择的repo ID列表
        const assignedRepoIds = (agent.repoIds || []).map(id => id.toString());

        this.response.template = 'agent_edit.html';
        this.response.body = {
            adoc: agent,
            tag: agent.tag,
            udoc,
            providerServers,
            nodeServers,
            repoServers,
            assignedToolIds,
            allRepos,
            assignedRepoIds,
            allNodes,
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
    @post('memory', Types.Content, true)
    @post('toolIds', Types.ArrayOf(Types.String), true)
    @post('repoIds', Types.ArrayOf(Types.Int), true)
    async postUpdate(domainId: string, aid: string, title: string, content: string, tag: string[] = [], memory?: string, toolIds?: string[], repoIds?: number[]) {
        const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
    
    
        const agent = await Agent.get(domainId, normalizedId);
        if (!agent) {
            throw new NotFoundError(`Agent not found for ${typeof normalizedId === 'number' ? 'docId' : 'aid'}=${normalizedId}`);
        }
    
        const validToolIds: ObjectId[] = [];
        if (toolIds && Array.isArray(toolIds)) {
            for (const toolIdStr of toolIds) {
                try {
                    const toolId = new ObjectId(toolIdStr);
                    const tool = await document.get(domainId, document.TYPE_MCP_TOOL, toolId);
                    if (tool) {
                        validToolIds.push(toolId);
                    } else {
                        AgentLogger.warn('Tool not found: %s', toolIdStr);
                    }
                } catch (error) {
                    AgentLogger.warn('Invalid tool ID: %s', toolIdStr);
                }
            }
        }
        
        // 验证repo ID是否有效
        const validRepoIds: number[] = [];
        if (repoIds && Array.isArray(repoIds)) {
            try {
                for (const rpid of repoIds) {
                    const repo = await RepoModel.getRepoByRpid(domainId, rpid);
                    if (repo) {
                        validRepoIds.push(rpid);
                    } else {
                        AgentLogger.warn('Repo not found: rpid=%d', rpid);
                    }
                }
            } catch (error: any) {
                AgentLogger.warn('Failed to validate repo IDs: %s', error.message);
            }
        }
        
        AgentLogger.info('Updating agent: aid=%s, toolIds=%o, validToolIds=%o, repoIds=%o, validRepoIds=%o', 
            agent.aid, toolIds, validToolIds.map(id => id.toString()), repoIds, validRepoIds);
    
        const agentAid = agent.aid;
        const updatedAgent = await Agent.edit(domainId, agentAid, { 
            title, 
            content, 
            tag: tag ?? [], 
            memory: memory || null,
            mcpToolIds: validToolIds,
            repoIds: validRepoIds.length > 0 ? validRepoIds : undefined
        });
        
        if (updatedAgent) {
            AgentLogger.info('Agent updated: aid=%s, mcpToolIds=%o', agentAid, updatedAgent.mcpToolIds?.map(id => id.toString()));
        } else {
            AgentLogger.warn('Agent.edit returned null/undefined for aid=%s', agentAid);
        }
    
    
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
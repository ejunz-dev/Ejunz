import { ObjectId } from 'mongodb';
import type { AgentDoc } from '../interface';
import Agent from '../model/agent';
import domain from '../model/domain';
import RecordModel from '../model/record';
import SessionModel from '../model/session';
import TaskModel from '../model/task';
import { Logger } from '../logger';
import {
    parseAgentSlashInvocation,
    renderSlashSystemBlock,
    resolveAgentPluginTools,
    resolveAgentSlashCatalog,
} from '../service/mcp/pluginRuntime';

const logger = new Logger('lib/agentTaskQueue');

function agentIdOf(adoc: AgentDoc): string {
    return adoc.aid || adoc.docId?.toString() || String((adoc as any)._id || '');
}

function truncateMemory(memory: string, maxLength = 2000): string {
    if (!memory || memory.length <= maxLength) return memory;
    return `${memory.substring(0, maxLength)}\n\n[... Memory truncated, keeping most important rules ...]`;
}

function appendUniversalAssistantRules(systemMessage: string): string {
    const emojiRule = '\n\nNote: Do not use any emoji in your responses.';
    const langRule =
        '\n\n**Response language**: Use the same language as the user\'s latest message for every user-visible reply '
        + '(including narration before and after tool calls). '
        + 'If recent user messages in this thread are clearly in one language, stay in that language. '
        + 'If the user explicitly asks for a specific language, follow that. '
        + 'Do not default to English when the user writes in Chinese, Japanese, or other non-English languages.';
    const toolUrlRule =
        '\n\n**Tool result URLs (critical)**: When a tool returns links (relative paths or absolute URLs), and you include them in your reply to the user, copy them **exactly** from the tool output—same characters, same scheme and host (if present), same path and query. '
        + 'Do not prepend `https://`, do not substitute the chat page host or any other domain you imagine, and do not invent or "normalize" a base URL. '
        + 'If the tool gives a path starting with `/d/`, keep it exactly that way unless the tool output already includes a full URL.';
    let out = systemMessage || '';
    if (!out.includes('do not use emoji')) out += emojiRule;
    if (!out.includes('**Response language**')) out += langRule;
    if (!out.includes('**Tool result URLs**')) out += toolUrlRule;
    return out.trimStart();
}

function effectiveAgentBaseDocId(adoc: AgentDoc): number | undefined {
    const raw = (adoc as any).baseLibraryBindings;
    const docId = Array.isArray(raw) && raw.length ? Number(raw[0]?.docId) : undefined;
    return Number.isFinite(docId) && docId! > 0 ? docId : undefined;
}

function effectiveAgentBaseBranch(adoc: AgentDoc): string | undefined {
    const raw = (adoc as any).baseLibraryBindings;
    const branch = Array.isArray(raw) && raw.length ? String(raw[0]?.branch || 'main').trim() : '';
    return branch || undefined;
}

function normalizeChatHistory(history?: string | any[]): any[] {
    if (Array.isArray(history)) return history;
    if (typeof history !== 'string') return [];
    try {
        const parsed = JSON.parse(history);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export async function getAgentExecutionTools(domainId: string, adoc: AgentDoc): Promise<any[]> {
    const finalTools: any[] = [];
    const processedNames = new Set<string>();
    const pluginTools = await resolveAgentPluginTools(domainId, adoc);
    for (const tool of pluginTools) {
        const name = String(tool?.name || '').trim();
        if (!name || processedNames.has(name)) continue;
        finalTools.push(tool);
        processedNames.add(name);
    }
    return finalTools;
}

export interface EnqueueAgentTaskInput {
    domainId: string;
    uid: number;
    agentId: string | number;
    message: string;
    history?: string | any[];
    chatSessionId?: ObjectId;
    sessionTitle?: string;
    bubbleId?: string;
    assistantbubbleId?: string;
    source?: 'chat' | 'schedule';
    scheduleId?: ObjectId;
    scheduleRunId?: ObjectId;
    parseSlashCommand?: boolean;
}

export interface EnqueueAgentTaskResult {
    taskId: ObjectId;
    recordId: ObjectId;
    chatSessionId: ObjectId;
    agentId: string;
}

export async function enqueueAgentTask(input: EnqueueAgentTaskInput): Promise<EnqueueAgentTaskResult> {
    const message = String(input.message || '').trim();
    if (!message) throw new Error('Agent task message cannot be empty');

    const adoc = await Agent.get(input.domainId, input.agentId as any, Agent.PROJECTION_DETAIL);
    if (!adoc) throw new Error(`Agent not found: ${input.agentId}`);
    const resolvedAgentId = agentIdOf(adoc);

    const domainInfo = await domain.get(input.domainId);
    if (!domainInfo) throw new Error(`Domain not found: ${input.domainId}`);
    const apiKey = (domainInfo as any).apiKey || '';
    if (!apiKey) throw new Error('AI API Key not configured');

    const history = normalizeChatHistory(input.history);
    let slashInvocation: any = null;
    let slashSystemBlock = '';
    if (input.parseSlashCommand === true && message.trimStart().startsWith('/')) {
        const slashCatalog = await resolveAgentSlashCatalog(input.domainId, adoc);
        const parsedSlash = parseAgentSlashInvocation(message, slashCatalog) as any;
        if (parsedSlash?.error) {
            const err = new Error(parsedSlash.error);
            (err as any).code = 'SLASH_COMMAND_ERROR';
            (err as any).suggestions = parsedSlash.suggestions || [];
            throw err;
        }
        if (parsedSlash?.entry) {
            slashInvocation = {
                name: parsedSlash.entry.name,
                kind: parsedSlash.entry.kind,
                pluginDocId: parsedSlash.entry.pluginDocId,
                nodeId: parsedSlash.entry.nodeId,
                args: parsedSlash.args,
            };
            slashSystemBlock = renderSlashSystemBlock(parsedSlash.entry, parsedSlash.args || '', input.domainId, adoc, parsedSlash.raw || message);
        }
    }

    let chatSessionId = input.chatSessionId;
    if (chatSessionId) {
        const sdoc = await SessionModel.getAgentChatSession(input.domainId, chatSessionId);
        if (!sdoc || sdoc.agentId !== resolvedAgentId || sdoc.uid !== input.uid) chatSessionId = undefined;
    }
    if (!chatSessionId) {
        chatSessionId = await SessionModel.addAgentChatSession(
            input.domainId,
            resolvedAgentId,
            input.uid,
            'chat',
            input.sessionTitle,
            undefined,
        );
    }

    const sdoc = await SessionModel.getAgentChatSession(input.domainId, chatSessionId);
    const sessionContext: Record<string, unknown> = { ...(sdoc?.context || {}) };
    delete (sessionContext as any).tools;

    const recordId = await RecordModel.insertAgentTask(
        input.domainId,
        resolvedAgentId,
        input.uid,
        message,
        chatSessionId,
        input.bubbleId,
    );
    await SessionModel.appendAgentChatSessionRecord(input.domainId, chatSessionId, recordId);

    const tools = await getAgentExecutionTools(input.domainId, adoc);
    const agentPrompt = adoc.content || '';
    let systemMessage = agentPrompt;
    if (adoc.memory) {
        const memory = truncateMemory(adoc.memory);
        systemMessage += `\n\n---\n[Work Rules Memory - Supplementary Guidelines]\n${memory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. Note: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
    }
    systemMessage = appendUniversalAssistantRules(systemMessage);
    if (slashSystemBlock) systemMessage += slashSystemBlock;

    if (tools.length > 0) {
        systemMessage += '\n\nYou can use the following tools. Use them when appropriate. Before calling a tool, briefly explain what you are about to do. Use one tool call at a time.\n\n'
            + tools.map((tool) => `- ${tool.name}: ${tool.description || ''}`).join('\n');
    }

    const context = {
        ...sessionContext,
        apiKey,
        model: (domainInfo as any).model || 'deepseek-chat',
        apiUrl: (domainInfo as any).apiUrl || 'https://api.deepseek.com/v1/chat/completions',
        agentContent: adoc.content || '',
        agentMemory: adoc.memory || '',
        baseDocId: effectiveAgentBaseDocId(adoc),
        baseBranch: effectiveAgentBaseBranch(adoc),
        owner: input.uid,
        toolsForModel: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            token: tool.token,
            edgeId: tool.edgeId,
            type: tool.type,
            mcpId: (tool as any).mcpId,
            system: (tool as any).system === true,
        })),
        systemMessage,
        ...(slashInvocation ? { slashInvocation } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.scheduleId ? { scheduleId: input.scheduleId.toHexString() } : {}),
        ...(input.scheduleRunId ? { scheduleRunId: input.scheduleRunId.toHexString() } : {}),
    };

    await SessionModel.updateAgentChatSession(input.domainId, chatSessionId, { context });

    const taskId = await TaskModel.add({
        type: 'task',
        recordId,
        agentChatSessionId: chatSessionId,
        domainId: input.domainId,
        agentId: resolvedAgentId,
        uid: input.uid,
        message,
        history: JSON.stringify(history),
        context: {
            ...context,
            ...(input.assistantbubbleId ? { assistantbubbleId: input.assistantbubbleId } : {}),
        },
        priority: 0,
        ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
        ...(input.scheduleRunId ? { scheduleRunId: input.scheduleRunId } : {}),
    });

    logger.info('Enqueued agent task source=%s task=%s record=%s session=%s', input.source || 'chat', taskId.toString(), recordId.toString(), chatSessionId.toString());
    return { taskId, recordId, chatSessionId, agentId: resolvedAgentId };
}

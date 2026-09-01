import child from 'child_process';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import { pick } from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import type { Readable } from 'stream';
import { Logger, size, streamToBuffer } from '@ejunz/utils/lib/utils';
import { Logger as AppLogger } from '../logger';
import { randomstring } from '@ejunz/utils';
import { Context } from '../context';
import { FileUploadError, ProblemNotFoundError } from '../error';
import type { Document, User, AgentDoc
} from '../interface';
import { parseConfig } from '../lib/testdataConfig';
import * as bus from '../service/bus';
import {
    ArrayKeys, MaybeArray, NumberKeys, Projection,
} from '../typeutils';
import { buildProjection } from '../utils';
import { PERM, STATUS } from './builtin';
import DomainModel from './domain';
import storage from './storage';
import SystemModel from './system';
import user from './user';
import * as document from './document';
import db from '../service/db';
import EdgeModel from './edge';
import ToolModel from './tool';
import { EdgeServerConnectionHandler } from '../handler/edge';
import { findLocalSystemToolByIdOrName, isLocalToolAvailableInDomain } from './tool';
import _ from 'lodash';
import RecordModel from './record';
import SessionModel from './session';
import TaskModel from './task';
import {
    parseAgentSlashInvocation,
    renderSlashSystemBlock,
    resolveAgentPluginTools,
    resolveAgentSlashCatalog,
} from './mcp';

const agentTaskLogger = new AppLogger('model/agent');

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

    const adoc = await AgentModel.get(input.domainId, input.agentId as any, AgentModel.PROJECTION_DETAIL);
    if (!adoc) throw new Error(`Agent not found: ${input.agentId}`);
    const resolvedAgentId = agentIdOf(adoc);

    const domainInfo = await DomainModel.get(input.domainId);
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

    agentTaskLogger.info('Enqueued agent task source=%s task=%s record=%s session=%s', input.source || 'chat', taskId.toString(), recordId.toString(), chatSessionId.toString());
    return { taskId, recordId, chatSessionId, agentId: resolvedAgentId };
}


export type Field = keyof AgentDoc;

export class AgentModel {
    static getAgentExecutionTools = getAgentExecutionTools;
    static enqueueAgentTask = enqueueAgentTask;

    static PROJECTION_LIST: Field[] = [
        'domainId', 'docId', 'aid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static PROJECTION_DETAIL: Field[] = [
        ...AgentModel.PROJECTION_LIST,
       'docId', 'aid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply', 'apiKey', 'memory', 'baseLibraryBindings', 'pluginBindings'
    ];

    static PROJECTION_PUBLIC: Field[] = [
        ...AgentModel.PROJECTION_DETAIL,
        'docId', 'aid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static async generateNextDocId(domainId: string): Promise<number> {
        const lastAgent = await document.getMulti(domainId, document.TYPE_AGENT, {})
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();

        const lastDocId = Number(lastAgent[0]?.docId) || 0;
        return lastDocId + 1;
    }

    static async generateNextAid(domainId: string): Promise<string> {
        const lastAgent = await document.getMulti(domainId, document.TYPE_AGENT, {})
            .sort({ aid: -1 })
            .limit(1)
            .project({ aid: 1 })
            .toArray();

        if (!lastAgent.length || !lastAgent[0]?.aid) {
            return "A1";
        }

        const lastAid = String(lastAgent[0].aid);
        const lastAidNumber = parseInt(lastAid.match(/\d+/)?.[0] || "0", 10);

        return `A${lastAidNumber + 1}`;
    }

    static async addWithId(
        domainId: string,
        docId: number,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<AgentDoc> = {},
    ): Promise<string> {
        const aid = await AgentModel.generateNextAid(domainId);
        const payload: Partial<AgentDoc> = {
            domainId,
            docId,
            aid,
            content,
            owner,
            title: String(title),
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            ...meta, 
        };

        await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            document.TYPE_AGENT,
            docId,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        return aid;
    }

    static async add(
        domainId: string, 
        owner: number, 
        title: string, 
        content: string, 
        ip?: string, 
    ): Promise<string> {
        const docId = await AgentModel.generateNextDocId(domainId);
        return AgentModel.addWithId(domainId, docId, owner, title, content, ip);
    }

    static async getByAid(domainId: string, aid: string): Promise<AgentDoc | null> {
        const query = /^\d+$/.test(aid) ? { docId: Number(aid) } : { aid };
    
    
        const doc = await document.getMulti(domainId, document.TYPE_AGENT, query)
            .project<AgentDoc>(buildProjection(AgentModel.PROJECTION_DETAIL)) 
            .limit(1)
            .next();
    
        if (!doc) {
            console.warn(`[AgentModel.getByAid] No document found for query=`, query);
        } else {
            console.log(`[AgentModel.getByAid] Retrieved document:`, JSON.stringify(doc, null, 2));
        }
    
        return doc || null;
    }

    static async getByApiKey(apiKey: string): Promise<AgentDoc | null> {
        const coll = db.collection('document');
        const doc = await coll.findOne<AgentDoc>(
            { docType: document.TYPE_AGENT, apiKey },
            { projection: buildProjection(AgentModel.PROJECTION_DETAIL) }
        );
        return doc || null;
    }
    

    static async get(
        domainId: string, 
        aid: string | number,
        projection: Projection<AgentDoc> = AgentModel.PROJECTION_PUBLIC
    ): Promise<AgentDoc | null> {
        if (Number.isSafeInteger(+aid)) aid = +aid;
        const res = typeof aid === 'number'
            ? await document.get(domainId, document.TYPE_AGENT, aid, projection)
            : (await document.getMulti(domainId, document.TYPE_AGENT, { aid })
                .project(buildProjection(projection)).limit(1).toArray())[0];
        if (!res) return null;
        return res;
    }

    static getMulti(domainId: string, query: Filter<AgentDoc> = {}, projection = AgentModel.PROJECTION_LIST) {
        return document.getMulti(domainId, document.TYPE_AGENT, query, projection).sort({ docId: -1 });
    }

    static async listFiles(
        domainId: string, 
        query: Filter<AgentDoc>,
        page: number, pageSize: number,
        projection = AgentModel.PROJECTION_LIST, uid?: number,
    ): Promise<[AgentDoc[], number, number]> {
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union.union || [])];
        let count = 0;
        const files = [];
        for (const id of domainIds) {
            // TODO enhance performance
            if (typeof uid === 'number') {
                // eslint-disable-next-line no-await-in-loop
                const udoc = await user.getById(id, uid);
                if (!udoc.hasPerm(PERM.PERM_VIEW)) continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const ccount = await document.count(id, document.TYPE_AGENT, query);
            if (files.length < pageSize && (page - 1) * pageSize - count <= ccount) {
                // eslint-disable-next-line no-await-in-loop
                files.push(...await document.getMulti(id, document.TYPE_AGENT, query, projection)
                    .sort({ sort: 1, docId: 1 })
                    .skip(Math.max((page - 1) * pageSize - count, 0)).limit(pageSize - files.length).toArray());
            }
            count += ccount;
        }
        return [files, Math.ceil(count / pageSize), count];
    }


    static async list(
        domainId: string, query: Filter<AgentDoc>,
        page: number, pageSize: number,
        projection = AgentModel.PROJECTION_LIST, uid?: number,
    ): Promise<[AgentDoc[], number, number]> {
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union.union || [])];
        let count = 0;
        const rdocs = [];
        for (const id of domainIds) {
            // TODO enhance performance
            if (typeof uid === 'number') {
                // eslint-disable-next-line no-await-in-loop
                const udoc = await user.getById(id, uid);
                if (!udoc.hasPerm(PERM.PERM_VIEW)) continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const ccount = await document.count(id, document.TYPE_AGENT, query);
            if (rdocs.length < pageSize && (page - 1) * pageSize - count <= ccount) {
                // eslint-disable-next-line no-await-in-loop
                rdocs.push(...await document.getMulti(id, document.TYPE_AGENT, query, projection)
                    .sort({ sort: 1, docId: 1 })
                    .skip(Math.max((page - 1) * pageSize - count, 0)).limit(pageSize - rdocs.length).toArray());
            }
            count += ccount;
        }
        return [rdocs, Math.ceil(count / pageSize), count];
    }
    static async getList(
        domainId: string, 
        docIds: number[],
        projection = AgentModel.PROJECTION_PUBLIC, 
        indexByDocIdOnly = false,
    ): Promise<Record<number | string, AgentDoc>> {
        if (!docIds?.length) {
            return {};
        }
    
        const r: Record<number, AgentDoc> = {};
        const l: Record<string, AgentDoc> = {};
    
        const q: any = { docId: { $in: docIds } };
    
        let agents = await document.getMulti(domainId, document.TYPE_AGENT, q)
            .project<AgentDoc>(buildProjection(projection))
            .toArray();
    
        for (const agent of agents) {
            r[agent.docId] = agent;
            if (agent.aid) l[agent.aid] = agent;
        }
    
        return indexByDocIdOnly ? r : Object.assign(r, l);
    }

    
    static async edit(domainId: string, aid: string, updates: Partial<AgentDoc>): Promise<AgentDoc> {
        const agent = await document.getMulti(domainId, document.TYPE_AGENT, { aid }).next();
        if (!agent) throw new Error(`Document with aid=${aid} not found`);

        if (updates.tag) {
            updates.tag = Array.isArray(updates.tag) ? updates.tag : [updates.tag];
        }

        return document.set(domainId, document.TYPE_AGENT, agent.docId, updates);
    }
static async addVersion(
        domainId: string,
        docId: number,
        filename: string,
        version: string,
        path: string,
        size: number,
        lastModified: Date,
        etag: string,
        tag: string[] = [],
    ): Promise<AgentDoc> {
        const agentDoc = await AgentModel.get(domainId, docId);
        if (!agentDoc) throw new Error(`Agent with docId=${docId} not found`);

        const payload = {
            filename,
            version,
            path,
            size,
            lastModified,
            etag,
            tag,
        };

        const [updatedAgent] = await document.push(domainId, document.TYPE_AGENT, docId, 'files', payload);

        return updatedAgent;
    }
    static async addFile(
        domainId: string,
        docId: number,
        filename: string,
        path: string,
        size: number,
        lastModified: Date,
        etag: string,
        tag: string[] = [],
    ): Promise<AgentDoc> {
        const agentDoc = await AgentModel.get(domainId, docId);
        if (!agentDoc) throw new Error(`Agent with docId=${docId} not found`);


        const payload = {
            filename,
            path,
            size,
            lastModified,
            etag,
            tag,
        };

        const [updatedAgent] = await document.push(domainId, document.TYPE_AGENT, docId, 'files', payload);

        return updatedAgent;
    }


    static async inc(domainId: string, aid: string, key: NumberKeys<AgentDoc>, value: number): Promise<AgentDoc | null> {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        return document.inc(domainId, document.TYPE_AGENT, doc.docId, key, value);
    }

    static async del(domainId: string, aid: string): Promise<boolean> {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        await Promise.all([
            document.deleteOne(domainId, document.TYPE_AGENT, doc.docId),
            document.deleteMultiStatus(domainId, document.TYPE_AGENT, { docId: doc.docId }),
        ]);
        return true;
    }

    static async count(domainId: string, query: Filter<AgentDoc>) {
        return document.count(domainId, document.TYPE_AGENT, query);
    }

    static async setStar(domainId: string, aid: string, uid: number, star: boolean) {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        return document.setStatus(domainId, document.TYPE_AGENT, doc.docId, uid, { star });
    }

    static async getStatus(domainId: string, aid: string, uid: number) {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        return document.getStatus(domainId, document.TYPE_AGENT, doc.docId, uid);
    }

    static async setStatus(domainId: string, aid: string, uid: number, updates) {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        return document.setStatus(domainId, document.TYPE_AGENT, doc.docId, uid, updates);
    }
}

export function apply(ctx: Context) {}

global.Ejunz.model.agent = AgentModel;
export default AgentModel;

// --- MCP client logic migrated from client.ts ---

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
}

export interface EdgeTool {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, any>;
    };
}

const ClientLogger = new AppLogger('mcp');

export class McpClient {
    /** domainId for listing domain market tools per domain */
    async getTools(domainId?: string): Promise<EdgeTool[]> {
        try {
            const ctx = (global as any).app || (global as any).Ejunz;
            // [Edge disabled] const edgeP = (async () => { try { return ctx ? await ctx.serial('mcp/tools/list/edge') : []; } catch { return []; } })();
            const localP = (async () => {
                try { return ctx && domainId ? await ctx.serial('mcp/tools/list/local', { domainId }) : []; } catch { return []; }
            })();
            // [Edge disabled] const [edgeTools, localTools] = await Promise.all([edgeP, localP]);
            const localTools = await localP;
            ClientLogger.info('Tool sources: local only (Edge disabled)', { localCount: (localTools || []).length });
            const merged: Record<string, EdgeTool> = Object.create(null);
            for (const t of ([] as EdgeTool[]).concat(/* edgeTools || [], */ localTools || [])) merged[t.name] = t;
            const list = Object.values(merged);
            ClientLogger.info('Got tool list (merged):', { toolCount: list.length });
            return list;
        } catch (e) {
            ClientLogger.error('Failed to get tool list', e);
            return [];
        }
    }

    async callTool(
        name: string,
        args: any,
        domainId?: string,
        serverId?: number,
        token?: string,
        toolType?: string,
        baseDocId?: number,
        toolCallerUid?: number,
        embeddingOverride?: any,
    ): Promise<any> {
        try {
            ClientLogger.info('[tool] callTool: name=%s toolType=%s', name, toolType ?? 'undefined');
            const ctx = (global as any).app || (global as any).Ejunz;
            if (!ctx) {
                throw new Error('Context not available');
            }

            let embedding = embeddingOverride;
            let ctxEmbedding = false;
            let ctxEmbeddingError = '';
            if (!embedding) {
                try {
                    embedding = (ctx as any).embedding;
                    ctxEmbedding = !!embedding;
                } catch (err: any) {
                    ctxEmbeddingError = err?.message || String(err);
                }
            }
            ClientLogger.info('[diag] callTool context: name=%s toolType=%s domainId=%s baseDocId=%s owner=%s hasEmbeddingOverride=%s hasCtxEmbedding=%s ctxEmbeddingError=%s pid=%d NODE_APP_INSTANCE=%s',
                name,
                toolType ?? '',
                domainId || '',
                baseDocId || '',
                toolCallerUid || '',
                !!embeddingOverride,
                ctxEmbedding,
                ctxEmbeddingError,
                process.pid,
                process.env.NODE_APP_INSTANCE || '',
            );
            const systemToolContext = {
                domainId,
                baseDocId,
                owner: toolCallerUid,
                embedding,
            };

            // Local MCP tools: default system tools or domain-market enabled MCP tools.
            if (domainId && await isLocalToolAvailableInDomain(domainId, name)) {
                const { tryExecuteSystemTool } = require('../service/mcp');
                const sysEarly = await tryExecuteSystemTool(name, args || {}, systemToolContext);
                if (sysEarly !== null) {
                    return sysEarly;
                }
            }

            // toolType system → built-in editor/base System Tools. These are default tools, not Tool Market installs.
            // Also protect known local system tools from stale/missing type metadata, without shadowing explicit edge/plugin tools.
            const isLocalSystemTool = !!findLocalSystemToolByIdOrName(name);
            if (toolType === 'system' || (!toolType && isLocalSystemTool)) {
                const { executeSystemTool } = require('../service/mcp');
                ClientLogger.info('[tool] callTool: name=%s -> branch=system (executeSystemTool, type=%s, hasToken=%s)', name, toolType || '', !!token);
                return executeSystemTool(name, args || {}, systemToolContext);
            }

            // Check if it's a repo internal MCP tool (format: repo_{rpid}_{operation}...)
            // Supported operations:
            // - Single operation words: commit, push, ask, pull
            // - Operation + underscore + type: query_doc, create_doc, edit_block, delete_block, create_branch, search_doc, search_block, sync_branch
            // - Others: update_structure, query_structure, query_branches
            if (name.match(/^repo_\d+_(query|create|edit|delete|update|pull|push|commit|search|ask|create_branch|sync_branch)/)) {
                try {
                    ClientLogger.info('[tool] callTool: name=%s -> branch=repo', name);
                    // Try to get agentId and agentName from context (if called from agent)
                    const agentId = (args as any).__agentId;
                    const agentName = (args as any).__agentName;
                    const cleanArgs = { ...args };
                    delete (cleanArgs as any).__agentId;
                    delete (cleanArgs as any).__agentName;
                    
                    const result = await ctx.serial('mcp/tool/call/repo', { 
                        name, 
                        args: cleanArgs, 
                        domainId,
                        agentId,
                        agentName,
                    });
                    return result;
                } catch (e) {
                    ClientLogger.error('Repo internal MCP tool call failed: %s', (e as Error).message);
                    throw e;
                }
            }

            if (toolType === 'ejunztools') {
                const { executeBuiltinEjunzToolsTool } = require('../service/mcp');
                ClientLogger.info('[tool] callTool: name=%s -> branch=ejunztools', name);
                return await executeBuiltinEjunzToolsTool(name, args || {});
            }

            if (toolType === 'plugin_mcp' && domainId) {
                const mcpId = Number((args as any)?.__mcpId);
                const cleanArgs = { ...(args || {}) };
                delete (cleanArgs as any).__mcpId;
                if (!Number.isFinite(mcpId) || mcpId <= 0) throw new Error(`Plugin MCP metadata missing for tool: ${name}`);
                const { callPluginMcpTool } = require('../service/mcp');
                return await callPluginMcpTool({ domainId, mcpId, name, args: cleanArgs });
            }

            if (token) {
                const connection = EdgeServerConnectionHandler.getConnection(token);
                if (!connection) {
                    const err = new Error(`Assigned inbound MCP is offline for tool: ${name}`);
                    (err as any).code = 'MCP_OFFLINE';
                    throw err;
                }
                ClientLogger.info('[tool] callTool: name=%s -> branch=edge token=%s', name, token);
                return await connection.callTool(name, args || {});
            }

            // [Edge adapter disabled] First try to call via edge (if available)
            // try {
            //     const edgeTools = await ctx.serial('mcp/tools/list/edge').catch(() => []);
            //     ...
            // } catch (e) { ... }

            // [Edge adapter disabled] Search for tool in Edge/Tool model
            // if (domainId) {
            //     const edges = await EdgeModel.getByDomain(domainId);
            //     for (const edge of connectedEdges) { ... }
            // }

            // Local MCP tools (default system + market MCP)
            try {
                if (domainId) {
                    const localTools = await ctx.serial('mcp/tools/list/local', { domainId }).catch(() => []);
                    const inLocal = (localTools || []).some((t: EdgeTool) => t.name === name);
                    if (inLocal) {
                        ClientLogger.info('[tool] callTool: name=%s -> branch=local', name);
                        return await ctx.serial('mcp/tool/call/local', {
                            name,
                            args,
                            domainId,
                            baseDocId,
                            owner: toolCallerUid,
                        });
                    }
                }
            } catch (e) {
                if ((e as Error).message?.startsWith('Tool not found:')) throw e;
                ClientLogger.debug('Local tools not available: %s', (e as Error).message);
            }

            // No catalog-only execution: must be on domain market (or built-in loaders); otherwise error
            ClientLogger.warn('[tool] callTool: name=%s -> not in assigned tools (market/local)', name);
            const err = new Error(`Tool not added: ${name}. Please add it from the tool market for this domain.`);
            (err as any).code = 'TOOL_NOT_ADDED';
            throw err;
        } catch (e) {
            ClientLogger.error(`Failed to call tool: ${name}`, e);
            throw e;
        }
    }
}

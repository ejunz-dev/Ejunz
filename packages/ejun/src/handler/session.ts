import { throttle } from 'lodash';
import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import {
    NotFoundError,
    PermissionError,
} from '../error';
import {
    Handler, ConnectionHandler, param, post, query, subscribe, Types,
} from '../service/server';
import { PERM, PRIV, STATUS } from '../model/builtin';
import SessionModel from '../model/session';
import { SessionDoc, RecordDoc } from '../interface';
import record from '../model/record';
import user from '../model/user';
import Agent from '../model/agent';
import domain from '../model/domain';
import { buildProjection } from '../utils';

export class SessionConnectionTracker {
    private static activeConnections = new Map<string, Set<ConnectionHandler>>();

    static add(sessionId: string, handler: ConnectionHandler) {
        if (!this.activeConnections.has(sessionId)) {
            this.activeConnections.set(sessionId, new Set());
        }
        this.activeConnections.get(sessionId)!.add(handler);
    }

    static remove(sessionId: string, handler: ConnectionHandler) {
        const handlers = this.activeConnections.get(sessionId);
        if (handlers) {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.activeConnections.delete(sessionId);
            }
        }
    }

    static isActive(sessionId: string): boolean {
        return this.activeConnections.has(sessionId) && 
               this.activeConnections.get(sessionId)!.size > 0;
    }
}

async function getSessionStatus(
    domainId: string,
    sdoc: SessionDoc,
): Promise<'working' | 'active' | 'detached'> {
    if (sdoc.recordIds && sdoc.recordIds.length > 0) {
        const records = await record.getList(domainId, sdoc.recordIds);
        const hasWorkingTask = Object.values(records).some((r: any) => {
            return r.status === STATUS.STATUS_TASK_PROCESSING || 
                   r.status === STATUS.STATUS_TASK_PENDING;
        });
        if (hasWorkingTask) {
            return 'working';
        }
    }

    if (sdoc.type === 'client' && sdoc.clientId) {
        const ClientConnectionHandler = require('./client').ClientConnectionHandler;
        const handler = ClientConnectionHandler.getConnection(sdoc.clientId);
        
        if (handler) {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const lastActivityAt = sdoc.lastActivityAt || sdoc.updatedAt;
            if (lastActivityAt && new Date(lastActivityAt) >= fiveMinutesAgo) {
                return 'active';
            } else {
                return 'detached';
            }
        } else {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const lastActivityAt = sdoc.lastActivityAt || sdoc.updatedAt;
            if (lastActivityAt && new Date(lastActivityAt) >= fiveMinutesAgo) {
                return 'active';
            } else {
                return 'detached';
            }
        }
    }

    const sessionId = sdoc._id.toString();
    if (SessionConnectionTracker.isActive(sessionId)) {
        return 'active';
    }

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const lastActivityAt = sdoc.lastActivityAt || sdoc.updatedAt;
    if (lastActivityAt && new Date(lastActivityAt) >= fiveMinutesAgo) {
        return 'active';
    }

    return 'detached';
}

export class SessionDomainHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('aid', Types.String, true)
    @query('uidOrName', Types.UidOrName, true)
    @query('status', Types.String, true)
    async get(domainId: string, page = 1, aid?: string, uidOrName?: string, status?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const query: any = { domainId };
        
        if (uidOrName) {
            const udoc = await user.getById(domainId, +uidOrName)
                || await user.getByUname(domainId, uidOrName)
                || await user.getByEmail(domainId, uidOrName);
            if (udoc) {
                query.uid = udoc._id;
            }
            // 如果查询的不是当前用户，需要权限
            if (query.uid !== this.user._id) {
                this.checkPerm(PERM.PERM_VIEW_RECORD);
            }
        } else {
            // 没有指定 uidOrName，显示所有 session，需要权限
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        
        if (aid) {
            const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
            try {
                const adoc = await Agent.get(domainId, normalizedId);
                if (adoc) {
                    query.agentId = adoc.aid || (adoc as any).docId?.toString() || aid;
                } else {
                    query.agentId = aid;
                }
            } catch {
                query.agentId = aid;
            }
        }
        
        const [sessions, count] = await Promise.all([
            SessionModel.getMulti(domainId, query, {
                sort: { _id: -1 },
                limit: 20,
                skip: (page - 1) * 20,
            }).toArray(),
            SessionModel.count(domainId, query),
        ]);
        
        const recordIds = sessions.flatMap(s => s.recordIds || []);
        const records = recordIds.length > 0 
            ? await record.getList(domainId, recordIds)
            : {};
        
        const sessionsWithRecords = await Promise.all(sessions.map(async (s) => {
            const sessionRecords = (s.recordIds || []).map(rid => records[rid.toString()]).filter(Boolean);
            const sessionStatus = await getSessionStatus(domainId, s);
            return {
                ...s,
                records: sessionRecords,
                status: sessionStatus,
            };
        }));
        
        let filteredSessions = sessionsWithRecords;
        if (status) {
            filteredSessions = sessionsWithRecords.filter(s => s.status === status);
        }
        
        const agentIds = [...new Set(sessions.map((s: any) => s.agentId).filter(Boolean))];
        let adict: Record<string, any> = {};
        if (agentIds.length > 0) {
            const agentDocs = await Promise.all(
                agentIds.map(async (aid) => {
                    try {
                        const adoc = await Agent.get(domainId, aid);
                        return [aid, adoc];
                    } catch {
                        return [aid, null];
                    }
                })
            );
            adict = Object.fromEntries(agentDocs);
        }
        
        const userIds = [...new Set(sessions.map((s: any) => s.uid))];
        const udict = await user.getList(domainId, userIds);
        
        const sessionsWithRecordsArray = filteredSessions.map(s => ({
            ...s,
            records: s.records || [],
        }));

        this.response.template = 'session_domain.html';
        this.response.body = {
            sessions: sessionsWithRecordsArray,
            page,
            count: status ? filteredSessions.length : count,
            pageCount: Math.ceil((status ? filteredSessions.length : count) / 20),
            adict,
            udict,
            filterAid: aid,
            filterUidOrName: uidOrName,
            filterStatus: status,
        };
    }
}

export class SessionDetailHandler extends Handler {
    @param('sid', Types.ObjectId)
    async get(domainId: string, sid: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const sdoc = await SessionModel.get(domainId, sid);
        if (!sdoc) {
            throw new NotFoundError('Session not found');
        }
        if (sdoc.uid !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        
        const records = sdoc.recordIds && sdoc.recordIds.length > 0
            ? await record.getList(domainId, sdoc.recordIds)
            : {};
        
        const recordsList = Object.values(records).sort((a: any, b: any) => 
            a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime()
        );
        
        // 获取session状态
        const sessionStatus = await getSessionStatus(domainId, sdoc);
        
        this.response.template = 'session_detail.html';
        this.response.body = {
            session: {
                ...sdoc,
                status: sessionStatus,
            },
            records: recordsList,
        };
    }
    
    @param('sid', Types.ObjectId)
    @post('title', Types.String, true)
    @post('operation', Types.String, true)
    async postUpdate(domainId: string, sid: ObjectId, title?: string, operation?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        if (operation === 'delete') {
            const sdoc = await SessionModel.get(domainId, sid);
            if (!sdoc) {
                throw new NotFoundError('Session not found');
            }
            if (sdoc.uid !== this.user._id) {
                throw new PermissionError('You can only delete your own sessions');
            }
            
            await SessionModel.delete(domainId, sid);
            this.response.redirect = this.url('session_domain', { domainId });
            return;
        }
        
        const sdoc = await SessionModel.get(domainId, sid);
        if (!sdoc) {
            throw new NotFoundError('Session not found');
        }
        if (sdoc.uid !== this.user._id) {
            throw new PermissionError('You can only update your own sessions');
        }
        
        const update: any = { updatedAt: new Date() };
        if (title !== undefined) {
            update.title = title;
        }
        
        await SessionModel.update(domainId, sid, update);
        this.response.redirect = this.url('session_detail', { domainId, sid });
    }
}

class SessionDomainConnectionHandler extends ConnectionHandler {
    aid?: string;
    uid?: number;
    sid?: ObjectId;
    queue: Map<string, () => Promise<any>> = new Map();
    throttleQueueClear: () => void;

    @param('aid', Types.String, true)
    @param('uidOrName', Types.UidOrName, true)
    @param('domainId', Types.String, true)
    @param('sid', Types.ObjectId, true)
    async prepare(
        domainId?: string,
        aid?: string,
        uidOrName?: string,
        sid?: ObjectId,
    ) {
        try {
            const queryDomainId = this.request.query.domainId as string || domainId || this.args.domainId;
            const queryAid = this.request.query.aid as string || aid;
            const queryUidOrName = this.request.query.uidOrName as string || uidOrName;
            const finalDomainId = queryDomainId;
            
            if (!finalDomainId) {
                this.close(4000, 'Domain ID is required');
                return;
            }
            
            this.args.domainId = finalDomainId;
            
            if (queryAid) {
                this.aid = queryAid;
            }
            
            if (queryUidOrName) {
                const udoc = await user.getById(finalDomainId, +queryUidOrName)
                    || await user.getByUname(finalDomainId, queryUidOrName);
                if (udoc) {
                    this.uid = udoc._id;
                } else {
                    this.close(4000, `User not found: ${queryUidOrName}`);
                    return;
                }
                // 如果查询的不是当前用户，需要权限
                if (this.uid !== this.user._id) {
                    this.checkPerm(PERM.PERM_VIEW_RECORD);
                }
            } else {
                // 没有指定 uidOrName，显示所有 session，需要权限
                this.checkPerm(PERM.PERM_VIEW_RECORD);
                // 不设置 this.uid，这样 onSessionChange 就不会按 uid 过滤
                this.uid = undefined;
            }
            
            this.throttleQueueClear = throttle(this.queueClear, 100, { trailing: true });
            
            // 如果指定了sid（从query参数或参数中获取），保存并订阅该session的record更新
            const querySid = this.request.query.sid as string || (sid ? sid.toString() : null);
            if (querySid) {
                try {
                    this.sid = new ObjectId(querySid);
                    const sdoc = await SessionModel.get(finalDomainId, this.sid);
                    if (sdoc) {
                        // 发送初始的record更新
                        const recordIds = sdoc.recordIds || [];
                        for (const recordId of recordIds) {
                            try {
                                const rdoc = await record.get(finalDomainId, recordId);
                                if (rdoc) {
                                    await this.sendRecordUpdate(sdoc, rdoc);
                                }
                            } catch (e) {
                                // ignore
                            }
                        }
                    }
                } catch (e) {
                    // ignore invalid sid
                }
            } else if (sid) {
                this.sid = sid;
                const sdoc = await SessionModel.get(finalDomainId, sid);
                if (sdoc) {
                    // 发送初始的record更新
                    const recordIds = sdoc.recordIds || [];
                    for (const recordId of recordIds) {
                        try {
                            const rdoc = await record.get(finalDomainId, recordId);
                            if (rdoc) {
                                await this.sendRecordUpdate(sdoc, rdoc);
                            }
                        } catch (e) {
                            // ignore
                        }
                    }
                }
            }
        } catch (error: any) {
            try {
                this.close(4000, error.message || String(error));
            } catch (e) {
                // ignore
            }
        }
    }

    async message(msg: { sids: string[] }) {
        if (!(msg.sids instanceof Array)) return;
        const sids = msg.sids.map((id) => new ObjectId(id));
        const sdocs = await SessionModel.getMulti(this.args.domainId, { _id: { $in: sids } })
            .toArray();
        for (const sdoc of sdocs) this.onSessionChange(sdoc);
    }

    @subscribe('session/change')
    async onSessionChange(sdoc: SessionDoc) {
        if (sdoc.domainId !== this.args.domainId) return;
        if (typeof this.uid === 'number') {
            if (sdoc.uid !== this.uid) return;
        } else {
            if (sdoc.uid !== this.user._id) return;
        }
        if (this.aid && sdoc.agentId !== this.aid) return;

        await this.sendSessionUpdate(sdoc);
    }

    @subscribe('record/change')
    async onRecordChange(rdoc: RecordDoc) {
        const r = rdoc as any;
        if (!r.agentId) return;
        if (r.domainId !== this.args.domainId) return;
        // 如果指定了 uid，只处理该用户的 record；否则处理所有 record
        if (typeof this.uid === 'number' && r.uid !== this.uid) return;
        if (this.aid && r.agentId !== this.aid) return;

        const sdocs = await SessionModel.getMulti(this.args.domainId, {
            recordIds: { $in: [r._id] },
        }).toArray();

        for (const sdoc of sdocs) {
            // 如果指定了 uid，只处理该用户的 session；否则处理所有 session
            if (typeof this.uid === 'number' && sdoc.uid !== this.uid) continue;
            if (this.aid && sdoc.agentId !== this.aid) continue;
            
            // 检查是否有sid参数（用于聊天页面）
            if (this.sid) {
                // 如果指定了sid，只发送该session的record更新
                if (sdoc._id.equals(this.sid)) {
                    await this.sendRecordUpdate(sdoc, r);
                }
            } else {
                // 否则发送session更新（用于列表页面）
                await this.sendSessionUpdate(sdoc);
            }
        }
    }
    
    async sendRecordUpdate(sdoc: SessionDoc, rdoc: RecordDoc) {
        const r = rdoc as any;
        // 获取完整的record信息（包括agentMessages）
        const fullRecord = await record.get(this.args.domainId, r._id);
        
        this.send({
            type: 'record_update',
            rid: r._id.toString(),
            record: fullRecord,
        });
    }

    async sendSessionUpdate(sdoc: SessionDoc) {
        const recordIds = sdoc.recordIds || [];
        const records = recordIds.length > 0 
            ? await record.getList(this.args.domainId, recordIds, [
                '_id', 'status', 'score', 'domainId', 'uid', 'agentId',
            ] as any)
            : {};
        
        const sessionRecords = recordIds.map(rid => {
            const r = records[rid.toString()];
            if (r) {
                const recordWithId = r as any;
                if (!recordWithId._id) {
                    recordWithId._id = rid;
                }
                return recordWithId;
            }
            return null;
        }).filter(Boolean);
        
        const status = await getSessionStatus(this.args.domainId, sdoc);
        
        let adoc = null;
        if (sdoc.agentId) {
            try {
                adoc = await Agent.get(this.args.domainId, sdoc.agentId);
            } catch (e) {
                // ignore
            }
        }
        
        const udoc = await user.getById(this.args.domainId, sdoc.uid);

        const sessionWithData = {
            ...sdoc,
            status,
            records: sessionRecords,
        };

        this.queueSend(sdoc._id.toHexString(), async () => ({
            html: await this.renderHTML('session_domain_tr.html', {
                session: sessionWithData,
                adoc,
                udoc,
            }),
        }));
    }

    queueSend(sid: string, fn: () => Promise<any>) {
        this.queue.set(sid, fn);
        this.throttleQueueClear();
    }

    async queueClear() {
        await Promise.all([...this.queue.values()].map(async (fn) => this.send(await fn())));
        this.queue.clear();
    }

    async cleanup() {
        this.queue.clear();
    }
}

export class SessionChatHandler extends Handler {
    @param('sid', Types.ObjectId)
    async get(domainId: string, sid: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const sdoc = await SessionModel.get(domainId, sid);
        if (!sdoc) {
            throw new NotFoundError('Session not found');
        }
        if (sdoc.uid !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        
        // 只允许client类型的session进入聊天
        if (sdoc.type !== 'client') {
            throw new PermissionError('Only client sessions can be accessed via chat interface');
        }
        
        // 获取session的所有records
        const records = sdoc.recordIds && sdoc.recordIds.length > 0
            ? await record.getList(domainId, sdoc.recordIds)
            : {};
        
        const recordsList = Object.values(records).sort((a: any, b: any) => 
            a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime()
        );
        
        // 获取agent信息
        let adoc = null;
        if (sdoc.agentId) {
            try {
                adoc = await Agent.get(domainId, sdoc.agentId);
            } catch (e) {
                // agent可能不存在，忽略错误
            }
        }
        
        // 获取domain信息以获取apiKey
        const domainInfo = await domain.get(domainId);
        const apiKey = (domainInfo as any)?.['apiKey'] || '';
        
        this.response.template = 'session_chat.html';
        this.response.body = {
            session: sdoc,
            records: recordsList,
            adoc,
            apiKey,
        };
    }
    
    @param('sid', Types.ObjectId)
    async post(domainId: string, sid: ObjectId) {
        this.response.template = null;
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const sdoc = await SessionModel.get(domainId, sid);
        if (!sdoc) {
            throw new NotFoundError('Session not found');
        }
        if (sdoc.uid !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        
        // 只允许client类型的session
        if (sdoc.type !== 'client') {
            throw new PermissionError('Only client sessions can send messages via chat interface');
        }
        
        const message = this.request.body?.message;
        if (!message || typeof message !== 'string' || !message.trim()) {
            this.response.body = { error: 'Message cannot be empty' };
            return;
        }
        
        // 获取agent信息
        if (!sdoc.agentId) {
            this.response.body = { error: 'Session has no agent' };
            return;
        }
        
        const normalizedId: number | string = /^\d+$/.test(sdoc.agentId) ? Number(sdoc.agentId) : sdoc.agentId;
        const adoc = await Agent.get(domainId, normalizedId);
        if (!adoc) {
            this.response.body = { error: 'Agent not found' };
            return;
        }
        
        // 构建history（从session的records中提取）
        const records = sdoc.recordIds && sdoc.recordIds.length > 0
            ? await record.getList(domainId, sdoc.recordIds)
            : {};
        
        const recordsList = Object.values(records).sort((a: any, b: any) => 
            a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime()
        );
        
        // 从records中提取历史消息（与AgentChatHandler保持一致）
        const history: any[] = [];
        for (const r of recordsList) {
            if ((r as any).agentMessages && Array.isArray((r as any).agentMessages)) {
                for (const msg of (r as any).agentMessages) {
                    if (msg.role === 'user' || msg.role === 'assistant') {
                        history.push({
                            role: msg.role,
                            content: msg.content,
                        });
                    }
                }
            }
        }
        
        // 检查API Key配置
        const apiKey = (this.domain as any)['apiKey'] || '';
        if (!apiKey) {
            this.response.body = { error: 'API Key not configured' };
            return;
        }
        
        // 创建任务记录（走task/record流程）
        const taskRecordId = await record.addTask(
            domainId,
            adoc.aid || adoc.docId.toString(),
            this.user._id,
            message,
            sid, // 使用现有的session
        );
        
        // 将record添加到session
        await SessionModel.addRecord(domainId, sid, taskRecordId);
        
        // 更新session的最后活动时间
        await SessionModel.update(domainId, sid, {
            lastActivityAt: new Date(),
        });
        
        // 创建task任务（类似AgentChatHandler的逻辑）
        const domainInfo = await domain.get(domainId);
        if (!domainInfo) {
            throw new Error('Domain not found');
        }
        
        const { getAssignedTools } = require('./agent');
        const tools = await getAssignedTools(domainId, adoc.mcpToolIds, adoc.repoIds, adoc.skillIds, adoc.skillBranch);
        
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
        
        const context = {
            ...(sdoc.context || {}),
            apiKey: (domainInfo as any)['apiKey'] || '',
            model: (domainInfo as any)['model'] || 'deepseek-chat',
            apiUrl: (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions',
            agentContent: adoc.content || '',
            agentMemory: adoc.memory || '',
            tools: tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                token: tool.token,
                edgeId: tool.edgeId,
            })),
            systemMessage,
        };
        
        await SessionModel.update(domainId, sid, {
            context,
        });
        
        const taskModel = require('../model/task').default;
        await taskModel.add({
            type: 'task',
            recordId: taskRecordId,
            sessionId: sid,
            domainId,
            agentId: adoc.aid || adoc.docId.toString(),
            uid: this.user._id,
            message,
            history: JSON.stringify(history),
            context,
            priority: 0,
        });
        
        this.response.body = {
            taskRecordId: taskRecordId.toString(),
            sessionId: sid.toString(),
            message: 'Task created, processing by worker',
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('session_domain', '/session', SessionDomainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('session_detail', '/session/:sid', SessionDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('session_chat', '/session/:sid/chat', SessionChatHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('session_domain_conn', '/session-conn', SessionDomainConnectionHandler, PRIV.PRIV_USER_PROFILE);
}


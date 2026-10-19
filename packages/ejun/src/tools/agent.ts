import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { AGENT, USER } from 'ejun/src/model/builtin';
import { AgentModel, AgentSessionModel } from 'ejun/src/model/agent';
import { MAX_AGENTS_PER_CALL, MAX_FILE_CONTENT_CHARS, MAX_FILE_CONTENT_CHARS_LIMIT } from '../lib/tool-limits';
import { asText, idList } from '../lib/tool-shared';
import { agentRuntimeHandlerContext } from '../service/runtime';
import { agentToolAccess } from '../service/agent-acl';
import type { AgentConfig, AgentSettings } from 'ejun/src/model/agent';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import { agentRecordView, configFromArgs, createSessionAgent, ensureGroupRoot, objectEntries, renameSessionAgent, requireGroup, sessionAgentInput, sessionAgentView, sessionConversation, sessionScope, settingsFromArgs, validateRoleAssignment, requireAgentConfigurationPermission } from './common/agent';

export const inject = ['server'];

const conversationRead = {
    beforeSeq: Schema.number().step(1).min(0).description('Return turns before this event seq.'),
    maxMessages: Schema.number().step(1).min(1).max(500).description('Maximum turns to read (default 50).'),
    maxChars: Schema.number().step(1).min(1).max(MAX_FILE_CONTENT_CHARS_LIMIT).description(`Cap on returned text (default ${MAX_FILE_CONTENT_CHARS}).`),
};
export const AgentList = Schema.object({ groupId: Schema.number().step(1).min(1).required(), teamId: Schema.string().description('Optional team filter.') }).description('List persisted Agent records, including agentId, teamId, title, and settings.');
export const AgentGet = Schema.object({ groupId: Schema.number().step(1).min(1).required(), agentId: Schema.string().required().description('Persisted Agent id.') }).description('Read one persisted Agent record by agentId.');
export const AgentCreate = Schema.object({ groupId: Schema.number().step(1).min(1).required(), teamId: Schema.string(), title: Schema.string().required(), provider: Schema.string(), model: Schema.string(), baseDocId: Schema.number().step(1).min(1), runtimeId: Schema.string(), agentPreset: Schema.string(), roleId: Schema.string().description('Optional Group role id; requires Agent configuration permission. Omit or pass an empty string to use Default.'), context: Schema.string() }).description('Create a persistent Agent record with teamId, title, settings, and optional role and context; does not create a session.');
export const AgentUpdate = Schema.object({ groupId: Schema.number().step(1).min(1).required(), agentId: Schema.string().required(), title: Schema.string(), teamId: Schema.string(), provider: Schema.string(), model: Schema.string(), baseDocId: Schema.number().step(1).min(1), runtimeId: Schema.string(), agentPreset: Schema.string(), roleId: Schema.string().description('Set a Group role id (requires Agent configuration permission); pass an empty string to return to Default.'), context: Schema.string() }).description('Update an Agent record, its settings, role assignment, or persistent context by agentId.');
export const AgentRemove = Schema.object({ groupId: Schema.number().step(1).min(1).required(), agentId: Schema.string().required() }).description('Delete an Agent record by agentId.');
const AgentCreateFields = Schema.object({ teamId: Schema.string(), title: Schema.string().required(), provider: Schema.string(), model: Schema.string(), baseDocId: Schema.number().step(1).min(1), runtimeId: Schema.string(), agentPreset: Schema.string(), roleId: Schema.string(), context: Schema.string() });
export const AgentCreateMany = Schema.object({ groupId: Schema.number().step(1).min(1).required(), agents: Schema.array(AgentCreateFields).min(1).max(MAX_AGENTS_PER_CALL).required() }).description('Create persisted Agent records.');
export const AgentGetMany = Schema.object({ groupId: Schema.number().step(1).min(1).required(), agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required() }).description('Read Agent records by agentIds.');
export const AgentUpdateMany = Schema.object({ groupId: Schema.number().step(1).min(1).required(), entries: Schema.array(Schema.object({ agentId: Schema.string().required(), title: Schema.string(), teamId: Schema.string(), roleId: Schema.string(), context: Schema.string() })).min(1).max(MAX_AGENTS_PER_CALL).required() }).description('Update Agent records by agentId.');
export const AgentRemoveMany = Schema.object({ groupId: Schema.number().step(1).min(1).required(), agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required() }).description('Delete Agent records by agentIds.');
export const AgentSessionList = Schema.object({ groupId: Schema.number().step(1).min(1).required(), teamId: Schema.string(), agentId: Schema.string() }).description('List runtime sessions by sessionId, optionally filtered by owning Agent or team.');
export const AgentSessionGet = Schema.object({ groupId: Schema.number().step(1).min(1).required(), sessionId: Schema.string().required(), ...conversationRead }).description('Read a runtime session conversation by sessionId.');
export const AgentSessionCreate = Schema.object({ groupId: Schema.number().step(1).min(1).required(), agentId: Schema.string().required(), title: Schema.string(), message: Schema.string().required().description('Required non-empty initial prompt sent to the Agent after session creation.') }).description('Create a runtime session for an existing Agent record and immediately send its required initial prompt.');
const AgentSessionCreateFields = Schema.object({
    agentId: Schema.string().required().description('Existing Agent id.'),
    title: Schema.string().description('Optional session title.'),
    message: Schema.string().required().description('Required non-empty initial prompt sent to the Agent.'),
});
export const AgentSessionCreateMany = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    sessions: Schema.array(AgentSessionCreateFields).min(1).required(),
}).description('Create runtime sessions concurrently for existing Agents. Every session requires an initial prompt. Results report successes and failures separately; this batch is not transactional.');
export const AgentSessionUpdate = Schema.object({ groupId: Schema.number().step(1).min(1).required(), sessionId: Schema.string().required(), title: Schema.string().required() }).description('Rename a runtime session by sessionId.');
export const AgentSessionDelete = Schema.object({ groupId: Schema.number().step(1).min(1).required(), sessionId: Schema.string().required() }).description('Delete a runtime session by sessionId.');
export const AgentSessionGetMany = Schema.object({ groupId: Schema.number().step(1).min(1).required(), sessionIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required(), ...conversationRead }).description('Read runtime sessions by sessionIds.');
export const AgentSessionDeleteMany = Schema.object({ groupId: Schema.number().step(1).min(1).required(), sessionIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required() }).description('Delete runtime sessions by sessionIds.');
export async function listAgents(ctx: ToolContext, args: ToolArgs) { const { groupId } = await requireGroup(ctx,args); const agents = await AgentModel.listAgents(ctx.domainId,ctx.owner,groupId,asText(args.teamId)||undefined); return { ok:true,groupId,count:agents.length,agents:agents.map(agentRecordView) }; }
export async function getAgent(ctx: ToolContext,args:ToolArgs) { const {groupId}=await requireGroup(ctx,args); const agentId=asText(args.agentId); const a=agentId&&await AgentModel.getAgent(ctx.domainId,ctx.owner,agentId,groupId); if(!a) throw new Error(`Agent not found: ${agentId}`); return {ok:true,groupId,agent:agentRecordView(a)}; }
export async function createAgent(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    const root = await ensureGroupRoot(ctx, groupId, group.title);
    const title = asText(args.title);
    if (!title) throw new Error('title is required');
    const teamId = asText(args.teamId) || root.teamId;
    if (!await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId)) throw new Error(`Team not found: ${teamId}`);
    const roleId = asText(args.roleId);
    if (roleId) await requireAgentConfigurationPermission(ctx);
    await validateRoleAssignment(ctx, groupId, group.title, roleId);
    const agent = await AgentModel.createAgent(ctx.domainId, ctx.owner, groupId, teamId, title, settingsFromArgs(args), configFromArgs(args));
    if (Object.prototype.hasOwnProperty.call(args, 'context')) {
        await ctx.broadcastAgentEvent?.('agent/agent-context', { domainId: ctx.domainId, userId: ctx.owner, groupId, agentId: agent.agentId });
    }
    return { ok: true, groupId, agent: agentRecordView(agent) };
}
export async function updateAgent(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    const agentId = asText(args.agentId);
    const old = agentId && await AgentModel.getAgent(ctx.domainId, ctx.owner, agentId, groupId);
    if (!old) throw new Error(`Agent not found: ${agentId}`);
    const patch: { title?: string; teamId?: string; settings?: AgentSettings; config?: AgentConfig } = {};
    if (Object.prototype.hasOwnProperty.call(args, 'title')) {
        const title = asText(args.title);
        if (!title) throw new Error('title cannot be empty');
        patch.title = title;
    }
    if (Object.prototype.hasOwnProperty.call(args, 'teamId')) {
        const teamId = asText(args.teamId);
        if (!teamId || !await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId)) throw new Error(`Team not found: ${teamId}`);
        patch.teamId = teamId;
    }
    if (['provider', 'model', 'baseDocId', 'runtimeId', 'agentPreset', 'roleId'].some((key) => Object.prototype.hasOwnProperty.call(args, key))) {
        const roleId = asText(args.roleId);
        if (Object.prototype.hasOwnProperty.call(args, 'roleId') && roleId) await requireAgentConfigurationPermission(ctx);
        await validateRoleAssignment(ctx, groupId, group.title, roleId);
        patch.settings = settingsFromArgs(args, old.settings);
    }
    if (Object.prototype.hasOwnProperty.call(args, 'context')) patch.config = configFromArgs(args, old.config);
    if (!Object.keys(patch).length) throw new Error('Nothing to update');
    const agent = await AgentModel.updateAgent(ctx.domainId, ctx.owner, agentId, patch, groupId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (patch.config !== undefined) {
        await ctx.broadcastAgentEvent?.('agent/agent-context', { domainId: ctx.domainId, userId: ctx.owner, groupId, agentId });
    }
    return { ok: true, groupId, agent: agentRecordView(agent) };
}
export async function removeAgent(ctx:ToolContext,args:ToolArgs) { const {groupId}=await requireGroup(ctx,args,'delete'); const agentId=asText(args.agentId);if(!agentId)throw new Error('agentId is required');await AgentModel.deleteAgent(ctx.domainId,ctx.owner,agentId,groupId);return {ok:true,groupId,agentId,deleted:true}; }

export async function createAgents(ctx: ToolContext, args: ToolArgs) {
 const {groupId}=await requireGroup(ctx,args,'edit'); const entries=objectEntries(args.agents,'agents'); const agents=[] as any[]; const refusedAgents=[] as any[];
 for(const [index,e] of entries.entries()) try { const r=await createAgent(ctx,{...e,groupId}); agents.push({index,agent:r.agent}); } catch(err){refusedAgents.push({index,error:(err as Error).message});}
 return {ok:!refusedAgents.length,groupId,agents,refusedAgents};
}
export async function getAgents(ctx: ToolContext,args: ToolArgs) {
 const {groupId}=await requireGroup(ctx,args); const ids=idList(args.agentIds,'agentIds',MAX_AGENTS_PER_CALL); const docs=await AgentModel.listAgents(ctx.domainId,ctx.owner,groupId); const map=new Map(docs.map(x=>[x.agentId,x])); const agents=ids.flatMap((id,index)=>{const a=map.get(id);return a?[{index,...agentRecordView(a)}]:[]}); const missingAgentIds=ids.filter(id=>!map.has(id)); return {ok:!missingAgentIds.length,groupId,agents,missingAgentIds};
}
export async function updateAgents(ctx: ToolContext,args: ToolArgs) {
 const {groupId}=await requireGroup(ctx,args,'edit'); const entries=objectEntries(args.entries,'entries'); const agents=[] as any[]; const refusedAgents=[] as any[];
 for(const [index,e] of entries.entries()) try {const r=await updateAgent(ctx,{...e,groupId});agents.push({index,agent:r.agent});}catch(err){refusedAgents.push({index,agentId:asText(e.agentId),error:(err as Error).message});}
 return {ok:!refusedAgents.length,groupId,agents,refusedAgents};
}
export async function removeAgents(ctx: ToolContext,args: ToolArgs) { const {groupId}=await requireGroup(ctx,args,'delete'); const agentIds=idList(args.agentIds,'agentIds',MAX_AGENTS_PER_CALL); for(const id of agentIds) await AgentModel.deleteAgent(ctx.domainId,ctx.owner,id,groupId); return {ok:true,groupId,removedAgentIds:agentIds}; }
export async function listAgentSessions(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args);
    const teamId = typeof args.teamId === 'string' && args.teamId.trim() ? args.teamId.trim() : undefined;
    if (teamId && !await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId)) {
        throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
    }
    const sessions = await AgentSessionModel.listSessionViews(ctx.domainId, ctx.owner, groupId);
    const agents = teamId ? sessions.filter((session) => session.teamId === teamId) : sessions;
    return { ok: true, groupId, ...(teamId ? { teamId } : {}), count: agents.length, agents: agents.map(sessionAgentView) };
}
export async function getAgentSession(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args);
    const sessionId = String(args.sessionId || '').trim();
    if (!sessionId) throw new Error('sessionId is required');
    const agent = await sessionConversation(ctx, groupId, sessionId, args);
    return { ok: true, groupId, ...agent };
}
export async function createAgentSession(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit');
    const agentId = asText(args.agentId);
    if (!agentId || !await AgentModel.getAgent(ctx.domainId, ctx.owner, agentId, groupId)) {
        throw new Error(`Agent not found: ${agentId}`);
    }
    const message = asText(args.message);
    if (!message) throw new Error('message is required and must not be empty');

    const response = await agentRuntimeHandlerContext.sessionCreate({ payload: { agentId } }, sessionScope(ctx, groupId));
    if (!response.result?.ok) throw new Error(response.error?.message || 'Failed to create session');
    const sessionId = (response.result.value as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) throw new Error('Session creation returned no sessionId');
    const title = asText(args.title);
    if (title) await renameSessionAgent(ctx, groupId, sessionId, title);
    const link = await agentRuntimeHandlerContext.linkForSession(sessionScope(ctx, groupId), sessionId);
    const sent = await agentRuntimeHandlerContext.callUpstream('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
    }, link);
    if (!sent.body.result?.ok) throw new Error(sent.body.error?.message || 'Failed to start session');
    return { ok: true, groupId, sessionId };
}

export async function createAgentSessionsForExistingAgents(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit');
    const entries = objectEntries(args.sessions, 'sessions');
    type SessionCreateResult =
        | { index: number; agentId: string; sessionId: string }
        | { index: number; agentId?: string; error: string };
    const results = await Promise.all(entries.map(async (entry, index): Promise<SessionCreateResult> => {
        const agentId = asText(entry.agentId);
        try {
            const result = await createAgentSession(ctx, { ...entry, groupId });
            return { index, agentId, sessionId: result.sessionId };
        } catch (error) {
            return { index, ...(agentId ? { agentId } : {}), error: (error as Error).message };
        }
    }));
    const created = results.filter((result): result is { index: number; agentId: string; sessionId: string } => 'sessionId' in result);
    const refused = results.filter((result): result is { index: number; agentId?: string; error: string } => 'error' in result);
    return { ok: refused.length === 0, groupId, sessionCount: created.length, sessions: created, refusedSessions: refused };
}

export async function updateAgentSession(ctx: ToolContext,args:ToolArgs) { const {groupId}=await requireGroup(ctx,args,'edit');const sessionId=asText(args.sessionId),title=asText(args.title);if(!sessionId||!title)throw new Error('sessionId and title are required');await renameSessionAgent(ctx,groupId,sessionId,title);return {ok:true,groupId,sessionId,title}; }

export async function createAgentSessions(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    const raw = objectEntries(args.agents, 'agents');
    if (raw.length > MAX_AGENTS_PER_CALL) throw new Error(`agents holds ${raw.length} entries and one call creates ${MAX_AGENTS_PER_CALL}; split the work across calls`);
    const planned = raw.map((fields, index) => sessionAgentInput(fields, `agents[${index}]`));
    const created: { index: number; started: boolean; agent: ReturnType<typeof sessionAgentView>; error?: string }[] = [];
    const refused: { index: number; agentId?: string; error: string }[] = [];
    for (const [index, input] of planned.entries()) {
        try {
            const result = await createSessionAgent(ctx, groupId, group.title, input);
            created.push({ index, started: result.started, agent: result.agent, ...(result.error ? { error: result.error } : {}) });
            if (result.error) refused.push({ index, agentId: result.agent.agentId, error: result.error });
        } catch (error) {
            refused.push({ index, error: (error as Error).message });
        }
    }
    return { ok: refused.length === 0, groupId, agentCount: created.length, agents: created, refusedAgents: refused };
}

export async function getAgentSessions(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args);
    const sessionIds = idList(args.sessionIds, 'sessionIds', MAX_AGENTS_PER_CALL);
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, groupId);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const found: { index: number; sessionId: string; title: string; content: string; hasMore?: boolean; beforeSeq?: number; truncated?: boolean }[] = [];
    const missing: string[] = [];
    for (const [index, sessionId] of sessionIds.entries()) {
        const session = byId.get(sessionId);
        if (!session) {
            missing.push(sessionId);
            continue;
        }
        const agent = await sessionConversation(ctx, groupId, sessionId, args);
        found.push({
            index,
            sessionId: agent.sessionId,
            title: agent.title,
            content: agent.content,
            ...(agent.hasMore ? { hasMore: true, beforeSeq: agent.beforeSeq } : {}),
            ...(agent.truncated ? { truncated: true } : {}),
        });
    }
    return { ok: missing.length === 0, groupId, sessionCount: found.length, sessions: found, missingSessionIds: missing };
}

export async function updateAgentSessions(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit');
    const raw = objectEntries(args.entries, 'entries');
    if (raw.length > MAX_AGENTS_PER_CALL) throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_AGENTS_PER_CALL}; split the work across calls`);
    const planned: { index: number; sessionId: string; title?: string; teamId?: string }[] = [];
    const seen = new Set<string>();
    for (const [index, fields] of raw.entries()) {
        const sessionId = asText(fields.sessionId);
        if (!sessionId) throw new Error(`entries[${index}].sessionId is required`);
        if (seen.has(sessionId)) throw new Error(`entries[${index}].sessionId ${sessionId} appears twice; send one entry per agent`);
        seen.add(sessionId);
        const hasTitle = Object.prototype.hasOwnProperty.call(fields, 'title');
        const hasTeam = Object.prototype.hasOwnProperty.call(fields, 'teamId');
        if (!hasTitle && !hasTeam) throw new Error(`entries[${index}] names nothing to change; give title, teamId, or both`);
        const title = hasTitle ? asText(fields.title) : undefined;
        if (hasTitle && !title) throw new Error(`entries[${index}].title cannot be empty`);
        const teamId = hasTeam ? asText(fields.teamId) : undefined;
        if (hasTeam && !teamId) throw new Error(`entries[${index}].teamId cannot be empty`);
        planned.push({ index, sessionId, ...(title ? { title } : {}), ...(teamId ? { teamId } : {}) });
    }
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, groupId);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    for (const entry of planned) {
        if (!byId.has(entry.sessionId)) throw new Error(`Session agent not found in Group ${groupId}: ${entry.sessionId}`);
        if (entry.teamId && !await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, entry.teamId, groupId)) {
            throw new Error(`Team not found in Group ${groupId}: ${entry.teamId}`);
        }
    }
    const updated: { index: number; agent: ReturnType<typeof sessionAgentView>; failedAddonIds?: string[]; failedContextSync?: boolean }[] = [];
    const refused: { index: number; sessionId: string; error: string }[] = [];
    for (const entry of planned) {
        try {
            const current = byId.get(entry.sessionId)!;
            let failedAddonIds: string[] = [];
            let failedContextSync = false;
            if (current.sessionId) {
                await AgentModel.updateAgent(ctx.domainId, ctx.owner, current.sessionId, {
                    ...(entry.title ? { title: entry.title } : {}),
                    ...(entry.teamId && entry.teamId !== current.teamId ? { teamId: entry.teamId } : {}),
                }, groupId);
                if (entry.teamId && entry.teamId !== current.teamId) {
                    const scope = sessionScope(ctx, groupId);
                    const linkedSessions = sessions.filter((item) => item.sessionId === current.sessionId);
                    const results = await Promise.all(linkedSessions.map(async (item) => ({
                        failedAddonIds: await agentRuntimeHandlerContext.syncSessionAddonsForTeam(scope, item.sessionId, entry.teamId!),
                        failedContextSync: await agentRuntimeHandlerContext.syncSessionTeamContextForTeam(scope, item.sessionId, entry.teamId!),
                    })));
                    failedAddonIds = [...new Set(results.flatMap((result) => result.failedAddonIds))];
                    failedContextSync = results.some((result) => result.failedContextSync);
                }
            } else {
                if (entry.title) await renameSessionAgent(ctx, groupId, entry.sessionId, entry.title);
                if (entry.teamId && entry.teamId !== current.teamId) {
                    const scope = sessionScope(ctx, groupId);
                    await agentRuntimeHandlerContext.agentDataAdapter.updateSession(scope, entry.sessionId, { teamId: entry.teamId });
                    failedAddonIds = await agentRuntimeHandlerContext.syncSessionAddonsForTeam(scope, entry.sessionId, entry.teamId);
                    failedContextSync = await agentRuntimeHandlerContext.syncSessionTeamContextForTeam(scope, entry.sessionId, entry.teamId);
                }
            }
            const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, entry.sessionId, groupId);
            if (!session) throw new Error(`Session agent not found in Group ${groupId}: ${entry.sessionId}`);
            updated.push({
                index: entry.index,
                agent: sessionAgentView(session),
                ...(failedAddonIds.length ? { failedAddonIds } : {}),
                ...(failedContextSync ? { failedContextSync: true } : {}),
            });
        } catch (error) {
            refused.push({ index: entry.index, sessionId: entry.sessionId, error: (error as Error).message });
        }
    }
    return { ok: refused.length === 0, groupId, agentCount: updated.length, agents: updated, refusedAgents: refused };
}

export async function removeAgentSessions(ctx:ToolContext,args:ToolArgs) {const {groupId}=await requireGroup(ctx,args,'delete');const sessionIds=idList(args.sessionIds,'sessionIds',MAX_AGENTS_PER_CALL);await AgentSessionModel.deleteSessions(ctx.domainId,ctx.owner,sessionIds,groupId);return {ok:true,groupId,removedSessionIds:sessionIds,removedCount:sessionIds.length};}

export async function removeAgentSession(ctx:ToolContext,args:ToolArgs) {const {groupId}=await requireGroup(ctx,args,'delete');const sessionId=asText(args.sessionId);if(!sessionId)throw new Error('sessionId is required');await AgentSessionModel.deleteSession(ctx.domainId,ctx.owner,sessionId,groupId);return {ok:true,groupId,sessionId,deleted:true};}

export function apply(ctx: Context) {
    ctx.Tool('agent', 'agent_agent_list', listAgents, AgentList, agentToolAccess(AGENT.AGENT_LIST), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_get', getAgent, AgentGet, agentToolAccess(AGENT.AGENT_GET), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_create', createAgent, AgentCreate, agentToolAccess(AGENT.AGENT_CREATE), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_update', updateAgent, AgentUpdate, agentToolAccess(AGENT.AGENT_UPDATE), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_delete', removeAgent, AgentRemove, agentToolAccess(AGENT.AGENT_DELETE), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_create_many', createAgents, AgentCreateMany, agentToolAccess(AGENT.AGENT_CREATE_MANY), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_get_many', getAgents, AgentGetMany, agentToolAccess(AGENT.AGENT_GET_MANY), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_update_many', updateAgents, AgentUpdateMany, agentToolAccess(AGENT.AGENT_UPDATE_MANY), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_delete_many', removeAgents, AgentRemoveMany, agentToolAccess(AGENT.AGENT_DELETE_MANY), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_session_list', listAgentSessions, AgentSessionList, agentToolAccess(AGENT.SESSION_LIST), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_session_get', getAgentSession, AgentSessionGet, agentToolAccess(AGENT.SESSION_GET), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_session_create', createAgentSession, AgentSessionCreate, agentToolAccess(AGENT.SESSION_CREATE), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_session_create_many', createAgentSessionsForExistingAgents, AgentSessionCreateMany, agentToolAccess(AGENT.SESSION_CREATE_MANY), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_session_update', updateAgentSession, AgentSessionUpdate, agentToolAccess(AGENT.SESSION_UPDATE), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_session_delete', removeAgentSession, AgentSessionDelete, agentToolAccess(AGENT.SESSION_DELETE), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_session_get_many', getAgentSessions, AgentSessionGetMany, agentToolAccess(AGENT.SESSION_GET_MANY), USER.PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_session_delete_many', removeAgentSessions, AgentSessionDeleteMany, agentToolAccess(AGENT.SESSION_DELETE_MANY), USER.PRIV.PRIV_USER_PROFILE);
}

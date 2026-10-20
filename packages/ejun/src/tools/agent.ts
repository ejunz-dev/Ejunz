import Schema from 'schemastery';
import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PERM } from 'ejun/src/model/builtin';
import { AgentModel, AgentSessionModel } from 'ejun/src/model/agent';
import { MAX_AGENTS_PER_CALL, MAX_FILE_CONTENT_CHARS, MAX_FILE_CONTENT_CHARS_LIMIT } from '../lib/tool-limits';
import { asText, idList } from '../lib/tool-shared';
import { agentRuntimeHandlerContext } from '../service/runtime';
import type { AgentConfig, AgentSettings } from 'ejun/src/model/agent';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import {
    agentRecordView,
    configFromArgs,
    createSessionAgent,
    ensureGroupRoot,
    objectEntries,
    renameSessionAgent,
    requireGroup,
    sessionAgentInput,
    sessionAgentView,
    sessionConversation,
    sessionScope,
    settingsFromArgs,
    validateRoleAssignment,
    requireAgentConfigurationPermission,
} from './common/agent';

export const inject = ['server'];

const conversationRead = {
    beforeSeq: Schema.number().step(1).min(0).description('Return turns before this event seq.'),
    maxMessages: Schema.number().step(1).min(1).max(500).description('Maximum turns to read (default 50).'),
    maxChars: Schema.number()
        .step(1)
        .min(1)
        .max(MAX_FILE_CONTENT_CHARS_LIMIT)
        .description(`Cap on returned text (default ${MAX_FILE_CONTENT_CHARS}).`),
};
export const AgentListSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    teamId: Schema.string().description('Optional team filter.'),
}).description('List persisted Agent records, including agentId, teamId, title, and settings.');
export const AgentGetSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    agentId: Schema.string().required().description('Persisted Agent id.'),
}).description('Read one persisted Agent record by agentId.');
export const AgentCreateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    teamId: Schema.string(),
    title: Schema.string().required(),
    provider: Schema.string(),
    model: Schema.string(),
    baseDocId: Schema.number().step(1).min(1),
    runtimeId: Schema.string(),
    agentPreset: Schema.string(),
    roleId: Schema.string().description(
        'Optional Group role id; requires Agent configuration permission. Omit or pass an empty string to use Default.',
    ),
    context: Schema.string(),
}).description('Create a persistent Agent record with teamId, title, settings, and optional role and context; does not create a session.');
export const AgentUpdateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    agentId: Schema.string().required(),
    title: Schema.string(),
    teamId: Schema.string(),
    provider: Schema.string(),
    model: Schema.string(),
    baseDocId: Schema.number().step(1).min(1),
    runtimeId: Schema.string(),
    agentPreset: Schema.string(),
    roleId: Schema.string().description('Set a Group role id (requires Agent configuration permission); pass an empty string to return to Default.'),
    context: Schema.string(),
}).description('Update an Agent record, its settings, role assignment, or persistent context by agentId.');
export const AgentRemoveSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    agentId: Schema.string().required(),
}).description('Delete an Agent record by agentId.');
const AgentCreateFieldsSchema = Schema.object({
    teamId: Schema.string(),
    title: Schema.string().required(),
    provider: Schema.string(),
    model: Schema.string(),
    baseDocId: Schema.number().step(1).min(1),
    runtimeId: Schema.string(),
    agentPreset: Schema.string(),
    roleId: Schema.string(),
    context: Schema.string(),
});
export const AgentCreateManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    agents: Schema.array(AgentCreateFieldsSchema).min(1).max(MAX_AGENTS_PER_CALL).required(),
}).description('Create persisted Agent records.');
export const AgentGetManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required(),
}).description('Read Agent records by agentIds.');
export const AgentUpdateManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    entries: Schema.array(
        Schema.object({
            agentId: Schema.string().required(),
            title: Schema.string(),
            teamId: Schema.string(),
            roleId: Schema.string(),
            context: Schema.string(),
        }),
    )
        .min(1)
        .max(MAX_AGENTS_PER_CALL)
        .required(),
}).description('Update Agent records by agentId.');
export const AgentRemoveManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required(),
}).description('Delete Agent records by agentIds.');
export const AgentSessionListSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    teamId: Schema.string(),
    agentId: Schema.string(),
}).description('List runtime sessions by sessionId, optionally filtered by owning Agent or team.');
export const AgentSessionGetSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    sessionId: Schema.string().required(),
    ...conversationRead,
}).description('Read a runtime session conversation by sessionId.');
export const AgentSessionCreateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    agentId: Schema.string().required(),
    title: Schema.string(),
    message: Schema.string().required().description('Required non-empty initial prompt sent to the Agent after session creation.'),
}).description('Create a runtime session for an existing Agent record and immediately send its required initial prompt.');
const AgentSessionCreateFieldsSchema = Schema.object({
    agentId: Schema.string().required().description('Existing Agent id.'),
    title: Schema.string().description('Optional session title.'),
    message: Schema.string().required().description('Required non-empty initial prompt sent to the Agent.'),
});
export const AgentSessionCreateManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    sessions: Schema.array(AgentSessionCreateFieldsSchema).min(1).required(),
}).description(
    'Create runtime sessions concurrently for existing Agents. Every session requires an initial prompt. Results report successes and failures separately; this batch is not transactional.',
);
export const AgentSessionUpdateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    sessionId: Schema.string().required(),
    title: Schema.string().required(),
}).description('Rename a runtime session by sessionId.');
export const AgentSessionDeleteSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    sessionId: Schema.string().required(),
}).description('Delete a runtime session by sessionId.');
export const AgentSessionGetManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    sessionIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required(),
    ...conversationRead,
}).description('Read runtime sessions by sessionIds.');
export const AgentSessionDeleteManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    sessionIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required(),
}).description('Delete runtime sessions by sessionIds.');

class AgentAgentListExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args);
        const agents = await AgentModel.listAgents(this.ctx.domainId, this.ctx.owner, groupId, asText(this.args.teamId) || undefined);
        return { ok: true, groupId, count: agents.length, agents: agents.map(agentRecordView) };
    }
}

class AgentAgentGetExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args);
        const agentId = asText(this.args.agentId);
        const a = agentId && (await AgentModel.getAgent(this.ctx.domainId, this.ctx.owner, agentId, groupId));
        if (!a) throw new Error(`Agent not found: ${agentId}`);
        return { ok: true, groupId, agent: agentRecordView(a) };
    }
}

export class AgentAgentCreateExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId, group } = await requireGroup(this.ctx, this.args, 'edit');
        const root = await ensureGroupRoot(this.ctx, groupId, group.title);
        const title = asText(this.args.title);
        if (!title) throw new Error('title is required');
        const teamId = asText(this.args.teamId) || root.teamId;
        if (!(await AgentSessionModel.getTeam(this.ctx.domainId, this.ctx.owner, teamId, groupId))) throw new Error(`Team not found: ${teamId}`);
        const roleId = asText(this.args.roleId);
        if (roleId) await requireAgentConfigurationPermission(this.ctx);
        await validateRoleAssignment(this.ctx, groupId, group.title, roleId);
        const agent = await AgentModel.createAgent(
            this.ctx.domainId,
            this.ctx.owner,
            groupId,
            teamId,
            title,
            settingsFromArgs(this.args),
            configFromArgs(this.args),
        );
        if (Object.prototype.hasOwnProperty.call(this.args, 'context')) {
            await this.ctx.broadcastAgentEvent?.('agent/agent-context', {
                domainId: this.ctx.domainId,
                userId: this.ctx.owner,
                groupId,
                agentId: agent.agentId,
            });
        }
        return { ok: true, groupId, agent: agentRecordView(agent) };
    }
}

export class AgentAgentUpdateExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId, group } = await requireGroup(this.ctx, this.args, 'edit');
        const agentId = asText(this.args.agentId);
        const old = agentId && (await AgentModel.getAgent(this.ctx.domainId, this.ctx.owner, agentId, groupId));
        if (!old) throw new Error(`Agent not found: ${agentId}`);
        const patch: { title?: string; teamId?: string; settings?: AgentSettings; config?: AgentConfig } = {};
        if (Object.prototype.hasOwnProperty.call(this.args, 'title')) {
            const title = asText(this.args.title);
            if (!title) throw new Error('title cannot be empty');
            patch.title = title;
        }
        if (Object.prototype.hasOwnProperty.call(this.args, 'teamId')) {
            const teamId = asText(this.args.teamId);
            if (!teamId || !(await AgentSessionModel.getTeam(this.ctx.domainId, this.ctx.owner, teamId, groupId)))
                throw new Error(`Team not found: ${teamId}`);
            patch.teamId = teamId;
        }
        if (
            ['provider', 'model', 'baseDocId', 'runtimeId', 'agentPreset', 'roleId'].some((key) =>
                Object.prototype.hasOwnProperty.call(this.args, key),
            )
        ) {
            const roleId = asText(this.args.roleId);
            if (Object.prototype.hasOwnProperty.call(this.args, 'roleId') && roleId) await requireAgentConfigurationPermission(this.ctx);
            await validateRoleAssignment(this.ctx, groupId, group.title, roleId);
            patch.settings = settingsFromArgs(this.args, old.settings);
        }
        if (Object.prototype.hasOwnProperty.call(this.args, 'context')) patch.config = configFromArgs(this.args, old.config);
        if (!Object.keys(patch).length) throw new Error('Nothing to update');
        const agent = await AgentModel.updateAgent(this.ctx.domainId, this.ctx.owner, agentId, patch, groupId);
        if (!agent) throw new Error(`Agent not found: ${agentId}`);
        if (patch.config !== undefined) {
            await this.ctx.broadcastAgentEvent?.('agent/agent-context', { domainId: this.ctx.domainId, userId: this.ctx.owner, groupId, agentId });
        }
        return { ok: true, groupId, agent: agentRecordView(agent) };
    }
}

class AgentAgentDeleteExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args, 'delete');
        const agentId = asText(this.args.agentId);
        if (!agentId) throw new Error('agentId is required');
        await AgentModel.deleteAgent(this.ctx.domainId, this.ctx.owner, agentId, groupId);
        return { ok: true, groupId, agentId, deleted: true };
    }
}

class AgentAgentCreateManyExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args, 'edit');
        const entries = objectEntries(this.args.agents, 'agents');
        const agents = [] as any[];
        const refusedAgents = [] as any[];
        for (const [index, e] of entries.entries())
            try {
                const r = (await new AgentAgentCreateExecutor(this.ctx, { ...e, groupId }).run()) as any;
                agents.push({ index, agent: r.agent });
            } catch (err) {
                refusedAgents.push({ index, error: (err as Error).message });
            }
        return { ok: !refusedAgents.length, groupId, agents, refusedAgents };
    }
}

export class AgentAgentGetManyExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args);
        const ids = idList(this.args.agentIds, 'agentIds', MAX_AGENTS_PER_CALL);
        const docs = await AgentModel.listAgents(this.ctx.domainId, this.ctx.owner, groupId);
        const map = new Map(docs.map((x) => [x.agentId, x]));
        const agents = ids.flatMap((id, index) => {
            const a = map.get(id);
            return a ? [{ index, ...agentRecordView(a) }] : [];
        });
        const missingAgentIds = ids.filter((id) => !map.has(id));
        return { ok: !missingAgentIds.length, groupId, agents, missingAgentIds };
    }
}

export class AgentAgentUpdateManyExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args, 'edit');
        const entries = objectEntries(this.args.entries, 'entries');
        const agents = [] as any[];
        const refusedAgents = [] as any[];
        for (const [index, e] of entries.entries())
            try {
                const r = (await new AgentAgentUpdateExecutor(this.ctx, { ...e, groupId }).run()) as any;
                agents.push({ index, agent: r.agent });
            } catch (err) {
                refusedAgents.push({ index, agentId: asText(e.agentId), error: (err as Error).message });
            }
        return { ok: !refusedAgents.length, groupId, agents, refusedAgents };
    }
}

export class AgentAgentDeleteManyExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args, 'delete');
        const agentIds = idList(this.args.agentIds, 'agentIds', MAX_AGENTS_PER_CALL);
        for (const id of agentIds) await AgentModel.deleteAgent(this.ctx.domainId, this.ctx.owner, id, groupId);
        return { ok: true, groupId, removedAgentIds: agentIds };
    }
}

class AgentSessionListExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args);
        const teamId = typeof this.args.teamId === 'string' && this.args.teamId.trim() ? this.args.teamId.trim() : undefined;
        if (teamId && !(await AgentSessionModel.getTeam(this.ctx.domainId, this.ctx.owner, teamId, groupId))) {
            throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
        }
        const sessions = await AgentSessionModel.listSessionViews(this.ctx.domainId, this.ctx.owner, groupId);
        const agents = teamId ? sessions.filter((session) => session.teamId === teamId) : sessions;
        return { ok: true, groupId, ...(teamId ? { teamId } : {}), count: agents.length, agents: agents.map(sessionAgentView) };
    }
}

class AgentSessionGetExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args);
        const sessionId = String(this.args.sessionId || '').trim();
        if (!sessionId) throw new Error('sessionId is required');
        const agent = await sessionConversation(this.ctx, groupId, sessionId, this.args);
        return { ok: true, groupId, ...agent };
    }
}

class AgentSessionCreateExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args, 'edit');
        const agentId = asText(this.args.agentId);
        if (!agentId || !(await AgentModel.getAgent(this.ctx.domainId, this.ctx.owner, agentId, groupId))) {
            throw new Error(`Agent not found: ${agentId}`);
        }
        const message = asText(this.args.message);
        if (!message) throw new Error('message is required and must not be empty');

        const response = await agentRuntimeHandlerContext.sessionCreate({ payload: { agentId } }, sessionScope(this.ctx, groupId));
        if (!response.result?.ok) throw new Error(response.error?.message || 'Failed to create session');
        const sessionId = (response.result.value as { sessionId?: string } | undefined)?.sessionId;
        if (!sessionId) throw new Error('Session creation returned no sessionId');
        const title = asText(this.args.title);
        if (title) await renameSessionAgent(this.ctx, groupId, sessionId, title);
        const link = await agentRuntimeHandlerContext.linkForSession(sessionScope(this.ctx, groupId), sessionId);
        const sent = await agentRuntimeHandlerContext.callUpstream(
            'session.prompt',
            {
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: message }],
            },
            link,
        );
        if (!sent.body.result?.ok) throw new Error(sent.body.error?.message || 'Failed to start session');
        return { ok: true, groupId, sessionId };
    }
}

class AgentSessionCreateManyExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args, 'edit');
        const entries = objectEntries(this.args.sessions, 'sessions');
        type SessionCreateResult = { index: number; agentId: string; sessionId: string } | { index: number; agentId?: string; error: string };
        const results = await Promise.all(
            entries.map(async (entry, index): Promise<SessionCreateResult> => {
                const agentId = asText(entry.agentId);
                try {
                    const result = (await new AgentSessionCreateExecutor(this.ctx, { ...entry, groupId }).run()) as any;
                    return { index, agentId, sessionId: result.sessionId };
                } catch (error) {
                    return { index, ...(agentId ? { agentId } : {}), error: (error as Error).message };
                }
            }),
        );
        const created = results.filter((result): result is { index: number; agentId: string; sessionId: string } => 'sessionId' in result);
        const refused = results.filter((result): result is { index: number; agentId?: string; error: string } => 'error' in result);
        return { ok: refused.length === 0, groupId, sessionCount: created.length, sessions: created, refusedSessions: refused };
    }
}

class AgentSessionUpdateExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args, 'edit');
        const sessionId = asText(this.args.sessionId),
            title = asText(this.args.title);
        if (!sessionId || !title) throw new Error('sessionId and title are required');
        await renameSessionAgent(this.ctx, groupId, sessionId, title);
        return { ok: true, groupId, sessionId, title };
    }
}

class AgentSessionDeleteExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args, 'delete');
        const sessionId = asText(this.args.sessionId);
        if (!sessionId) throw new Error('sessionId is required');
        await AgentSessionModel.deleteSession(this.ctx.domainId, this.ctx.owner, sessionId, groupId);
        return { ok: true, groupId, sessionId, deleted: true };
    }
}

class AgentSessionGetManyExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args);
        const sessionIds = idList(this.args.sessionIds, 'sessionIds', MAX_AGENTS_PER_CALL);
        const sessions = await AgentSessionModel.listSessions(this.ctx.domainId, this.ctx.owner, groupId);
        const byId = new Map(sessions.map((session) => [session.sessionId, session]));
        const found: {
            index: number;
            sessionId: string;
            title: string;
            content: string;
            hasMore?: boolean;
            beforeSeq?: number;
            truncated?: boolean;
        }[] = [];
        const missing: string[] = [];
        for (const [index, sessionId] of sessionIds.entries()) {
            const session = byId.get(sessionId);
            if (!session) {
                missing.push(sessionId);
                continue;
            }
            const agent = await sessionConversation(this.ctx, groupId, sessionId, this.args);
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
}

class AgentSessionDeleteManyExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const { groupId } = await requireGroup(this.ctx, this.args, 'delete');
        const sessionIds = idList(this.args.sessionIds, 'sessionIds', MAX_AGENTS_PER_CALL);
        await AgentSessionModel.deleteSessions(this.ctx.domainId, this.ctx.owner, sessionIds, groupId);
        return { ok: true, groupId, removedSessionIds: sessionIds, removedCount: sessionIds.length };
    }
}

export function apply(ctx: Context) {
    ctx.Tool('agent', 'agent_agent_list', AgentAgentListExecutor, AgentListSchema, PERM.AGENT_PERM_AGENT_LIST);
    ctx.Tool('agent', 'agent_agent_get', AgentAgentGetExecutor, AgentGetSchema, PERM.AGENT_PERM_AGENT_GET);
    ctx.Tool('agent', 'agent_agent_create', AgentAgentCreateExecutor, AgentCreateSchema, PERM.AGENT_PERM_AGENT_CREATE);
    ctx.Tool('agent', 'agent_agent_update', AgentAgentUpdateExecutor, AgentUpdateSchema, PERM.AGENT_PERM_AGENT_UPDATE);
    ctx.Tool('agent', 'agent_agent_delete', AgentAgentDeleteExecutor, AgentRemoveSchema, PERM.AGENT_PERM_AGENT_DELETE);
    ctx.Tool('agent', 'agent_agent_create_many', AgentAgentCreateManyExecutor, AgentCreateManySchema, PERM.AGENT_PERM_AGENT_CREATE_MANY);
    ctx.Tool('agent', 'agent_agent_get_many', AgentAgentGetManyExecutor, AgentGetManySchema, PERM.AGENT_PERM_AGENT_GET_MANY);
    ctx.Tool('agent', 'agent_agent_update_many', AgentAgentUpdateManyExecutor, AgentUpdateManySchema, PERM.AGENT_PERM_AGENT_UPDATE_MANY);
    ctx.Tool('agent', 'agent_agent_delete_many', AgentAgentDeleteManyExecutor, AgentRemoveManySchema, PERM.AGENT_PERM_AGENT_DELETE_MANY);
    ctx.Tool('agent', 'agent_session_list', AgentSessionListExecutor, AgentSessionListSchema, PERM.AGENT_PERM_SESSION_LIST);
    ctx.Tool('agent', 'agent_session_get', AgentSessionGetExecutor, AgentSessionGetSchema, PERM.AGENT_PERM_SESSION_GET);
    ctx.Tool('agent', 'agent_session_create', AgentSessionCreateExecutor, AgentSessionCreateSchema, PERM.AGENT_PERM_SESSION_CREATE);
    ctx.Tool('agent', 'agent_session_create_many', AgentSessionCreateManyExecutor, AgentSessionCreateManySchema, PERM.AGENT_PERM_SESSION_CREATE_MANY);
    ctx.Tool('agent', 'agent_session_update', AgentSessionUpdateExecutor, AgentSessionUpdateSchema, PERM.AGENT_PERM_SESSION_UPDATE);
    ctx.Tool('agent', 'agent_session_delete', AgentSessionDeleteExecutor, AgentSessionDeleteSchema, PERM.AGENT_PERM_SESSION_DELETE);
    ctx.Tool('agent', 'agent_session_get_many', AgentSessionGetManyExecutor, AgentSessionGetManySchema, PERM.AGENT_PERM_SESSION_GET_MANY);
    ctx.Tool('agent', 'agent_session_delete_many', AgentSessionDeleteManyExecutor, AgentSessionDeleteManySchema, PERM.AGENT_PERM_SESSION_DELETE_MANY);
}

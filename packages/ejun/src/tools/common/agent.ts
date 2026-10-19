import { PERM } from 'ejun/src/model/builtin';
import GroupDefinitionModel, { AgentModel, AgentSessionModel } from 'ejun/src/model/agent';
import UserModel from 'ejun/src/model/user';
import { MAX_FILE_CONTENT_CHARS, MAX_FILE_CONTENT_CHARS_LIMIT } from '../../lib/tool-limits';
import { asText, idList } from '../../lib/tool-shared';
import { agentRuntimeHandlerContext } from '../../service/runtime';
import { defaultAgentAcl } from 'ejun/src/model/agent';
import { agentPermissionCatalog, normalizeAgentAcl } from '../../service/agent-acl';
import type { AgentConfig, AgentSettings, AgentTeamAcl, AgentTeamDoc, AgentSessionSummary, AgentSessionView } from 'ejun/src/model/agent';
import type { ToolArgs, ToolContext } from '../../lib/tool-types';

export function groupIdOf(args: ToolArgs): number {
    const groupId = Number(args.groupId);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('groupId is required');
    return groupId;
}

export function groupView(group: { docId: number; aid?: string; title?: string; content?: string; updateAt?: Date | string }) {
    return {
        groupId: Number(group.docId),
        aid: String(group.aid || ''),
        title: String(group.title || ''),
        content: String(group.content || ''),
        updateAt: group.updateAt instanceof Date ? group.updateAt.toISOString() : String(group.updateAt || ''),
    };
}

export function teamView(team: AgentTeamDoc) {
    return {
        teamId: team.teamId,
        ...(team.parentTeamId ? { parentTeamId: team.parentTeamId } : {}),
        ...(team.isRootTeam ? { isRootTeam: true } : {}),
        text: team.text,
        order: team.order,
        ...(team.config === undefined ? {} : { config: team.config }),
        createdAt: team.createdAt.toISOString(),
        updatedAt: team.updatedAt.toISOString(),
    };
}

type SessionAgentData = AgentSessionView;

export function sessionTitleOf(session: Pick<AgentSessionSummary, 'sessionId' | 'blank' | 'projections'>): string {
    const title = session.projections?.values?.title;
    return typeof title === 'string' && title.trim()
        ? title
        : session.blank ? '新会话' : `会话 ${session.sessionId.slice(8, 16)}`;
}

export function sessionAgentView(session: SessionAgentData) {
    return {
        sessionId: session.sessionId,
        ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
        ...(session.groupId === undefined ? {} : { groupId: session.groupId }),
        ...(session.teamId === undefined ? {} : { teamId: session.teamId }),
        title: sessionTitleOf(session),
        agentType: 'session',
        createdAt: session.createdAt instanceof Date ? session.createdAt.getTime() : session.createdAt ?? null,
        updatedAt: session.updatedAt,
        running: session.running,
        blank: session.blank,
    };
}

export async function requireGroup(ctx: ToolContext, args: ToolArgs, action: 'read' | 'edit' | 'delete' = 'read') {
    const groupId = groupIdOf(args);
    const group = await GroupDefinitionModel.get(ctx.domainId, groupId, GroupDefinitionModel.PROJECTION_LIST);
    if (!group) throw new Error(`Group not found: ${groupId}`);
    if (action !== 'read' && Number(group.owner) !== Number(ctx.owner)) {
        const user = await UserModel.getById(ctx.domainId, ctx.owner);
        const permission = action === 'delete' ? PERM.PERM_DELETE_DISCUSSION : PERM.PERM_EDIT_DISCUSSION;
        if (!user.hasPerm(permission)) throw new Error(`You do not have permission to ${action} this Group`);
    }
    return { groupId, group };
}

export async function ensureGroupRoot(ctx: ToolContext, groupId: number, title: string) {
    return await AgentSessionModel.ensureGroupRoot(ctx.domainId, ctx.owner, groupId, title);
}

export function resultLimit(raw: unknown): number {
    return Math.max(1, Math.min(50, Number(raw) || 15));
}
interface OutlineEntry {
    type: 'team' | 'agent';
    id: string;
    title: string;
    children?: OutlineEntry[];
}

export function buildOutline(teams: AgentTeamDoc[], sessions: AgentSessionView[]): OutlineEntry[] {
    const ids = new Set(teams.map((team) => team.teamId));
    const childrenByParent = new Map<string, AgentTeamDoc[]>();
    for (const team of teams) {
        if (!team.parentTeamId || !ids.has(team.parentTeamId)) continue;
        const children = childrenByParent.get(team.parentTeamId);
        if (children) children.push(team);
        else childrenByParent.set(team.parentTeamId, [team]);
    }
    const agentsByTeam = new Map<string, AgentSessionView[]>();
    const loose: AgentSessionView[] = [];
    for (const session of sessions) {
        if (session.teamId && ids.has(session.teamId)) {
            const attachedAgents = agentsByTeam.get(session.teamId);
            if (attachedAgents) attachedAgents.push(session);
            else agentsByTeam.set(session.teamId, [session]);
        } else loose.push(session);
    }
    const render = (team: AgentTeamDoc): OutlineEntry => ({
        type: 'team',
        id: team.teamId,
        title: team.text,
        children: [
            ...(agentsByTeam.get(team.teamId) || []).map((session) => ({ type: 'agent' as const, id: session.sessionId, title: sessionTitleOf(session) })),
            ...(childrenByParent.get(team.teamId) || []).map(render),
        ],
    });
    return [
        ...teams.filter((team) => !team.parentTeamId || !ids.has(team.parentTeamId)).map(render),
        ...loose.map((session) => ({ type: 'agent' as const, id: session.sessionId, title: sessionTitleOf(session) })),
    ];
}

export function teamDetail(team: AgentTeamDoc, teams: AgentTeamDoc[], sessions: AgentSessionView[]) {
    return {
        team: teamView(team),
        childTeams: teams
            .filter((child) => child.parentTeamId === team.teamId)
            .map((child) => ({ teamId: child.teamId, title: child.text })),
        agents: sessions.filter((session) => session.teamId === team.teamId).map(sessionAgentView),
    };
}

export async function groupWorkspace(ctx: ToolContext, groupId: number) {
    const [teams, sessions] = await Promise.all([
        AgentSessionModel.listTeams(ctx.domainId, ctx.owner, groupId),
        AgentSessionModel.listSessionViews(ctx.domainId, ctx.owner, groupId),
    ]);
    return { teams, sessions };
}
export function sessionScope(ctx: ToolContext, groupId: number) {
    return { domainId: ctx.domainId, userId: ctx.owner, groupId };
}

export async function groupRootAcl(ctx: ToolContext, groupId: number, title: string) {
    const root = await ensureGroupRoot(ctx, groupId, title);
    return { root, acl: normalizeAgentAcl(root.config?.acl ?? defaultAgentAcl()) };
}

export async function validateRoleAssignment(ctx: ToolContext, groupId: number, title: string, roleId: string) {
    if (!roleId) return undefined;
    const { acl } = await groupRootAcl(ctx, groupId, title);
    if (!acl.roles.some((role) => role.roleId === roleId)) throw new Error(`Agent role not found in Group ${groupId}: ${roleId}`);
    return roleId;
}

export function validateRolePermissions(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new Error('permissions must be an array of permission IDs');
    const known = new Set(agentPermissionCatalog().map((permission) => permission.id));
    const permissions = [...new Set((value as string[]).map((id) => id.trim()))];
    const unknown = permissions.find((id) => !known.has(id));
    if (unknown) throw new Error(`Unknown Agent permission: ${unknown}`);
    return permissions.sort();
}

export async function saveGroupRootAcl(ctx: ToolContext, groupId: number, root: AgentTeamDoc, acl: AgentTeamAcl) {
    const updated = await AgentSessionModel.updateTeamConfig(ctx.domainId, ctx.owner, root.teamId, {
        ...root.config,
        acl,
    }, groupId);
    if (!updated) throw new Error(`Group root Team not found: ${root.teamId}`);
    await ctx.broadcastAgentEvent?.('agent/acl-update', { ...sessionScope(ctx, groupId), teamId: root.teamId, acl });
    return updated;
}

export async function requireAgentConfigurationPermission(ctx: ToolContext) {
    const user = await UserModel.getById(ctx.domainId, ctx.owner);
    if (!user.hasPerm(PERM.PERM_CONFIGURE_AGENT)) throw new Error('You do not have permission to configure Agent roles or Addons');
}

export async function renameSessionAgent(ctx: ToolContext, groupId: number, sessionId: string, title: string) {
    const scope = sessionScope(ctx, groupId);
    const link = await agentRuntimeHandlerContext.linkForSession(scope, sessionId);
    const upstream = await agentRuntimeHandlerContext.callUpstream('session.rename', { sessionId, title }, link);
    if (!upstream.body.result?.ok) throw new Error(upstream.body.error?.message || 'Session rename failed');
    const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, groupId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await agentRuntimeHandlerContext.agentDataAdapter.updateSession(scope, sessionId, {
        projections: { values: { ...session.projections?.values, title } },
    });
}
export function agentRecordView(agent: any) { return { agentId: agent.agentId, teamId: agent.teamId, groupId: agent.groupId, title: agent.title, settings: agent.settings, ...(agent.config === undefined ? {} : { config: agent.config }), createdAt: agent.createdAt.toISOString(), updatedAt: agent.updatedAt.toISOString() }; }
export function settingsFromArgs(args: ToolArgs, old: AgentSettings = {}): AgentSettings {
    const has = (key: string) => Object.prototype.hasOwnProperty.call(args, key);
    const provider = has('provider') ? asText(args.provider) : old.model?.provider;
    const model = has('model') ? asText(args.model) : old.model?.model;
    if (Boolean(provider) !== Boolean(model)) throw new Error('provider and model must be passed together');
    let baseDocId = old.baseDocId;
    if (has('baseDocId')) { const n = Number(args.baseDocId); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('baseDocId must be a positive integer'); baseDocId = String(n); }
    return { ...(provider && model ? { model: { provider, model } } : {}), ...(baseDocId ? { baseDocId } : {}),
        ...(has('runtimeId') ? (asText(args.runtimeId) ? { runtimeId: asText(args.runtimeId) } : {}) : old.runtimeId ? { runtimeId: old.runtimeId } : {}),
        ...(has('agentPreset') ? (asText(args.agentPreset) ? { agentPreset: asText(args.agentPreset) } : {}) : old.agentPreset ? { agentPreset: old.agentPreset } : {}),
        ...(has('roleId') ? (asText(args.roleId) ? { roleId: asText(args.roleId) } : {}) : old.roleId ? { roleId: old.roleId } : {}) };
}
export function configFromArgs(args: ToolArgs, old: AgentConfig = {}): AgentConfig {
    if (!Object.prototype.hasOwnProperty.call(args, 'context')) return old;
    if (typeof args.context !== 'string') throw new Error('context must be a string');
    if (args.context.length > 20_000) throw new Error('context must not exceed 20000 characters');
    return { context: args.context };
}
export function messageText(event: Record<string, unknown>): string {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    const nested = data.message && typeof data.message === 'object' ? data.message as Record<string, unknown> : {};
    const content = data.content ?? nested.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((block) => {
        if (!block || typeof block !== 'object') return '';
        const item = block as Record<string, unknown>;
        if (typeof item.text === 'string') return item.text;
        if (item.type === 'thinking' && typeof item.thinking === 'string') return item.thinking;
        if (item.type === 'input_text' && typeof item.input_text === 'string') return item.input_text;
        return '';
    }).filter(Boolean).join('');
}

export function messageRole(event: Record<string, unknown>): 'user' | 'assistant' | 'context' {
    if (event.type === 'assistant/message') return 'assistant';
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    const source = data.source && typeof data.source === 'object' ? data.source as Record<string, unknown> : {};
    return source.kind && source.kind !== 'user' ? 'context' : 'user';
}

export function boundedCount(raw: unknown, label: string, max: number, fallback: number): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label} must be an integer from 1 to ${max}`);
    return value;
}

export async function sessionConversation(ctx: ToolContext, groupId: number, sessionId: string, args: ToolArgs) {
    const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, groupId);
    if (!session) throw new Error(`Session agent not found in Group ${groupId}: ${sessionId}`);
    const maxMessages = boundedCount(args.maxMessages, 'maxMessages', 500, 50);
    const maxChars = boundedCount(args.maxChars, 'maxChars', MAX_FILE_CONTENT_CHARS_LIMIT, MAX_FILE_CONTENT_CHARS);
    const beforeSeq = args.beforeSeq === undefined || args.beforeSeq === null || args.beforeSeq === '' ? undefined : Number(args.beforeSeq);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) throw new Error('beforeSeq must be a non-negative integer');
    const page = await AgentSessionModel.listMessageEvents(ctx.domainId, ctx.owner, sessionId, beforeSeq, maxMessages, groupId);
    const turns = page.events.flatMap((event) => {
        const text = messageText(event);
        if (!text) return [];
        return [{ seq: Number(event.seq), role: messageRole(event), text }];
    });
    let kept = turns;
    let content = kept.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n');
    let truncated = false;
    while (kept.length > 1 && content.length > maxChars) {
        kept = kept.slice(1);
        content = kept.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n');
        truncated = true;
    }
    if (content.length > maxChars) {
        content = content.slice(content.length - maxChars);
        truncated = true;
    }
    return {
        ...sessionAgentView(session),
        content,
        textLength: content.length,
        truncated,
        hasMore: page.hasMore || kept.length < turns.length,
        ...(kept[0] ? { beforeSeq: kept[0].seq } : {}),
    };
}
export interface SessionAgentCreateInput {
    teamId?: string;
    title?: string;
    message?: string;
    provider?: string;
    model?: string;
    baseDocId?: number;
    runtimeId?: string;
    agentPreset?: string;
}

export function sessionAgentInput(fields: Record<string, unknown>, label = ''): SessionAgentCreateInput {
    const prefix = label ? `${label}.` : '';
    const provider = asText(fields.provider);
    const model = asText(fields.model);
    if (Boolean(provider) !== Boolean(model)) throw new Error(`${prefix}provider and model must be passed together`);
    let baseDocId: number | undefined;
    if (fields.baseDocId !== undefined && fields.baseDocId !== null && fields.baseDocId !== '') {
        const numeric = Number(fields.baseDocId);
        if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error(`${prefix}baseDocId must be a positive integer`);
        baseDocId = numeric;
    }
    const title = typeof fields.title === 'string' ? fields.title.trim() : '';
    const message = typeof fields.message === 'string' ? fields.message.trim() : '';
    return {
        ...(asText(fields.teamId) ? { teamId: asText(fields.teamId) } : {}),
        ...(title ? { title } : {}),
        ...(message ? { message } : {}),
        ...(provider ? { provider, model } : {}),
        ...(baseDocId === undefined ? {} : { baseDocId }),
        ...(asText(fields.runtimeId) ? { runtimeId: asText(fields.runtimeId) } : {}),
        ...(asText(fields.agentPreset) ? { agentPreset: asText(fields.agentPreset) } : {}),
    };
}

export async function createSessionAgent(ctx: ToolContext, groupId: number, agentTitle: string, input: SessionAgentCreateInput) {
    const root = await ensureGroupRoot(ctx, groupId, agentTitle);
    const teamId = input.teamId || root.teamId;
    if (!await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId)) {
        throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
    }
    const settings: AgentSettings = {
        ...(input.provider && input.model ? { model: { provider: input.provider, model: input.model } } : {}),
        ...(input.baseDocId === undefined ? {} : { baseDocId: String(input.baseDocId) }),
        ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
        ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
    };
    const agent = await AgentModel.createAgent(ctx.domainId, ctx.owner, groupId, teamId, input.title || '新 Agent', settings);
    let sessionId: string | undefined;
    try {
        const scope = sessionScope(ctx, groupId);
        const created = await agentRuntimeHandlerContext.sessionCreate({ payload: { agentId: agent.agentId } }, scope);
        if (!created.result?.ok) throw new Error(created.error?.message || 'Failed to create Agent session');
        const value = created.result.value as { sessionId?: string } | undefined;
        sessionId = value?.sessionId;
        if (!sessionId) throw new Error('Session creation returned no sessionId');
        if (input.title) await renameSessionAgent(ctx, groupId, sessionId, input.title);
        let started = false;
        let error: string | undefined;
        if (input.message) {
            try {
                const link = await agentRuntimeHandlerContext.linkForSession(scope, sessionId);
                const upstream = await agentRuntimeHandlerContext.callUpstream('session.prompt', {
                    sessionId,
                    mode: 'queue',
                    content: [{ type: 'text', text: input.message }],
                }, link);
                if (!upstream.body.result?.ok) throw new Error(upstream.body.error?.message || 'Failed to start the conversation');
                started = true;
            } catch (caught) {
                error = (caught as Error).message;
            }
        }
        const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, groupId);
        if (!session) throw new Error(`Created session not found: ${sessionId}`);
        return { agent: sessionAgentView(session), started, ...(error ? { error } : {}) };
    } catch (error) {
        if (!sessionId) await AgentModel.deleteAgent(ctx.domainId, ctx.owner, agent.agentId, groupId);
        throw error;
    }
}

export function objectEntries(raw: unknown, label: string): Record<string, unknown>[] {
    if (!Array.isArray(raw) || !raw.length) throw new Error(`${label} must be a non-empty array`);
    return raw.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label}[${index}] must be an object`);
        return entry as Record<string, unknown>;
    });
}

export function optionalEntries(raw: unknown, label: string): Record<string, unknown>[] {
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return [];
    return objectEntries(raw, label);
}

export function optionalIds(raw: unknown, label: string, limit: number): string[] {
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return [];
    return idList(raw, label, limit);
}

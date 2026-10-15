import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PRIV, PERM } from 'ejun/src/model/builtin';
import GroupDefinitionModel, { AgentSessionModel } from 'ejun/src/model/agent';
import UserModel from 'ejun/src/model/user';
import { MAX_AGENTS_PER_CALL, MAX_FILE_CONTENT_CHARS, MAX_FILE_CONTENT_CHARS_LIMIT, MAX_TEAMS_PER_CALL } from '../lib/tool-limits';
import { asText, idList } from '../lib/tool-shared';
import { agentRuntimeHandlerContext } from '../service/runtime';
import { listAgentAddons, registerAgentAddon } from '../service/addons';
import type { AgentTeamConfig, AgentTeamDoc, AgentSessionSummary } from 'ejun/src/model/agent';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/registry';

export const inject = ['server'];

export const GroupList = Schema.object({
    limit: Schema.number().min(1).max(50).description('Maximum result count, up to 50.'),
}).description('List Groups available in the current domain. Each result includes its groupId, title, description, update time, and the current user’s team and agent counts.');

export const GroupSearch = Schema.object({
    query: Schema.string().required().description('Search text.'),
    limit: Schema.number().min(1).max(50).description('Maximum result count, up to 50.'),
}).description('Search Groups in the current domain by title or description.');

export const GroupGet = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
}).description('Read a Group by groupId. Returns its groupId, title, description, update time, and the current user’s team and agent tree.');

export const GroupCreate = Schema.object({
    title: Schema.string().required().description('Group name (required, up to 256 characters).'),
    content: Schema.string().description('Group description or instructions (optional, up to 100000 characters).'),
}).description('Create a Group in the current domain. The current user owns the new Group and its root team.');

export const GroupUpdate = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    title: Schema.string().description('New Group name (optional).'),
    content: Schema.string().description('New Group description or instructions (optional).'),
}).description('Update a Group by groupId. Only the owner or a user with edit-discussion permission can update another user’s Group.');

export const GroupRemove = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
}).description('Delete a Group by groupId. Existing sessions and workspace teams are detached, as in the Group management UI.');

export const TeamList = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
}).description('List the current user’s workspace teams for a Group, including each team’s Addon and context configuration and its root team.');

export const TeamGet = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamId: Schema.string().required().description('Team id.'),
}).description('Read one workspace team belonging to an Agent, including its Addon and context configuration, direct child teams, and attached session agents.');

export const TeamCreate = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    text: Schema.string().required().description('Team title.'),
    parentTeamId: Schema.string().description('Existing parent team id (optional; defaults to the Group root).'),
}).description('Create a workspace team for a Group. Omit parentTeamId to place it under the Group root.');

export const TeamUpdate = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamId: Schema.string().required().description('Team id.'),
    text: Schema.string().description('New team title (optional).'),
    parentTeamId: Schema.string().description('Existing parent team id (optional; omit to keep the current parent).'),
    addonIds: Schema.array(Schema.string()).description('Replace the Addons enabled for this team. Pass an empty array to disable all Addons. Addons must already be installed and enabled for this Group.'),
    context: Schema.string().description('Replace the free-form context injected into agents on this team. Pass an empty string to clear it.'),
}).description('Rename or move an Group workspace team with text and/or parentTeamId, or configure its Addons and context. Team-local Addon configuration does not change Group-wide Addon switches. Context is injected into agents on this team. The root team may be configured but cannot be renamed or moved.');

export const TeamRemove = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamId: Schema.string().required().description('Team id.'),
}).description('Delete a workspace team belonging to an Agent. Its child teams and session agents move to its parent. The root team cannot be deleted.');

export const AgentList = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamId: Schema.string().description('Optional team id to filter sessions by their workspace team.'),
}).description('List this Group’s session agents. Omit teamId to list agents from every workspace team.');

const conversationRead = {
    beforeSeq: Schema.number().step(1).min(0).description('Return turns before this event seq. Omit it to read the latest turns.'),
    maxMessages: Schema.number().step(1).min(1).max(500).description('Maximum turns to read (default 50).'),
    maxChars: Schema.number().step(1).min(1).max(MAX_FILE_CONTENT_CHARS_LIMIT).description(`Cap on the returned text (default ${MAX_FILE_CONTENT_CHARS}).`),
};

export const AgentGet = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    agentId: Schema.string().required().description('Session id shown as the agent id in the Agent workspace.'),
    ...conversationRead,
}).description('Read one session agent by agentId and return its title and conversation as `content`, the same way `agent_agent_get` returns an agent content. '
    + 'Turns are the stored user and assistant messages, in order. The text stops at `maxChars` and `truncated` reports that. '
    + '`hasMore` means older turns remain. Pass the returned `beforeSeq` to read the previous page.');

export const AgentCreate = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamId: Schema.string().description('Optional existing workspace team id (defaults to the Group root).'),
    title: Schema.string().description('Optional session agent title.'),
    message: Schema.string().description('Optional first message. Omit it to create the agent with its settings ready and start no conversation.'),
    provider: Schema.string().description('Optional model provider. Pass it together with model.'),
    model: Schema.string().description('Optional model id. Pass it together with provider.'),
    baseDocId: Schema.number().step(1).min(1).description('Optional Base to attach as this session\'s context.'),
    runtimeId: Schema.string().description('Optional host id. Omit it to use the default host.'),
    agentPreset: Schema.string().description('Optional Agent preset id.'),
}).description('Create a session agent with its team, title, model, Base, host, and preset already set. The selected team’s context is injected when the conversation starts. '
    + 'Pass message to start the conversation after the agent exists. Omit message to leave the agent ready and silent. Requires an available Agent runtime.');

export const AgentUpdate = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    agentId: Schema.string().required().description('Session id shown as the agent id in the Agent workspace.'),
    title: Schema.string().description('New session agent title (optional).'),
    teamId: Schema.string().description('Move the session agent to an existing workspace team (optional).'),
}).description('Rename or move a session agent belonging to an Agent. Moving it to another team applies that team’s Addon configuration to the existing session.');

export const AgentRemove = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    agentId: Schema.string().required().description('Session id shown as the agent id in the Agent workspace.'),
}).description('Delete a session agent and its conversation history.');

const AgentCreateFields = Schema.object({
    teamId: Schema.string().description('Optional existing workspace team id (defaults to the Group root).'),
    title: Schema.string().description('Optional session agent title.'),
    message: Schema.string().description('Optional first message. Omit it to leave the agent ready and silent.'),
    provider: Schema.string().description('Optional model provider. Pass it together with model.'),
    model: Schema.string().description('Optional model id. Pass it together with provider.'),
    baseDocId: Schema.number().step(1).min(1).description('Optional Base to attach as this session\'s context.'),
    runtimeId: Schema.string().description('Optional host id.'),
    agentPreset: Schema.string().description('Optional Agent preset id.'),
});

export const AgentCreateMany = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    agents: Schema.array(AgentCreateFields).min(1).max(MAX_AGENTS_PER_CALL).required().description('Session agents to create, in order.'),
}).description('Create several session agents for one Group. Each entry uses the same fields as `agent_agent_create`. '
    + 'An agent is stored before its optional message is sent, so a refused first message still leaves the agent. '
    + `One call creates at most ${MAX_AGENTS_PER_CALL} workspace agents.`);

export const AgentGetMany = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required().description('Session agent ids to read, in order.'),
    ...conversationRead,
}).description('Read several workspace agents of one Group in a single call, each reported as `agent_agent_get` reports one, including its conversation as `content`. '
    + 'A missing id is listed in `missingAgentIds` and `ok` is false. '
    + `One call reads at most ${MAX_AGENTS_PER_CALL} workspace agents.`);

export const AgentUpdateMany = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    entries: Schema.array(Schema.object({
        agentId: Schema.string().required().description('Session agent id (required).'),
        title: Schema.string().description('New session agent title (optional).'),
        teamId: Schema.string().description('Existing workspace team to move the agent to (optional).'),
    })).min(1).max(MAX_AGENTS_PER_CALL).required().description('One entry per session agent.'),
}).description('Rename and/or move several workspace agents of one Group. Each entry is `{ agentId, title?, teamId? }` and must name at least one change. Moving an agent applies the destination team’s Addon configuration to its existing session. '
    + `One call updates at most ${MAX_AGENTS_PER_CALL} workspace agents.`);

export const AgentRemoveMany = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).required().description('Session agents to remove.'),
}).description('Delete several workspace agents of one Group and their conversation history. '
    + `One call removes at most ${MAX_AGENTS_PER_CALL} agents.`);

const TeamAgentCreateFields = Schema.object({
    teamId: Schema.string().description('Existing Agent team id. Omit to use the Group root team.'),
    teamRef: Schema.string().description('ref of a team created in this same request.'),
    title: Schema.string().description('Optional agent title.'),
    message: Schema.string().description('Optional first message.'),
    provider: Schema.string().description('Optional model provider. Pass together with model.'),
    model: Schema.string().description('Optional model id. Pass together with provider.'),
    baseDocId: Schema.number().step(1).min(1).description('Optional Base to attach as this agent’s context.'),
    runtimeId: Schema.string().description('Optional host id.'),
    agentPreset: Schema.string().description('Optional Agent preset id.'),
});

export const TeamCreateMany = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    parentTeamId: Schema.string().description('Default parent team for entries without teamId/parentTeamId; defaults to the Group root.'),
    teams: Schema.array(Schema.object({
        text: Schema.string().required().description('Team title.'),
        ref: Schema.string().description('Optional name for this team, for parentRef or teamRef references.'),
        parentTeamId: Schema.string().description('Existing parent team id.'),
        parentRef: Schema.string().description('ref of an earlier team in this request.'),
    })).max(MAX_TEAMS_PER_CALL).description('Teams to create, in order.'),
    agents: Schema.array(TeamAgentCreateFields).max(MAX_AGENTS_PER_CALL).description('Agents to create after teams; teamRef may refer to a team created above.'),
}).description('Create teams and agents for one Group in a single tool call. Teams are created first, so agents may refer to them by teamRef. Team and agent results report successes and refusals separately; this batch is not transactional.');

export const TeamGetMany = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamIds: Schema.array(Schema.string()).max(MAX_TEAMS_PER_CALL).description('Team ids to read.'),
    agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).description('Agent ids to read.'),
    ...conversationRead,
}).description('Read multiple teams and agents for one Group in one tool call. At least one of teamIds or agentIds is required; each array can contain up to 500 ids.');

export const TeamUpdateMany = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teams: Schema.array(Schema.object({
        teamId: Schema.string().required().description('Team id.'),
        text: Schema.string().description('New team title.'),
        parentTeamId: Schema.string().description('Move under this existing team.'),
        addonIds: Schema.array(Schema.string()).description('Replace this team’s enabled Addons.'),
        context: Schema.string().description('Replace this team’s free-form context; empty string clears it.'),
    })).max(MAX_TEAMS_PER_CALL).description('Team changes; config changes (addonIds/context) are submitted separately from text/parentTeamId.'),
    agents: Schema.array(Schema.object({
        agentId: Schema.string().required().description('Agent id.'),
        title: Schema.string().description('New agent title.'),
        teamId: Schema.string().description('Move to this existing team.'),
    })).max(MAX_AGENTS_PER_CALL).description('Agent title and team changes.'),
}).description('Update multiple teams and agents for one Group. Team and agent results report successes and refusals separately; this batch is not transactional.');

export const TeamDeleteMany = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamIds: Schema.array(Schema.string()).max(MAX_TEAMS_PER_CALL).description('Teams to delete; agents and child teams move to the deleted team’s parent.'),
    agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).description('Agents to delete.'),
}).description('Delete multiple teams and agents for one Group in one tool call. Agents are deleted before teams; the root team cannot be deleted.');

function groupIdOf(args: ToolArgs): number {
    const groupId = Number(args.groupId);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('groupId is required');
    return groupId;
}

function groupView(group: { docId: number; aid?: string; title?: string; content?: string; updateAt?: Date | string }) {
    return {
        groupId: Number(group.docId),
        aid: String(group.aid || ''),
        title: String(group.title || ''),
        content: String(group.content || ''),
        updateAt: group.updateAt instanceof Date ? group.updateAt.toISOString() : String(group.updateAt || ''),
    };
}

function teamView(team: AgentTeamDoc) {
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

type SessionAgentData = Omit<AgentSessionSummary, 'createdAt'> & { createdAt?: number | Date };

function sessionTitleOf(session: SessionAgentData): string {
    const title = session.projections?.values?.title;
    return typeof title === 'string' && title.trim()
        ? title
        : session.blank ? '新会话' : `会话 ${session.sessionId.slice(8, 16)}`;
}

function sessionAgentView(session: SessionAgentData) {
    return {
        agentId: session.sessionId,
        sessionId: session.sessionId,
        ...(session.groupId === undefined ? {} : { groupId: session.groupId }),
        ...(session.teamId === undefined ? {} : { teamId: session.teamId }),
        title: sessionTitleOf(session),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        agentType: 'session',
        createdAt: session.createdAt instanceof Date ? session.createdAt.getTime() : session.createdAt ?? null,
        updatedAt: session.updatedAt,
        running: session.running,
        blank: session.blank,
        ...(session.model === undefined ? {} : { model: session.model }),
        ...(session.baseDocId === undefined ? {} : { baseDocId: session.baseDocId }),
    };
}

async function requireGroup(ctx: ToolContext, args: ToolArgs, action: 'read' | 'edit' | 'delete' = 'read') {
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

async function ensureGroupRoot(ctx: ToolContext, groupId: number, title: string) {
    return await AgentSessionModel.ensureGroupRoot(ctx.domainId, ctx.owner, groupId, title);
}

function resultLimit(raw: unknown): number {
    return Math.max(1, Math.min(50, Number(raw) || 15));
}

interface OutlineEntry {
    type: 'team' | 'agent';
    id: string;
    title: string;
    children?: OutlineEntry[];
}

function buildOutline(teams: AgentTeamDoc[], sessions: AgentSessionSummary[]): OutlineEntry[] {
    const ids = new Set(teams.map((team) => team.teamId));
    const childrenByParent = new Map<string, AgentTeamDoc[]>();
    for (const team of teams) {
        if (!team.parentTeamId || !ids.has(team.parentTeamId)) continue;
        const children = childrenByParent.get(team.parentTeamId);
        if (children) children.push(team);
        else childrenByParent.set(team.parentTeamId, [team]);
    }
    const agentsByTeam = new Map<string, AgentSessionSummary[]>();
    const loose: AgentSessionSummary[] = [];
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

function teamDetail(team: AgentTeamDoc, teams: AgentTeamDoc[], sessions: AgentSessionSummary[]) {
    return {
        team: teamView(team),
        childTeams: teams
            .filter((child) => child.parentTeamId === team.teamId)
            .map((child) => ({ teamId: child.teamId, title: child.text })),
        agents: sessions.filter((session) => session.teamId === team.teamId).map(sessionAgentView),
    };
}

async function groupWorkspace(ctx: ToolContext, groupId: number) {
    const [teams, sessions] = await Promise.all([
        AgentSessionModel.listTeams(ctx.domainId, ctx.owner, groupId),
        AgentSessionModel.listSessions(ctx.domainId, ctx.owner, groupId),
    ]);
    return { teams, sessions };
}

export async function listGroups(ctx: ToolContext, args: ToolArgs) {
    const limit = resultLimit(args.limit);
    const groups = (await GroupDefinitionModel.getMulti(ctx.domainId).toArray()).slice(0, limit);
    const listed = await Promise.all(groups.map(async (group) => {
        const workspace = await groupWorkspace(ctx, group.docId);
        return { ...groupView(group), teamCount: workspace.teams.length, agentCount: workspace.sessions.length };
    }));
    return { ok: true, count: listed.length, groups: listed };
}

export async function searchGroups(ctx: ToolContext, args: ToolArgs) {
    const query = String(args.query || '').trim().toLowerCase();
    if (!query) throw new Error('query is required');
    const limit = resultLimit(args.limit);
    const groups = await GroupDefinitionModel.getMulti(ctx.domainId).toArray();
    const matches = groups.filter((group) => [group.title, group.content].some((value) => typeof value === 'string' && value.toLowerCase().includes(query)));
    return { ok: true, query, count: Math.min(matches.length, limit), groups: matches.slice(0, limit).map(groupView) };
}

export async function getGroup(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args);
    await ensureGroupRoot(ctx, groupId, group.title);
    const workspace = await groupWorkspace(ctx, groupId);
    return {
        ok: true,
        group: groupView(group),
        teamCount: workspace.teams.length,
        agentCount: workspace.sessions.length,
        outline: buildOutline(workspace.teams, workspace.sessions),
    };
}

export async function createGroup(ctx: ToolContext, args: ToolArgs) {
    const title = String(args.title || '').trim();
    const content = typeof args.content === 'string' ? args.content : '';
    if (!title || title.length > 256) throw new Error('title is required and must be at most 256 characters');
    if (content.length > 100000) throw new Error('content must be at most 100000 characters');
    const aid = await GroupDefinitionModel.add(ctx.domainId, ctx.owner, title, content);
    const group = await GroupDefinitionModel.get(ctx.domainId, aid, GroupDefinitionModel.PROJECTION_LIST);
    if (!group) throw new Error('Failed to read the created Group');
    await ensureGroupRoot(ctx, group.docId, group.title);
    return { ok: true, group: groupView(group) };
}

export async function updateGroup(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit');
    const updates: Record<string, string> = {};
    if (Object.prototype.hasOwnProperty.call(args, 'title')) {
        const title = String(args.title || '').trim();
        if (!title || title.length > 256) throw new Error('title must be between 1 and 256 characters');
        updates.title = title;
    }
    if (typeof args.content === 'string') {
        if (args.content.length > 100000) throw new Error('content must be at most 100000 characters');
        updates.content = args.content;
    }
    if (!Object.keys(updates).length) throw new Error('Nothing to update');
    const group = await GroupDefinitionModel.edit(ctx.domainId, groupId, updates);
    if (updates.title !== undefined) await AgentSessionModel.syncGroupRootTitle(ctx.domainId, groupId, updates.title);
    return { ok: true, group: groupView(group) };
}

export async function removeGroup(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'delete');
    await AgentSessionModel.detachGroup(ctx.domainId, groupId);
    await GroupDefinitionModel.del(ctx.domainId, groupId);
    return { ok: true, groupId, deleted: true };
}

export async function listTeams(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args);
    await ensureGroupRoot(ctx, groupId, group.title);
    const teams = await AgentSessionModel.listTeams(ctx.domainId, ctx.owner, groupId);
    return { ok: true, groupId, count: teams.length, teams: teams.map(teamView) };
}

export async function getTeam(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args);
    await ensureGroupRoot(ctx, groupId, group.title);
    const teamId = String(args.teamId || '').trim();
    if (!teamId) throw new Error('teamId is required');
    const team = await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId);
    if (!team) throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
    const workspace = await groupWorkspace(ctx, groupId);
    return { ok: true, groupId, ...teamDetail(team, workspace.teams, workspace.sessions) };
}

export async function createTeam(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    await ensureGroupRoot(ctx, groupId, group.title);
    const text = String(args.text || '').trim();
    if (!text) throw new Error('text is required');
    const parentTeamId = typeof args.parentTeamId === 'string' && args.parentTeamId.trim() ? args.parentTeamId.trim() : undefined;
    const team = await AgentSessionModel.createTeam(ctx.domainId, ctx.owner, text, groupId, parentTeamId);
    return { ok: true, groupId, team: teamView(team) };
}

export async function updateTeam(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    await ensureGroupRoot(ctx, groupId, group.title);
    const teamId = String(args.teamId || '').trim();
    if (!teamId) throw new Error('teamId is required');

    const hasText = Object.prototype.hasOwnProperty.call(args, 'text');
    const text = hasText ? String(args.text || '').trim() : undefined;
    if (hasText && !text) throw new Error('text cannot be empty');
    const hasParent = Object.prototype.hasOwnProperty.call(args, 'parentTeamId');
    const parentTeamId = hasParent ? asText(args.parentTeamId) : undefined;
    if (hasParent && !parentTeamId) throw new Error('parentTeamId cannot be empty');
    const hasAddonIds = Object.prototype.hasOwnProperty.call(args, 'addonIds');
    const hasContext = Object.prototype.hasOwnProperty.call(args, 'context');
    if (!hasText && !hasParent && !hasAddonIds && !hasContext) throw new Error('Nothing to update');
    if ((hasAddonIds || hasContext) && (hasText || hasParent)) throw new Error('Update team configuration separately from team text or placement');

    let team = await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId);
    if (!team) throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
    if (hasText || hasParent) {
        team = await AgentSessionModel.updateTeam(ctx.domainId, ctx.owner, teamId, text ?? team.text, groupId, parentTeamId);
        if (!team) throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
    }

    let configUpdate: Record<string, unknown> = {};
    let resultTeam: unknown = teamView(team);
    if (hasAddonIds || hasContext) {
        const config: AgentTeamConfig = {
            ...(team.config?.addons === undefined ? {} : { addons: team.config.addons }),
            ...(team.config?.context === undefined ? {} : { context: team.config.context }),
        };
        if (hasAddonIds) {
            if (!Array.isArray(args.addonIds) || args.addonIds.some((id: unknown) => typeof id !== 'string' || !id.trim())) {
                throw new Error('addonIds must be an array of non-empty add-on ids');
            }
            const addonIds = [...new Set((args.addonIds as string[]).map((id) => id.trim()))];
            const result = await agentRuntimeHandlerContext.agentAddonsList({ rpcId: 'agent-team-addons', method: 'agent.addons.list' }, sessionScope(ctx, groupId));
            const available = (result.result?.value as { addons?: { addonId: string; installed: boolean; enabled: boolean }[] } | undefined)?.addons ?? [];
            for (const addonId of addonIds) {
                if (!available.some((addon) => addon.addonId === addonId && addon.installed && addon.enabled)) {
                    throw new Error(`Add-on ${addonId} is not installed and enabled for this Group`);
                }
            }
            config.addons = Object.fromEntries(addonIds.map((id) => [id, true]));
        }
        if (hasContext) {
            if (typeof args.context !== 'string') throw new Error('context must be a string');
            if (args.context.length > 20_000) throw new Error('context must not exceed 20000 characters');
            config.context = args.context;
        }
        if (!ctx.broadcastAgentEvent) throw new Error('Cordis event publisher is unavailable');
        const updated = await AgentSessionModel.updateTeamConfig(ctx.domainId, ctx.owner, teamId, config, groupId);
        if (!updated) throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
        resultTeam = teamView(updated);
        if (hasAddonIds) {
            for (const addon of listAgentAddons()) {
                await ctx.broadcastAgentEvent('agent/addon-state', {
                    domainId: ctx.domainId,
                    userId: ctx.owner,
                    groupId,
                    teamId,
                    addonId: addon.addonId,
                    enabled: config.addons?.[addon.addonId] === true,
                });
            }
        }
        if (hasContext) {
            await ctx.broadcastAgentEvent('agent/team-context', { domainId: ctx.domainId, userId: ctx.owner, groupId, teamId });
        }
        configUpdate = { syncScheduled: true };
    }
    return { ok: true, groupId, team: resultTeam, ...configUpdate };
}

export async function removeTeam(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    await ensureGroupRoot(ctx, groupId, group.title);
    const teamId = String(args.teamId || '').trim();
    if (!teamId) throw new Error('teamId is required');
    const team = await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId);
    if (!team) throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
    const response = await agentRuntimeHandlerContext.teamRpc({
        rpcId: 'agent_team_delete',
        method: 'team.delete',
        payload: { teamId },
    }, sessionScope(ctx, groupId));
    if (!response.result?.ok) throw new Error(response.error?.message || 'Failed to delete Agent team');
    const value = response.result.value as Record<string, unknown> | undefined;
    return { ok: true, groupId, teamId, ...value };
}

function sessionScope(ctx: ToolContext, groupId: number) {
    return { domainId: ctx.domainId, userId: ctx.owner, groupId };
}

async function renameSessionAgent(ctx: ToolContext, groupId: number, sessionId: string, title: string) {
    const scope = sessionScope(ctx, groupId);
    const link = await agentRuntimeHandlerContext.linkForSession(scope, sessionId);
    const upstream = await agentRuntimeHandlerContext.callUpstream('session.rename', { sessionId, title }, link);
    if (!upstream.body.result?.ok) throw new Error(upstream.body.error?.message || 'Session rename failed');
    const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, groupId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await agentRuntimeHandlerContext.agentDataAdapter.updateSession(scope, sessionId, {
        projections: { values: { ...(session.projections?.values ?? {}), title } },
    });
}

export async function listAgents(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args);
    const teamId = typeof args.teamId === 'string' && args.teamId.trim() ? args.teamId.trim() : undefined;
    if (teamId && !await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId)) {
        throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
    }
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, groupId);
    const agents = teamId ? sessions.filter((session) => session.teamId === teamId) : sessions;
    return { ok: true, groupId, ...(teamId ? { teamId } : {}), count: agents.length, agents: agents.map(sessionAgentView) };
}

function messageText(event: Record<string, unknown>): string {
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

function messageRole(event: Record<string, unknown>): 'user' | 'assistant' | 'context' {
    if (event.type === 'assistant/message') return 'assistant';
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    const source = data.source && typeof data.source === 'object' ? data.source as Record<string, unknown> : {};
    return source.kind && source.kind !== 'user' ? 'context' : 'user';
}

function boundedCount(raw: unknown, label: string, max: number, fallback: number): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label} must be an integer from 1 to ${max}`);
    return value;
}

async function sessionConversation(ctx: ToolContext, groupId: number, sessionId: string, args: ToolArgs) {
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

export async function getAgent(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args);
    const sessionId = String(args.agentId || '').trim();
    if (!sessionId) throw new Error('agentId is required');
    const agent = await sessionConversation(ctx, groupId, sessionId, args);
    return { ok: true, groupId, ...agent };
}

interface SessionAgentCreateInput {
    teamId?: string;
    title?: string;
    message?: string;
    provider?: string;
    model?: string;
    baseDocId?: number;
    runtimeId?: string;
    agentPreset?: string;
}

function sessionAgentInput(fields: Record<string, unknown>, label = ''): SessionAgentCreateInput {
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

async function createSessionAgent(ctx: ToolContext, groupId: number, agentTitle: string, input: SessionAgentCreateInput) {
    const root = await ensureGroupRoot(ctx, groupId, agentTitle);
    const teamId = input.teamId || root.teamId;
    if (!await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId)) {
        throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
    }
    const scope = sessionScope(ctx, groupId);
    const payload: Record<string, unknown> = {
        teamId,
        ...(input.provider && input.model ? { provider: input.provider, model: input.model } : {}),
        ...(input.baseDocId === undefined ? {} : { baseDocId: input.baseDocId }),
        ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
        ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
    };
    const created = await agentRuntimeHandlerContext.sessionCreate({ payload }, scope);
    if (!created.result?.ok) throw new Error(created.error?.message || 'Failed to create Agent session');
    const value = created.result.value as { sessionId?: string } | undefined;
    const sessionId = value?.sessionId;
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
}

function objectEntries(raw: unknown, label: string): Record<string, unknown>[] {
    if (!Array.isArray(raw) || !raw.length) throw new Error(`${label} must be a non-empty array`);
    return raw.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label}[${index}] must be an object`);
        return entry as Record<string, unknown>;
    });
}

function optionalEntries(raw: unknown, label: string): Record<string, unknown>[] {
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return [];
    return objectEntries(raw, label);
}

function optionalIds(raw: unknown, label: string, limit: number): string[] {
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return [];
    return idList(raw, label, limit);
}

export async function createAgent(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    const created = await createSessionAgent(ctx, groupId, group.title, sessionAgentInput(args));
    return {
        ok: created.error === undefined,
        groupId,
        started: created.started,
        agent: created.agent,
        ...(created.error ? { error: created.error } : {}),
    };
}

export async function updateAgent(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit');
    const sessionId = String(args.agentId || '').trim();
    if (!sessionId) throw new Error('agentId is required');
    const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, groupId);
    if (!session) throw new Error(`Session agent not found in Group ${groupId}: ${sessionId}`);
    const title = typeof args.title === 'string' ? args.title.trim() : undefined;
    if (title === '') throw new Error('title cannot be empty');
    const teamId = typeof args.teamId === 'string' ? args.teamId.trim() : undefined;
    if (teamId !== undefined) {
        if (!teamId) throw new Error('teamId cannot be empty');
        if (!await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, teamId, groupId)) {
            throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
        }
    }
    if (title === undefined && teamId === undefined) throw new Error('Nothing to update (title or teamId required)');
    if (title !== undefined) await renameSessionAgent(ctx, groupId, sessionId, title);
    let failedAddonIds: string[] = [];
    let failedContextSync = false;
    if (teamId !== undefined && teamId !== session.teamId) {
        const scope = sessionScope(ctx, groupId);
        await agentRuntimeHandlerContext.agentDataAdapter.updateSession(scope, sessionId, { teamId });
        failedAddonIds = await agentRuntimeHandlerContext.syncSessionAddonsForTeam(scope, sessionId, teamId);
        failedContextSync = await agentRuntimeHandlerContext.syncSessionTeamContextForTeam(scope, sessionId, teamId);
    }
    const updated = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, groupId);
    if (!updated) throw new Error(`Session agent not found in Group ${groupId}: ${sessionId}`);
    return {
        ok: true,
        groupId,
        agent: sessionAgentView(updated),
        ...(failedAddonIds.length ? { failedAddonIds } : {}),
        ...(failedContextSync ? { failedContextSync: true } : {}),
    };
}

export async function createTeams(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    const root = await ensureGroupRoot(ctx, groupId, group.title);
    const raw = objectEntries(args.teams, 'teams');
    if (raw.length > MAX_TEAMS_PER_CALL) throw new Error(`teams holds ${raw.length} entries and one call creates ${MAX_TEAMS_PER_CALL}; split the work across calls`);
    const existing = await AgentSessionModel.listTeams(ctx.domainId, ctx.owner, groupId);
    const known = new Set(existing.map((team) => team.teamId));
    const defaultParent = asText(args.parentTeamId) || root.teamId;
    if (!known.has(defaultParent)) throw new Error(`Parent team not found in Group ${groupId}: ${defaultParent}`);
    const refIndex = new Map<string, number>();
    const planned: { index: number; text: string; ref: string; parentRef: string; parentTeamId: string }[] = [];
    for (const [index, fields] of raw.entries()) {
        const text = asText(fields.text);
        if (!text) throw new Error(`teams[${index}].text is required`);
        const ref = asText(fields.ref);
        if (ref && refIndex.has(ref)) throw new Error(`teams[${index}].ref ${ref} is already the ref of teams[${refIndex.get(ref)}]`);
        const parentRef = asText(fields.parentRef);
        const ownParent = asText(fields.parentTeamId);
        if (parentRef && ownParent) throw new Error(`teams[${index}] names both parentRef and parentTeamId; keep one`);
        if (parentRef && !refIndex.has(parentRef)) throw new Error(`teams[${index}].parentRef ${parentRef} does not name an earlier entry`);
        if (ownParent && !known.has(ownParent)) throw new Error(`teams[${index}].parentTeamId ${ownParent} is not a team of this Group`);
        if (ref) refIndex.set(ref, index);
        planned.push({ index, text, ref, parentRef, parentTeamId: ownParent });
    }
    const createdIds = new Map<number, string>();
    const created: { index: number; ref?: string; teamId: string; parentTeamId?: string; text: string }[] = [];
    const refused: { index: number; error: string }[] = [];
    for (const entry of planned) {
        const parentFromRef = entry.parentRef ? createdIds.get(refIndex.get(entry.parentRef) as number) : undefined;
        if (entry.parentRef && !parentFromRef) {
            refused.push({ index: entry.index, error: `Parent ref ${entry.parentRef} was not created` });
            continue;
        }
        const parentTeamId = parentFromRef || entry.parentTeamId || defaultParent;
        try {
            const team = await AgentSessionModel.createTeam(ctx.domainId, ctx.owner, entry.text, groupId, parentTeamId);
            createdIds.set(entry.index, team.teamId);
            known.add(team.teamId);
            created.push({ index: entry.index, ...(entry.ref ? { ref: entry.ref } : {}), teamId: team.teamId, parentTeamId: team.parentTeamId, text: team.text });
        } catch (error) {
            refused.push({ index: entry.index, error: (error as Error).message });
        }
    }
    return { ok: refused.length === 0, groupId, teamCount: created.length, teams: created, refusedTeams: refused };
}

export async function getTeams(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args);
    await ensureGroupRoot(ctx, groupId, group.title);
    const teamIds = idList(args.teamIds, 'teamIds', MAX_TEAMS_PER_CALL);
    const workspace = await groupWorkspace(ctx, groupId);
    const byId = new Map(workspace.teams.map((team) => [team.teamId, team]));
    const found: { index: number; team: ReturnType<typeof teamView>; childTeams: { teamId: string; title: string }[]; agents: ReturnType<typeof sessionAgentView>[] }[] = [];
    const missing: string[] = [];
    for (const [index, teamId] of teamIds.entries()) {
        const team = byId.get(teamId);
        if (!team) {
            missing.push(teamId);
            continue;
        }
        found.push({ index, ...teamDetail(team, workspace.teams, workspace.sessions) });
    }
    return { ok: missing.length === 0, groupId, teamCount: found.length, teams: found, missingTeamIds: missing };
}

export async function updateTeams(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    await ensureGroupRoot(ctx, groupId, group.title);
    const raw = objectEntries(args.entries, 'entries');
    if (raw.length > MAX_TEAMS_PER_CALL) throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_TEAMS_PER_CALL}; split the work across calls`);
    const planned: { index: number; teamId: string; text?: string; parentTeamId?: string }[] = [];
    const seen = new Set<string>();
    for (const [index, fields] of raw.entries()) {
        const teamId = asText(fields.teamId);
        if (!teamId) throw new Error(`entries[${index}].teamId is required`);
        if (seen.has(teamId)) throw new Error(`entries[${index}].teamId ${teamId} appears twice; send one entry per team`);
        seen.add(teamId);
        const hasText = Object.prototype.hasOwnProperty.call(fields, 'text');
        const hasParent = Object.prototype.hasOwnProperty.call(fields, 'parentTeamId');
        if (!hasText && !hasParent) throw new Error(`entries[${index}] names nothing to change; give text, parentTeamId, or both`);
        const text = hasText ? asText(fields.text) : undefined;
        if (hasText && !text) throw new Error(`entries[${index}].text cannot be empty`);
        const parentTeamId = hasParent ? asText(fields.parentTeamId) : undefined;
        if (hasParent && !parentTeamId) throw new Error(`entries[${index}].parentTeamId cannot be empty`);
        planned.push({ index, teamId, ...(text ? { text } : {}), ...(parentTeamId ? { parentTeamId } : {}) });
    }
    const currentTeams = await AgentSessionModel.listTeams(ctx.domainId, ctx.owner, groupId);
    const byId = new Map(currentTeams.map((team) => [team.teamId, team]));
    for (const entry of planned) {
        const team = byId.get(entry.teamId);
        if (!team) throw new Error(`Team not found in Group ${groupId}: ${entry.teamId}`);
        if (team.isRootTeam) throw new Error('Group root team cannot be renamed or moved');
    }
    const updated: { index: number; team: ReturnType<typeof teamView> }[] = [];
    const refused: { index: number; teamId: string; error: string }[] = [];
    for (const entry of planned) {
        const current = await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, entry.teamId, groupId);
        if (!current) {
            refused.push({ index: entry.index, teamId: entry.teamId, error: `Team not found in Group ${groupId}: ${entry.teamId}` });
            continue;
        }
        try {
            const team = await AgentSessionModel.updateTeam(ctx.domainId, ctx.owner, entry.teamId, entry.text ?? current.text, groupId, entry.parentTeamId);
            if (!team) throw new Error(`Team not found in Group ${groupId}: ${entry.teamId}`);
            updated.push({ index: entry.index, team: teamView(team) });
        } catch (error) {
            refused.push({ index: entry.index, teamId: entry.teamId, error: (error as Error).message });
        }
    }
    return { ok: refused.length === 0, groupId, teamCount: updated.length, teams: updated, refusedTeams: refused };
}

export async function removeTeams(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    await ensureGroupRoot(ctx, groupId, group.title);
    const teamIds = idList(args.teamIds, 'teamIds', MAX_TEAMS_PER_CALL);
    const currentTeams = await AgentSessionModel.listTeams(ctx.domainId, ctx.owner, groupId);
    const byId = new Map(currentTeams.map((team) => [team.teamId, team]));
    for (const teamId of teamIds) {
        const team = byId.get(teamId);
        if (!team) throw new Error(`Team not found in Group ${groupId}: ${teamId}`);
        if (team.isRootTeam) throw new Error('Group root team cannot be deleted');
    }
    const failedSessionIds = new Set<string>();
    for (const teamId of teamIds) {
        const response = await agentRuntimeHandlerContext.teamRpc({
            rpcId: 'agent_team_delete_many',
            method: 'team.delete',
            payload: { teamId },
        }, sessionScope(ctx, groupId));
        if (!response.result?.ok) throw new Error(response.error?.message || `Failed to delete Agent team ${teamId}`);
        const value = response.result.value as { failedSessionIds?: string[] } | undefined;
        value?.failedSessionIds?.forEach((sessionId) => failedSessionIds.add(sessionId));
    }
    return { ok: true, groupId, removedTeamIds: teamIds, removedCount: teamIds.length, failedSessionIds: [...failedSessionIds] };
}

export async function createAgents(ctx: ToolContext, args: ToolArgs) {
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

export async function getAgents(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args);
    const agentIds = idList(args.agentIds, 'agentIds', MAX_AGENTS_PER_CALL);
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, groupId);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const found: { index: number; agentId: string; title: string; content: string; hasMore?: boolean; beforeSeq?: number; truncated?: boolean }[] = [];
    const missing: string[] = [];
    for (const [index, agentId] of agentIds.entries()) {
        const session = byId.get(agentId);
        if (!session) {
            missing.push(agentId);
            continue;
        }
        const agent = await sessionConversation(ctx, groupId, agentId, args);
        found.push({
            index,
            agentId: agent.agentId,
            title: agent.title,
            content: agent.content,
            ...(agent.hasMore ? { hasMore: true, beforeSeq: agent.beforeSeq } : {}),
            ...(agent.truncated ? { truncated: true } : {}),
        });
    }
    return { ok: missing.length === 0, groupId, agentCount: found.length, agents: found, missingAgentIds: missing };
}

export async function updateAgents(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit');
    const raw = objectEntries(args.entries, 'entries');
    if (raw.length > MAX_AGENTS_PER_CALL) throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_AGENTS_PER_CALL}; split the work across calls`);
    const planned: { index: number; agentId: string; title?: string; teamId?: string }[] = [];
    const seen = new Set<string>();
    for (const [index, fields] of raw.entries()) {
        const agentId = asText(fields.agentId);
        if (!agentId) throw new Error(`entries[${index}].agentId is required`);
        if (seen.has(agentId)) throw new Error(`entries[${index}].agentId ${agentId} appears twice; send one entry per agent`);
        seen.add(agentId);
        const hasTitle = Object.prototype.hasOwnProperty.call(fields, 'title');
        const hasTeam = Object.prototype.hasOwnProperty.call(fields, 'teamId');
        if (!hasTitle && !hasTeam) throw new Error(`entries[${index}] names nothing to change; give title, teamId, or both`);
        const title = hasTitle ? asText(fields.title) : undefined;
        if (hasTitle && !title) throw new Error(`entries[${index}].title cannot be empty`);
        const teamId = hasTeam ? asText(fields.teamId) : undefined;
        if (hasTeam && !teamId) throw new Error(`entries[${index}].teamId cannot be empty`);
        planned.push({ index, agentId, ...(title ? { title } : {}), ...(teamId ? { teamId } : {}) });
    }
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, groupId);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    for (const entry of planned) {
        if (!byId.has(entry.agentId)) throw new Error(`Session agent not found in Group ${groupId}: ${entry.agentId}`);
        if (entry.teamId && !await AgentSessionModel.getTeam(ctx.domainId, ctx.owner, entry.teamId, groupId)) {
            throw new Error(`Team not found in Group ${groupId}: ${entry.teamId}`);
        }
    }
    const updated: { index: number; agent: ReturnType<typeof sessionAgentView>; failedAddonIds?: string[]; failedContextSync?: boolean }[] = [];
    const refused: { index: number; agentId: string; error: string }[] = [];
    for (const entry of planned) {
        try {
            if (entry.title) await renameSessionAgent(ctx, groupId, entry.agentId, entry.title);
            const current = byId.get(entry.agentId)!;
            let failedAddonIds: string[] = [];
            let failedContextSync = false;
            if (entry.teamId && entry.teamId !== current.teamId) {
                const scope = sessionScope(ctx, groupId);
                await agentRuntimeHandlerContext.agentDataAdapter.updateSession(scope, entry.agentId, { teamId: entry.teamId });
                failedAddonIds = await agentRuntimeHandlerContext.syncSessionAddonsForTeam(scope, entry.agentId, entry.teamId);
                failedContextSync = await agentRuntimeHandlerContext.syncSessionTeamContextForTeam(scope, entry.agentId, entry.teamId);
            }
            const session = await AgentSessionModel.getSession(ctx.domainId, ctx.owner, entry.agentId, groupId);
            if (!session) throw new Error(`Session agent not found in Group ${groupId}: ${entry.agentId}`);
            updated.push({
                index: entry.index,
                agent: sessionAgentView(session),
                ...(failedAddonIds.length ? { failedAddonIds } : {}),
                ...(failedContextSync ? { failedContextSync: true } : {}),
            });
        } catch (error) {
            refused.push({ index: entry.index, agentId: entry.agentId, error: (error as Error).message });
        }
    }
    return { ok: refused.length === 0, groupId, agentCount: updated.length, agents: updated, refusedAgents: refused };
}

export async function removeAgents(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'delete');
    const agentIds = idList(args.agentIds, 'agentIds', MAX_AGENTS_PER_CALL);
    const sessions = await AgentSessionModel.listSessions(ctx.domainId, ctx.owner, groupId);
    const known = new Set(sessions.map((session) => session.sessionId));
    for (const agentId of agentIds) {
        if (!known.has(agentId)) throw new Error(`Session agent not found in Group ${groupId}: ${agentId}`);
    }
    await AgentSessionModel.deleteSessions(ctx.domainId, ctx.owner, agentIds, groupId);
    return { ok: true, groupId, removedAgentIds: agentIds, removedCount: agentIds.length };
}

export async function removeAgent(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'delete');
    const sessionId = String(args.agentId || '').trim();
    if (!sessionId) throw new Error('agentId is required');
    if (!await AgentSessionModel.getSession(ctx.domainId, ctx.owner, sessionId, groupId)) {
        throw new Error(`Session agent not found in Group ${groupId}: ${sessionId}`);
    }
    await AgentSessionModel.deleteSession(ctx.domainId, ctx.owner, sessionId, groupId);
    return { ok: true, groupId, agentId: sessionId, deleted: true };
}

export async function createTeamMany(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    const rawTeams = optionalEntries(args.teams, 'teams');
    const rawAgents = optionalEntries(args.agents, 'agents');
    if (rawTeams.length > MAX_TEAMS_PER_CALL) throw new Error(`teams holds ${rawTeams.length} entries; one call creates at most ${MAX_TEAMS_PER_CALL}`);
    if (rawAgents.length > MAX_AGENTS_PER_CALL) throw new Error(`agents holds ${rawAgents.length} entries; one call creates at most ${MAX_AGENTS_PER_CALL}`);
    if (!rawTeams.length && !rawAgents.length) throw new Error('Give teams, agents, or both');

    const teamResult = rawTeams.length
        ? await createTeams(ctx, { groupId, ...(asText(args.parentTeamId) ? { parentTeamId: asText(args.parentTeamId) } : {}), teams: rawTeams })
        : undefined;
    const teamIdsByRef = new Map<string, string>();
    for (const team of teamResult?.teams ?? []) {
        if (team.ref) teamIdsByRef.set(team.ref, team.teamId);
    }

    const agents: { index: number; started: boolean; agent: ReturnType<typeof sessionAgentView>; error?: string }[] = [];
    const refusedAgents: { index: number; agentId?: string; error: string }[] = [];
    for (const [index, rawAgent] of rawAgents.entries()) {
        const fields = { ...rawAgent };
        const teamId = asText(fields.teamId);
        const teamRef = asText(fields.teamRef);
        if (teamId && teamRef) {
            refusedAgents.push({ index, error: `agents[${index}] must use teamId or teamRef, not both` });
            continue;
        }
        if (teamRef) {
            const resolvedTeamId = teamIdsByRef.get(teamRef);
            if (!resolvedTeamId) {
                refusedAgents.push({ index, error: `agents[${index}].teamRef ${teamRef} was not created in this request` });
                continue;
            }
            fields.teamId = resolvedTeamId;
        }
        delete fields.teamRef;
        try {
            const result = await createSessionAgent(ctx, groupId, group.title, sessionAgentInput(fields, `agents[${index}]`));
            agents.push({ index, started: result.started, agent: result.agent, ...(result.error ? { error: result.error } : {}) });
            if (result.error) refusedAgents.push({ index, agentId: result.agent.agentId, error: result.error });
        } catch (error) {
            refusedAgents.push({ index, error: (error as Error).message });
        }
    }
    const refusedTeams = teamResult?.refusedTeams ?? [];
    return {
        ok: refusedTeams.length === 0 && refusedAgents.length === 0,
        groupId,
        teams: teamResult?.teams ?? [],
        refusedTeams,
        agents,
        refusedAgents,
    };
}

export async function getTeamMany(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args);
    const teamIds = optionalIds(args.teamIds, 'teamIds', MAX_TEAMS_PER_CALL);
    const agentIds = optionalIds(args.agentIds, 'agentIds', MAX_AGENTS_PER_CALL);
    if (!teamIds.length && !agentIds.length) throw new Error('Give teamIds, agentIds, or both');
    const [teamResult, agentResult] = await Promise.all([
        teamIds.length ? getTeams(ctx, { groupId, teamIds }) : Promise.resolve(undefined),
        agentIds.length ? getAgents(ctx, { groupId, agentIds, maxMessages: args.maxMessages, maxChars: args.maxChars, beforeSeq: args.beforeSeq }) : Promise.resolve(undefined),
    ]);
    return {
        ok: (teamResult?.ok ?? true) && (agentResult?.ok ?? true),
        groupId,
        ...(teamResult ? { teams: teamResult.teams, missingTeamIds: teamResult.missingTeamIds } : {}),
        ...(agentResult ? { agents: agentResult.agents, missingAgentIds: agentResult.missingAgentIds } : {}),
    };
}

export async function updateTeamMany(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit');
    const rawTeams = optionalEntries(args.teams, 'teams');
    const rawAgents = optionalEntries(args.agents, 'agents');
    if (rawTeams.length > MAX_TEAMS_PER_CALL) throw new Error(`teams holds ${rawTeams.length} entries; one call updates at most ${MAX_TEAMS_PER_CALL}`);
    if (rawAgents.length > MAX_AGENTS_PER_CALL) throw new Error(`agents holds ${rawAgents.length} entries; one call updates at most ${MAX_AGENTS_PER_CALL}`);
    if (!rawTeams.length && !rawAgents.length) throw new Error('Give teams, agents, or both');

    const updatedTeams: { index: number; team: unknown }[] = [];
    const refusedTeams: { index: number; teamId: string; error: string }[] = [];
    const seenTeamIds = new Set<string>();
    for (const [index, entry] of rawTeams.entries()) {
        const teamId = asText(entry.teamId);
        if (!teamId) throw new Error(`teams[${index}].teamId is required`);
        if (seenTeamIds.has(teamId)) throw new Error(`teams[${index}].teamId ${teamId} appears twice`);
        seenTeamIds.add(teamId);
        try {
            const result = await updateTeam(ctx, { ...entry, groupId, teamId });
            updatedTeams.push({ index, team: result.team });
        } catch (error) {
            refusedTeams.push({ index, teamId, error: (error as Error).message });
        }
    }

    let agentResult: Awaited<ReturnType<typeof updateAgents>> | undefined;
    if (rawAgents.length) agentResult = await updateAgents(ctx, { groupId, entries: rawAgents });
    const refusedAgents = agentResult?.refusedAgents ?? [];
    return {
        ok: refusedTeams.length === 0 && refusedAgents.length === 0,
        groupId,
        teams: updatedTeams,
        refusedTeams,
        agents: agentResult?.agents ?? [],
        refusedAgents,
    };
}

export async function deleteTeamMany(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'delete');
    const teamIds = optionalIds(args.teamIds, 'teamIds', MAX_TEAMS_PER_CALL);
    const agentIds = optionalIds(args.agentIds, 'agentIds', MAX_AGENTS_PER_CALL);
    if (!teamIds.length && !agentIds.length) throw new Error('Give teamIds, agentIds, or both');
    const agents = agentIds.length ? await removeAgents(ctx, { groupId, agentIds }) : undefined;
    const teams = teamIds.length ? await removeTeams(ctx, { groupId, teamIds }) : undefined;
    return {
        ok: true,
        groupId,
        removedAgentIds: agents?.removedAgentIds ?? [],
        removedTeamIds: teams?.removedTeamIds ?? [],
        failedSessionIds: teams?.failedSessionIds ?? [],
    };
}

export function apply(ctx: Context) {
    const unregister = registerAgentAddon({
        addonId: 'agent',
        displayName: 'Ejunz Agent',
        description: 'Create and manage Groups, Teams, and Agents in the Agent workspace.',
        toolPrefixes: ['agent_'],
        defaultEnabled: true,
    });
    ctx.effect(() => unregister);
    const read = { source: 'agent', bindBase: 'none' as const };
    const write = { ...read, mutating: true };
    ctx.Tool('agent', 'agent_group_list', listGroups, GroupList, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_group_search', searchGroups, GroupSearch, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_group_get', getGroup, GroupGet, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_group_create', createGroup, GroupCreate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_group_update', updateGroup, GroupUpdate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_group_delete', removeGroup, GroupRemove, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_team_list', listTeams, TeamList, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_team_get', getTeam, TeamGet, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_team_create', createTeam, TeamCreate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_team_update', updateTeam, TeamUpdate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_team_delete', removeTeam, TeamRemove, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_list', listAgents, AgentList, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_get', getAgent, AgentGet, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_create', createAgent, AgentCreate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_update', updateAgent, AgentUpdate, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_agent_delete', removeAgent, AgentRemove, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_team_create_many', createTeamMany, TeamCreateMany, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_team_get_many', getTeamMany, TeamGetMany, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_team_update_many', updateTeamMany, TeamUpdateMany, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_team_delete_many', deleteTeamMany, TeamDeleteMany, write, PRIV.PRIV_USER_PROFILE);
}

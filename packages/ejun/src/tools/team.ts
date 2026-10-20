import Schema from 'schemastery';
import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PERM } from 'ejun/src/model/builtin';
import { AgentSessionModel, normalizeAgentAcl } from 'ejun/src/model/agent';
import type { AgentTeamConfig } from 'ejun/src/model/agent';
import { MAX_AGENTS_PER_CALL, MAX_TEAMS_PER_CALL } from '../lib/tool-limits';
import { asText, idList } from '../lib/tool-shared';
import { agentRuntimeHandlerContext } from '../service/runtime';
import { agentPermissionCatalog, listAgentAddons as listRegisteredAgentAddons } from '../service/addons';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import { ensureGroupRoot, groupRootAcl, groupWorkspace, objectEntries, optionalEntries, optionalIds, requireAgentConfigurationPermission, requireGroup, saveGroupRootAcl, sessionScope, teamDetail, teamView, validateRolePermissions } from './common/agent';
import { createAgent, getAgents, removeAgents, updateAgents } from './agent';

export const inject = ['server'];

export const TeamListSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
}).description('List the current user’s workspace teams for a Group, including each team’s Addon and context configuration and its root team.');

export const TeamGetSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamId: Schema.string().required().description('Team id.'),
}).description('Read one workspace team belonging to an Agent, including its Addon and context configuration, direct child teams, and attached session agents.');

export const TeamCreateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    text: Schema.string().required().description('Team title.'),
    parentTeamId: Schema.string().description('Existing parent team id (optional; defaults to the Group root).'),
}).description('Create a workspace team for a Group. Omit parentTeamId to place it under the Group root.');

export const TeamUpdateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamId: Schema.string().required().description('Team id.'),
    text: Schema.string().description('New team title (optional).'),
    parentTeamId: Schema.string().description('Existing parent team id (optional; omit to keep the current parent).'),
    addonIds: Schema.array(Schema.string()).description('Replace the Addons enabled for this team. Pass an empty array to disable all Addons. Addons must already be installed and enabled for this Group.'),
    context: Schema.string().description('Replace the free-form context injected into agents on this team. Pass an empty string to clear it.'),
}).description('Rename or move an Group workspace team with text and/or parentTeamId, or configure its Addons and context. Team-local Addon configuration does not change Group-wide Addon switches. Context is injected into agents on this team. The root team may be configured but cannot be renamed or moved.');

export const TeamRemoveSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamId: Schema.string().required().description('Team id.'),
}).description('Delete a workspace team belonging to an Agent. Its child teams and session agents move to its parent. The root team cannot be deleted.');

export const AgentRoleListSchema = Schema.object({ groupId: Schema.number().step(1).min(1).required() }).description('List roles configured on the Group root Team, including available Agent permissions.');
export const AgentRoleGetSchema = Schema.object({ groupId: Schema.number().step(1).min(1).required(), roleId: Schema.string().required() }).description('Read one Agent role and its permissions.');
export const AgentRoleCreateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    roleId: Schema.string().required().description('Unique lowercase role id (1–32 characters; letters, digits, dots, underscores, and hyphens).'),
    name: Schema.string().required().description('Role name, 1–64 characters.'),
    permissions: Schema.array(Schema.string()).description('Permission IDs from agent_permission_list; defaults to no permissions.'),
}).description('Create a custom role on the Group root Team. Built-in role ids are reserved.');
export const AgentRoleUpdateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    roleId: Schema.string().required(),
    name: Schema.string().description('New role name (custom roles only).'),
    permissions: Schema.array(Schema.string()).description('Replace the role permission list. Root permissions are fixed.'),
}).description('Rename a custom role and/or replace its permission list. Built-in roles cannot be renamed; Root permissions cannot be changed.');
export const AgentRoleRemoveSchema = Schema.object({ groupId: Schema.number().step(1).min(1).required(), roleId: Schema.string().required() }).description('Delete a custom role. Built-in roles cannot be deleted. Agents assigned to a deleted role fall back to Default.');
const TeamAgentCreateFieldsSchema = Schema.object({
    teamId: Schema.string().description('Existing Agent team id. Omit to use the Group root team.'),
    teamRef: Schema.string().description('ref of a team created in this same request.'),
    title: Schema.string().required().description('Agent record title.'),
    provider: Schema.string().description('Optional model provider. Pass together with model.'),
    model: Schema.string().description('Optional model id. Pass together with provider.'),
    baseDocId: Schema.number().step(1).min(1).description('Optional Base to attach as this agent’s context.'),
    runtimeId: Schema.string().description('Optional host id.'),
    agentPreset: Schema.string().description('Optional Agent preset id.'),
    roleId: Schema.string().description('Optional Group role id; requires Agent configuration permission. Omit to use Default.'),
});

export const TeamCreateManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    parentTeamId: Schema.string().description('Default parent team for entries without teamId/parentTeamId; defaults to the Group root.'),
    teams: Schema.array(Schema.object({
        text: Schema.string().required().description('Team title.'),
        ref: Schema.string().description('Optional name for this team, for parentRef or teamRef references.'),
        parentTeamId: Schema.string().description('Existing parent team id.'),
        parentRef: Schema.string().description('ref of an earlier team in this request.'),
    })).max(MAX_TEAMS_PER_CALL).description('Teams to create, in order.'),
    agents: Schema.array(TeamAgentCreateFieldsSchema).max(MAX_AGENTS_PER_CALL).description('Agents to create after teams; teamRef may refer to a team created above.'),
}).description('Create teams and agents for one Group in a single tool call. Teams are created first, so agents may refer to them by teamRef. Team and agent results report successes and refusals separately; this batch is not transactional.');

export const TeamGetManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamIds: Schema.array(Schema.string()).max(MAX_TEAMS_PER_CALL).description('Team ids to read.'),
    agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).description('Persisted Agent ids to read.'),
}).description('Read multiple teams and agents for one Group in one tool call. At least one of teamIds or agentIds is required; each array can contain up to 500 ids.');

export const TeamUpdateManySchema = Schema.object({
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
        roleId: Schema.string().description('Assign a Group role; pass an empty string to use Default.'),
    })).max(MAX_AGENTS_PER_CALL).description('Agent title, team, and role changes.'),
}).description('Update multiple teams and agents for one Group. Team and agent results report successes and refusals separately; this batch is not transactional.');

export const TeamDeleteManySchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    teamIds: Schema.array(Schema.string()).max(MAX_TEAMS_PER_CALL).description('Teams to delete; agents and child teams move to the deleted team’s parent.'),
    agentIds: Schema.array(Schema.string()).max(MAX_AGENTS_PER_CALL).description('Persisted Agent ids to delete.'),
}).description('Delete multiple teams and agents for one Group in one tool call. Agents are deleted before teams; the root team cannot be deleted.');
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
            for (const addon of listRegisteredAgentAddons()) {
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
export async function listAgentRoles(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args);
    const { acl } = await groupRootAcl(ctx, groupId, group.title);
    return { ok: true, groupId, roles: acl.roles, permissions: agentPermissionCatalog() };
}

export async function getAgentRole(ctx: ToolContext, args: ToolArgs) {
    const { groupId, group } = await requireGroup(ctx, args);
    const roleId = asText(args.roleId);
    const { acl } = await groupRootAcl(ctx, groupId, group.title);
    const role = acl.roles.find((item) => item.roleId === roleId);
    if (!role) throw new Error(`Agent role not found: ${roleId}`);
    return { ok: true, groupId, role };
}

export async function createAgentRole(ctx: ToolContext, args: ToolArgs) {
    await requireAgentConfigurationPermission(ctx);
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    const roleId = asText(args.roleId);
    const name = asText(args.name);
    if (!/^[a-z][a-z0-9._-]{0,31}$/.test(roleId)) throw new Error('roleId must be 1–32 lowercase letters, digits, dots, underscores, or hyphens and start with a letter');
    if (['root', 'default', 'guest'].includes(roleId)) throw new Error(`Built-in role id is reserved: ${roleId}`);
    if (!name || name.length > 64) throw new Error('name must be between 1 and 64 characters');
    const { root, acl } = await groupRootAcl(ctx, groupId, group.title);
    if (acl.roles.some((role) => role.roleId === roleId)) throw new Error(`Agent role already exists: ${roleId}`);
    acl.roles.push({ roleId, name, permissions: args.permissions === undefined ? [] : validateRolePermissions(args.permissions) });
    const updated = await saveGroupRootAcl(ctx, groupId, root, normalizeAgentAcl(acl));
    return { ok: true, groupId, role: updated.config?.acl?.roles.find((role) => role.roleId === roleId) };
}

export async function updateAgentRole(ctx: ToolContext, args: ToolArgs) {
    await requireAgentConfigurationPermission(ctx);
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    const roleId = asText(args.roleId);
    const hasName = Object.prototype.hasOwnProperty.call(args, 'name');
    const hasPermissions = Object.prototype.hasOwnProperty.call(args, 'permissions');
    if (!hasName && !hasPermissions) throw new Error('Nothing to update');
    const { root, acl } = await groupRootAcl(ctx, groupId, group.title);
    const role = acl.roles.find((item) => item.roleId === roleId);
    if (!role) throw new Error(`Agent role not found: ${roleId}`);
    if (roleId === 'root') throw new Error('The Root role is fixed and cannot be updated');
    if (hasName) {
        const name = asText(args.name);
        if (['default', 'guest'].includes(roleId)) throw new Error(`Built-in role name cannot be changed: ${roleId}`);
        if (!name || name.length > 64) throw new Error('name must be between 1 and 64 characters');
        role.name = name;
    }
    if (hasPermissions) role.permissions = validateRolePermissions(args.permissions);
    const updated = await saveGroupRootAcl(ctx, groupId, root, normalizeAgentAcl(acl));
    return { ok: true, groupId, role: updated.config?.acl?.roles.find((item) => item.roleId === roleId) };
}

export async function removeAgentRole(ctx: ToolContext, args: ToolArgs) {
    await requireAgentConfigurationPermission(ctx);
    const { groupId, group } = await requireGroup(ctx, args, 'edit');
    const roleId = asText(args.roleId);
    if (['root', 'default', 'guest'].includes(roleId)) throw new Error(`Built-in role cannot be deleted: ${roleId}`);
    const { root, acl } = await groupRootAcl(ctx, groupId, group.title);
    if (!acl.roles.some((role) => role.roleId === roleId)) throw new Error(`Agent role not found: ${roleId}`);
    acl.roles = acl.roles.filter((role) => role.roleId !== roleId);
    await saveGroupRootAcl(ctx, groupId, root, normalizeAgentAcl(acl));
    return { ok: true, groupId, roleId, deleted: true };
}
async function createTeams(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit');
    const teams: any[] = [], refusedTeams: any[] = [], refs = new Set<string>();
    for (const [index, fields] of objectEntries(args.teams, 'teams').entries()) {
        const text = asText(fields.text), ref = asText(fields.ref), parentRef = asText(fields.parentRef);
        if (!text) throw new Error(`teams[${index}].text is required`);
        if (ref && refs.has(ref)) throw new Error(`Duplicate team ref: ${ref}`);
        let parentTeamId = asText(fields.parentTeamId) || asText(args.parentTeamId);
        if (parentRef) { const parent = teams.find((item) => item.ref === parentRef); if (!parent) { refusedTeams.push({ index, error: `Unknown parentRef ${parentRef}` }); continue; } parentTeamId = parent.teamId; }
        try { const result = await createTeam(ctx, { groupId, text, ...(parentTeamId ? { parentTeamId } : {}) }); teams.push({ index, ...(ref ? { ref } : {}), ...result.team }); if (ref) refs.add(ref); }
        catch (error) { refusedTeams.push({ index, error: (error as Error).message }); }
    }
    return { teams, refusedTeams };
}
async function getTeams(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args); const teamIds = idList(args.teamIds, 'teamIds', MAX_TEAMS_PER_CALL);
    const workspace = await groupWorkspace(ctx, groupId); const byId = new Map(workspace.teams.map((team) => [team.teamId, team]));
    const teams = teamIds.flatMap((teamId, index) => { const team = byId.get(teamId); return team ? [{ index, ...teamDetail(team, workspace.teams, workspace.sessions) }] : []; });
    const missingTeamIds = teamIds.filter((id) => !byId.has(id)); return { ok: !missingTeamIds.length, groupId, teams, missingTeamIds };
}
async function removeTeams(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit'); const teamIds = idList(args.teamIds, 'teamIds', MAX_TEAMS_PER_CALL);
    for (const teamId of teamIds) await removeTeam(ctx, { groupId, teamId });
    return { ok: true, groupId, removedTeamIds: teamIds, failedSessionIds: [] as string[] };
}

export async function createTeamMany(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'edit');
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

    const agents: { index: number; agent?: unknown; error?: string }[] = [];
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
            const result = await createAgent(ctx, { ...fields, groupId });
            agents.push({ index, agent: result.agent });
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
        agentIds.length ? getAgents(ctx, { groupId, agentIds }) : Promise.resolve(undefined),
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

class AgentTeamListExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return listTeams(this.context, this.args);
    }
}

class AgentTeamGetExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return getTeam(this.context, this.args);
    }
}

class AgentTeamCreateExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return createTeam(this.context, this.args);
    }
}

class AgentTeamUpdateExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return updateTeam(this.context, this.args);
    }
}

class AgentTeamDeleteExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return removeTeam(this.context, this.args);
    }
}

class AgentRoleListExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return listAgentRoles(this.context, this.args);
    }
}

class AgentRoleGetExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return getAgentRole(this.context, this.args);
    }
}

class AgentRoleCreateExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return createAgentRole(this.context, this.args);
    }
}

class AgentRoleUpdateExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return updateAgentRole(this.context, this.args);
    }
}

class AgentRoleDeleteExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return removeAgentRole(this.context, this.args);
    }
}

class AgentTeamCreateManyExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return createTeamMany(this.context, this.args);
    }
}

class AgentTeamGetManyExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return getTeamMany(this.context, this.args);
    }
}

class AgentTeamUpdateManyExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return updateTeamMany(this.context, this.args);
    }
}

class AgentTeamDeleteManyExecutor extends Executor<ToolContext, ToolArgs> {
    execute() {
        return deleteTeamMany(this.context, this.args);
    }
}

export function apply(ctx: Context) {
    ctx.Tool('agent', 'agent_team_list', AgentTeamListExecutor, TeamListSchema, PERM.AGENT_PERM_TEAM_LIST);
    ctx.Tool('agent', 'agent_team_get', AgentTeamGetExecutor, TeamGetSchema, PERM.AGENT_PERM_TEAM_GET);
    ctx.Tool('agent', 'agent_team_create', AgentTeamCreateExecutor, TeamCreateSchema, PERM.AGENT_PERM_TEAM_CREATE);
    ctx.Tool('agent', 'agent_team_update', AgentTeamUpdateExecutor, TeamUpdateSchema, PERM.AGENT_PERM_TEAM_UPDATE);
    ctx.Tool('agent', 'agent_team_delete', AgentTeamDeleteExecutor, TeamRemoveSchema, PERM.AGENT_PERM_TEAM_DELETE);
    ctx.Tool('agent', 'agent_role_list', AgentRoleListExecutor, AgentRoleListSchema, PERM.AGENT_PERM_ROLE_LIST);
    ctx.Tool('agent', 'agent_role_get', AgentRoleGetExecutor, AgentRoleGetSchema, PERM.AGENT_PERM_ROLE_GET);
    ctx.Tool('agent', 'agent_role_create', AgentRoleCreateExecutor, AgentRoleCreateSchema, PERM.AGENT_PERM_ROLE_CREATE);
    ctx.Tool('agent', 'agent_role_update', AgentRoleUpdateExecutor, AgentRoleUpdateSchema, PERM.AGENT_PERM_ROLE_UPDATE);
    ctx.Tool('agent', 'agent_role_delete', AgentRoleDeleteExecutor, AgentRoleRemoveSchema, PERM.AGENT_PERM_ROLE_DELETE);
    ctx.Tool('agent', 'agent_team_create_many', AgentTeamCreateManyExecutor, TeamCreateManySchema, PERM.AGENT_PERM_TEAM_CREATE_MANY);
    ctx.Tool('agent', 'agent_team_get_many', AgentTeamGetManyExecutor, TeamGetManySchema, PERM.AGENT_PERM_TEAM_GET_MANY);
    ctx.Tool('agent', 'agent_team_update_many', AgentTeamUpdateManyExecutor, TeamUpdateManySchema, PERM.AGENT_PERM_TEAM_UPDATE_MANY);
    ctx.Tool('agent', 'agent_team_delete_many', AgentTeamDeleteManyExecutor, TeamDeleteManySchema, PERM.AGENT_PERM_TEAM_DELETE_MANY);
}

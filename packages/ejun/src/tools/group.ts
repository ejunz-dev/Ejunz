import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PERM } from 'ejun/src/model/builtin';
import { agentToolAccess } from '../service/addons';
import GroupDefinitionModel, { AgentSessionModel } from 'ejun/src/model/agent';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import { buildOutline, ensureGroupRoot, groupView, groupWorkspace, requireGroup, resultLimit } from './common/agent';

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
    await ctx.broadcastAgentEvent?.('agent/group-context', { domainId: ctx.domainId, groupId });
    return { ok: true, group: groupView(group) };
}

export async function removeGroup(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args, 'delete');
    await AgentSessionModel.detachGroup(ctx.domainId, groupId);
    await GroupDefinitionModel.del(ctx.domainId, groupId);
    return { ok: true, groupId, deleted: true };
}

export function apply(ctx: Context) {
    ctx.Tool('agent', 'agent_group_list', listGroups, GroupList, agentToolAccess(PERM.AGENT_PERM_GROUP_LIST));
    ctx.Tool('agent', 'agent_group_search', searchGroups, GroupSearch, agentToolAccess(PERM.AGENT_PERM_GROUP_SEARCH));
    ctx.Tool('agent', 'agent_group_get', getGroup, GroupGet, agentToolAccess(PERM.AGENT_PERM_GROUP_GET));
    ctx.Tool('agent', 'agent_group_create', createGroup, GroupCreate, agentToolAccess(PERM.AGENT_PERM_GROUP_CREATE, true));
    ctx.Tool('agent', 'agent_group_update', updateGroup, GroupUpdate, agentToolAccess(PERM.AGENT_PERM_GROUP_UPDATE, true));
    ctx.Tool('agent', 'agent_group_delete', removeGroup, GroupRemove, agentToolAccess(PERM.AGENT_PERM_GROUP_DELETE, true));
}

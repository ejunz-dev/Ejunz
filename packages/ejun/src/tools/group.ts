import Schema from 'schemastery';
import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PERM } from 'ejun/src/model/builtin';
import GroupDefinitionModel, { AgentSessionModel } from 'ejun/src/model/agent';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import { buildOutline, ensureGroupRoot, groupView, groupWorkspace, requireGroup, resultLimit } from './common/agent';

export const inject = ['server'];

export const GroupListSchema = Schema.object({
    limit: Schema.number().min(1).max(50).description('Maximum result count, up to 50.'),
}).description('List Groups available in the current domain. Each result includes its groupId, title, description, update time, and the current user’s team and agent counts.');

export const GroupSearchSchema = Schema.object({
    query: Schema.string().required().description('Search text.'),
    limit: Schema.number().min(1).max(50).description('Maximum result count, up to 50.'),
}).description('Search Groups in the current domain by title or description.');

export const GroupGetSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
}).description('Read a Group by groupId. Returns its groupId, title, description, update time, and the current user’s team and agent tree.');

export const GroupCreateSchema = Schema.object({
    title: Schema.string().required().description('Group name (required, up to 256 characters).'),
    content: Schema.string().description('Group description or instructions (optional, up to 100000 characters).'),
}).description('Create a Group in the current domain. The current user owns the new Group and its root team.');

export const GroupUpdateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
    title: Schema.string().description('New Group name (optional).'),
    content: Schema.string().description('New Group description or instructions (optional).'),
}).description('Update a Group by groupId. Only the owner or a user with edit-discussion permission can update another user’s Group.');

export const GroupRemoveSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required().description('Group id.'),
}).description('Delete a Group by groupId. Existing sessions and workspace teams are detached, as in the Group management UI.');












class AgentGroupListExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(){


            const limit = resultLimit(this.args.limit);
            const groups = (await GroupDefinitionModel.getMulti(this.ctx.domainId).toArray()).slice(0, limit);
            const listed = await Promise.all(groups.map(async (group) => {
                const workspace = await groupWorkspace(this.ctx, group.docId);
                return { ...groupView(group), teamCount: workspace.teams.length, agentCount: workspace.sessions.length };
            }));
            return { ok: true, count: listed.length, groups: listed };
    }
}

class AgentGroupSearchExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(){


            const query = String(this.args.query || '').trim().toLowerCase();
            if (!query) throw new Error('query is required');
            const limit = resultLimit(this.args.limit);
            const groups = await GroupDefinitionModel.getMulti(this.ctx.domainId).toArray();
            const matches = groups.filter((group) => [group.title, group.content].some((value) => typeof value === 'string' && value.toLowerCase().includes(query)));
            return { ok: true, query, count: Math.min(matches.length, limit), groups: matches.slice(0, limit).map(groupView) };
    }
}

class AgentGroupGetExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(){


            const { groupId, group } = await requireGroup(this.ctx, this.args);
            await ensureGroupRoot(this.ctx, groupId, group.title);
            const workspace = await groupWorkspace(this.ctx, groupId);
            return {
                ok: true,
                group: groupView(group),
                teamCount: workspace.teams.length,
                agentCount: workspace.sessions.length,
                outline: buildOutline(workspace.teams, workspace.sessions),
            };
    }
}

class AgentGroupCreateExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(){


            const title = String(this.args.title || '').trim();
            const content = typeof this.args.content === 'string' ? this.args.content : '';
            if (!title || title.length > 256) throw new Error('title is required and must be at most 256 characters');
            if (content.length > 100000) throw new Error('content must be at most 100000 characters');
            const aid = await GroupDefinitionModel.add(this.ctx.domainId, this.ctx.owner, title, content);
            const group = await GroupDefinitionModel.get(this.ctx.domainId, aid, GroupDefinitionModel.PROJECTION_LIST);
            if (!group) throw new Error('Failed to read the created Group');
            await ensureGroupRoot(this.ctx, group.docId, group.title);
            return { ok: true, group: groupView(group) };
    }
}

class AgentGroupUpdateExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(){


            const { groupId } = await requireGroup(this.ctx, this.args, 'edit');
            const updates: Record<string, string> = {};
            if (Object.prototype.hasOwnProperty.call(this.args, 'title')) {
                const title = String(this.args.title || '').trim();
                if (!title || title.length > 256) throw new Error('title must be between 1 and 256 characters');
                updates.title = title;
            }
            if (typeof this.args.content === 'string') {
                if (this.args.content.length > 100000) throw new Error('content must be at most 100000 characters');
                updates.content = this.args.content;
            }
            if (!Object.keys(updates).length) throw new Error('Nothing to update');
            const group = await GroupDefinitionModel.edit(this.ctx.domainId, groupId, updates);
            if (updates.title !== undefined) await AgentSessionModel.syncGroupRootTitle(this.ctx.domainId, groupId, updates.title);
            await this.ctx.broadcastAgentEvent?.('agent/group-context', { domainId: this.ctx.domainId, groupId });
            return { ok: true, group: groupView(group) };
    }
}

class AgentGroupDeleteExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(){


            const { groupId } = await requireGroup(this.ctx, this.args, 'delete');
            await AgentSessionModel.detachGroup(this.ctx.domainId, groupId);
            await GroupDefinitionModel.del(this.ctx.domainId, groupId);
            return { ok: true, groupId, deleted: true };
    }
}

export function apply(ctx: Context) {
    ctx.Tool('agent', 'agent_group_list', AgentGroupListExecutor, GroupListSchema, PERM.AGENT_PERM_GROUP_LIST);
    ctx.Tool('agent', 'agent_group_search', AgentGroupSearchExecutor, GroupSearchSchema, PERM.AGENT_PERM_GROUP_SEARCH);
    ctx.Tool('agent', 'agent_group_get', AgentGroupGetExecutor, GroupGetSchema, PERM.AGENT_PERM_GROUP_GET);
    ctx.Tool('agent', 'agent_group_create', AgentGroupCreateExecutor, GroupCreateSchema, PERM.AGENT_PERM_GROUP_CREATE);
    ctx.Tool('agent', 'agent_group_update', AgentGroupUpdateExecutor, GroupUpdateSchema, PERM.AGENT_PERM_GROUP_UPDATE);
    ctx.Tool('agent', 'agent_group_delete', AgentGroupDeleteExecutor, GroupRemoveSchema, PERM.AGENT_PERM_GROUP_DELETE);
}

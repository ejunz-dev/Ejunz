import Schema from 'schemastery';
import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PERM } from 'ejun/src/model/builtin';
import { agentRuntimeHandlerContext } from '../service/runtime';
import { asText } from '../lib/tool-shared';
import { agentPermissionCatalog, registerAgentAddon } from '../service/addons';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import { requireAgentConfigurationPermission, requireGroup, sessionScope } from './common/agent';

export const inject = ['server'];

export const AgentPermissionListSchema = Schema.object({}).description('List permissions contributed by registered Addons for Agent roles. Core Agent tool permissions are assigned through domain roles.');
export const AgentPermissionGetSchema = Schema.object({ permissionId: Schema.string().required() }).description('Read one Addon permission available to Agent roles.');

export const AgentAddonListSchema = Schema.object({ groupId: Schema.number().step(1).min(1).required() }).description('List registered Addons and their installed and Group-enabled status. Read Team-specific selections from the Team config.');
export const AgentAddonGetSchema = Schema.object({ groupId: Schema.number().step(1).min(1).required(), addonId: Schema.string().required() }).description('Read one registered Addon and its tools and permissions.');
export const AgentAddonInstallSchema = Schema.object({ addonId: Schema.string().required() }).description('Install a registered Addon for the current domain. Requires Agent configuration permission.');
export const AgentAddonUninstallSchema = Schema.object({ addonId: Schema.string().required() }).description('Uninstall a registered Addon from the current domain. This disables it for all Groups and removes its role permissions. Requires Agent configuration permission.');
export const AgentAddonUpdateSchema = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    addonId: Schema.string().required(),
    enabled: Schema.boolean().required(),
}).description('Enable or disable an installed Addon for one Group. This does not change domain installation. Requires Agent configuration permission.');




async function addonRpcValue(response: { result?: { ok?: boolean; value?: unknown }; error?: { message?: string } }, label: string) {
    if (!response.result?.ok) throw new Error(response.error?.message || label);
    return response.result.value;
}











class AgentPermissionListExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(_ctx: ToolContext, _args: ToolArgs) {


            const permissions = agentPermissionCatalog();
            return { ok: true, count: permissions.length, permissions };
    }
}

class AgentPermissionGetExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(_ctx: ToolContext, args: ToolArgs) {


            const permissionId = asText(args.permissionId);
            const permission = agentPermissionCatalog().find((item) => item.id === permissionId);
            if (!permission) throw new Error(`Agent permission not found: ${permissionId}`);
            return { ok: true, permission };
    }
}

class AgentAddonListExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(ctx: ToolContext, args: ToolArgs) {


            const { groupId } = await requireGroup(ctx, args);
            const result = await agentRuntimeHandlerContext.agentAddonsList({ rpcId: 'agent_addons_list', method: 'agent.addons.list' }, sessionScope(ctx, groupId));
            const value = await addonRpcValue(result, 'Failed to list Agent Addons') as { addons?: unknown[] };
            return { ok: true, groupId, addons: value.addons ?? [], permissions: agentPermissionCatalog() };
    }
}

class AgentAddonGetExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(ctx: ToolContext, args: ToolArgs) {


            const { groupId } = await requireGroup(ctx, args);
            const addonId = asText(args.addonId);
            const result = await agentRuntimeHandlerContext.agentAddonsList({ rpcId: 'agent_addons_get', method: 'agent.addons.list' }, sessionScope(ctx, groupId));
            const value = await addonRpcValue(result, 'Failed to read Agent Addon') as { addons?: { addonId: string }[] };
            const addon = value.addons?.find((item) => item.addonId === addonId);
            if (!addon) throw new Error(`Agent Addon not found: ${addonId}`);
            return { ok: true, groupId, addon };
    }
}

class AgentAddonInstallExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(ctx: ToolContext, args: ToolArgs) {


            await requireAgentConfigurationPermission(ctx);
            const addonId = asText(args.addonId);
            const result = await agentRuntimeHandlerContext.setAgentAddonInstalled({ rpcId: 'agent_addon_install', method: 'agent.addons.install', payload: { addonId } }, { domainId: ctx.domainId, userId: ctx.owner }, async (change) => {
                await ctx.broadcastAgentEvent?.('agent/addon-state', { ...change });
            }, true);
            const value = await addonRpcValue(result, 'Failed to install Agent Addon');
            return { ok: true, ...(value as Record<string, unknown>) };
    }
}

class AgentAddonUninstallExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(ctx: ToolContext, args: ToolArgs) {


            await requireAgentConfigurationPermission(ctx);
            const addonId = asText(args.addonId);
            const result = await agentRuntimeHandlerContext.setAgentAddonInstalled({ rpcId: 'agent_addon_uninstall', method: 'agent.addons.uninstall', payload: { addonId } }, { domainId: ctx.domainId, userId: ctx.owner }, async (change) => {
                await ctx.broadcastAgentEvent?.('agent/addon-state', { ...change });
            }, false);
            const value = await addonRpcValue(result, 'Failed to uninstall Agent Addon');
            return { ok: true, ...(value as Record<string, unknown>) };
    }
}

class AgentAddonUpdateExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(ctx: ToolContext, args: ToolArgs) {


            await requireAgentConfigurationPermission(ctx);
            const { groupId } = await requireGroup(ctx, args, 'edit');
            const addonId = asText(args.addonId);
            if (typeof args.enabled !== 'boolean') throw new Error('enabled must be a boolean');
            const result = await agentRuntimeHandlerContext.agentAddonSet({ rpcId: 'agent_addon_update', method: 'agent.addons.set', payload: { addonId, enabled: args.enabled } }, sessionScope(ctx, groupId), async (change) => {
                await ctx.broadcastAgentEvent?.('agent/addon-state', { ...change });
            });
            const value = await addonRpcValue(result, 'Failed to update Agent Addon');
            return { ok: true, groupId, ...(value as Record<string, unknown>) };
    }
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
    ctx.Tool('agent', 'agent_permission_list', AgentPermissionListExecutor, AgentPermissionListSchema, PERM.AGENT_PERM_PERMISSION_LIST);
    ctx.Tool('agent', 'agent_permission_get', AgentPermissionGetExecutor, AgentPermissionGetSchema, PERM.AGENT_PERM_PERMISSION_GET);
    ctx.Tool('agent', 'agent_addon_list', AgentAddonListExecutor, AgentAddonListSchema, PERM.AGENT_PERM_ADDON_LIST);
    ctx.Tool('agent', 'agent_addon_get', AgentAddonGetExecutor, AgentAddonGetSchema, PERM.AGENT_PERM_ADDON_GET);
    ctx.Tool('agent', 'agent_addon_install', AgentAddonInstallExecutor, AgentAddonInstallSchema, PERM.AGENT_PERM_ADDON_INSTALL);
    ctx.Tool('agent', 'agent_addon_uninstall', AgentAddonUninstallExecutor, AgentAddonUninstallSchema, PERM.AGENT_PERM_ADDON_UNINSTALL);
    ctx.Tool('agent', 'agent_addon_update', AgentAddonUpdateExecutor, AgentAddonUpdateSchema, PERM.AGENT_PERM_ADDON_UPDATE);
}

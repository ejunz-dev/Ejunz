import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import { agentRuntimeHandlerContext } from '../service/runtime';
import { asText } from '../lib/tool-shared';
import { registerAgentAddon } from '../service/addons';
import { agentPermissionCatalog } from '../service/agent-permissions';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import { requireAgentConfigurationPermission, requireGroup, sessionScope } from './agent-common';

export const inject = ['server'];

export const AgentPermissionList = Schema.object({}).description('List the fixed Agent permission catalog, including permissions contributed by registered Addons.');
export const AgentPermissionGet = Schema.object({ permissionId: Schema.string().required() }).description('Read one permission from the Agent permission catalog.');

export const AgentAddonList = Schema.object({ groupId: Schema.number().step(1).min(1).required() }).description('List registered Addons and their installed and Group-enabled status. Read Team-specific selections from the Team config.');
export const AgentAddonGet = Schema.object({ groupId: Schema.number().step(1).min(1).required(), addonId: Schema.string().required() }).description('Read one registered Addon and its tools and permissions.');
export const AgentAddonInstall = Schema.object({ addonId: Schema.string().required() }).description('Install a registered Addon for the current domain. Requires Agent configuration permission.');
export const AgentAddonUninstall = Schema.object({ addonId: Schema.string().required() }).description('Uninstall a registered Addon from the current domain. This disables it for all Groups and removes its role permissions. Requires Agent configuration permission.');
export const AgentAddonUpdate = Schema.object({
    groupId: Schema.number().step(1).min(1).required(),
    addonId: Schema.string().required(),
    enabled: Schema.boolean().required(),
}).description('Enable or disable an installed Addon for one Group. This does not change domain installation. Requires Agent configuration permission.');
export async function listAgentPermissions(_ctx: ToolContext, _args: ToolArgs) {
    const permissions = agentPermissionCatalog();
    return { ok: true, count: permissions.length, permissions };
}

export async function getAgentPermission(_ctx: ToolContext, args: ToolArgs) {
    const permissionId = asText(args.permissionId);
    const permission = agentPermissionCatalog().find((item) => item.id === permissionId);
    if (!permission) throw new Error(`Agent permission not found: ${permissionId}`);
    return { ok: true, permission };
}

async function addonRpcValue(response: { result?: { ok?: boolean; value?: unknown }; error?: { message?: string } }, label: string) {
    if (!response.result?.ok) throw new Error(response.error?.message || label);
    return response.result.value;
}

export async function listAgentAddons(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args);
    const result = await agentRuntimeHandlerContext.agentAddonsList({ rpcId: 'agent_addons_list', method: 'agent.addons.list' }, sessionScope(ctx, groupId));
    const value = await addonRpcValue(result, 'Failed to list Agent Addons') as { addons?: unknown[] };
    return { ok: true, groupId, addons: value.addons ?? [], permissions: agentPermissionCatalog() };
}

export async function getAgentAddon(ctx: ToolContext, args: ToolArgs) {
    const { groupId } = await requireGroup(ctx, args);
    const addonId = asText(args.addonId);
    const result = await agentRuntimeHandlerContext.agentAddonsList({ rpcId: 'agent_addons_get', method: 'agent.addons.list' }, sessionScope(ctx, groupId));
    const value = await addonRpcValue(result, 'Failed to read Agent Addon') as { addons?: { addonId: string }[] };
    const addon = value.addons?.find((item) => item.addonId === addonId);
    if (!addon) throw new Error(`Agent Addon not found: ${addonId}`);
    return { ok: true, groupId, addon };
}

export async function installAgentAddon(ctx: ToolContext, args: ToolArgs) {
    await requireAgentConfigurationPermission(ctx);
    const addonId = asText(args.addonId);
    const result = await agentRuntimeHandlerContext.setAgentAddonInstalled({ rpcId: 'agent_addon_install', method: 'agent.addons.install', payload: { addonId } }, { domainId: ctx.domainId, userId: ctx.owner }, async (change) => {
        await ctx.broadcastAgentEvent?.('agent/addon-state', { ...change });
    }, true);
    const value = await addonRpcValue(result, 'Failed to install Agent Addon');
    return { ok: true, ...(value as Record<string, unknown>) };
}

export async function uninstallAgentAddon(ctx: ToolContext, args: ToolArgs) {
    await requireAgentConfigurationPermission(ctx);
    const addonId = asText(args.addonId);
    const result = await agentRuntimeHandlerContext.setAgentAddonInstalled({ rpcId: 'agent_addon_uninstall', method: 'agent.addons.uninstall', payload: { addonId } }, { domainId: ctx.domainId, userId: ctx.owner }, async (change) => {
        await ctx.broadcastAgentEvent?.('agent/addon-state', { ...change });
    }, false);
    const value = await addonRpcValue(result, 'Failed to uninstall Agent Addon');
    return { ok: true, ...(value as Record<string, unknown>) };
}

export async function updateAgentAddon(ctx: ToolContext, args: ToolArgs) {
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

export function apply(ctx: Context) {
    const unregister = registerAgentAddon({
        addonId: 'agent',
        displayName: 'Ejunz Agent',
        description: 'Create and manage Groups, Teams, and Agents in the Agent workspace.',
        toolPrefixes: ['agent_'],
        defaultEnabled: true,
    });
    ctx.effect(() => unregister);
    const read = { source: 'agent', bindBase: 'none' as const, agentPermissions: ['agent:read'] };
    const write = { ...read, mutating: true, agentPermissions: ['agent:manage'] };
    ctx.Tool('agent', 'agent_permission_list', listAgentPermissions, AgentPermissionList, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_permission_get', getAgentPermission, AgentPermissionGet, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_addon_list', listAgentAddons, AgentAddonList, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_addon_get', getAgentAddon, AgentAddonGet, read, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_addon_install', installAgentAddon, AgentAddonInstall, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_addon_uninstall', uninstallAgentAddon, AgentAddonUninstall, write, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('agent', 'agent_addon_update', updateAgentAddon, AgentAddonUpdate, write, PRIV.PRIV_USER_PROFILE);
}

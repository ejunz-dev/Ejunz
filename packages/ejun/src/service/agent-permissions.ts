import type { AgentTeamAcl } from '../model/agent';
import { listAgentAddons } from './addons';

export interface AgentPermissionInfo {
    id: string;
    name: string;
    description?: string;
    addonId?: string;
}

export const AGENT_CORE_PERMISSIONS: readonly AgentPermissionInfo[] = [
    { id: 'agent:read', name: 'Read Agent workspace', description: 'View Agents, Teams, sessions, and their history.' },
    { id: 'agent:manage', name: 'Manage Agent workspace', description: 'Create, update, and delete Agents, Teams, and sessions.' },
];

export const DEFAULT_AGENT_ROLE_ID = 'default';

export function addonAgentPermissionId(addonId: string, permissionId: string): string {
    return `${addonId}:${permissionId}`;
}

export function agentPermissionCatalog(): AgentPermissionInfo[] {
    return [
        ...AGENT_CORE_PERMISSIONS,
        ...listAgentAddons().flatMap((addon) => (addon.permissions || []).map((permission) => ({
            id: addonAgentPermissionId(addon.addonId, permission.id),
            name: permission.name,
            ...(permission.description ? { description: permission.description } : {}),
            addonId: addon.addonId,
        }))),
    ];
}

export function defaultAgentAcl(): AgentTeamAcl {
    return {
        activeRoleId: DEFAULT_AGENT_ROLE_ID,
        roles: [{
            roleId: DEFAULT_AGENT_ROLE_ID,
            name: 'Default',
            permissions: AGENT_CORE_PERMISSIONS.map((permission) => permission.id),
        }],
    };
}

export function normalizeAgentAcl(value: unknown): AgentTeamAcl {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Agent ACL.');
    const input = value as Record<string, unknown>;
    if (!Array.isArray(input.roles) || input.roles.length === 0 || input.roles.length > 32) {
        throw new Error('Agent ACL must contain between 1 and 32 roles.');
    }
    const roleIds = new Set<string>();
    const roles = input.roles.map((value): AgentTeamAcl['roles'][number] => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Agent role.');
        const role = value as Record<string, unknown>;
        const roleId = typeof role.roleId === 'string' ? role.roleId.trim() : '';
        const name = typeof role.name === 'string' ? role.name.trim() : '';
        if (!/^[a-z][a-z0-9._-]{0,31}$/.test(roleId) || !name || name.length > 64 || roleIds.has(roleId)) {
            throw new Error('Agent role IDs must be unique and names must be 1–64 characters.');
        }
        roleIds.add(roleId);
        const permissions = Array.isArray(role.permissions) ? role.permissions : [];
        if (permissions.length > 256 || permissions.some((permission) => typeof permission !== 'string' || !/^[a-z][a-z0-9._-]{0,63}:[a-z][a-z0-9._-]{0,63}$/.test(permission))) {
            throw new Error(`Agent role "${roleId}" contains an invalid permission ID.`);
        }
        return { roleId, name, permissions: [...new Set(permissions as string[])].sort() };
    });
    const activeRoleId = typeof input.activeRoleId === 'string' ? input.activeRoleId : '';
    if (!roleIds.has(activeRoleId)) throw new Error('The selected Agent role does not exist.');
    return { activeRoleId, roles };
}

export function permissionsForAgentAcl(acl: AgentTeamAcl | undefined): Set<string> {
    const resolved = acl || defaultAgentAcl();
    return new Set(resolved.roles.find((role) => role.roleId === resolved.activeRoleId)?.permissions || []);
}

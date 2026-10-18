import { BUILTIN_AGENT_ROLES, defaultAgentAcl, type AgentTeamAcl } from '../model/agent';

export { defaultAgentAcl };
import { listAgentAddons } from './addons';

export interface AgentPermissionInfo {
    id: string;
    name: string;
    family: string;
    description?: string;
    addonId?: string;
}

export const AGENT_CORE_PERMISSIONS: readonly AgentPermissionInfo[] = [
    { id: 'agent:read', name: 'Read Agent workspace', family: 'Agent', description: 'View Agents, Teams, sessions, and their history.' },
    { id: 'agent:manage', name: 'Manage Agent workspace', family: 'Agent', description: 'Create, update, and delete Agents, Teams, and sessions.' },
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
            family: addon.displayName,
            ...(permission.description ? { description: permission.description } : {}),
            addonId: addon.addonId,
        }))),
    ];
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
    const builtins = BUILTIN_AGENT_ROLES.map((role) => ({ ...role, permissions: [...role.permissions] }));
    for (const builtin of builtins) {
        const existing = roles.find((role) => role.roleId === builtin.roleId);
        if (builtin.roleId === 'root' && existing) existing.permissions = [...builtin.permissions];
        else if (!existing) roles.push(builtin);
    }
    if (roles.length > 32) throw new Error('Agent ACL can contain at most 32 roles.');
    return { roles };
}

export function permissionsForAgentAcl(acl: AgentTeamAcl | undefined, roleId = DEFAULT_AGENT_ROLE_ID): Set<string> {
    const resolved = acl || defaultAgentAcl();
    const role = resolved.roles.find((item) => item.roleId === roleId)
        || resolved.roles.find((item) => item.roleId === DEFAULT_AGENT_ROLE_ID);
    return new Set(role?.permissions || []);
}

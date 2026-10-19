import { BUILTIN_AGENT_ROLES, defaultAgentAcl, type AgentTeamAcl } from '../model/agent';
import { PERM, AGENT_TOOL_PERMISSION_DEFINITIONS, type AgentPermissionId } from '../model/builtin';
import { listAgentAddons } from './addons';

export { defaultAgentAcl };

export interface AgentPermissionInfo {
    id: string;
    name: string;
    family: string;
    description?: string;
    addonId?: string;
}

export const DEFAULT_AGENT_ROLE_ID = 'default';

export function addonAgentPermissionId(addonId: string, permissionId: string): string {
    return `${addonId}:${permissionId}`;
}

export function agentToolAccess(permission: AgentPermissionId) {
    const definition = AGENT_TOOL_PERMISSION_DEFINITIONS[permission];
    return {
        source: 'agent' as const,
        bindBase: 'none' as const,
        ...(definition.access === 'manage' ? { mutating: true } : {}),
        agentPermissions: [permission],
    };
}

function expandLegacyAgentPermissions(permissions: readonly string[]): string[] {
    const expanded = new Set<string>();
    for (const permission of permissions) {
        if (permission === 'agent:read' || permission === 'agent:manage') {
            for (const [permissionId, definition] of Object.entries(AGENT_TOOL_PERMISSION_DEFINITIONS) as [AgentPermissionId, typeof AGENT_TOOL_PERMISSION_DEFINITIONS[AgentPermissionId]][]) {
                if (permission === 'agent:read' && definition.access === 'read'
                    || permission === 'agent:manage' && definition.access === 'manage') {
                    expanded.add(permissionId);
                }
            }
        } else expanded.add(permission);
    }
    return [...expanded].sort();
}

export function agentPermissionCatalog(): AgentPermissionInfo[] {
    return listAgentAddons().flatMap((addon) => (addon.permissions || []).map((permission) => ({
        id: addonAgentPermissionId(addon.addonId, permission.id),
        name: permission.name,
        family: addon.displayName,
        ...(permission.description ? { description: permission.description } : {}),
        addonId: addon.addonId,
    })));
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
        return { roleId, name, permissions: expandLegacyAgentPermissions(permissions as string[]) };
    });
    const builtins = BUILTIN_AGENT_ROLES.map((role) => ({
        ...role,
        permissions: expandLegacyAgentPermissions(role.permissions),
    }));
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
    return new Set(expandLegacyAgentPermissions(role?.permissions || []));
}

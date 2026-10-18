import { useEffect, useMemo, useState } from 'react';
import { Button, Callout } from '@ejunz/ui-next';
import type { AgentTeam, AgentTeamAcl, AgentTeamRole } from '../../runtime/session';
import type { AgentAddonView } from '../types';
import { i18n } from '@/i18n';
import styles from './TeamPermissionsPanel.module.css';

interface PermissionOption {
    id: string;
    name: string;
    description?: string;
    addonId?: string;
}

interface Props {
    team: AgentTeam;
    addons: readonly AgentAddonView[];
    saving: boolean;
    onSave: (acl: AgentTeamAcl) => Promise<void>;
}

const CORE_PERMISSIONS: PermissionOption[] = [
    { id: 'agent:read', name: 'Read Agent workspace', description: 'View Agents, Teams, sessions, and their history.' },
    { id: 'agent:manage', name: 'Manage Agent workspace', description: 'Create, update, and delete Agents, Teams, and sessions.' },
];

function defaultAcl(): AgentTeamAcl {
    return {
        activeRoleId: 'default',
        roles: [{ roleId: 'default', name: 'Default', permissions: CORE_PERMISSIONS.map(({ id }) => id) }],
    };
}

function permissionCatalog(addons: readonly AgentAddonView[]): PermissionOption[] {
    return [
        ...CORE_PERMISSIONS,
        ...addons.filter((addon) => addon.installed).flatMap((addon) => (addon.permissions || []).map((permission) => ({
            id: `${addon.addonId}:${permission.id}`,
            name: permission.name,
            ...(permission.description ? { description: permission.description } : {}),
            addonId: addon.addonId,
        }))),
    ];
}

function mountedAddonIds(team: AgentTeam, addons: readonly AgentAddonView[]): Set<string> {
    return new Set(addons.filter((addon) => {
        if (!addon.installed || !addon.enabled) return false;
        return team.config?.addons === undefined ? true : team.config.addons[addon.addonId] === true;
    }).map((addon) => addon.addonId));
}

function normalizeAcl(value: AgentTeamAcl | undefined): AgentTeamAcl {
    if (!value?.roles?.length) return defaultAcl();
    const roles = value.roles.map((role) => ({
        roleId: String(role.roleId),
        name: String(role.name),
        permissions: [...new Set(Array.isArray(role.permissions) ? role.permissions : [])],
    }));
    const activeRoleId = roles.some((role) => role.roleId === value.activeRoleId) ? value.activeRoleId : roles[0].roleId;
    return { activeRoleId, roles };
}

function newRoleId(name: string, roles: AgentTeamRole[]): string {
    const base = name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z]+/, 'role-').slice(0, 24) || 'role';
    let candidate = base;
    let suffix = 2;
    while (roles.some((role) => role.roleId === candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
}

export function TeamPermissionsPanel({ team, addons, saving, onSave }: Props) {
    const initialAcl = normalizeAcl(team.config?.acl);
    const [acl, setAcl] = useState(initialAcl);
    const [newRoleName, setNewRoleName] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [dirty, setDirty] = useState(false);
    const catalog = useMemo(() => permissionCatalog(addons), [addons]);
    const mounted = useMemo(() => mountedAddonIds(team, addons), [addons, team.config?.addons, team.teamId]);
    const autoGranted = useMemo(() => new Set(catalog.filter((permission) => permission.addonId && mounted.has(permission.addonId)).map((permission) => permission.id)), [catalog, mounted]);
    const activeRole = acl.roles.find((role) => role.roleId === acl.activeRoleId) ?? acl.roles[0];

    useEffect(() => {
        setAcl(normalizeAcl(team.config?.acl));
        setDirty(false);
        setError('');
    }, [team.teamId, team.config?.acl]);

    function updateActiveRole(update: (role: AgentTeamRole) => AgentTeamRole) {
        setAcl((current) => ({
            ...current,
            roles: current.roles.map((role) => role.roleId === current.activeRoleId ? update(role) : role),
        }));
        setDirty(true);
        setNotice('');
    }

    function addRole() {
        const name = newRoleName.trim();
        if (!name) return setError(i18n('Enter a role name.'));
        if (name.length > 64) return setError(i18n('Role name must be 64 characters or fewer.'));
        const roleId = newRoleId(name, acl.roles);
        const role: AgentTeamRole = { roleId, name, permissions: [...autoGranted] };
        setAcl((current) => ({ ...current, activeRoleId: roleId, roles: [...current.roles, role] }));
        setNewRoleName('');
        setDirty(true);
        setError('');
        setNotice('');
    }

    function removeRole() {
        if (acl.roles.length <= 1 || activeRole.roleId === 'default') return;
        const roles = acl.roles.filter((role) => role.roleId !== activeRole.roleId);
        setAcl((current) => ({ ...current, activeRoleId: roles[0].roleId, roles }));
        setDirty(true);
        setNotice('');
    }

    function togglePermission(permissionId: string) {
        if (autoGranted.has(permissionId)) return;
        updateActiveRole((role) => ({
            ...role,
            permissions: role.permissions.includes(permissionId)
                ? role.permissions.filter((id) => id !== permissionId)
                : [...role.permissions, permissionId],
        }));
    }

    async function save() {
        if (saving || !dirty) return;
        setError('');
        setNotice('');
        const nextAcl: AgentTeamAcl = {
            ...acl,
            roles: acl.roles.map((role) => role.roleId === acl.activeRoleId
                ? { ...role, permissions: [...new Set([...role.permissions, ...autoGranted])].sort() }
                : role),
        };
        try {
            await onSave(nextAcl);
            setAcl(nextAcl);
            setDirty(false);
            setNotice(i18n('Agent role permissions saved.'));
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    }

    return (
        <div className={styles.panel}>
            <div className={styles.body}>
                {error ? <Callout type="error">{error}</Callout> : null}
                {notice ? <Callout type="info">{notice}</Callout> : null}
                <section className={styles.section}>
                    <div className={styles.roleHeader}>
                        <label className={styles.roleSelect}>
                            <span>{i18n('Role')}</span>
                            <select value={acl.activeRoleId} disabled={saving} onChange={(event) => {
                                setAcl((current) => ({ ...current, activeRoleId: event.target.value }));
                                setDirty(true);
                                setNotice('');
                            }}>
                                {acl.roles.map((role) => <option key={role.roleId} value={role.roleId}>{role.name}</option>)}
                            </select>
                        </label>
                        <button type="button" className={styles.removeRole} disabled={saving || acl.roles.length <= 1 || activeRole.roleId === 'default'} onClick={removeRole}>{i18n('Delete role')}</button>
                    </div>
                    <div className={styles.addRole}>
                        <input value={newRoleName} disabled={saving} onChange={(event) => setNewRoleName(event.target.value)} placeholder={i18n('New role name')} />
                        <button type="button" disabled={saving || !newRoleName.trim()} onClick={addRole}>{i18n('Add role')}</button>
                    </div>
                </section>
                <section className={styles.section}>
                    <h3>{i18n('Permissions')}</h3>
                    <p className={styles.hint}>{i18n('Mounted add-ons automatically grant their declared permissions to this Agent role.')}</p>
                    <div className={styles.permissionList}>
                        {catalog.map((permission) => {
                            const isAuto = autoGranted.has(permission.id);
                            const checked = isAuto || activeRole.permissions.includes(permission.id);
                            return <label className={styles.permission} key={permission.id}>
                                <input type="checkbox" checked={checked} disabled={saving || isAuto} onChange={() => togglePermission(permission.id)} />
                                <span className={styles.permissionCopy}>
                                    <span>{i18n(permission.name)}{isAuto ? <small>{i18n(' · Add-on mounted')}</small> : null}</span>
                                    {permission.description ? <small>{i18n(permission.description)}</small> : null}
                                </span>
                            </label>;
                        })}
                        {!catalog.length ? <span className={styles.hint}>{i18n('No Agent permissions are registered.')}</span> : null}
                    </div>
                </section>
            </div>
            <footer className={styles.footer}>
                <span className={styles.hint}>{saving ? i18n('Saving...') : dirty ? i18n('Unsaved changes') : ''}</span>
                <Button variant="primary" disabled={!dirty || saving} onClick={() => { void save(); }}>{i18n('Save permissions')}</Button>
            </footer>
        </div>
    );
}

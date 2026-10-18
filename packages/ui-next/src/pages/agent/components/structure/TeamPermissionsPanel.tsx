import { useEffect, useMemo, useState } from 'react';
import { Button, Callout } from '@ejunz/ui-next';
import type { AgentTeam, AgentTeamAcl, AgentTeamRole } from '../../runtime/session';
import type { AgentAddonView, AgentPermissionView } from '../types';
import { i18n } from '@/i18n';
import styles from './TeamPermissionsPanel.module.css';

interface Props {
    team: AgentTeam;
    teams: readonly AgentTeam[];
    addons: readonly AgentAddonView[];
    permissions: readonly AgentPermissionView[];
    section: 'roles' | 'permissions';
    saving: boolean;
    onSave: (acl: AgentTeamAcl) => Promise<void>;
}

function mountedPermissionCatalog(permissions: readonly AgentPermissionView[], mounted: ReadonlySet<string>): AgentPermissionView[] {
    return permissions.filter((permission) => !permission.addonId || mounted.has(permission.addonId));
}

function mountedAddonIds(team: AgentTeam, teams: readonly AgentTeam[], addons: readonly AgentAddonView[]): Set<string> {
    const groupTeams = teams.filter((item) => item.groupId === team.groupId);
    const scopedTeams = groupTeams.length ? groupTeams : [team];
    return new Set(addons.filter((addon) => addon.installed && addon.enabled && scopedTeams.some((item) => (
        item.config?.addons === undefined ? true : item.config.addons[addon.addonId] === true
    ))).map((addon) => addon.addonId));
}

function normalizeAcl(value: AgentTeamAcl | undefined): AgentTeamAcl {
    return {
        roles: Array.isArray(value?.roles) ? value.roles.map((role) => ({
            roleId: String(role.roleId),
            name: String(role.name),
            permissions: [...new Set(Array.isArray(role.permissions) ? role.permissions : [])],
        })) : [],
    };
}

function newRoleId(name: string, roles: AgentTeamRole[]): string {
    const base = name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z]+/, 'role-').slice(0, 24) || 'role';
    let candidate = base;
    let suffix = 2;
    while (roles.some((role) => role.roleId === candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
}

export function TeamPermissionsPanel({ team, teams, addons, permissions, section, saving, onSave }: Props) {
    const mounted = useMemo(() => mountedAddonIds(team, teams, addons), [addons, team.config?.addons, team.groupId, team.teamId, teams]);
    const catalog = useMemo(() => mountedPermissionCatalog(permissions, mounted), [mounted, permissions]);
    const permissionFamilies = useMemo(() => {
        const families = new Map<string, AgentPermissionView[]>();
        for (const permission of catalog) {
            const items = families.get(permission.family) ?? [];
            items.push(permission);
            families.set(permission.family, items);
        }
        return [...families.entries()];
    }, [catalog]);
    const [acl, setAcl] = useState(() => normalizeAcl(team.config?.acl));
    const [newRoleName, setNewRoleName] = useState('');
    const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [dirty, setDirty] = useState(false);

    useEffect(() => {
        setAcl(normalizeAcl(team.config?.acl));
        setSelectedRoleIds([]);
        setDirty(false);
        setError('');
    }, [catalog, team.teamId, team.config?.acl]);

    function addRole() {
        const name = newRoleName.trim();
        if (acl.roles.length >= 32) return setError(i18n('A Group can have at most 32 roles.'));
        if (!name) return setError(i18n('Enter a role name.'));
        if (name.length > 64) return setError(i18n('Role name must be 64 characters or fewer.'));
        const roleId = newRoleId(name, acl.roles);
        const defaultRole = acl.roles.find((role) => role.roleId === 'default');
        const role: AgentTeamRole = { roleId, name, permissions: [...(defaultRole?.permissions || [])] };
        setAcl((current) => ({ ...current, roles: [...current.roles, role] }));
        setNewRoleName('');
        setDirty(true);
        setError('');
        setNotice('');
    }

    function removeSelectedRoles() {
        const removable = selectedRoleIds.filter((roleId) => !['root', 'default', 'guest'].includes(roleId));
        if (!removable.length) {
            setError(i18n('Select at least one custom role to delete.'));
            return;
        }
        if (!window.confirm(i18n('Confirm deleting the selected roles? Agents assigned to them will inherit the Default role.'))) return;
        setAcl((current) => ({ ...current, roles: current.roles.filter((role) => !removable.includes(role.roleId)) }));
        setSelectedRoleIds([]);
        setDirty(true);
        setError('');
        setNotice('');
    }

    function toggleRoleSelection(roleId: string) {
        if (['root', 'default', 'guest'].includes(roleId)) return;
        setSelectedRoleIds((current) => current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId]);
    }

    function togglePermission(roleId: string, permissionId: string) {
        const role = acl.roles.find((item) => item.roleId === roleId);
        if (!role || roleId === 'root') return;
        setAcl((current) => ({
            ...current,
            roles: current.roles.map((item) => item.roleId !== roleId ? item : {
                ...item,
                permissions: item.permissions.includes(permissionId)
                    ? item.permissions.filter((id) => id !== permissionId)
                    : [...item.permissions, permissionId],
            }),
        }));
        setDirty(true);
        setNotice('');
    }

    async function save() {
        if (saving || !dirty) return;
        setError('');
        setNotice('');
        const nextAcl: AgentTeamAcl = {
            ...acl,
            roles: acl.roles.map((role) => ({ ...role, permissions: [...new Set(role.permissions)].sort() })),
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
                {section === 'roles' ? (
                    <section className={styles.section}>
                        <h3>{i18n('Roles')}</h3>
                        <p className={styles.hint}>{i18n('Assign a role to each Agent from the Agents tab. Agents without an assigned role use Default.')}</p>
                        <div className={styles.tableWrap}>
                            <table className={styles.permissionTable}>
                                <thead><tr><th>{i18n('Select')}</th><th>{i18n('Role')}</th><th>{i18n('Permissions')}</th></tr></thead>
                                <tbody>
                                    {acl.roles.map((role) => {
                                        const builtin = ['root', 'default', 'guest'].includes(role.roleId);
                                        return <tr key={role.roleId}>
                                            <td><input type="checkbox" checked={selectedRoleIds.includes(role.roleId)} disabled={saving || builtin} onChange={() => setSelectedRoleIds((current) => current.includes(role.roleId) ? current.filter((id) => id !== role.roleId) : [...current, role.roleId])} /></td>
                                            <td>{i18n(role.name)}{builtin ? <small> · {i18n('Built-in')}</small> : null}</td>
                                            <td>{role.roleId === 'root' ? i18n('All permissions') : role.permissions.length}</td>
                                        </tr>;
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <div className={styles.addRole}>
                            <input value={newRoleName} disabled={saving} onChange={(event) => setNewRoleName(event.target.value)} placeholder={i18n('New role name')} />
                            <button type="button" disabled={saving || !newRoleName.trim()} onClick={addRole}>{i18n('Add role')}</button>
                            <button type="button" className={styles.removeRole} disabled={saving || !selectedRoleIds.some((roleId) => !['root', 'default', 'guest'].includes(roleId))} onClick={removeSelectedRoles}>{i18n('Delete Selected Roles')}</button>
                        </div>
                    </section>
                ) : (
                    <section className={styles.section}>
                        <h3>{i18n('Permissions')}</h3>
                        <p className={styles.hint}>{i18n('Only permissions from mounted add-ons are listed. Assign each permission to a role independently.')}</p>
                        <div className={styles.tableWrap}>
                            <table className={styles.permissionTable}>
                                <thead>
                                    <tr>
                                        <th>{i18n('Permission')}</th>
                                        {acl.roles.map((role) => <th key={role.roleId}>{i18n(role.name)}</th>)}
                                    </tr>
                                </thead>
                                {permissionFamilies.map(([family, permissions]) => (
                                    <tbody key={family}>
                                        <tr className={styles.familyRow}><th colSpan={acl.roles.length + 1}>{i18n(family)}</th></tr>
                                        {permissions.map((permission) => (
                                            <tr key={permission.id}>
                                                <td>
                                                    <span>{i18n(permission.name)}</span>
                                                    {permission.description ? <small>{i18n(permission.description)}</small> : null}
                                                </td>
                                                {acl.roles.map((role) => {
                                                    const isRoot = role.roleId === 'root';
                                                    const checked = isRoot || role.permissions.includes(permission.id);
                                                    return <td key={role.roleId}>
                                                        <input
                                                            type="checkbox"
                                                            aria-label={`${role.name}: ${permission.name}`}
                                                            checked={checked}
                                                            disabled={saving || isRoot}
                                                            onChange={() => togglePermission(role.roleId, permission.id)}
                                                        />
                                                    </td>;
                                                })}
                                            </tr>
                                        ))}
                                    </tbody>
                                ))}
                            </table>
                        </div>
                        {!catalog.length ? <span className={styles.hint}>{i18n('No Agent permissions are registered.')}</span> : null}
                    </section>
                )}
            </div>
            <footer className={styles.footer}>
                <span className={styles.hint}>{saving ? i18n('Saving...') : dirty ? i18n('Unsaved changes') : ''}</span>
                <Button variant="primary" disabled={!dirty || saving} onClick={() => { void save(); }}>{section === 'roles' ? i18n('Save role') : i18n('Save permissions')}</Button>
            </footer>
        </div>
    );
}

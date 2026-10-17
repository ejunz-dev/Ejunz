import { Button, Card, Callout } from '../components';
import { usePageData } from '../context/page-data';
import { i18n } from '../i18n';
import { DomainManageLayout } from './domain-manage-layout';
import './domain_permission.css';

interface Role {
  _id: string;
  perm?: string | number;
}

interface Permission {
  key: string | number;
  desc: string;
}

function asBigInt(value: string | number | undefined): bigint {
  return BigInt(String(value ?? 0).replace(/^BigInt::/, ''));
}

function hasPermission(role: Role, key: Permission['key']): boolean {
  try {
    return (asBigInt(role.perm) & asBigInt(key)) !== 0n;
  } catch {
    return false;
  }
}

function permissionIndex(key: Permission['key']): number {
  let value = asBigInt(key);
  let index = 0;
  while (value > 1n) {
    value >>= 1n;
    index++;
  }
  return index;
}

export default function DomainPermission() {
  const { args } = usePageData();
  const roles = Array.isArray(args.roles) ? args.roles as Role[] : [];
  const permissions = args.PERMS_BY_FAMILY;
  const families: [string, Permission[]][] = Array.isArray(permissions)
    ? permissions as [string, Permission[]][]
    : permissions && typeof permissions === 'object'
      ? Object.entries(permissions as Record<string, Permission[]>).filter((entry) => Array.isArray(entry[1]))
      : [];
  return (
    <DomainManageLayout>
      <div className="uix-domain-permission">
        {roles.length === 3 ? (
          <Callout type="warn">
            {i18n("The 'default' role applies to ALL REGISTERED USER. You may want to create a new role in 'Manage Role' page.")}
          </Callout>
        ) : null}
        <Card title={i18n('Permissions')}>
          <form method="post" action={window.location.href}>
            <div className="uix-domain-permission__table-wrap">
              <table className="uix-domain-permission__table">
                <thead>
                  <tr><th>{i18n('Permissions')}</th>{roles.map((role) => <th key={role._id} title={role._id}>{role._id}</th>)}</tr>
                </thead>
                {families.map(([family, permissions]) => (
                  <tbody key={family}>
                    <tr className="uix-domain-permission__family"><th colSpan={roles.length + 1}>{i18n(family)}</th></tr>
                    {permissions.map((permission) => (
                      <tr key={String(permission.key)}>
                        <td>{i18n(permission.desc)}</td>
                        {roles.map((role) => (
                          <td key={role._id}>
                            <input
                              type="checkbox"
                              name={role._id}
                              value={permissionIndex(permission.key)}
                              defaultChecked={hasPermission(role, permission.key)}
                              disabled={role._id === 'root'}
                              aria-label={`${role._id}: ${i18n(permission.desc)}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                    <tr className="uix-domain-permission__sentinel" aria-hidden>
                      <td />
                      {roles.map((role) => <td key={role._id}><input type="checkbox" name={role._id} value="1000" defaultChecked disabled={role._id === 'root'} tabIndex={-1} /></td>)}
                    </tr>
                  </tbody>
                ))}
              </table>
            </div>
            <div className="uix-domain-permission__actions"><Button type="submit" variant="primary">{i18n('Update Permission')}</Button></div>
          </form>
        </Card>
      </div>
    </DomainManageLayout>
  );
}

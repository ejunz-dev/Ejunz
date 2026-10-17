import { useState, type FormEvent } from 'react';
import { Button, Card, Callout } from '../components';
import { usePageData } from '../context/page-data';
import { i18n } from '../i18n';
import { DomainManageLayout } from './domain-manage-layout';
import './domain_role.css';

interface Role {
  _id: string;
  count?: number;
  perm?: string | number;
}

export default function DomainRole() {
  const { args } = usePageData();
  const roles = Array.isArray(args.roles) ? args.roles as Role[] : [];
  const [selected, setSelected] = useState<string[]>([]);
  const [roleName, setRoleName] = useState('');
  const [error, setError] = useState('');
  const builtins = new Set(['root', 'default', 'guest']);

  function toggleRole(role: string) {
    setSelected((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role]);
  }

  function confirmDelete(event: FormEvent<HTMLFormElement>) {
    if (!selected.length) {
      event.preventDefault();
      setError(i18n('Please select at least one role to perform this operation.'));
      return;
    }
    if (!window.confirm(i18n('Confirm deleting the selected roles? Users with those roles will be removed from the domain.'))) event.preventDefault();
  }

  return (
    <DomainManageLayout>
      <div className="uix-domain-role">
        {error ? <Callout type="warn">{error}</Callout> : null}
        <Card title={i18n('Roles')}>
          <form method="post" action={window.location.href} className="uix-domain-role__create">
            <input type="hidden" name="operation" value="add" />
            <label className="uix-domain-role__field">
              <span>{i18n('Role name')}</span>
              <input className="uix-domain-role__input" name="role" value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder={i18n('Role name')} />
            </label>
            <Button type="submit" variant="primary" disabled={!roleName.trim()}>{i18n('Create Role')}</Button>
          </form>
          <p className="uix-domain-role__hint">{i18n('Role name can only contains numbers, letters and underscores.')}</p>
          <form method="post" action={window.location.href} onSubmit={confirmDelete}>
            <input type="hidden" name="operation" value="delete" />
            <div className="uix-domain-role__table-wrap">
              <table className="uix-domain-role__table">
                <thead><tr><th>{i18n('Select')}</th><th>{i18n('Role')}</th><th>{i18n('Users')}</th></tr></thead>
                <tbody>
                  {roles.map((role) => {
                    const builtin = builtins.has(role._id);
                    return (
                      <tr key={role._id}>
                        <td><input type="checkbox" name="roles" value={role._id} checked={selected.includes(role._id)} disabled={builtin} onChange={() => toggleRole(role._id)} /></td>
                        <td>{i18n(builtin ? 'Built-in' : 'User-defined role')}: <code>{role._id}</code></td>
                        <td>{role.count ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="uix-domain-role__actions"><Button type="submit">{i18n('Delete Selected Roles')}</Button></div>
          </form>
        </Card>
      </div>
    </DomainManageLayout>
  );
}

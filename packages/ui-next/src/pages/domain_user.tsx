import { useMemo, useState } from 'react';
import { Button, Card, Callout } from '../components';
import { usePageData, useUserContext } from '../context/page-data';
import { i18n } from '../i18n';
import { DomainManageLayout } from './domain-manage-layout';
import './domain_user.css';

interface User {
  _id: number;
  uname?: string;
  avatarUrl?: string;
  role: string;
  join?: boolean;
}

interface Role {
  _id: string;
}

export default function DomainUser() {
  const { args } = usePageData();
  const currentUser = useUserContext();
  const roles = Array.isArray(args.roles) ? args.roles as Role[] : [];
  const roleNames = roles.map((role) => role._id).filter((role) => role !== 'guest');
  const groups = args.rudocs && typeof args.rudocs === 'object' ? args.rudocs as Record<string, User[]> : {};
  const [selected, setSelected] = useState<number[]>([]);
  const [assignRole, setAssignRole] = useState(roleNames.find((role) => role !== 'root') || 'default');
  const [newUids, setNewUids] = useState('');
  const [error, setError] = useState('');
  const canForceJoin = Boolean(args.canForceJoin);
  const users = useMemo(() => Object.entries(groups).flatMap(([role, items]) => (Array.isArray(items) ? items : []).map((item) => ({ ...item, role: item.role || role }))), [groups]);

  function toggle(uid: number) {
    setSelected((current) => current.includes(uid) ? current.filter((item) => item !== uid) : [...current, uid]);
  }

  const parsedNewUids = [...new Set(newUids.split(/[\s,;]+/).map((id) => Number(id.trim())).filter((id) => Number.isSafeInteger(id) && id > 0))];

  return (
    <DomainManageLayout>
      <div className="uix-domain-user">
        {error ? <Callout type="warn">{error}</Callout> : null}
        <Card title={i18n('Users')}>
          <form method="post" action={window.location.href} className="uix-domain-user__new-form">
            <input type="hidden" name="operation" value="set_users" />
            <input type="hidden" name="role" value={assignRole} />
            {parsedNewUids.map((uid) => <input key={uid} type="hidden" name="uids" value={uid} />)}
            {canForceJoin ? <input type="hidden" name="join" value="true" /> : null}
            <label className="uix-domain-user__field">
              <span>{i18n('Add User IDs')}</span>
              <input className="uix-domain-user__input" value={newUids} onChange={(event) => setNewUids(event.target.value)} placeholder={i18n('Enter user IDs separated by commas')} />
            </label>
            <label className="uix-domain-user__field">
              <span>{i18n('Role')}</span>
              <select className="uix-domain-user__input" value={assignRole} onChange={(event) => setAssignRole(event.target.value)}>
                {roleNames.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
            {canForceJoin ? <span className="uix-domain-user__hint">{i18n('Added users will be joined to this domain.')}</span> : null}
            <Button type="submit" variant="primary" disabled={!parsedNewUids.length}>{i18n('Add User')}</Button>
          </form>
          <form method="post" action={window.location.href} onSubmit={(event) => {
            setError('');
            const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            if (!selected.length) {
              event.preventDefault();
              setError(i18n('Please select at least one user to perform this operation.'));
            } else if (submitter?.value === 'kick' && !window.confirm(i18n('Confirm removing the selected users? Their account will not be deleted and they will be with the default role.'))) {
              event.preventDefault();
            }
          }}>
            <div className="uix-domain-user__table-wrap">
              <table className="uix-domain-user__table">
                <thead><tr><th>{i18n('Select')}</th><th>{i18n('User ID')}</th><th>{i18n('Username')}</th><th>{i18n('Role')}</th><th>{i18n('Status')}</th></tr></thead>
                {Object.entries(groups).map(([role, members]) => (
                  <tbody key={role}>
                    <tr className="uix-domain-user__group"><th colSpan={5}>{role}</th></tr>
                    {(Array.isArray(members) ? members : []).map((member) => {
                      const isSelf = Number(member._id) === Number(currentUser._id);
                      return (
                        <tr key={member._id}>
                          <td><input type="checkbox" name="uids" value={member._id} checked={selected.includes(Number(member._id))} disabled={isSelf} onChange={() => toggle(Number(member._id))} /></td>
                          <td>{member._id}</td>
                          <td>{member.uname || `#${member._id}`}</td>
                          <td>{member.role || role}</td>
                          <td>{member.join ? i18n('Joined') : i18n('Not joined yet')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
            <div className="uix-domain-user__actions">
              <select className="uix-domain-user__input" name="role" value={assignRole} onChange={(event) => setAssignRole(event.target.value)} aria-label={i18n('Role')}>
                {roleNames.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <button type="submit" name="operation" value="set_users" className="uix-button uix-domain-user__submit">{i18n('Set Roles for Selected User')}</button>
              <button type="submit" name="operation" value="kick" className="uix-button">{i18n('Remove Selected User')}</button>
            </div>
          </form>
        </Card>
      </div>
    </DomainManageLayout>
  );
}

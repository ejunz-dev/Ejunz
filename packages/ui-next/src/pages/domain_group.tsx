import { useState } from 'react';
import { Button, Card, Callout } from '../components';
import { usePageData, useUiContext } from '../context/page-data';
import { i18n } from '../i18n';
import { DomainManageLayout } from './domain-manage-layout';
import './domain_group.css';

interface DomainGroup {
  name: string;
  uids: number[];
}

function prefixOf(domainId: string): string {
  return `/d/${encodeURIComponent(domainId)}`;
}

function parseUids(value: string): number[] {
  return [...new Set(value.split(/[\s,;]+/).map((part) => Number(part.trim())).filter((uid) => Number.isSafeInteger(uid) && uid > 0))];
}

export default function DomainGroup() {
  const { args } = usePageData();
  const { domainId } = useUiContext();
  const initialGroups = Array.isArray(args.groups) ? args.groups as DomainGroup[] : [];
  const [groups, setGroups] = useState(() => initialGroups.map((group) => ({ ...group, uids: group.uids || [] })));
  const [selected, setSelected] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [newUids, setNewUids] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const prefix = prefixOf(String(domainId || 'system'));

  async function mutate(name: string, uids?: number[]) {
    const response = await fetch(`${prefix}/api/domain.group`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { name, ...(uids?.length ? { uids } : {}) }, projection: [] }),
    });
    if (!response.ok) throw new Error(`${i18n('Request failed')}: ${response.status}`);
    const result = await response.json() as { error?: string };
    if (result.error) throw new Error(result.error);
  }

  async function createGroup() {
    const name = newName.trim();
    if (!name) return setError(i18n('Please enter a group name.'));
    if (!parseUids(newUids).length) return setError(i18n('Please select at least one user.'));
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await mutate(name, parseUids(newUids));
      setGroups((current) => [...current.filter((group) => group.name !== name), { name, uids: parseUids(newUids) }]);
      setNewName('');
      setNewUids('');
      setNotice(i18n('Saved.'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function saveGroups() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      for (const group of groups) await mutate(group.name, group.uids);
      setGroups((current) => current.filter((group) => group.uids.length > 0));
      setNotice(i18n('Saved.'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroups() {
    if (!selected.length) return setError(i18n('Please select at least one group to perform this operation.'));
    if (!window.confirm(i18n('Confirm deleting the selected groups?'))) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      for (const name of selected) await mutate(name);
      setGroups((current) => current.filter((group) => !selected.includes(group.name)));
      setSelected([]);
      setNotice(i18n('Selected groups have been deleted.'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  function setGroupUids(name: string, value: string) {
    const uids = parseUids(value);
    setGroups((current) => current.map((group) => group.name === name ? { ...group, uids } : group));
  }

  return (
    <DomainManageLayout>
      <div className="uix-domain-group">
        {error ? <Callout type="error">{error}</Callout> : null}
        {notice ? <Callout type="info">{notice}</Callout> : null}
        <Card title={i18n('Groups')}>
          <div className="uix-domain-group__create">
            <label><span>{i18n('Group Name')}</span><input className="uix-domain-group__input" value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
            <label><span>{i18n('Users (IDs)')}</span><input className="uix-domain-group__input" value={newUids} onChange={(event) => setNewUids(event.target.value)} placeholder={i18n('Enter user IDs separated by commas')} /></label>
            <Button variant="primary" disabled={busy || !newName.trim()} onClick={() => { void createGroup(); }}>{i18n('Create Group')}</Button>
          </div>
          <div className="uix-domain-group__table-wrap">
            <table className="uix-domain-group__table">
              <thead><tr><th>{i18n('Select')}</th><th>{i18n('Group Name')}</th><th>{i18n('Users (IDs)')}</th></tr></thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.name}>
                    <td><input type="checkbox" checked={selected.includes(group.name)} onChange={() => setSelected((current) => current.includes(group.name) ? current.filter((name) => name !== group.name) : [...current, group.name])} /></td>
                    <td>{group.name}</td>
                    <td><input className="uix-domain-group__input" aria-label={`${i18n('Users')} ${group.name}`} defaultValue={group.uids.join(', ')} onChange={(event) => setGroupUids(group.name, event.target.value)} /></td>
                  </tr>
                ))}
                {!groups.length ? <tr><td colSpan={3} className="uix-domain-group__empty">{i18n('No groups')}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="uix-domain-group__actions">
            <Button disabled={busy || !selected.length} onClick={() => { void deleteGroups(); }}>{i18n('Remove Selected Group')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => { void saveGroups(); }}>{i18n('Save All Changes')}</Button>
          </div>
        </Card>
      </div>
    </DomainManageLayout>
  );
}

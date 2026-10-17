import { useMemo, useState } from 'react';
import { Button, Card, Callout } from '../components';
import { usePageData, useUiContext } from '../context/page-data';
import { i18n } from '../i18n';
import { DomainManageLayout } from './domain-manage-layout';
import './domain_join_applications.css';

interface JoinSettings {
  method?: number;
  role?: string;
  group?: string;
  expire?: string | number | Date | null;
  code?: string;
}

export default function DomainJoinApplications() {
  const { args } = usePageData();
  const ui = useUiContext();
  const settings = (args.joinSettings || null) as JoinSettings | null;
  const roles = Array.isArray(args.rolesWithText) ? args.rolesWithText as [string, string][] : [];
  const expirations = args.expirations && typeof args.expirations === 'object' ? Object.entries(args.expirations as Record<string, string>) : [];
  const [method, setMethod] = useState(Number(settings?.method ?? 0));
  const defaultExpire = expirations.some(([value]) => value === '0') ? '0' : expirations[0]?.[0] || '';
  const joinUrl = useMemo(() => {
    const prefix = String(args.url_prefix || window.location.origin + '/');
    return `${prefix}d/${encodeURIComponent(String(ui.domainId || 'system'))}/domain/join`;
  }, [args.url_prefix, ui.domainId]);

  return (
    <DomainManageLayout>
      <div className="uix-domain-join-applications">
        {settings ? (
          <Card title={i18n('Information')}>
            <p>{i18n('User can join this domain by visiting the following URL')}:</p>
            <code className="uix-domain-join-applications__url">{joinUrl}</code>
            {settings.method === 2 && settings.code ? <><p>{i18n('Or, with automatically filled invitation code')}:</p><code className="uix-domain-join-applications__url">{joinUrl}?code={encodeURIComponent(settings.code)}</code></> : null}
            {settings.expire ? <p>{i18n('The link will expire at {0}', new Date(settings.expire).toLocaleString())}</p> : null}
          </Card>
        ) : null}
        {roles.length <= 1 ? <Callout type="warn">{i18n("The 'default' role applies to ALL REGISTERED USER. You may want to create a new role in 'Manage Role' page.")}</Callout> : null}
        <Card title={i18n('Settings')}>
          <form method="post" action={window.location.href} className="uix-domain-join-applications__form">
            <label className="uix-domain-join-applications__field">
              <span>{i18n('Method')}</span>
              <select className="uix-domain-join-applications__input" name="method" value={method} onChange={(event) => setMethod(Number(event.target.value))}>
                <option value={0}>{i18n('No user is allowed to join this domain')}</option>
                <option value={1}>{i18n('Any user is allowed to join this domain')}</option>
                <option value={2}>{i18n('Any user is allowed to join this domain with an invitation code')}</option>
              </select>
            </label>
            <label className="uix-domain-join-applications__field">
              <span>{i18n('Role Assignment')}</span>
              <select className="uix-domain-join-applications__input" name="role" defaultValue={settings?.role || roles[0]?.[0] || ''} disabled={method === 0}>
                {roles.map(([value, label]) => <option key={value} value={value}>{i18n(label)}</option>)}
              </select>
              <small>{i18n('The role to assign when user joining the domain.')}</small>
            </label>
            <label className="uix-domain-join-applications__field">
              <span>{i18n('Expire')}</span>
              <select className="uix-domain-join-applications__input" name="expire" defaultValue={defaultExpire} disabled={method === 0}>
                {expirations.map(([value, label]) => <option key={value} value={value}>{i18n(label)}</option>)}
              </select>
              <small>{i18n('User will no longer be allowed to join the domain after expiration.')}</small>
            </label>
            <label className="uix-domain-join-applications__field">
              <span>{i18n('Invitation Code')}</span>
              <input className="uix-domain-join-applications__input" name="invitationCode" defaultValue={settings?.code || ''} disabled={method !== 2} />
              <small>{i18n('The invitation code must contain only letters and numbers and be no longer than 64 characters.')}</small>
            </label>
            <div><Button type="submit" variant="primary">{i18n('Update Settings')}</Button></div>
          </form>
        </Card>
      </div>
    </DomainManageLayout>
  );
}

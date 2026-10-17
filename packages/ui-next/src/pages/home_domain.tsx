import { useState } from 'react';
import { Button, Card, Link } from '../components';
import { usePageData, useUserContext } from '../context/page-data';
import { useBuildUrl } from '../hooks/use-build-url';
import { i18n } from '../i18n';
import './home_domain.css';

interface Domain {
  _id: string;
  name?: string;
  avatarUrl?: string;
  owner?: number | string;
}

export default function HomeDomain() {
  const { args } = usePageData();
  const user = useUserContext();
  const buildUrl = useBuildUrl();
  const [busy, setBusy] = useState<string | null>(null);
  const domains = Array.isArray(args.ddocs) ? args.ddocs as Domain[] : [];
  const roles = args.role || {};
  const canManage = args.canManage || {};
  const [pinnedDomains, setPinnedDomains] = useState(() => new Set<string>(Array.isArray(args.pinnedDomains) ? args.pinnedDomains : []));

  async function submitOperation(domainId: string, operation: 'star' | 'unstar' | 'leave') {
    if (busy) return;
    setBusy(domainId);
    const form = new URLSearchParams({ operation, id: domainId });
    if (operation === 'star' || operation === 'unstar') form.set('star', String(operation === 'star'));
    try {
      const response = await fetch(buildUrl('home_domain'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      if (operation === 'leave') window.location.reload();
      else setPinnedDomains((current) => {
        const next = new Set(current);
        if (operation === 'star') next.add(domainId);
        else next.delete(domainId);
        return next;
      });
    } catch (error) {
      console.error('[Ejunz] Failed to update domain membership:', error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="uix-home-domain">
      <Card title={i18n('My Domains')}>
        <div className="uix-home-domain__tools">
          {args.canCreate ? <Button to="home_domain_create" variant="primary">＋ {i18n('Create Domain')}</Button> : null}
          {args.canJoin ? <Button to="domain_join">＋ {i18n('Join Domain')}</Button> : null}
          <Link href={buildUrl('wiki_help', {}, { anchor: 'domain' })} className="uix-home-domain__help">ⓘ {i18n("What's domain?")}</Link>
        </div>
        <div className="uix-home-domain__table-wrap">
          <table className="uix-home-domain__table">
            <thead>
              <tr>
                <th className="uix-home-domain__icon" aria-label={i18n('Avatar')} />
                <th>{i18n('Name')} ({i18n('ID')})</th>
                <th className="uix-home-domain__role">{i18n('My Role')}</th>
                <th>{i18n('Action')}</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((domain) => {
                const id = String(domain._id);
                const pinned = pinnedDomains.has(id);
                const visitHref = id === 'system' ? '/' : buildUrl('homepage', { domainId: id });
                const manageHref = id === 'system' ? buildUrl('domain_dashboard') : buildUrl('domain_dashboard', { domainId: id });
                return (
                  <tr key={id}>
                    <td className="uix-home-domain__icon"><img src={domain.avatarUrl || '/img/team_avatar.png'} alt="" width="32" height="32" /></td>
                    <td className="uix-home-domain__name">
                      <button
                        className={`uix-home-domain__pin${pinned ? ' is-pinned' : ''}`}
                        type="button"
                        aria-label={pinned ? i18n('Unpin') : i18n('Pin')}
                        title={pinned ? i18n('Unpin') : i18n('Pin')}
                        disabled={busy === id}
                        onClick={() => void submitOperation(id, pinned ? 'unstar' : 'star')}
                      >★</button>
                      <span>{domain.name || id} <span className="uix-home-domain__id">({id})</span></span>
                    </td>
                    <td className="uix-home-domain__role">{roles[id] || 'default'}</td>
                    <td className="uix-home-domain__actions">
                      <a href={visitHref}>{i18n('Visit')}</a>
                      {canManage[id] ? <><span aria-hidden> · </span><a href={manageHref}>{i18n('Manage')}</a></> : null}
                      {id !== 'system' && String(domain.owner) !== String(user._id) ? (
                        <><span aria-hidden> · </span><button type="button" disabled={busy === id} onClick={() => void submitOperation(id, 'leave')}>{i18n('Leave')}</button></>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {!domains.length ? <tr><td colSpan={4} className="uix-home-domain__empty">{i18n('No domains')}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from '../link';
import { usePageData, useUiContext, useUserContext } from '../../context/page-data';
import { useBuildUrl } from '../../hooks/use-build-url';
import './navigation.css';

interface DomainItem {
  _id?: string;
  name?: string;
  avatar?: string;
  avatarUrl?: string;
}

const navItems = [
  ['homepage', 'Home', 'homepage'],
  ['learn', 'Learn', 'learn'],
  ['develop', 'Develop', 'develop'],
  ['base_domain', 'Bases', 'base'],
  ['agent_domain', 'Agents', 'agent'],
  ['session_domain', 'Sessions', 'session'],
  ['record_main', 'Records', 'record'],
  ['discussion_main', 'Discussions', 'discussion'],
] as const;

function avatarUrl(domain: DomainItem | null | undefined): string {
  return domain?.avatarUrl || domain?.avatar || '/img/team_avatar.png';
}

function isGuest(user: Record<string, any>): boolean {
  return !user || user._id == null || user._id === 0 || user._id === '0';
}

function activeFor(name: string, prefix: string, pageName: string, template: string): boolean {
  const page = template.replace(/\.html$/, '') || pageName;
  return page === name || page.startsWith(prefix);
}

function HamburgerIcon({ active = false }: { active?: boolean }) {
  return (
    <span className={`uix-hamburger${active ? ' is-active' : ''}`} aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const buildUrl = useBuildUrl();
  const logout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(buildUrl('user_logout'), { method: 'POST', credentials: 'same-origin' });
      if (response.redirected) window.location.href = response.url;
      else window.location.reload();
    } catch {
      window.location.href = buildUrl('user_logout');
    }
  };
  return <button type="button" className="uix-nav__menu-link" onClick={() => void logout()} disabled={busy}>{busy ? 'Logging out…' : 'Logout'}</button>;
}

function UserMenu({ user, domain }: { user: Record<string, any>; domain: DomainItem | null }) {
  const [open, setOpen] = useState(false);
  const buildUrl = useBuildUrl();
  const uid = String(user._id);
  return (
    <div
      className="uix-nav__menu-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button type="button" className="uix-nav__user" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <img src={user.avatarUrl || user.avatar || '/img/avatar.png'} alt="" />
        <span>{user.uname || `#${uid}`}</span><span aria-hidden>⌄</span>
      </button>
      <div className={`uix-nav__menu${open ? ' is-open' : ''}`} role="menu" aria-hidden={!open}>
        <Link href={buildUrl('user_detail', { uid })} className="uix-nav__menu-link">My Profile</Link>
        <Link to="home_messages" className="uix-nav__menu-link">Messages</Link>
        <div className="uix-nav__menu-separator" />
        <Link to="home_settings" params={{ category: 'domain' }} className="uix-nav__menu-link">@ {domain?.name || 'Domain'}</Link>
        <Link to="home_settings" params={{ category: 'account' }} className="uix-nav__menu-link">Account settings</Link>
        <Link to="home_settings" params={{ category: 'preference' }} className="uix-nav__menu-link">Preferences</Link>
        <Link to="home_security" className="uix-nav__menu-link">Security</Link>
        <Link to="home_domain" className="uix-nav__menu-link">My Domains</Link>
        {user.priv != null && user.priv !== 0 ? <Link to="home_files" className="uix-nav__menu-link">My Files</Link> : null}
        <div className="uix-nav__menu-separator" />
        <LogoutButton />
      </div>
    </div>
  );
}

function DomainMenu({ current, domains, mobile = false, onClose }: { current: string; domains: DomainItem[]; mobile?: boolean; onClose?: () => void }) {
  const buildUrl = useBuildUrl();
  return (
    <div className={`uix-domain-menu${mobile ? ' uix-domain-menu--mobile' : ''}`}>
      <div className="uix-domain-menu__title">Joined domains</div>
      <div className="uix-domain-menu__list">
        {domains.map((domain) => {
          const id = String(domain._id || 'system');
          const href = id === 'system' ? '/' : buildUrl('homepage', { domainId: id });
          return <a key={id} href={href} className={`uix-domain-menu__item${id === current ? ' is-active' : ''}`} onClick={onClose}><img src={avatarUrl(domain)} alt="" /><span>{domain.name || id}{domain.name && domain.name !== id ? ` (${id})` : ''}</span></a>;
        })}
      </div>
      <Link to="home_domain" className="uix-domain-menu__footer" onClick={onClose}>⚙ My Domains</Link>
    </div>
  );
}

export function Navigation() {
  const { name, template } = usePageData();
  const ui = useUiContext();
  const user = useUserContext();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [domainsOpen, setDomainsOpen] = useState(false);
  const guest = isGuest(user);
  const currentDomain = String(ui.domainId || 'system');
  const domains = useMemo(() => {
    const items = user.joinedDomains || user.domains || ui.joinedDomains || [];
    return Array.isArray(items) ? items : [];
  }, [ui.joinedDomains, user.domains, user.joinedDomains]);

  useEffect(() => {
    if (!mobileOpen && !domainsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMobileOpen(false); setDomainsOpen(false); } };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [domainsOpen, mobileOpen]);

  const closeDrawers = () => { setMobileOpen(false); setDomainsOpen(false); };

  return (
    <>
      <nav className="uix-nav" aria-label="Main navigation">
        <div className="uix-nav__inner">
          <a className="uix-nav__logo" href="/" aria-label="Ejunz"><img src="/components/navigation/nav-logo-small_dark.png" alt="Ejunz" /></a>
          <div className="uix-nav__main">
            {navItems.map(([route, label, prefix]) => (
              <Link key={route} to={route} className={`uix-nav__item${activeFor(route, prefix, name, template) ? ' is-active' : ''}`}>{label}</Link>
            ))}
          </div>
          <div className="uix-nav__secondary">
            {guest ? <><Link to="user_login" className="uix-nav__item">Login</Link><Link to="user_register" className="uix-nav__signup">Sign Up</Link><span className="uix-nav__badge">GUEST</span></> : <><div className="uix-nav__domain-wrap" onMouseEnter={() => setDomainsOpen(true)} onMouseLeave={() => setDomainsOpen(false)}><button type="button" className="uix-nav__domain" onClick={() => setDomainsOpen((value) => !value)} aria-expanded={domainsOpen}><img src={avatarUrl(ui.domain)} alt="" />{ui.domain?.name || currentDomain}<span>⌄</span></button><div className={`uix-domain-menu${domainsOpen ? ' is-open' : ''}`}><DomainMenu current={currentDomain} domains={domains} onClose={() => setDomainsOpen(false)} /></div></div><UserMenu user={user} domain={ui.domain} /></>}
          </div>
          <button type="button" className="uix-nav__mobile-button" onClick={() => { setDomainsOpen(false); setMobileOpen((open) => !open); }} aria-label="Open navigation" aria-expanded={mobileOpen}><HamburgerIcon active={mobileOpen} /></button>
        </div>
      </nav>
      <div className="uix-mobile-header"><button type="button" onClick={() => { setMobileOpen(false); setDomainsOpen((open) => !open); }} aria-label="Open domains" aria-expanded={domainsOpen}><HamburgerIcon active={domainsOpen} /></button><a href="/"><img src="/components/navigation/nav-logo-small_dark.png" alt="Ejunz" /></a><button type="button" onClick={() => { setDomainsOpen(false); setMobileOpen((open) => !open); }} aria-label="Open navigation" aria-expanded={mobileOpen}><HamburgerIcon active={mobileOpen} /></button></div>
      {(mobileOpen || domainsOpen) ? <button type="button" className="uix-shell-backdrop" onClick={closeDrawers} aria-label="Close navigation" /> : null}
      {mobileOpen ? <aside className="uix-mobile-menu"><button type="button" className="uix-mobile-menu__close" onClick={() => setMobileOpen(false)} aria-label="Close">×</button><div className="uix-mobile-menu__links">{navItems.map(([route, label, prefix]) => <Link key={route} to={route} onClick={() => setMobileOpen(false)} className={`uix-nav__item${activeFor(route, prefix, name, template) ? ' is-active' : ''}`}>{label}</Link>)}{guest ? <><Link to="user_login" onClick={() => setMobileOpen(false)} className="uix-nav__item">Login</Link><Link to="user_register" onClick={() => setMobileOpen(false)} className="uix-nav__item">Sign Up</Link></> : <UserMenu user={user} domain={ui.domain} />}</div></aside> : null}
      {domainsOpen && !guest ? <aside className="uix-domain-drawer"><DomainMenu current={currentDomain} domains={domains} mobile onClose={() => setDomainsOpen(false)} /></aside> : null}
    </>
  );
}

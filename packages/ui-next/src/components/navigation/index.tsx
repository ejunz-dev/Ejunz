import { useEffect, useMemo, useState } from 'react';
import navLogo from './nav-logo-small_dark.png';
import { Link } from '../link';
import { usePageData, useUiContext, useUserContext } from '../../context/page-data';
import { useBuildUrl } from '../../hooks/use-build-url';
import { i18n } from '../../i18n';
import './navigation.css';

interface DomainItem {
  _id?: string;
  name?: string;
  avatar?: string;
  avatarUrl?: string;
}

interface NavItem {
  name: string;
  displayName?: string;
  args?: Record<string, string>;
  prefix?: string;
}

function avatarUrl(domain: DomainItem | null | undefined): string {
  return domain?.avatarUrl || '';
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
  return <button type="button" className="uix-nav__menu-link" onClick={() => void logout()} disabled={busy}>{busy ? i18n('Logging out…') : i18n('Logout')}</button>;
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
        <Link href={buildUrl('user_detail', { uid })} className="uix-nav__menu-link">{i18n('My Profile')}</Link>
        <Link to="home_messages" className="uix-nav__menu-link">{i18n('home_messages')}</Link>
        <div className="uix-nav__menu-separator" />
        <Link to="home_settings" params={{ category: 'domain' }} className="uix-nav__menu-link">@ {domain?.name || i18n('Domain')}</Link>
        <Link to="home_settings" params={{ category: 'account' }} className="uix-nav__menu-link">{i18n('home_account')}</Link>
        <Link to="home_settings" params={{ category: 'preference' }} className="uix-nav__menu-link">{i18n('home_preference')}</Link>
        <Link to="home_security" className="uix-nav__menu-link">{i18n('home_security')}</Link>
        <Link to="home_domain" className="uix-nav__menu-link">{i18n('home_domain')}</Link>
        {user.priv != null && user.priv !== 0 ? <Link to="home_files" className="uix-nav__menu-link">{i18n('home_files')}</Link> : null}
        <div className="uix-nav__menu-separator" />
        <LogoutButton />
      </div>
    </div>
  );
}

function DomainMenu({ current, domains, mobile = false, inline = false, onClose, targetRoute = 'homepage' }: { current: string; domains: DomainItem[]; mobile?: boolean; inline?: boolean; onClose?: () => void; targetRoute?: string }) {
  const buildUrl = useBuildUrl();
  return (
    <div className={`${inline ? 'uix-domain-menu__panel' : 'uix-domain-menu'}${mobile ? ' uix-domain-menu--mobile' : ''}`}>
      <div className="uix-domain-menu__title">{i18n('home_domain')}</div>
      <div className="uix-domain-menu__list">
        {domains.map((domain) => {
          const id = String(domain._id || 'system');
          const href = buildUrl(targetRoute, { domainId: id });
          return <a key={id} href={href} className={`uix-domain-menu__item${id === current ? ' is-active' : ''}`} onClick={onClose}><img src={avatarUrl(domain)} alt="" /><span>{domain.name || id}{domain.name && domain.name !== id ? ` (${id})` : ''}</span></a>;
        })}
      </div>
      <Link to="home_domain" className="uix-domain-menu__footer" onClick={onClose}>⚙ {i18n('home_domain')}</Link>
    </div>
  );
}

export function Navigation() {
  const { name, template } = usePageData();
  const ui = useUiContext();
  const pageRoute = typeof template === 'string' ? template.replace(/\.html$/, '') : name;
  const domainTargetRoute = pageRoute === 'ejunz_agent' ? 'ejunz_agent' : 'homepage';
  const user = useUserContext();
  const navItems = Array.isArray(ui.navItems) ? ui.navItems as NavItem[] : [];
  const [mobileOpen, setMobileOpen] = useState(false);
  const [domainsOpen, setDomainsOpen] = useState(false);
  const [mobileDomainsOpen, setMobileDomainsOpen] = useState(false);
  const guest = isGuest(user);
  const currentDomain = String(ui.domainId || 'system');
  const domains = useMemo(() => {
    const items = ui.joinedDomains || [];
    return Array.isArray(items) ? items : [];
  }, [ui.joinedDomains]);

  useEffect(() => {
    if (!mobileOpen && !domainsOpen && !mobileDomainsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMobileOpen(false); setDomainsOpen(false); setMobileDomainsOpen(false); } };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [domainsOpen, mobileDomainsOpen, mobileOpen]);

  const closeDrawers = () => { setMobileOpen(false); setDomainsOpen(false); setMobileDomainsOpen(false); };

  return (
    <>
      <nav className="uix-nav" aria-label={i18n('homepage')}>
        <div className="uix-nav__inner">
          <a className="uix-nav__logo" href="/" aria-label="Ejunz"><img src={navLogo} alt="Ejunz" /></a>
          <div className="uix-nav__main">
            {navItems.map((item) => (
              <Link key={item.name} to={item.name} params={item.args} className={`uix-nav__item${activeFor(item.name, item.prefix || item.name, name, template) ? ' is-active' : ''}`}>{i18n(item.displayName || item.name)}</Link>
            ))}
          </div>
          <div className="uix-nav__secondary">
            {guest ? <><Link to="user_login" className="uix-nav__item">{i18n('Login')}</Link><Link to="user_register" className="uix-nav__signup">{i18n('Sign Up')}</Link><span className="uix-nav__badge">{i18n('Guest')}</span></> : <><div className="uix-nav__domain-wrap" onMouseEnter={() => setDomainsOpen(true)} onMouseLeave={() => setDomainsOpen(false)}><button type="button" className="uix-nav__domain" onClick={() => setDomainsOpen((value) => !value)} aria-expanded={domainsOpen}><img src={avatarUrl(ui.domain)} alt="" />{ui.domain?.name || currentDomain}<span>⌄</span></button><div className={`uix-nav__domain-dropdown${domainsOpen ? ' is-open' : ''}`}><DomainMenu inline current={currentDomain} domains={domains} targetRoute={domainTargetRoute} onClose={() => setDomainsOpen(false)} /></div></div><UserMenu user={user} domain={ui.domain} /></>}
          </div>
          <button type="button" className="uix-nav__mobile-button" onClick={() => { setDomainsOpen(false); setMobileOpen((open) => !open); }} aria-label={i18n('Open')} aria-expanded={mobileOpen}><HamburgerIcon active={mobileOpen} /></button>
        </div>
      </nav>
      <div className="uix-mobile-header"><button type="button" onClick={() => { setMobileOpen(false); setDomainsOpen(false); setMobileDomainsOpen((open) => !open); }} aria-label={i18n('Open')} aria-expanded={mobileDomainsOpen}><HamburgerIcon active={mobileDomainsOpen} /></button><a href="/"><img src={navLogo} alt="Ejunz" /></a><button type="button" onClick={() => { setDomainsOpen(false); setMobileDomainsOpen(false); setMobileOpen((open) => !open); }} aria-label={i18n('Open')} aria-expanded={mobileOpen}><HamburgerIcon active={mobileOpen} /></button></div>
      {(mobileOpen || mobileDomainsOpen) && <button type="button" className="uix-shell-backdrop" onClick={closeDrawers} aria-label={i18n('Close')} />}
      {mobileOpen ? <aside className="uix-mobile-menu"><button type="button" className="uix-mobile-menu__close" onClick={() => setMobileOpen(false)} aria-label={i18n('Close')}>×</button><div className="uix-mobile-menu__links">{navItems.map((item) => <Link key={item.name} to={item.name} params={item.args} onClick={() => setMobileOpen(false)} className={`uix-nav__item${activeFor(item.name, item.prefix || item.name, name, template) ? ' is-active' : ''}`}>{i18n(item.displayName || item.name)}</Link>)}{guest ? <><Link to="user_login" onClick={() => setMobileOpen(false)} className="uix-nav__item">{i18n('Login')}</Link><Link to="user_register" onClick={() => setMobileOpen(false)} className="uix-nav__item">{i18n('Sign Up')}</Link></> : <UserMenu user={user} domain={ui.domain} />}</div></aside> : null}
      {mobileDomainsOpen && !guest ? <aside className="uix-domain-drawer"><DomainMenu current={currentDomain} domains={domains} mobile targetRoute={domainTargetRoute} onClose={() => setMobileDomainsOpen(false)} /></aside> : null}
    </>
  );
}

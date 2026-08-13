import { useEffect, useState } from 'react';
import { Link } from '../link';
import { useUiContext, useUserContext } from '../../context/page-data';
import { getLocaleList, i18n } from '../../i18n';
import './footer.css';

const languages = Object.entries(getLocaleList());

export function Footer() {
  const ui = useUiContext();
  const user = useUserContext();
  const [languageOpen, setLanguageOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const domainExtra = typeof ui.domain?.ui?.footer_extra_html === 'string' ? ui.domain.ui.footer_extra_html : '';
  const version = typeof window !== 'undefined' ? (window as any).EjunzVersions?.ejun : undefined;
  const professional = Boolean((ui as any).server?.pro || (ui as any).pro);

  useEffect(() => {
    if (!languageOpen && !themeOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLanguageOpen(false);
        setThemeOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [languageOpen, themeOpen]);

  return (
    <footer className="uix-footer">
      <div className="uix-footer__inner">
        <div className="uix-footer__left">
          <div className="uix-footer__dropdown" onMouseEnter={() => setLanguageOpen(true)} onMouseLeave={() => setLanguageOpen(false)}>
            <button type="button" onClick={() => { setThemeOpen(false); setLanguageOpen((open) => !open); }} aria-expanded={languageOpen}>◎ {i18n('Language')}⌄</button>
            <div className={`uix-footer__menu${languageOpen ? ' is-open' : ''}`}>{languages.map(([key, info]) => <Link key={key} to="switch_language" params={{ lang: key }} className="uix-footer__menu-link">{info.flag ? `${info.flag} ` : ""}{info.name}</Link>)}</div>
          </div>
          <div className="uix-footer__dropdown" onMouseEnter={() => setThemeOpen(true)} onMouseLeave={() => setThemeOpen(false)}>
            <button type="button" onClick={() => { setLanguageOpen(false); setThemeOpen((open) => !open); }} aria-expanded={themeOpen}>◐ {i18n('theme')}⌄</button>
            <div className={`uix-footer__menu${themeOpen ? ' is-open' : ''}`}><Link to="set_theme" params={{ theme: 'light' }} className="uix-footer__menu-link">{i18n('Light')}</Link><Link to="set_theme" params={{ theme: 'dark' }} className="uix-footer__menu-link">{i18n('Dark')}</Link></div>
          </div>
        </div>
        <div className="uix-footer__right">
          {domainExtra.split('\n').filter(Boolean).map((html, index) => <span key={`domain-${index}`} className="uix-footer__item" dangerouslySetInnerHTML={{ __html: html }} />)}
          {(user as any).footer_extra_html ? <span className="uix-footer__item" dangerouslySetInnerHTML={{ __html: String((user as any).footer_extra_html) }} /> : null}
          {version ? <span className="uix-footer__item">{i18n('Powered by')} <a href="https://docs.ejunz.com">Ejunz v{version}</a> {professional ? i18n('Professional') : i18n('Community')}</span> : <span className="uix-footer__item">{i18n('Powered by')} <a href="https://docs.ejunz.com">Ejunz</a></span>}
        </div>
      </div>
    </footer>
  );
}

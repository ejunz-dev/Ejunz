import { useEffect, useState } from 'react';
import { useUiContext, useUserContext } from '../../context/page-data';
import { useBuildUrl } from '../../hooks/use-build-url';
import { getLocaleList, i18n } from '../../i18n';
import './footer.css';

const languages = Object.entries(getLocaleList());

export function Footer() {
  const ui = useUiContext();
  const user = useUserContext();
  const buildUrl = useBuildUrl();
  const [languageOpen, setLanguageOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const domainExtra = typeof ui.domain?.ui?.footer_extra_html === 'string' ? ui.domain.ui.footer_extra_html : '';
  const version = typeof window !== 'undefined' ? (window as any).EjunzVersions?.ejun : undefined;
  const professional = Boolean((ui as any).server?.pro || (ui as any).pro);
  const currentLanguage = String((user as any).viewLang || 'zh');
  const currentLanguageInfo = getLocaleList()[currentLanguage] || getLocaleList()[currentLanguage.split('_')[0]];
  const currentTheme = user.theme === 'dark' ? 'dark' : 'light';

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
            <button type="button" onClick={() => { setThemeOpen(false); setLanguageOpen((open) => !open); }} aria-expanded={languageOpen}>◎ {currentLanguageInfo?.flag ? `${currentLanguageInfo.flag} ` : ''}{currentLanguageInfo?.name || i18n('Language')}⌄</button>
            <div className={`uix-footer__menu${languageOpen ? ' is-open' : ''}`}>{languages.map(([key, info]) => <a key={key} href={buildUrl('switch_language', { lang: key })} className={`uix-footer__menu-link${key === currentLanguage ? ' is-active' : ''}`}>{info.flag ? `${info.flag} ` : ''}{info.name}{key === currentLanguage ? ' ✓' : ''}</a>)}</div>
          </div>
          <div className="uix-footer__dropdown" onMouseEnter={() => setThemeOpen(true)} onMouseLeave={() => setThemeOpen(false)}>
            <button type="button" onClick={() => { setLanguageOpen(false); setThemeOpen((open) => !open); }} aria-expanded={themeOpen}>◐ {i18n(currentTheme === 'dark' ? 'Dark' : 'Light')}⌄</button>
            <div className={`uix-footer__menu${themeOpen ? ' is-open' : ''}`}><a href={buildUrl('set_theme', { theme: 'light' })} className={`uix-footer__menu-link${currentTheme === 'light' ? ' is-active' : ''}`}>{i18n('Light')}{currentTheme === 'light' ? ' ✓' : ''}</a><a href={buildUrl('set_theme', { theme: 'dark' })} className={`uix-footer__menu-link${currentTheme === 'dark' ? ' is-active' : ''}`}>{i18n('Dark')}{currentTheme === 'dark' ? ' ✓' : ''}</a></div>
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

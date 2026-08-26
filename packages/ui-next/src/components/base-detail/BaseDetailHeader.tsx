import { useState, type ReactNode } from 'react';
import { useBuildUrl } from '../../hooks/use-build-url';
import { i18n } from '../../i18n';

interface Props {
  title: string;
  description?: string;
  domainId: string;
  docId: string;
  treeOpen: boolean;
  onToggleTree: () => void;
  onShare: () => void;
  onOpenSettings: () => void;
  onOpenDisplaySettings?: () => void;
  metadata?: ReactNode;
  onSearchClick?: () => void;
  searchActive?: boolean;
  onAiTutorClick?: () => void;
  aiTutorActive?: boolean;
  onEditClick?: () => void;
  editActive?: boolean;
}

export function BaseDetailHeader({ title, description, domainId, docId, treeOpen, onToggleTree, onShare, onOpenSettings, onOpenDisplaySettings, metadata, onSearchClick, searchActive, onAiTutorClick, aiTutorActive, onEditClick, editActive }: Props) {
  const buildUrl = useBuildUrl();
  const [copied, setCopied] = useState(false);
  const listUrl = buildUrl('base_domain', { domainId });
  const share = async () => {
    try {
      await navigator.clipboard?.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { /* Clipboard permissions are optional. */ }
    onShare();
  };
  return (
    <header className="bd-header">
      <div className="bd-header__topline">
        <a className="bd-header__back" href={listUrl}>← {i18n('All Bases')}</a>
        <div className="bd-header__actions">
          <button type="button" className="bd-header__action" onClick={onToggleTree} aria-expanded={treeOpen}>☷ <span>{i18n('Document Structure')}</span></button>
          {onSearchClick ? (
            <button type="button" className={`bd-header__action${searchActive ? ' is-active' : ''}`} onClick={onSearchClick} aria-label={i18n('Semantic Search')}>⌕ <span>{i18n('Search')}</span></button>
          ) : null}
          {onEditClick ? <button type="button" className={`bd-header__action${editActive ? ' is-active' : ''}`} onClick={onEditClick} aria-pressed={editActive}>{editActive ? '✓' : '✎'} <span>编辑</span></button> : null}
          {onOpenDisplaySettings ? <button type="button" className="bd-header__action" onClick={onOpenDisplaySettings} aria-label="显示设置">◌ <span>显示</span></button> : null}
          <button type="button" className="bd-header__action" onClick={onOpenSettings} aria-label={i18n('Roadmap detail settings title')}>⚙ <span>{i18n('Settings')}</span></button>
          <button type="button" className="bd-header__action" onClick={share} aria-label={i18n('Copy link')}>↗ <span>{copied ? i18n('Copied') : i18n('Share')}</span></button>
        </div>
      </div>
      <div className="bd-header__body">
        <h1>{title}</h1>
        {description?.trim() ? <p>{description}</p> : null}
        {metadata}
      </div>
      <div className="bd-header__tabs" role="tablist" aria-label={i18n('Knowledge Base')}>
        <span className={`bd-header__tab${aiTutorActive ? '' : ' is-active'}`} role="tab" aria-selected={!aiTutorActive}>▤ {i18n('Knowledge Base')}</span>
        {onAiTutorClick ? (
          <button type="button" className={`bd-header__tab${aiTutorActive ? ' is-active' : ''}`} onClick={onAiTutorClick} aria-selected={aiTutorActive}>✦ {i18n('Roadmap AI tutor')}</button>
        ) : null}
        <button type="button" className={`bd-header__tab${treeOpen ? ' is-active' : ''}`} onClick={onToggleTree} aria-selected={treeOpen}>⌘ {i18n('Document Structure')}</button>
      </div>
    </header>
  );
}

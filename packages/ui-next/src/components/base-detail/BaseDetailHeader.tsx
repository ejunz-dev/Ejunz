import { useState } from 'react';
import { useBuildUrl } from '../../hooks/use-build-url';
import { i18n } from '../../i18n';

interface Props {
  title: string;
  description?: string;
  domainId: string;
  docId: string;
  nodeCount: number;
  cardCount: number;
  treeOpen: boolean;
  onToggleTree: () => void;
  onShare: () => void;
}

export function BaseDetailHeader({ title, description, domainId, docId, nodeCount, cardCount, treeOpen, onToggleTree, onShare }: Props) {
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
          <button type="button" className="bd-header__action" onClick={share} aria-label={i18n('Copy link')}>↗ <span>{copied ? i18n('Copied') : i18n('Share')}</span></button>
        </div>
      </div>
      <div className="bd-header__body">
        <div className="bd-header__title-row">
          <h1>{title}</h1>
          <span className="bd-header__stats"><strong>{nodeCount}</strong> {i18n('nodes')} <span>·</span> <strong>{cardCount}</strong> {i18n('cards')}</span>
        </div>
        {description?.trim() ? <p>{description}</p> : null}
      </div>
      <div className="bd-header__tabs" role="tablist" aria-label={i18n('Knowledge Base')}>
        <span className="bd-header__tab is-active" role="tab" aria-selected="true">▤ {i18n('Knowledge Base')}</span>
        <button type="button" className={`bd-header__tab${treeOpen ? ' is-active' : ''}`} onClick={onToggleTree} aria-selected={treeOpen}>⌘ {i18n('Document Structure')}</button>
      </div>
      <div className="bd-header__meta">{docId ? <span className="bd-header__id">{docId}</span> : null}</div>
    </header>
  );
}

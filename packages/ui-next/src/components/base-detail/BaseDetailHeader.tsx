import { useState } from 'react';
import { useBuildUrl } from '../../hooks/use-build-url';

interface Props {
  title: string;
  description?: string;
  domainId: string;
  docId: string;
  treeOpen: boolean;
  onToggleTree: () => void;
  onShare: () => void;
}

export function BaseDetailHeader({ title, description, domainId, docId, treeOpen, onToggleTree, onShare }: Props) {
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
        <a className="bd-header__back" href={listUrl}>← All bases</a>
        <div className="bd-header__actions">
          <button type="button" className="bd-header__action" onClick={onToggleTree} aria-expanded={treeOpen}>☷ <span>Structure</span></button>
          <button type="button" className="bd-header__action" onClick={share} aria-label="Copy page link">↗ <span>{copied ? 'Copied' : 'Share'}</span></button>
        </div>
      </div>
      <div className="bd-header__body">
        <p className="bd-header__eyebrow">Knowledge base</p>
        <h1>{title}</h1>
        {description?.trim() ? <p>{description}</p> : null}
      </div>
      <div className="bd-header__tabs" role="tablist" aria-label="Base detail views">
        <span className="bd-header__tab is-active" role="tab" aria-selected="true">▤ Knowledge Base</span>
        <button type="button" className={`bd-header__tab${treeOpen ? ' is-active' : ''}`} onClick={onToggleTree} aria-selected={treeOpen}>⌘ Document Structure</button>
      </div>
      <div className="bd-header__meta"><span>Document view</span>{docId ? <span className="bd-header__id">{docId}</span> : null}</div>
    </header>
  );
}

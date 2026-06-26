import React, { useCallback } from 'react';
import Notification from 'vj/components/notification';
import { domainApiPath, domainScopedPath, i18n } from 'vj/utils';

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="12" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.8 7.1L10.2 4.4M5.8 8.9l4.4 2.7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function BaseTabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 4.5h12M2 8h8M2 11.5h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <rect x="11" y="6.5" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function TreeTabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 3.5h10M3 8h7M3 12.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12.5" cy="8" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function BaseDetailHeader({
  title,
  description,
  domainId,
  docId,
  branch,
  treeDrawerOpen,
  onTreeDrawerOpen,
}: {
  title: string;
  description?: string;
  domainId: string;
  docId: string;
  branch: string;
  treeDrawerOpen?: boolean;
  onTreeDrawerOpen?: () => void;
}) {
  const listUrl = domainScopedPath('/base', domainId);
  const editUrl = domainApiPath(
    `/base/${docId}/branch/${encodeURIComponent(branch)}/editor`,
    domainId,
  );
  const trimmedDescription = String(description || '').trim();

  const onShare = useCallback(() => {
    const link = window.location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link)
        .then(() => Notification.success(i18n('Link copied to clipboard')))
        .catch(() => Notification.error(i18n('Copy failed')));
      return;
    }
    Notification.error(i18n('Clipboard unavailable'));
  }, []);

  return (
    <header className="roadmap-detail-header-card">
      <div className="roadmap-detail-header-card__top">
        <a className="roadmap-detail-header-card__back" href={listUrl}>
          <span className="roadmap-detail-header-card__back-arrow" aria-hidden>←</span>
          {i18n('All Bases')}
        </a>
        <div className="roadmap-detail-header-card__actions">
          <a className="roadmap-detail-header-card__btn" href={editUrl}>
            <span className="icon icon-edit" aria-hidden />
            {i18n('Edit graph')}
          </a>
          <button
            type="button"
            className="roadmap-detail-header-card__btn roadmap-detail-header-card__btn--primary roadmap-detail-header-card__btn--icon"
            onClick={onShare}
            aria-label={i18n('Share')}
          >
            <ShareIcon />
          </button>
        </div>
      </div>

      <div className="roadmap-detail-header-card__body">
        <h1 className="roadmap-detail-header-card__title">{title}</h1>
        {trimmedDescription ? (
          <p className="roadmap-detail-header-card__desc">{trimmedDescription}</p>
        ) : null}
      </div>

      <div className="roadmap-detail-header-card__tabs">
        <span className="roadmap-detail-header-card__tab is-active">
          <BaseTabIcon />
          {i18n('Knowledge Base')}
        </span>
        {onTreeDrawerOpen ? (
          <button
            type="button"
            className={`roadmap-detail-header-card__tab${treeDrawerOpen ? ' is-active' : ''}`}
            onClick={onTreeDrawerOpen}
            aria-expanded={treeDrawerOpen}
          >
            <TreeTabIcon />
            {i18n('Document Structure')}
          </button>
        ) : null}
      </div>
    </header>
  );
}

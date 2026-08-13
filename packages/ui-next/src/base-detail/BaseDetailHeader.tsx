import React, { useCallback } from 'react';

export interface BaseDetailHeaderProps {
  title: string;
  description?: string;
  listUrl: string;
  treeDrawerOpen: boolean;
  onTreeDrawerOpen(): void;
  labels: {
    allBases: string;
    knowledgeBase: string;
    documentStructure: string;
    share: string;
    baseOperations: string;
  };
}

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
  return <span aria-hidden>▤</span>;
}

function TreeTabIcon() {
  return <span aria-hidden>☷</span>;
}

export function BaseDetailHeader({
  title, description, listUrl, treeDrawerOpen, onTreeDrawerOpen, labels,
}: BaseDetailHeaderProps) {
  const onShare = useCallback(() => {
    if (typeof window === 'undefined') return;
    void navigator.clipboard?.writeText(window.location.href);
  }, []);

  return (
    <header className="roadmap-detail-header-card ej-bd__header-card">
      <div className="roadmap-detail-header-card__top ej-bd__header-top">
        <a className="roadmap-detail-header-card__back ej-bd__back" href={listUrl}>
          <span className="roadmap-detail-header-card__back-arrow ej-bd__back-arrow" aria-hidden>←</span>
          {labels.allBases}
        </a>
        <div className="roadmap-detail-header-card__actions ej-bd__ops" aria-label={labels.baseOperations}>
          <button
            type="button"
            className="roadmap-detail-header-card__btn roadmap-detail-header-card__btn--primary roadmap-detail-header-card__btn--icon ej-bd__op ej-bd__op--icon"
            onClick={onShare}
            aria-label={labels.share}
            title={labels.share}
          >
            <ShareIcon />
          </button>
        </div>
      </div>
      <div className="roadmap-detail-header-card__body ej-bd__header-body">
        <p className="ej-bd__eyebrow">{labels.knowledgeBase}</p>
        <h1 className="roadmap-detail-header-card__title ej-bd__title">{title}</h1>
        {description?.trim() ? <p className="roadmap-detail-header-card__desc ej-bd__desc">{description}</p> : null}
      </div>
      <div className="roadmap-detail-header-card__tabs ej-bd__tabs" role="tablist">
        <span className="roadmap-detail-header-card__tab is-active ej-bd__tab" role="tab" aria-selected>
          <BaseTabIcon />
          {labels.knowledgeBase}
        </span>
        <button
          type="button"
          className={`roadmap-detail-header-card__tab ej-bd__tab${treeDrawerOpen ? ' is-active is-selected' : ''}`}
          onClick={onTreeDrawerOpen}
          role="tab"
          aria-selected={treeDrawerOpen}
          aria-expanded={treeDrawerOpen}
        >
          <TreeTabIcon />
          {labels.documentStructure}
        </button>
      </div>
    </header>
  );
}

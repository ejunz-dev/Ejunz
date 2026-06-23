import React, { useCallback } from 'react';
import Notification from 'vj/components/notification';
import { domainApiPath, domainScopedPath, i18n } from 'vj/utils';
import type { BaseRoadmapEdge, BaseRoadmapNode } from './shared';
import { renderRoadmapSvg } from './svg';

function roadmapEditUrl(domainId: string, docId: string, branch: string): string {
  return domainApiPath(
    `/roadmap/${docId}/branch/${encodeURIComponent(branch)}/edit`,
    domainId,
  );
}

function roadmapManageUrl(domainId: string, docId: string): string {
  return domainApiPath(`/roadmap/${docId}/manage`, domainId);
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

function RoadmapTabIcon() {
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

function downloadRoadmapSvg(nodes: BaseRoadmapNode[], edges: BaseRoadmapEdge[], title: string) {
  const svg = renderRoadmapSvg(nodes, edges);
  const svgString = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const safeName = (title.trim() || 'roadmap').replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '');
  anchor.href = url;
  anchor.download = `${safeName || 'roadmap'}.svg`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function AiTutorTabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2l1 3h3l-2.5 2 1 3L8 8.5 5.5 10l1-3L4 5h3L8 2z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RoadmapDetailHeader({
  title,
  description,
  domainId,
  docId,
  branch,
  nodes,
  edges,
  aiTutorActive,
  onAiTutorClick,
  onSettingsClick,
  settingsActive,
}: {
  title: string;
  description?: string;
  domainId: string;
  docId: string;
  branch: string;
  nodes: BaseRoadmapNode[];
  edges: BaseRoadmapEdge[];
  aiTutorActive?: boolean;
  onAiTutorClick?: () => void;
  onSettingsClick?: () => void;
  settingsActive?: boolean;
}) {
  const listUrl = domainScopedPath('/roadmap', domainId);
  const editUrl = roadmapEditUrl(domainId, docId, branch);
  const manageUrl = roadmapManageUrl(domainId, docId);
  const trimmedDescription = String(description || '').trim();

  const onDownload = useCallback(() => {
    if (!nodes.length) {
      Notification.error(i18n('Roadmap detail empty'));
      return;
    }
    downloadRoadmapSvg(nodes, edges, title);
  }, [edges, nodes, title]);

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
          {i18n('All Roadmaps')}
        </a>
        <div className="roadmap-detail-header-card__actions">
          <a className="roadmap-detail-header-card__btn" href={editUrl}>
            <span className="icon icon-edit" aria-hidden />
            {i18n('Edit graph')}
          </a>
          <a className="roadmap-detail-header-card__btn" href={manageUrl}>
            {i18n('Manage')}
          </a>
          <button
            type="button"
            className="roadmap-detail-header-card__btn roadmap-detail-header-card__btn--primary"
            onClick={onDownload}
          >
            <span className="icon icon-download" aria-hidden />
            {i18n('Download')}
          </button>
          <button
            type="button"
            className="roadmap-detail-header-card__btn roadmap-detail-header-card__btn--primary roadmap-detail-header-card__btn--icon"
            onClick={onShare}
            aria-label={i18n('Share')}
          >
            <ShareIcon />
          </button>
          {onSettingsClick ? (
            <button
              type="button"
              className={`roadmap-detail-header-card__btn roadmap-detail-header-card__btn--icon${settingsActive ? ' is-active' : ''}`}
              onClick={onSettingsClick}
              aria-label={i18n('Roadmap detail settings open')}
              title={String(i18n('Roadmap detail settings open'))}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"
                  stroke="currentColor"
                  strokeWidth="1.75"
                />
                <path
                  d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <div className="roadmap-detail-header-card__body">
        <h1 className="roadmap-detail-header-card__title">{title}</h1>
        {trimmedDescription ? (
          <p className="roadmap-detail-header-card__desc">{trimmedDescription}</p>
        ) : null}
      </div>

      <div className="roadmap-detail-header-card__tabs">
        <span className={`roadmap-detail-header-card__tab${aiTutorActive ? '' : ' is-active'}`}>
          <RoadmapTabIcon />
          {i18n('Roadmap')}
        </span>
        {onAiTutorClick ? (
          <button
            type="button"
            className={`roadmap-detail-header-card__tab${aiTutorActive ? ' is-active' : ''}`}
            onClick={onAiTutorClick}
          >
            <AiTutorTabIcon />
            {i18n('Roadmap AI tutor')}
          </button>
        ) : null}
      </div>
    </header>
  );
}

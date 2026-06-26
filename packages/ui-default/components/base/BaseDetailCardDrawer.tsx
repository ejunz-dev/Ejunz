import $ from 'jquery';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { i18n } from 'vj/utils';
import type { Problem } from 'ejun/src/interface';
import { RoadmapDrawerProblemList } from '../roadmap/RoadmapDrawerProblemList';
import type { Card } from './types';
import { cardDisplayLabel } from './detail_tree';

type DrawerTab = 'content' | 'problems';

export function BaseDetailCardDrawer({
  open,
  card,
  onClose,
}: {
  open: boolean;
  card: Card | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DrawerTab>('content');
  const contentRef = useRef<HTMLDivElement>(null);
  const title = card ? cardDisplayLabel(card) : '';
  const problems = useMemo(
    () => (card?.problems || []) as Problem[],
    [card?.docId, card?.problems],
  );
  const hasProblems = problems.length > 0;

  useEffect(() => {
    if (!open || !card) return undefined;
    setTab('content');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [card, open, onClose]);

  useEffect(() => {
    const container = contentRef.current;
    if (!open || !card || !container) return undefined;

    const markdown = String(card.content || '').trim();
    if (!markdown) {
      container.innerHTML = `<p>${i18n('Base detail card empty')}</p>`;
      return undefined;
    }

    let cancelled = false;
    container.innerHTML = `<p>${i18n('Loading...')}</p>`;

    fetch('/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: markdown, inline: false }),
    })
      .then((response) => {
        if (!response.ok) throw new Error('Failed to render markdown');
        return response.text();
      })
      .then((html) => {
        if (cancelled || !contentRef.current) return;
        contentRef.current.innerHTML = html;
        $(contentRef.current).trigger('vjContentNew');
      })
      .catch(() => {
        if (cancelled || !contentRef.current) return;
        contentRef.current.innerHTML = `<p>${i18n('Roadmap markdown preview failed')}</p>`;
      });

    return () => {
      cancelled = true;
    };
  }, [card?.content, card?.docId, open]);

  if (!open || !card) return null;

  return ReactDOM.createPortal(
    <>
      <button
        type="button"
        className="roadmap-detail-backdrop"
        onClick={onClose}
        aria-label={i18n('Close')}
      />
      <aside className="roadmap-detail-drawer" aria-label={title}>
        <div className="roadmap-detail-drawer__header">
          <div className="roadmap-detail-drawer__tabs" role="tablist" aria-label={title}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'content'}
              className={`roadmap-detail-drawer__tab${tab === 'content' ? ' is-active' : ''}`}
              onClick={() => setTab('content')}
            >
              {i18n('Roadmap drawer content')}
            </button>
            {hasProblems ? (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'problems'}
                className={`roadmap-detail-drawer__tab${tab === 'problems' ? ' is-active' : ''}`}
                onClick={() => setTab('problems')}
              >
                {i18n('Roadmap drawer problems')}
                <span className="roadmap-detail-drawer__tab-count">{problems.length}</span>
              </button>
            ) : null}
          </div>
          <div className="roadmap-detail-drawer__header-actions">
            <button
              type="button"
              className="roadmap-detail-drawer__close"
              onClick={onClose}
              aria-label={i18n('Close')}
            >
              ×
            </button>
          </div>
        </div>

        <div className="roadmap-detail-drawer__body">
          <div
            className={`roadmap-detail-drawer__panel${tab === 'content' ? ' is-active' : ''}`}
            role="tabpanel"
            hidden={tab !== 'content'}
          >
            <h1 className="roadmap-detail-drawer__title">{title}</h1>
            <div ref={contentRef} className="roadmap-detail-drawer__markdown typo" />
          </div>

          {hasProblems ? (
            <div
              className={`roadmap-detail-drawer__panel${tab === 'problems' ? ' is-active' : ''}`}
              role="tabpanel"
              hidden={tab !== 'problems'}
            >
              <h1 className="roadmap-detail-drawer__title">{title}</h1>
              <RoadmapDrawerProblemList
                problems={problems}
                resetKey={`${card.docId}:${open}`}
              />
            </div>
          ) : null}
        </div>
      </aside>
    </>,
    document.body,
  );
}

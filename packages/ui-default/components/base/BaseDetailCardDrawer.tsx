import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import Notification from 'vj/components/notification';
import { domainApiPath, domainScopedPath, i18n, request } from 'vj/utils';
import type { Problem } from 'ejun/src/interface';
import { RoadmapDrawerProblemList } from '../roadmap/RoadmapDrawerProblemList';
import type { Card } from './types';
import { cardDisplayLabel } from './detail_tree';
import { useDrawerTransition } from './useDrawerTransition';
import { attachTypoImagePreviewHandlers } from './typo_image_preview';

type DrawerTab = 'content' | 'problems';

export function BaseDetailCardDrawer({
  open,
  card,
  onClose,
  highlightText,
}: {
  open: boolean;
  card: Card | null;
  onClose: () => void;
  highlightText?: string | null;
}) {
  const [tab, setTab] = useState<DrawerTab>('content');
  const [practiceBusy, setPracticeBusy] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastCardRef = useRef<Card | null>(null);
  const { visible, closing } = useDrawerTransition(open);
  if (card) lastCardRef.current = card;
  const displayCard = card || lastCardRef.current;
  const title = displayCard ? cardDisplayLabel(displayCard) : '';
  const problems = useMemo(
    () => (displayCard?.problems || []) as Problem[],
    [displayCard?.docId, displayCard?.problems],
  );
  const hasProblems = problems.length > 0;

  const startCardPractice = useCallback(async () => {
    const cardId = String(displayCard?.docId || '').trim();
    if (!cardId || practiceBusy || !hasProblems) return;
    if (!/^[a-f0-9]{24}$/i.test(cardId)) {
      Notification.error(i18n('Outline learn invalid card'));
      return;
    }
    const rawDomainId = (window as any).UiContext?.base?.domainId
      ?? (window as any).UiContext?.domainId;
    const domainId = typeof rawDomainId === 'object'
      ? (rawDomainId?._id ? String(rawDomainId._id) : 'system')
      : (rawDomainId ? String(rawDomainId) : 'system');
    setPracticeBusy(true);
    try {
      const res: any = await request.post(domainApiPath('/learn/lesson/start', domainId), {
        mode: 'card',
        cardId,
      });
      const redir = res?.redirect ?? res?.body?.redirect ?? res?.data?.redirect;
      const url = redir || domainScopedPath(`/learn/lesson?cardId=${encodeURIComponent(cardId)}`, domainId);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        opened.opener = null;
      } else {
        Notification.error(i18n('Outline editor popup blocked'));
      }
    } catch (e: any) {
      const raw = typeof e?.message === 'string' ? e.message : String(e ?? '');
      const cleaned = raw.replace(/^[A-Za-z]+Error:\s*/i, '').trim();
      const msg = cleaned === 'No cards match session card filter'
        || cleaned === 'Learn requires cards with problems'
        ? i18n('Learn requires cards with problems')
        : (cleaned || i18n('Outline learn start failed'));
      Notification.error(msg);
    } finally {
      setPracticeBusy(false);
    }
  }, [displayCard?.docId, hasProblems, practiceBusy]);

  useEffect(() => {
    if (!visible || closing || !displayCard) return undefined;
    setTab('content');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closing, displayCard, onClose, visible]);

  // Markdown rendering + apply search highlight synchronously after render
  useEffect(() => {
    const container = contentRef.current;
    if (!visible || closing || !displayCard || !container) return undefined;

    const markdown = String(displayCard.content || '').trim();
    if (!markdown) {
      container.innerHTML = `<p>${i18n('Base detail card empty')}</p>`;
      return undefined;
    }

    let cancelled = false;
    container.innerHTML = `<p>${i18n('Loading...')}</p>`;

    const pendingHighlight = highlightText; // capture for this render cycle

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
        attachTypoImagePreviewHandlers(contentRef.current);

        // Apply search highlight right after DOM is ready
        if (pendingHighlight) {
          applyHighlight(contentRef.current, pendingHighlight);
        }
      })
      .catch(() => {
        if (cancelled || !contentRef.current) return;
        contentRef.current.innerHTML = `<p>${i18n('Roadmap markdown preview failed')}</p>`;
      });

    return () => {
      cancelled = true;
    };
  }, [displayCard?.content, displayCard?.docId, closing, visible]);

  // Helper: walk the rendered DOM and highlight the first content match.
  // Since markdown→HTML rendering removes syntax markers (e.g. '# ' → heading),
  // we strip the same markers from the chunk text before matching.
  function applyHighlight(container: HTMLElement, markdownText: string) {
    const plain = markdownText
      .replace(/^#+\s*/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^>\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();
    if (!plain || plain.length < 10) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const idx = node.textContent?.indexOf(plain) ?? -1;
      if (idx === -1) continue;
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      const tail = node.textContent!.slice(idx + plain.length);
      node.textContent = node.textContent!.slice(0, idx);
      mark.textContent = plain;
      node.parentNode!.insertBefore(mark, node.nextSibling);
      if (tail) {
        node.parentNode!.insertBefore(document.createTextNode(tail), mark.nextSibling);
      }
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
  }

  if (!visible || !displayCard) return null;

  return ReactDOM.createPortal(
    <>
      <button
        type="button"
        className={`roadmap-detail-backdrop roadmap-detail-drawer-backdrop${closing ? ' is-closing' : ''}`}
        onClick={onClose}
        aria-label={i18n('Close')}
      />
      <aside className={`roadmap-detail-drawer${closing ? ' is-closing' : ''}`} aria-label={title}>
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
              <div className="roadmap-detail-drawer__practice-action">
                <button
                  type="button"
                  className="roadmap-detail-drawer__practice-btn"
                  disabled={practiceBusy || !hasProblems}
                  onClick={() => { void startCardPractice(); }}
                >
                  {practiceBusy
                    ? i18n('Roadmap drawer start node practice busy')
                    : i18n('Roadmap drawer start card practice')}
                </button>
              </div>
              <RoadmapDrawerProblemList
                problems={problems}
                resetKey={`${displayCard.docId}:${visible}`}
              />
            </div>
          ) : null}
        </div>
      </aside>
    </>,
    document.body,
  );
}

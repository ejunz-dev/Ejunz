import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import Notification from 'vj/components/notification';
import { domainApiPath, domainScopedPath, i18n, request } from 'vj/utils';
import type { Problem } from 'ejun/src/interface';
import { RoadmapDrawerProblemList } from '../roadmap/RoadmapDrawerProblemList';
import { renderRoadmapMarkdown } from '../roadmap/markdown_render';
import type { Card } from './types';
import { cardDisplayLabel, findCardHostNodeId } from './detail_tree';
import { getCardIcon, getCardColor } from './utils';
import {
  CardFileOtherIcon,
} from './BaseEditorCardIcons';
import { useDrawerTransition } from './useDrawerTransition';
import { attachTypoImagePreviewHandlers } from './typo_image_preview';
import type { BaseDetailDisplaySettings } from './detail_display_settings';

/**
 * Render an inline preview for a file-card inside the detail card drawer.
 */
function renderFilePreview(card: Card, domainId?: string, baseDocId?: string) {
  const fileType = card?.fileType || '';
  const fileName = card?.fileName || '';
  const cardId = card?.docId || '';
  let nodeId = card?.nodeId || '';

  // Fallback: look up host node from the global nodeCardsMap
  if (!nodeId) {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const found = findCardHostNodeId(cardId, nodeCardsMap);
    if (found) nodeId = found;
  }

  if (!fileName || (!cardId && !nodeId)) {
    return <p className="roadmap-detail-drawer__empty">{i18n('Base detail card empty')}</p>;
  }
  const resolvedDomainId = domainId || (window as any).UiContext?.domainId || 'system';
  const resolvedDocId = baseDocId || String((window as any).UiContext?.base?.docId || '');
  const branch = (window as any).UiContext?.currentBranch || 'main';

  // File-cards store files on the node, not on the card itself.
  // Use node-based download URL matching how BaseEditor previews them.
  const fileUrl = domainScopedPath(
    `/base/${resolvedDocId}/node/${nodeId}/file/${encodeURIComponent(fileName)}?branch=${encodeURIComponent(branch)}&noDisposition=1`,
    resolvedDomainId,
  );
  const downloadUrl = domainScopedPath(
    `/base/${resolvedDocId}/node/${nodeId}/file/${encodeURIComponent(fileName)}?branch=${encodeURIComponent(branch)}`,
    resolvedDomainId,
  );

  switch (fileType) {
    case 'pdf':
      return (
        <object data={fileUrl} type="application/pdf" style={{ width: '100%', flex: 1, border: 'none', minHeight: '400px' }}>
          <embed src={fileUrl} type="application/pdf" style={{ width: '100%', height: '100%', border: 'none' }} />
        </object>
      );
    case 'image': {
      const openViewer = () => {
        const img = document.createElement('img');
        img.src = fileUrl;
        img.style.cssText = 'display: none;';
        document.body.appendChild(img);
        img.onload = async () => {
          try {
            const { default: Viewer } = await import('viewerjs/dist/viewer.esm.js');
            const viewer = new Viewer(img, {
              inline: false,
              viewed() { document.body.style.overflow = 'hidden'; },
              hidden() {
                document.body.style.overflow = '';
                if (img.parentNode) img.parentNode.removeChild(img);
                viewer.destroy();
              },
              toolbar: {
                zoomIn: true, zoomOut: true, oneToOne: true, reset: true,
                prev: false, play: false, next: false,
                rotateLeft: true, rotateRight: true,
                flipHorizontal: true, flipVertical: true,
              },
              zoomRatio: 0.1, minZoomRatio: 0.01, maxZoomRatio: 100,
              movable: true, rotatable: true, scalable: true,
              transition: true, fullscreen: true, keyboard: true,
            });
            viewer.show();
          } catch { /* fallback */ }
        };
      };
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', overflow: 'auto', width: '100%' }}>
          <img
            src={fileUrl}
            alt={fileName}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'zoom-in', borderRadius: '4px' }}
            onClick={openViewer}
            onKeyDown={(e) => { if (e.key === 'Enter') openViewer(); }}
          />
        </div>
      );
    }
    case 'video':
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', width: '100%' }}>
          <video controls style={{ maxWidth: '100%', maxHeight: '100%' }}>
            <source src={fileUrl} />
          </video>
        </div>
      );
    case 'audio':
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', width: '100%' }}>
          <audio controls src={fileUrl} style={{ width: '100%', maxWidth: '480px' }} />
        </div>
      );
    case 'code':
      return (
        <iframe
          src={fileUrl}
          style={{ width: '100%', flex: 1, border: 'none', minHeight: '400px' }}
          title={fileName}
        />
      );
    default: {
      const theme = (() => {
        try {
          if ((window as any).Ejunz?.utils?.getTheme) return (window as any).Ejunz.utils.getTheme();
          return (window as any).UserContext?.theme === 'dark' ? 'dark' : 'light';
        } catch { return 'light'; }
      })();
      const iconKey = getCardIcon('file', fileType);
      const cardColor = getCardColor(iconKey, theme);
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px', width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5, display: 'flex', justifyContent: 'center' }}>
              <CardFileOtherIcon size={48} color={cardColor} />
            </div>
            <p style={{ margin: '0 0 8px', fontSize: '14px' }}>{fileName}</p>
            <a
              href={downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--link-color, #1a73e8)', textDecoration: 'underline', fontSize: '13px' }}
            >
              {i18n('Download file')}
            </a>
          </div>
        </div>
      );
    }
  }
}

type DrawerTab = 'content' | 'problems';

export function BaseDetailCardDrawer({
  open,
  card,
  onClose,
  highlightText,
  baseDocId,
  domainId,
  drawerWidth,
  onDrawerWidthChange,
  onEditCard,
  editorBusy,
}: {
  open: boolean;
  card: Card | null;
  onClose: () => void;
  highlightText?: string | null;
  baseDocId?: string;
  domainId?: string;
  drawerWidth: number;
  onDrawerWidthChange: (w: number) => void;
  onEditCard?: () => void;
  editorBusy?: boolean;
}) {
  const [tab, setTab] = useState<DrawerTab>('content');
  const [practiceBusy, setPracticeBusy] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastCardRef = useRef<Card | null>(null);
  const { visible, closing } = useDrawerTransition(open);
  const drawWRef = useRef(drawerWidth);
  drawWRef.current = drawerWidth;
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
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

    const pendingHighlight = highlightText; // capture for this render cycle
    const html = renderRoadmapMarkdown(markdown);
    container.innerHTML = html;
    $(container).trigger('vjContentNew');
    attachTypoImagePreviewHandlers(container);

    // Apply search highlight right after DOM is ready
    if (pendingHighlight) {
      applyHighlight(container, pendingHighlight);
    }

    return undefined;
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
      <aside className={`roadmap-detail-drawer${closing ? ' is-closing' : ''}`} style={{ width: drawerWidth }} aria-label={title}>
        <div className="roadmap-detail-drawer__resize-handle--left" onPointerDown={(e) => {
          dragRef.current = { startX: e.clientX, startW: drawWRef.current };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
          onPointerMove={(e) => {
            const drag = dragRef.current;
            if (!drag) return;
            onDrawerWidthChange(Math.max(200, Math.min(window.innerWidth - 40, drag.startW + (drag.startX - e.clientX))));
          }}
          onPointerUp={() => { dragRef.current = null; }}
        />
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
            {onEditCard ? (
              <button
                type="button"
                className="roadmap-detail-drawer__edit-btn"
                onClick={onEditCard}
                disabled={editorBusy}
                aria-busy={editorBusy || undefined}
                aria-label={i18n('Edit')}
                title={String(i18n('Edit'))}
              >
                {i18n('Edit')}
              </button>
            ) : null}
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

        <div className="roadmap-detail-drawer__body" style={displayCard?.cardType === 'file' ? { display: 'flex', flexDirection: 'column' } : undefined}>
          {displayCard?.cardType === 'file' ? (
            <div
              className={`roadmap-detail-drawer__panel is-active`}
              role="tabpanel"
              style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
            >
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {renderFilePreview(displayCard, domainId, baseDocId)}
              </div>
            </div>
          ) : (
            <>
          <div
            className={`roadmap-detail-drawer__panel${tab === 'content' ? ' is-active' : ''}`}
            role="tabpanel"
            hidden={tab !== 'content'}
          >
            <div ref={contentRef} className="roadmap-detail-drawer__markdown typo" />
          </div>

          {hasProblems ? (
            <div
              className={`roadmap-detail-drawer__panel${tab === 'problems' ? ' is-active' : ''}`}
              role="tabpanel"
              hidden={tab !== 'problems'}
            >
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
          </>
        )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

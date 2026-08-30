import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Viewer from 'viewerjs';
import 'viewerjs/dist/viewer.css';
import { i18n } from '../../i18n';
import { renderMarkdown } from './markdown';
import { BaseDetailProblemList } from './BaseDetailProblemList';
import { useDrawerPresence, useDrawerSwipe } from './drawer-hooks';
import { cardDisplayLabel } from './tree';
import type { BaseDetailCard } from './types';
import './base-detail.css';

interface Props {
  card: BaseDetailCard | null;
  onClose: () => void;
  onSelectProblem?: (pid: string) => void;
  onEditCard?: () => void;
  onEditProblem?: (pid: string, index: number) => void;
  editorBusy?: boolean;
  selectedProblemId?: string | null;
  baseDocId?: string;
  domainId?: string;
  drawerWidth?: number;
}

function fileUrl(card: BaseDetailCard, baseDocId?: string, domainId?: string): string {
  if (!card.fileName || !card.nodeId || !baseDocId) return '';
  const prefix = domainId && domainId !== 'system' ? `/d/${encodeURIComponent(domainId)}` : '';
  return `${prefix}/base/${encodeURIComponent(baseDocId)}/node/${encodeURIComponent(card.nodeId)}/file/${encodeURIComponent(card.fileName)}?noDisposition=1`;
}

export function BaseDetailCardDrawer({ card, onClose, onSelectProblem, onEditCard, onEditProblem, editorBusy, selectedProblemId, baseDocId, domainId, drawerWidth }: Props) {
  const { present, closing } = useDrawerPresence(Boolean(card));
  const swipe = useDrawerSwipe('right', onClose);
  const [renderedCard, setRenderedCard] = useState(card);
  const [tab, setTab] = useState<'content' | 'problems'>('content');
  const [loadingMedia, setLoadingMedia] = useState(true);
  const drawerRef = useRef<HTMLElement>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const viewerImageRef = useRef<HTMLImageElement | null>(null);
  const displayCard = renderedCard;

  useEffect(() => {
    if (card) setRenderedCard(card);
  }, [card]);
  const problems = displayCard?.problems || [];
  const contentHtml = displayCard?.content ? renderMarkdown(displayCard.content) : '';

  useEffect(() => {
    if (!displayCard) return undefined;
    viewerRef.current?.destroy();
    viewerRef.current = null;
    viewerImageRef.current?.remove();
    viewerImageRef.current = null;
    setLoadingMedia(true);
    setTab(selectedProblemId ? 'problems' : 'content');
    drawerRef.current?.focus();
    const media = markdownRef.current?.querySelectorAll('img, iframe, video, object, embed');
    const finishLoading = () => setLoadingMedia(false);
    if (!media?.length) {
      finishLoading();
    } else {
      media.forEach((element) => {
        element.addEventListener('load', finishLoading);
        element.addEventListener('loadeddata', finishLoading);
        element.addEventListener('canplay', finishLoading);
        element.addEventListener('error', finishLoading);
        if (element instanceof HTMLImageElement && element.complete) finishLoading();
      });
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      media?.forEach((element) => {
        element.removeEventListener('load', finishLoading);
        element.removeEventListener('loadeddata', finishLoading);
        element.removeEventListener('canplay', finishLoading);
        element.removeEventListener('error', finishLoading);
      });
      viewerRef.current?.destroy();
      viewerRef.current = null;
      viewerImageRef.current?.remove();
      viewerImageRef.current = null;
    };
  }, [displayCard, onClose, selectedProblemId]);

  useEffect(() => {
    if (!displayCard || !markdownRef.current) return undefined;
    const images = markdownRef.current.querySelectorAll('img');
    if (!images.length) return undefined;
    const imageContainer = markdownRef.current;
    const openViewer = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      const preview = new Image();
      preview.src = target.currentSrc || target.src;
      preview.alt = target.alt;
      preview.style.display = 'none';
      document.body.appendChild(preview);
      viewerImageRef.current?.remove();
      viewerImageRef.current = preview;
      viewerRef.current?.destroy();
      viewerRef.current = new Viewer(preview, {
        inline: false,
        title: false,
        navbar: false,
        toolbar: {
          zoomIn: true,
          zoomOut: true,
          oneToOne: true,
          reset: true,
          rotateLeft: true,
          rotateRight: true,
          flipHorizontal: true,
          flipVertical: true,
          prev: false,
          next: false,
          play: false,
        },
        viewed: () => setLoadingMedia(false),
      });
      viewerRef.current.show();
    };
    imageContainer.addEventListener('click', openViewer);
    return () => imageContainer.removeEventListener('click', openViewer);
  }, [contentHtml, displayCard?.docId]);

  if (!present || !displayCard) return null;
  const url = fileUrl(displayCard, baseDocId, domainId);
  const hasEmbeddedMedia = /<(?:img|iframe|video|object|embed)\b/i.test(contentHtml);
  return createPortal(
    <>
      <button type="button" className={`bd-backdrop bd-card-backdrop${closing ? ' is-closing' : ''}`} onClick={onClose} aria-label={i18n('Close')} />
      <aside ref={drawerRef} className={`bd-drawer bd-card-drawer${closing ? ' is-closing' : ''}`} style={{ ...(drawerWidth ? { width: `min(${drawerWidth}px, calc(100vw - 1rem))` } : {}), ...swipe.style }} onPointerDown={swipe.onPointerDown} onPointerMove={swipe.onPointerMove} onPointerUp={swipe.onPointerUp} onPointerCancel={swipe.onPointerCancel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={cardDisplayLabel(displayCard)}>
        <header className="bd-drawer__header">
          <div className="bd-drawer__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'content'} className={tab === 'content' ? 'is-active' : ''} onClick={() => setTab('content')}>{i18n('Content')}</button>
            {problems.length ? <button type="button" role="tab" aria-selected={tab === 'problems'} className={tab === 'problems' ? 'is-active' : ''} onClick={() => setTab('problems')}>{i18n('Problems')} <span>{problems.length}</span></button> : null}
          </div>
          <div className="bd-drawer__header-actions">
            {onEditCard ? <button type="button" className="bd-drawer__edit" onClick={onEditCard} disabled={editorBusy} aria-busy={editorBusy || undefined}>{i18n('Edit')}</button> : null}
            <button type="button" className="bd-drawer__close" onClick={onClose} aria-label={i18n('Close')}>×</button>
          </div>
        </header>
        {tab === 'content' ? (
          <div className="bd-drawer__body">
            <h2>{cardDisplayLabel(displayCard)}</h2>
            {displayCard.tags?.length ? <div className="bd-card__tags bd-card__tags--drawer">{displayCard.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
            {displayCard.cardFace ? <div className="bd-drawer__face bd-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(displayCard.cardFace) }} /> : null}
            {displayCard.cardType === 'file' && url ? (
              <div className="bd-drawer__file">
                {loadingMedia ? <span className="bd-media-loader" role="status" aria-label={i18n('Loading...')} /> : null}
                {displayCard.fileType === 'image' ? <img src={url} alt={displayCard.fileName || ''} onLoad={() => setLoadingMedia(false)} onError={() => setLoadingMedia(false)} /> : displayCard.fileType === 'video' ? <video controls src={url} onLoadedData={() => setLoadingMedia(false)} onError={() => setLoadingMedia(false)} /> : displayCard.fileType === 'audio' ? <audio controls src={url} onCanPlay={() => setLoadingMedia(false)} onError={() => setLoadingMedia(false)} /> : <a href={url} target="_blank" rel="noreferrer" onClick={() => setLoadingMedia(false)}>{i18n('Open')} {displayCard.fileName}</a>}
              </div>
            ) : displayCard.content ? (
              <div className="bd-markdown--media-aware">
                <div ref={markdownRef} className="bd-markdown" dangerouslySetInnerHTML={{ __html: contentHtml }} />
                {hasEmbeddedMedia && loadingMedia ? <span className="bd-media-loader" role="status" aria-label={i18n('Loading...')} /> : null}
              </div>
            ) : <p className="bd-muted">{i18n('Base detail card empty')}</p>}
          </div>
        ) : (
          <div className="bd-drawer__body bd-drawer__problems">
            <h2>{cardDisplayLabel(displayCard)}</h2>
            {displayCard.tags?.length ? <div className="bd-card__tags bd-card__tags--drawer">{displayCard.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
            <BaseDetailProblemList problems={problems} resetKey={String(displayCard.docId)} selectedProblemId={selectedProblemId} onSelectProblem={onSelectProblem} onEditProblem={onEditProblem} />
          </div>
        )}
      </aside>
    </>,
    document.body,
  );
}

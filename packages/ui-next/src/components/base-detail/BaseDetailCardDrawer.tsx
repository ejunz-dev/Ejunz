import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { i18n } from '../../i18n';
import { renderMarkdown } from './markdown';
import { cardDisplayLabel } from './tree';
import type { BaseDetailCard } from './types';
import './base-detail.css';

interface Props {
  card: BaseDetailCard | null;
  onClose: () => void;
  onSelectProblem?: (pid: string) => void;
  selectedProblemId?: string | null;
  baseDocId?: string;
  domainId?: string;
}

function fileUrl(card: BaseDetailCard, baseDocId?: string, domainId?: string): string {
  if (!card.fileName || !card.nodeId || !baseDocId) return '';
  const prefix = domainId && domainId !== 'system' ? `/d/${encodeURIComponent(domainId)}` : '';
  return `${prefix}/base/${encodeURIComponent(baseDocId)}/node/${encodeURIComponent(card.nodeId)}/file/${encodeURIComponent(card.fileName)}?noDisposition=1`;
}

export function BaseDetailCardDrawer({ card, onClose, onSelectProblem, selectedProblemId, baseDocId, domainId }: Props) {
  const [tab, setTab] = useState<'content' | 'problems'>('content');
  const [loadingMedia, setLoadingMedia] = useState(true);
  const drawerRef = useRef<HTMLElement>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  const displayCard = card;
  const problems = displayCard?.problems || [];

  useEffect(() => {
    if (!displayCard) return undefined;
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
    };
  }, [displayCard, onClose, selectedProblemId]);

  if (!displayCard) return null;
  const url = fileUrl(displayCard, baseDocId, domainId);
  const contentHtml = displayCard.content ? renderMarkdown(displayCard.content) : '';
  const hasEmbeddedMedia = /<(?:img|iframe|video|object|embed)\b/i.test(contentHtml);
  return createPortal(
    <>
      <button type="button" className="bd-backdrop bd-card-backdrop" onClick={onClose} aria-label={i18n('Close')} />
      <aside ref={drawerRef} className="bd-drawer bd-card-drawer" tabIndex={-1} role="dialog" aria-modal="true" aria-label={cardDisplayLabel(displayCard)}>
        <header className="bd-drawer__header">
          <div className="bd-drawer__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'content'} className={tab === 'content' ? 'is-active' : ''} onClick={() => setTab('content')}>{i18n('Content')}</button>
            {problems.length ? <button type="button" role="tab" aria-selected={tab === 'problems'} className={tab === 'problems' ? 'is-active' : ''} onClick={() => setTab('problems')}>{i18n('Problems')} <span>{problems.length}</span></button> : null}
          </div>
          <button type="button" className="bd-drawer__close" onClick={onClose} aria-label={i18n('Close')}>×</button>
        </header>
        {tab === 'content' ? (
          <div className="bd-drawer__body">
            <h2>{cardDisplayLabel(displayCard)}</h2>
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
            {displayCard.tags?.length ? <div className="bd-card__tags">{displayCard.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
          </div>
        ) : (
          <div className="bd-drawer__body bd-drawer__problems">
            <h2>{cardDisplayLabel(displayCard)}</h2>
            <ol>
              {problems.map((problem, index) => {
                const pid = String(problem.pid || `problem-${index}`);
                return <li key={pid}><button type="button" className={selectedProblemId === pid ? 'is-selected' : ''} onClick={() => onSelectProblem?.(pid)}>{String(problem.title || problem.stem || problem.content || `${i18n('Problem')} ${index + 1}`).replace(/<[^>]+>/g, '').slice(0, 180)}</button></li>;
              })}
            </ol>
          </div>
        )}
      </aside>
    </>,
    document.body,
  );
}

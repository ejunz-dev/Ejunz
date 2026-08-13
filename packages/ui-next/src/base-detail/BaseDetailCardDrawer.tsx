import { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from './markdown';
import { cardDisplayLabel } from './tree';
import type { BaseDetailCard } from './types';

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
  const previousCard = useRef<BaseDetailCard | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  if (card) previousCard.current = card;
  const displayCard = card || previousCard.current;
  const problems = displayCard?.problems || [];

  useEffect(() => {
    if (!displayCard) return undefined;
    setTab(selectedProblemId ? 'problems' : 'content');
    drawerRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [displayCard?.docId, onClose, selectedProblemId]);

  if (!displayCard) return null;
  const url = fileUrl(displayCard, baseDocId, domainId);
  return (
    <>
      <button type="button" className="bd-backdrop" onClick={onClose} aria-label="Close card" />
      <aside ref={drawerRef} className="bd-drawer" tabIndex={-1} role="dialog" aria-modal="true" aria-label={cardDisplayLabel(displayCard)}>
        <header className="bd-drawer__header">
          <div className="bd-drawer__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'content'} className={tab === 'content' ? 'is-active' : ''} onClick={() => setTab('content')}>Content</button>
            {problems.length ? <button type="button" role="tab" aria-selected={tab === 'problems'} className={tab === 'problems' ? 'is-active' : ''} onClick={() => setTab('problems')}>Problems <span>{problems.length}</span></button> : null}
          </div>
          <button type="button" className="bd-drawer__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {tab === 'content' ? (
          <div className="bd-drawer__body">
            <h2>{cardDisplayLabel(displayCard)}</h2>
            {displayCard.cardFace ? <div className="bd-drawer__face bd-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(displayCard.cardFace) }} /> : null}
            {displayCard.cardType === 'file' && url ? (
              <div className="bd-drawer__file">
                {displayCard.fileType === 'image' ? <img src={url} alt={displayCard.fileName || ''} /> : displayCard.fileType === 'video' ? <video controls src={url} /> : displayCard.fileType === 'audio' ? <audio controls src={url} /> : <a href={url} target="_blank" rel="noreferrer">Open {displayCard.fileName}</a>}
              </div>
            ) : displayCard.content ? <div className="bd-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(displayCard.content) }} /> : <p className="bd-muted">This card has no content.</p>}
            {displayCard.tags?.length ? <div className="bd-card__tags">{displayCard.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
          </div>
        ) : (
          <div className="bd-drawer__body bd-drawer__problems">
            <h2>{cardDisplayLabel(displayCard)}</h2>
            <ol>
              {problems.map((problem, index) => {
                const pid = String(problem.pid || `problem-${index}`);
                return <li key={pid}><button type="button" className={selectedProblemId === pid ? 'is-selected' : ''} onClick={() => onSelectProblem?.(pid)}>{String(problem.title || problem.stem || problem.content || `Problem ${index + 1}`).replace(/<[^>]+>/g, '').slice(0, 180)}</button></li>;
              })}
            </ol>
          </div>
        )}
      </aside>
    </>
  );
}

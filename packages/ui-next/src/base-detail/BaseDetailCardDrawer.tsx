import React from 'react';
import { renderMarkdown } from './markdown';
import { ProblemList } from './ProblemView';
import { cardDisplayLabel } from './tree';
import type { BaseDetailCard } from './types';

interface CardDrawerProps {
  card: BaseDetailCard | null;
  onClose(): void;
  unnamedCard: string;
  drawerWidth?: number;
  onDrawerWidthChange?(width: number): void;
}

export function BaseDetailCardDrawer({ card, onClose, unnamedCard, drawerWidth = 608, onDrawerWidthChange }: CardDrawerProps) {
  const dragRef = React.useRef<{ startX: number; startWidth: number } | null>(null);
  if (!card) return null;
  const content = renderMarkdown(card.content);
  return (
    <div
      className="roadmap-detail-drawer ej-bd-drawer"
      role="dialog"
      aria-label={cardDisplayLabel(card, unnamedCard)}
      style={{ width: drawerWidth }}
    >
      <div
        className="roadmap-detail-drawer__resize-handle--left"
        onPointerDown={(event) => {
          dragRef.current = { startX: event.clientX, startWidth: drawerWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag && onDrawerWidthChange) onDrawerWidthChange(Math.max(280, Math.min(window.innerWidth - 40, drag.startWidth + drag.startX - event.clientX)));
        }}
        onPointerUp={() => { dragRef.current = null; }}
      />
      <div className="ej-bd-drawer__head">
        <h2 className="ej-bd-drawer__title">{cardDisplayLabel(card, unnamedCard)}</h2>
        <button type="button" className="ej-bd-drawer__close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {card.cardFace ? (
        <div className="ej-bd-drawer__face ej-bd-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.cardFace) }} />
      ) : null}
      <div className="ej-bd-drawer__body ej-bd-md" dangerouslySetInnerHTML={{ __html: content }} />
      {card.tags?.length ? (
        <div className="ej-bd-drawer__tags">
          {card.tags.map((tag) => <span key={tag} className="ej-web-tag">{tag}</span>)}
        </div>
      ) : null}
      <ProblemList problems={card.problems} />
    </div>
  );
}

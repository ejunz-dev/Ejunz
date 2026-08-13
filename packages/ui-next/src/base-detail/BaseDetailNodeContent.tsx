import React from 'react';
import { renderMarkdown } from './markdown';
import { ProblemList } from './ProblemView';
import {
  cardDisplayLabel,
  collectSubtreeNodeIds,
  getSortedNodeCards,
  nodeDisplayLabel,
} from './tree';
import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode } from './types';

interface NodeContentProps {
  rootNodeId: string;
  nodes: BaseDetailNode[];
  edges: BaseDetailEdge[];
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  selectedCardId: string | null;
  onSelectCard(card: BaseDetailCard): void;
  onSelectNode(nodeId: string): void;
  filter: string;
  unnamedNode: string;
  unnamedCard: string;
  noCardsText: string;
}

function formatDate(value: unknown): string {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(+date) ? '' : date.toLocaleString();
}

export function BaseDetailNodeContent({
  rootNodeId, nodes, edges, nodeCardsMap, selectedCardId,
  onSelectCard, onSelectNode, filter, unnamedNode, unnamedCard, noCardsText,
}: NodeContentProps) {
  const query = filter.trim().toLowerCase();
  const subtreeIds = [rootNodeId, ...collectSubtreeNodeIds(rootNodeId, nodes, edges)];
  let rendered = 0;

  const sections = subtreeIds.map((nodeId) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    let cards = getSortedNodeCards(nodeId, nodeCardsMap);
    if (query) {
      cards = cards.filter((card) => `${card.title || ''} ${card.content || ''} ${(card.tags || []).join(' ')}`
        .toLowerCase().includes(query));
    }
    if (!cards.length) return null;
    rendered += cards.length;
    const isRoot = nodeId === rootNodeId;
    return (
      <section key={nodeId} className="ej-bd-node-section" data-node-id={nodeId}>
        <h2 className="ej-bd-node-section__title">
          {isRoot
            ? nodeDisplayLabel(node, unnamedNode)
            : (
              <button type="button" className="ej-bd-link" onClick={() => onSelectNode(nodeId)}>
                {nodeDisplayLabel(node, unnamedNode)}
              </button>
            )}
        </h2>
        {cards.map((card) => {
          const cardId = String(card.docId);
          const selected = cardId === selectedCardId;
          return (
            <article
              key={cardId}
              id={`base-detail-card-${cardId}`}
              className={`ej-bd-card${selected ? ' is-selected' : ''}`}
            >
              <header className="ej-bd-card__head">
                <button type="button" className="ej-bd-card__title ej-bd-link" onClick={() => onSelectCard(card)}>
                  {cardDisplayLabel(card, unnamedCard)}
                </button>
                <span className="ej-bd-card__meta">
                  {formatDate(card.updateAt)}
                  {card.problems?.length ? ` · ${card.problems.length} problems` : ''}
                </span>
              </header>
              <div className="ej-bd-card__body ej-bd-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.content) }} />
              {card.tags?.length ? (
                <footer className="ej-bd-card__tags">
                  {card.tags.map((tag) => <span key={tag} className="ej-web-tag">{tag}</span>)}
                </footer>
              ) : null}
              <ProblemList problems={card.problems} />
            </article>
          );
        })}
      </section>
    );
  });

  if (!rendered) {
    return <p className="ej-bd-muted ej-bd-empty">{noCardsText}</p>;
  }
  return <div className="ej-bd-node-content">{sections}</div>;
}

import { useMemo } from 'react';
import { i18n } from '../../i18n';
import { renderMarkdown } from './markdown';
import { cardDisplayLabel, collectSubtreeNodeIds, getSortedNodeCards, nodeDisplayLabel } from './tree';
import { cardMatchesFilters, cardMatchesSearch, nodeMatchesFilter, nodeMatchesSearch, type BaseDetailFilter } from './detail-filter';
import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode } from './types';

interface Props {
  rootNodeId: string;
  nodes: BaseDetailNode[];
  edges: BaseDetailEdge[];
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  selectedCardId: string | null;
  onSelectCard: (card: BaseDetailCard) => void;
  onSelectNode: (nodeId: string) => void;
  filter?: string;
  filters?: BaseDetailFilter;
}

function date(value: unknown): string {
  if (!value) return '';
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleString();
}

function ProblemList({ card }: { card: BaseDetailCard }) {
  if (!card.problems?.length) return null;
  return (
    <details className="bd-card__problems">
      <summary>{card.problems.length} {i18n('practice')} {card.problems.length === 1 ? i18n('problem') : i18n('problems')}</summary>
      <ol>
        {card.problems.map((problem, index) => (
          <li key={String(problem.pid || index)}>{String(problem.title || problem.stem || problem.content || `${i18n('Problem')} ${index + 1}`).replace(/<[^>]+>/g, '').slice(0, 120)}</li>
        ))}
      </ol>
    </details>
  );
}

export function BaseDetailNodeContent({ rootNodeId, nodes, edges, nodeCardsMap, selectedCardId, onSelectCard, onSelectNode, filter = '', filters = { filterNode: '', filterCard: '', filterProblem: '', filterCardTag: '', filterProblemTag: '' } }: Props) {
  const query = filter.trim().toLowerCase();
  const sections = useMemo(() => [rootNodeId, ...collectSubtreeNodeIds(rootNodeId, nodes, edges)].map((nodeId) => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || !nodeMatchesFilter(node, filters)) return null;
    const cards = getSortedNodeCards(nodeId, nodeCardsMap).filter((card) => cardMatchesFilters(card, filters) && (!query || nodeMatchesSearch(node, query) || cardMatchesSearch(card, query)));
    if (!cards.length) return null;
    return { nodeId, node, cards };
  }).filter((section): section is { nodeId: string; node: BaseDetailNode; cards: BaseDetailCard[] } => !!section), [edges, filters, nodeCardsMap, nodes, query, rootNodeId]);

  if (!sections.length) return <div className="bd-empty bd-empty--content">{i18n('Base detail node empty')}</div>;
  return (
    <div className="bd-content">
      {sections.map(({ nodeId, node, cards }) => (
        <section className="bd-content__section" key={nodeId}>
          <h2 className="bd-content__section-title">
            {nodeId === rootNodeId ? nodeDisplayLabel(node) : <button type="button" onClick={() => onSelectNode(nodeId)}>{nodeDisplayLabel(node)}</button>}
          </h2>
          {cards.map((card) => {
            const cardId = String(card.docId);
            return (
              <article className={`bd-card${selectedCardId === cardId ? ' is-selected' : ''}`} id={`base-detail-card-${cardId}`} key={cardId}>
                <header className="bd-card__header">
                  <button type="button" className="bd-card__title" onClick={() => onSelectCard(card)}>{cardDisplayLabel(card)}</button>
                  <span className="bd-card__meta">{date(card.updateAt)}{card.problems?.length ? ` · ${card.problems.length} ${i18n('problems')}` : ''}</span>
                </header>
                {card.content ? <div className="bd-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.content) }} /> : <p className="bd-muted">{i18n('Base detail card empty')}</p>}
                {card.tags?.length ? <footer className="bd-card__tags">{card.tags.map((tag) => <span key={tag}>{tag}</span>)}</footer> : null}
                <ProblemList card={card} />
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}

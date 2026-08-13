import { Fragment, useMemo } from 'react';
import { i18n } from '../../i18n';
import {
  cardDisplayLabel,
  getMixedNodeChildren,
  nodeDisplayLabel,
} from './tree';
import { cardMatchesFilters, cardMatchesSearch, nodeMatchesFilter, nodeMatchesSearch, type BaseDetailFilter } from './detail-filter';
import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode, BaseDetailProblem } from './types';

interface Props {
  rootNodeIds: string[];
  nodes: BaseDetailNode[];
  edges: BaseDetailEdge[];
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  expandedNodes: Set<string>;
  onToggle: (nodeId: string) => void;
  selectedNodeId: string | null;
  selectedCardId: string | null;
  selectedProblemId?: string | null;
  onSelectNode: (nodeId: string) => void;
  onSelectCard: (card: BaseDetailCard) => void;
  onSelectProblem?: (card: BaseDetailCard, pid: string) => void;
  filter?: string;
  filters?: BaseDetailFilter;
  emptyMessage?: string;
}

function matches(card: BaseDetailCard, query: string): boolean {
  return cardMatchesSearch(card, query);
}

function problemLabel(problem: BaseDetailProblem, index: number): string {
  const title = String(problem.title || problem.stem || problem.content || '')
    .replace(/<[^>]+>/g, '').trim();
  return title.slice(0, 72) || `${i18n('Problem')} ${index + 1}`;
}

function TagList({ tags, problem = false }: { tags?: string[]; problem?: boolean }) {
  if (!tags?.length) return null;
  return (
    <span className={`bd-tree__tags${problem ? ' bd-tree__tags--problem' : ''}`}>
      {tags.map((tag) => <span className="bd-tree__tag" key={tag}>{tag}</span>)}
    </span>
  );
}

function CardIcon({ card }: { card: BaseDetailCard }) {
  const type = `${card.fileType || card.cardType || ''}`.toLowerCase();
  return <span className="bd-tree__card-icon" aria-hidden>{type === 'image' ? '▧' : type === 'pdf' ? '▤' : type === 'video' ? '▶' : '▱'}</span>;
}

function TreeBranch({
  nodeId, level, nodes, edges, nodeCardsMap, expandedNodes, onToggle,
  selectedNodeId, selectedCardId, selectedProblemId, onSelectNode, onSelectCard, onSelectProblem, query, filters,
}: Omit<Props, 'rootNodeIds' | 'emptyMessage' | 'filter' | 'filters'> & { nodeId: string; level: number; query: string; filters: BaseDetailFilter }) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  const children = getMixedNodeChildren(nodeId, nodes, edges, nodeCardsMap).filter((child) => (
    child.kind === 'node'
      ? subtreeMatches(child.node.id, nodes, edges, nodeCardsMap, query, filters)
      : cardMatchesFilters(child.card, filters) && (!query || matches(child.card, query) || nodeMatchesSearch(node, query))
  ));
  const expanded = expandedNodes.has(nodeId) || !!query || Object.values(filters).some(Boolean);
  const hasChildren = children.length > 0;

  return (
    <div className="bd-tree__branch">
      <div className={`bd-tree__row bd-tree__row--node${selectedNodeId === nodeId ? ' is-selected' : ''}${node.type === 'roadmap' ? ' is-roadmap' : ''}`} style={{ paddingLeft: `${level * 1.1}rem` }}>
        {hasChildren ? (
          <button type="button" className="bd-tree__toggle" onClick={() => onToggle(nodeId)} aria-expanded={expanded} aria-label={expanded ? i18n('Collapse') : i18n('Expand')}>
            {expanded ? '⌄' : '›'}
          </button>
        ) : <span className="bd-tree__toggle-spacer" />}
        <button type="button" className="bd-tree__main" onClick={() => onSelectNode(nodeId)}>
          <span className="bd-tree__node-icon" aria-hidden>{node.type === 'roadmap' ? '⌘' : expanded ? '▾' : '▸'}</span>
          <span className="bd-tree__label" title={nodeDisplayLabel(node)}>{nodeDisplayLabel(node)}</span>
        </button>
      </div>
      {expanded && hasChildren ? (
        <div className="bd-tree__children">
          {children.map((child) => child.kind === 'node' ? (
            <TreeBranch key={child.node.id} nodeId={child.node.id} level={level + 1} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={onToggle} selectedNodeId={selectedNodeId} selectedCardId={selectedCardId} selectedProblemId={selectedProblemId} onSelectNode={onSelectNode} onSelectCard={onSelectCard} onSelectProblem={onSelectProblem} query={query} filters={filters} />
          ) : (
            <Fragment key={child.card.docId}>
              <div className={`bd-tree__row bd-tree__row--card${selectedCardId === child.card.docId ? ' is-selected' : ''}`} style={{ paddingLeft: `${(level + 1) * 1.1}rem` }}>
                <span className="bd-tree__toggle-spacer" />
                <button type="button" className="bd-tree__main" onClick={() => onSelectCard(child.card)}>
                  <CardIcon card={child.card} />
                  <span className="bd-tree__label" title={cardDisplayLabel(child.card)}>{cardDisplayLabel(child.card)}</span>
                  {child.card.problems?.length ? <span className="bd-tree__problem-count">{child.card.problems.length}</span> : null}
                  <TagList tags={child.card.tags} />
                </button>
              </div>
              {child.card.problems?.map((problem, index) => {
                const pid = String(problem.pid || `problem-${index}`);
                return (
                  <button type="button" key={pid} className={`bd-tree__row bd-tree__row--problem${selectedProblemId === pid ? ' is-selected' : ''}`} style={{ paddingLeft: `${(level + 2) * 1.1}rem` }} onClick={() => { onSelectCard(child.card); onSelectProblem?.(child.card, pid); }}>
                    <span className="bd-tree__toggle-spacer" />
                    <span className="bd-tree__main"><span className="bd-tree__label">{problemLabel(problem, index)}</span><TagList tags={problem.tags} problem /></span>
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function hasCardFilters(filters: BaseDetailFilter): boolean {
  return !!(filters.filterCard.trim() || filters.filterProblem.trim() || filters.filterCardTag.trim() || filters.filterProblemTag.trim());
}

function cardIsVisible(card: BaseDetailCard, node: BaseDetailNode, query: string, filters: BaseDetailFilter): boolean {
  if (!nodeMatchesFilter(node, filters) || !cardMatchesFilters(card, filters)) return false;
  return !query || nodeMatchesSearch(node, query) || matches(card, query);
}

function subtreeMatches(nodeId: string, nodes: BaseDetailNode[], edges: BaseDetailEdge[], cards: Record<string, BaseDetailCard[]>, query: string, filters: BaseDetailFilter): boolean {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  const nodeMatches = nodeMatchesFilter(node, filters) && (!query || nodeMatchesSearch(node, query));
  const ownCards = getMixedNodeChildren(nodeId, nodes, edges, cards).filter((child): child is { kind: 'card'; card: BaseDetailCard; order: number } => child.kind === 'card');
  if (nodeMatches && (!hasCardFilters(filters) || ownCards.some((child) => cardMatchesFilters(child.card, filters)))) return true;
  return getMixedNodeChildren(nodeId, nodes, edges, cards).some((child) => child.kind === 'node'
    ? subtreeMatches(child.node.id, nodes, edges, cards, query, filters)
    : cardIsVisible(child.card, node, query, filters));
}

export function BaseDetailTree({ rootNodeIds, nodes, edges, nodeCardsMap, expandedNodes, onToggle, selectedNodeId, selectedCardId, selectedProblemId, onSelectNode, onSelectCard, onSelectProblem, filter = '', filters = { filterNode: '', filterCard: '', filterProblem: '', filterCardTag: '', filterProblemTag: '' }, emptyMessage = i18n('Base detail tree empty') }: Props) {
  const query = filter.trim().toLowerCase();
  const active = !!query || Object.values(filters).some(Boolean);
  const visibleRoots = useMemo(() => rootNodeIds.filter((id) => !active || subtreeMatches(id, nodes, edges, nodeCardsMap, query, filters)), [active, edges, filters, nodeCardsMap, nodes, query, rootNodeIds]);
  if (!visibleRoots.length) return <p className="bd-empty">{active ? i18n('Roadmap detail search no results') : emptyMessage}</p>;
  return <div className="bd-tree">{visibleRoots.map((id) => <TreeBranch key={id} nodeId={id} level={0} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={onToggle} selectedNodeId={selectedNodeId} selectedCardId={selectedCardId} selectedProblemId={selectedProblemId} onSelectNode={onSelectNode} onSelectCard={onSelectCard} onSelectProblem={onSelectProblem} query={query} filters={filters} />)}</div>;
}

import React from 'react';
import {
  cardDisplayLabel,
  getMixedNodeChildren,
  nodeDisplayLabel,
} from './tree';
import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode, BaseDetailProblem } from './types';

export interface BaseDetailTreeProps {
  rootNodeIds: string[];
  nodes: BaseDetailNode[];
  edges: BaseDetailEdge[];
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  expanded: Set<string>;
  onToggle(nodeId: string): void;
  selectedNodeId: string | null;
  selectedCardId: string | null;
  onSelectNode(nodeId: string): void;
  onSelectCard(card: BaseDetailCard): void;
  filter: string;
  unnamedNode: string;
  unnamedCard: string;
  showProblemTree?: boolean;
}

function cardMatches(card: BaseDetailCard, query: string): boolean {
  if (!query) return true;
  return `${card.title || ''} ${card.content || ''} ${(card.tags || []).join(' ')}`.toLowerCase().includes(query);
}

function subtreeMatches(
  nodeId: string,
  nodes: BaseDetailNode[],
  edges: BaseDetailEdge[],
  cards: Record<string, BaseDetailCard[]>,
  query: string,
): boolean {
  const node = nodes.find((item) => item.id === nodeId);
  if (node && node.text.toLowerCase().includes(query)) return true;
  const children = getMixedNodeChildren(nodeId, nodes, edges, cards);
  return children.some((child) => child.kind === 'card'
    ? cardMatches(child.card, query)
    : subtreeMatches(child.node.id, nodes, edges, cards, query));
}

function problemLabel(problem: BaseDetailProblem, index: number): string {
  const raw = String(problem.title || problem.stem || '').replace(/<[^>]+>/g, '').trim();
  return raw.slice(0, 60) || `#${index + 1}`;
}

function TagParts({ tags, problem = false }: { tags?: string[]; problem?: boolean }) {
  if (!tags?.length) return null;
  const parents: string[] = [];
  const children: Record<string, string[]> = {};
  tags.forEach((tag) => {
    const slash = tag.indexOf('/');
    if (slash > 0) {
      const parent = tag.slice(0, slash);
      (children[parent] ||= []).push(tag.slice(slash + 1));
    } else {
      parents.push(tag);
    }
  });
  if (!parents.length) return null;
  return (
    <span className={problem ? 'base-detail-tree__problem-tags' : 'base-detail-tree__card-tags'}>
      {parents.map((parent) => (
        <span key={parent} className={`base-detail-tree__tag${problem ? ' base-detail-tree__tag--problem' : ''}`}>
          <span>{parent}</span>
          {(children[parent] || []).map((child) => <span key={child}>/{child}</span>)}
        </span>
      ))}
    </span>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className={`base-detail-tree__chevron${expanded ? ' is-expanded' : ''}`}>
      <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NodeIcon({ expanded, roadmap }: { expanded: boolean; roadmap?: boolean }) {
  if (roadmap) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="4" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6 7.2l4-2.4M6 8.8l4 2.4" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  return <span aria-hidden>{expanded ? '▾' : '▸'}</span>;
}

function CardIcon({ card }: { card: BaseDetailCard }) {
  const fileType = `${card.fileType || card.cardType || ''}`.toLowerCase();
  const icon = fileType.includes('pdf') ? '▧'
    : fileType.includes('image') ? '▨'
      : fileType.includes('video') ? '▶'
        : fileType.includes('audio') ? '♫'
          : fileType.includes('code') ? '</>' : '▤';
  return <span aria-hidden>{icon}</span>;
}

function TimestampMeta({ createdAt, updateAt }: { createdAt?: string | Date; updateAt?: string | Date }) {
  const created = createdAt ? new Date(createdAt).toLocaleString() : '';
  const updated = updateAt ? new Date(updateAt).toLocaleString() : '';
  if (!created && !updated) return null;
  return <span className="base-detail-tree__meta">{[created && `Created at: ${created}`, updated && `Updated at: ${updated}`].filter(Boolean).join(' · ')}</span>;
}

export function BaseDetailTree({
  rootNodeIds, nodes, edges, nodeCardsMap, expanded, onToggle, selectedNodeId, selectedCardId,
  onSelectNode, onSelectCard, filter, unnamedNode, unnamedCard, showProblemTree = true,
}: BaseDetailTreeProps) {
  const query = filter.trim().toLowerCase();

  const renderNode = (nodeId: string, level: number): React.ReactNode => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || (query && !subtreeMatches(nodeId, nodes, edges, nodeCardsMap, query))) return null;
    const children = getMixedNodeChildren(nodeId, nodes, edges, nodeCardsMap)
      .filter((child) => !query || (child.kind === 'card' ? cardMatches(child.card, query) : subtreeMatches(child.node.id, nodes, edges, nodeCardsMap, query)));
    const isExpanded = expanded.has(nodeId) || !!query;
    const hasChildren = children.length > 0;
    return (
      <div key={`node-${nodeId}`} className="base-detail-tree__branch">
        <div
          className={`base-detail-tree__row base-detail-tree__row--node${node.type === 'roadmap' ? ' is-roadmap' : ''}${nodeId === selectedNodeId ? ' is-selected' : ''}`}
          style={{ paddingLeft: `${level * 16}px` }}
          data-node-id={nodeId}
        >
          {hasChildren ? (
            <button type="button" className="base-detail-tree__toggle" onClick={() => onToggle(nodeId)} aria-expanded={isExpanded} aria-label={isExpanded ? 'Collapse' : 'Expand'}>
              <ChevronIcon expanded={isExpanded} />
            </button>
          ) : <span className="base-detail-tree__toggle-spacer" aria-hidden />}
          <button type="button" className="base-detail-tree__row-main" onClick={() => onSelectNode(nodeId)}>
            <span className="base-detail-tree__icon"><NodeIcon expanded={isExpanded} roadmap={node.type === 'roadmap'} /></span>
            <span className="base-detail-tree__label-wrap">
              <span className="base-detail-tree__label" title={nodeDisplayLabel(node, unnamedNode)}>{nodeDisplayLabel(node, unnamedNode)}</span>
              <TimestampMeta createdAt={node.createdAt as string | Date | undefined} updateAt={node.updateAt as string | Date | undefined} />
            </span>
          </button>
        </div>
        {isExpanded && hasChildren ? (
          <div className="base-detail-tree__children">
            {children.map((child) => {
              if (child.kind === 'node') return renderNode(child.node.id, level + 1);
              const card = child.card;
              const cardId = String(card.docId);
              const problems = card.problems || [];
              return (
                <React.Fragment key={`card-${cardId}`}>
                  <div className={`base-detail-tree__row base-detail-tree__row--card${cardId === selectedCardId ? ' is-selected' : ''}`} style={{ paddingLeft: `${(level + 1) * 16}px` }} data-base-detail-card-id={cardId}>
                    <span className="base-detail-tree__toggle-spacer" aria-hidden />
                    <button type="button" className="base-detail-tree__row-main" onClick={() => onSelectCard(card)}>
                      <span className="base-detail-tree__icon"><CardIcon card={card} /></span>
                      <span className="base-detail-tree__label-wrap">
                        <span className="base-detail-tree__label" title={cardDisplayLabel(card, unnamedCard)}>{cardDisplayLabel(card, unnamedCard)}</span>
                        <TimestampMeta createdAt={card.createdAt} updateAt={card.updateAt} />
                      </span>
                      {problems.length ? <span className="base-detail-tree__problem-badge" title={`${problems.length} problems`}>{problems.length}</span> : null}
                      <TagParts tags={card.tags} />
                    </button>
                  </div>
                  {showProblemTree && problems.length ? (
                    <div className="base-detail-tree__problem-children">
                      {problems.map((problem, index) => (
                        <button key={problem.pid || index} type="button" className="base-detail-tree__row base-detail-tree__row--problem" style={{ paddingLeft: `${(level + 2) * 16}px` }} onClick={() => onSelectCard(card)}>
                          <span className="base-detail-tree__toggle-spacer" aria-hidden />
                          <span className="base-detail-tree__row-main">
                            <span className="base-detail-tree__label" title={problemLabel(problem, index)}>{problemLabel(problem, index)}</span>
                            <TagParts tags={problem.tags} problem />
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  const visibleRootIds = rootNodeIds.filter((rootId) => nodes.some((node) => node.id === rootId));
  if (!visibleRootIds.length) return <p className="roadmap-detail-drawer__empty">No nodes yet.</p>;
  return <div className="base-detail-tree">{visibleRootIds.map((rootId) => renderNode(rootId, 0))}</div>;
}

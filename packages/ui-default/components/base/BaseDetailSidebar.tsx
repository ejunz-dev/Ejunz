import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { i18n } from 'vj/utils';
import type { BaseEdge, BaseNode, Card } from './types';
import {
  cardDisplayLabel,
  collectDefaultExpandedNodeIds,
  getMixedNodeChildren,
  getRootNodeIds,
  nodeDisplayLabel,
} from './detail_tree';

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className={`base-detail-tree__chevron${expanded ? ' is-expanded' : ''}`}
    >
      <path
        d="M4.5 2.5L8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2.5" y="3" width="11" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 6.5h6M5 9h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3" y="2.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function RoadmapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 7.2l4-2.4M6 8.8l4 2.4" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function TreeBranch({
  nodeId,
  level,
  nodes,
  edges,
  nodeCardsMap,
  expandedNodes,
  selectedRoadmapNodeId,
  onToggleNode,
  onSelectRoadmapNode,
}: {
  nodeId: string;
  level: number;
  nodes: BaseNode[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  expandedNodes: Set<string>;
  selectedRoadmapNodeId?: string | null;
  onToggleNode: (nodeId: string) => void;
  onSelectRoadmapNode?: (nodeId: string) => void;
}) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return null;

  const isRoadmapNode = node.type === 'roadmap';
  const expanded = expandedNodes.has(nodeId);
  const children = isRoadmapNode ? [] : getMixedNodeChildren(nodeId, nodes, edges, nodeCardsMap);
  const hasChildren = children.length > 0;

  const isSelectedRoadmap = isRoadmapNode && selectedRoadmapNodeId === nodeId;

  return (
    <div className="base-detail-tree__branch">
      {isRoadmapNode ? (
        <button
          type="button"
          className={`base-detail-tree__row base-detail-tree__row--node base-detail-tree__row--roadmap-btn is-roadmap${isSelectedRoadmap ? ' is-selected' : ''}`}
          style={{ paddingLeft: `${level * 16}px` }}
          onClick={() => onSelectRoadmapNode?.(nodeId)}
        >
          <span className="base-detail-tree__toggle-spacer" aria-hidden />
          <span className="base-detail-tree__icon">
            <RoadmapIcon />
          </span>
          <span className="base-detail-tree__label" title={nodeDisplayLabel(node)}>
            {nodeDisplayLabel(node)}
          </span>
        </button>
      ) : (
      <div
        className="base-detail-tree__row base-detail-tree__row--node"
        style={{ paddingLeft: `${level * 16}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="base-detail-tree__toggle"
            onClick={() => onToggleNode(nodeId)}
            aria-expanded={expanded}
            aria-label={expanded ? i18n('Collapse') : i18n('Expand')}
          >
            <ChevronIcon expanded={expanded} />
          </button>
        ) : (
          <span className="base-detail-tree__toggle-spacer" aria-hidden />
        )}
        <span className="base-detail-tree__icon">
          <NodeIcon />
        </span>
        <span className="base-detail-tree__label" title={nodeDisplayLabel(node)}>
          {nodeDisplayLabel(node)}
        </span>
      </div>
      )}

      {expanded && hasChildren ? (
        <div className="base-detail-tree__children">
          {children.map((child) => {
            if (child.kind === 'node') {
              return (
                <TreeBranch
                  key={`node-${child.node.id}`}
                  nodeId={child.node.id}
                  level={level + 1}
                  nodes={nodes}
                  edges={edges}
                  nodeCardsMap={nodeCardsMap}
                  expandedNodes={expandedNodes}
                  selectedRoadmapNodeId={selectedRoadmapNodeId}
                  onToggleNode={onToggleNode}
                  onSelectRoadmapNode={onSelectRoadmapNode}
                />
              );
            }
            return (
              <div
                key={`card-${child.card.docId}`}
                className="base-detail-tree__row base-detail-tree__row--card"
                style={{ paddingLeft: `${(level + 1) * 16}px` }}
              >
                <span className="base-detail-tree__toggle-spacer" aria-hidden />
                <span className="base-detail-tree__icon">
                  <CardIcon />
                </span>
                <span className="base-detail-tree__label" title={cardDisplayLabel(child.card)}>
                  {cardDisplayLabel(child.card)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function BaseDetailTreeDrawer({
  open,
  nodes,
  edges,
  nodeCardsMap,
  selectedRoadmapNodeId,
  onClose,
  onSelectRoadmapNode,
}: {
  open: boolean;
  nodes: BaseNode[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  selectedRoadmapNodeId?: string | null;
  onClose: () => void;
  onSelectRoadmapNode?: (nodeId: string) => void;
}) {
  const rootNodeIds = useMemo(() => getRootNodeIds(nodes, edges), [nodes, edges]);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => (
    new Set(collectDefaultExpandedNodeIds(nodes, edges))
  ));

  useEffect(() => {
    setExpandedNodes(new Set(collectDefaultExpandedNodeIds(nodes, edges)));
  }, [nodes, edges]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const onToggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const nodeCount = nodes.length;
  const cardCount = useMemo(
    () => Object.values(nodeCardsMap).reduce((sum, cards) => sum + cards.length, 0),
    [nodeCardsMap],
  );

  if (!open) return null;

  return ReactDOM.createPortal(
    <>
      <button
        type="button"
        className="roadmap-detail-backdrop base-detail-tree-backdrop"
        onClick={onClose}
        aria-label={i18n('Close')}
      />
      <aside
        className="roadmap-detail-drawer roadmap-detail-drawer--left"
        aria-label={String(i18n('Document Structure'))}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="roadmap-detail-drawer__header">
          <div className="roadmap-detail-drawer__tabs" role="tablist">
            <span
              className="roadmap-detail-drawer__tab is-active"
              role="tab"
              aria-selected
            >
              {i18n('Document Structure')}
              <span className="roadmap-detail-drawer__tab-count">{nodeCount + cardCount}</span>
            </span>
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
          {rootNodeIds.length === 0 ? (
            <p className="roadmap-detail-drawer__empty">{i18n('Base detail tree empty')}</p>
          ) : (
            <div className="base-detail-tree">
              {rootNodeIds.map((rootId) => (
                <TreeBranch
                  key={rootId}
                  nodeId={rootId}
                  level={0}
                  nodes={nodes}
                  edges={edges}
                  nodeCardsMap={nodeCardsMap}
                  expandedNodes={expandedNodes}
                  selectedRoadmapNodeId={selectedRoadmapNodeId}
                  onToggleNode={onToggleNode}
                  onSelectRoadmapNode={onSelectRoadmapNode}
                />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

/** @deprecated Use BaseDetailTreeDrawer */
export const BaseDetailSidebar = BaseDetailTreeDrawer;

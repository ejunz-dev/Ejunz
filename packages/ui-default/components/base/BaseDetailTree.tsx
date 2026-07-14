import React, { useCallback, useEffect, useMemo, useState } from 'react';
import moment from 'moment';
import { i18n } from 'vj/utils';
import type { BaseEdge, BaseNode, Card } from './types';
import type { BaseDetailTreeVisibility } from './detail_tree_filter';
import type { BaseDetailDisplaySettings } from './detail_display_settings';
import { getCardProblemCount } from './detail_display_settings';
import {
  cardDisplayLabel,
  collectDefaultExpandedNodeIds,
  getMixedNodeChildren,
  nodeDisplayLabel,
} from './detail_tree';
import { getCardIcon, getCardColor } from './utils';
import {
  CardPdfIcon,
  CardImageIcon,
  CardVideoIcon,
  CardAudioIcon,
  CardCodeIcon,
  CardFileOtherIcon,
} from './BaseEditorCardIcons';
import { useBaseDetailCardScroll } from './url_sync';

function getTheme(): 'light' | 'dark' {
  try {
    if ((window as any).Ejunz?.utils?.getTheme) {
      return (window as any).Ejunz.utils.getTheme();
    }
    return (window as any).UserContext?.theme === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

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

function formatAbsoluteDate(raw?: string | Date | null): string {
  if (!raw) return '';
  const m = moment(raw);
  return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : '';
}

function formatRelativeDate(raw?: string | Date | null): string {
  if (!raw) return '';
  const m = moment(raw);
  return m.isValid() ? m.fromNow() : '';
}

function TimestampMeta({
  createdAt,
  updateAt,
}: {
  createdAt?: string | Date | null;
  updateAt?: string | Date | null;
}) {
  const created = formatAbsoluteDate(createdAt);
  const updated = formatRelativeDate(updateAt);
  if (!created && !updated) return null;
  const parts: string[] = [];
  if (created) parts.push(i18n('Created at: {0}', created));
  if (updated) parts.push(i18n('Updated at: {0}', updated));
  return (
    <span className="base-detail-tree__meta">
      {parts.join(' · ')}
    </span>
  );
}

function TreeBranch({
  nodeId,
  level,
  nodes,
  edges,
  nodeCardsMap,
  expandedNodes,
  selectedNodeId,
  selectedCardId,
  nodesClickable,
  treeVisibility,
  displaySettings,
  onToggleNode,
  onSelectNode,
  onSelectCard,
}: {
  nodeId: string;
  level: number;
  nodes: BaseNode[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  expandedNodes: Set<string>;
  selectedNodeId?: string | null;
  selectedCardId?: string | null;
  nodesClickable?: boolean;
  treeVisibility?: BaseDetailTreeVisibility | null;
  displaySettings?: BaseDetailDisplaySettings | null;
  onToggleNode: (nodeId: string) => void;
  onSelectNode?: (nodeId: string) => void;
  onSelectCard?: (card: Card) => void;
}) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  if (treeVisibility && !treeVisibility.visibleNodeIds.has(nodeId)) return null;

  const isRoadmapNode = node.type === 'roadmap';
  const expanded = expandedNodes.has(nodeId);
  const children = isRoadmapNode ? [] : getMixedNodeChildren(nodeId, nodes, edges, nodeCardsMap);
  const hasChildren = children.length > 0;
  const isSelected = nodesClickable !== false && selectedNodeId === nodeId;
  const showTimestamps = displaySettings?.showNodeCardTimestamps;
  const nodeLabel = (
    <>
      <span className="base-detail-tree__icon">
        {isRoadmapNode ? <RoadmapIcon /> : <NodeIcon />}
      </span>
      <span className="base-detail-tree__label-wrap">
        <span className="base-detail-tree__label" title={nodeDisplayLabel(node)}>
          {nodeDisplayLabel(node)}
        </span>
        {showTimestamps ? (
          <TimestampMeta createdAt={node.createdAt} updateAt={node.updateAt} />
        ) : null}
      </span>
    </>
  );

  return (
    <div className="base-detail-tree__branch">
      <div
        className={`base-detail-tree__row base-detail-tree__row--node${isRoadmapNode ? ' is-roadmap' : ''}${isSelected ? ' is-selected' : ''}${nodesClickable === false ? ' is-static' : ''}`}
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
        {nodesClickable !== false ? (
          <button
            type="button"
            className="base-detail-tree__row-main"
            onClick={() => onSelectNode?.(nodeId)}
          >
            {nodeLabel}
          </button>
        ) : (
          <span className="base-detail-tree__row-main base-detail-tree__row-main--static">
            {nodeLabel}
          </span>
        )}
      </div>

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
                  selectedNodeId={selectedNodeId}
                  selectedCardId={selectedCardId}
                  nodesClickable={nodesClickable}
                  treeVisibility={treeVisibility}
                  displaySettings={displaySettings}
                  onToggleNode={onToggleNode}
                  onSelectNode={onSelectNode}
                  onSelectCard={onSelectCard}
                />
              );
            }

            if (treeVisibility?.visibleCardIds && !treeVisibility.visibleCardIds.has(child.card.docId)) {
              return null;
            }

            const cardSelected = selectedCardId === child.card.docId;
            const problemCount = getCardProblemCount(child.card);
            const showProblemCount = displaySettings?.showProblemCount && problemCount > 0;
            const showCardTimestamps = displaySettings?.showNodeCardTimestamps;
            return (
              <div
                key={`card-${child.card.docId}`}
                className={`base-detail-tree__row base-detail-tree__row--card${cardSelected ? ' is-selected' : ''}`}
                style={{ paddingLeft: `${(level + 1) * 16}px` }}
                data-base-detail-card-id={child.card.docId}
              >
                <span className="base-detail-tree__toggle-spacer" aria-hidden />
                <button
                  type="button"
                  className="base-detail-tree__row-main"
                  onClick={() => onSelectCard?.(child.card)}
                >
                  <span className="base-detail-tree__icon">
                    {(() => {
                      const iconKey = getCardIcon(child.card?.cardType, child.card?.fileType);
                      if (iconKey === 'text') return <CardIcon />;
                      const size = 14;
                      const theme = getTheme();
                      const cardColor = getCardColor(iconKey, theme);
                      switch (iconKey) {
                        case 'pdf': return <CardPdfIcon size={size} color={cardColor} />;
                        case 'image': return <CardImageIcon size={size} color={cardColor} />;
                        case 'video': return <CardVideoIcon size={size} color={cardColor} />;
                        case 'audio': return <CardAudioIcon size={size} color={cardColor} />;
                        case 'code': return <CardCodeIcon size={size} color={cardColor} />;
                        default: return <CardFileOtherIcon size={size} color={cardColor} />;
                      }
                    })()}
                  </span>
                  <span className="base-detail-tree__label-wrap">
                    <span className="base-detail-tree__label" title={cardDisplayLabel(child.card)}>
                      {cardDisplayLabel(child.card)}
                    </span>
                    {showCardTimestamps ? (
                      <TimestampMeta createdAt={child.card.createdAt} updateAt={child.card.updateAt} />
                    ) : null}
                  </span>
                  {showProblemCount ? (
                    <span
                      className="base-detail-tree__problem-badge"
                      aria-label={String(problemCount)}
                      title={String(problemCount)}
                    >
                      {problemCount}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function BaseDetailTree({
  rootNodeIds,
  nodes,
  edges,
  nodeCardsMap,
  selectedNodeId,
  selectedCardId,
  initialExpandedNodeIds,
  extraExpandedNodeIds,
  scrollToCardId,
  emptyMessage,
  nodesClickable = true,
  treeVisibility = null,
  displaySettings = null,
  onSelectNode,
  onSelectCard,
}: {
  rootNodeIds: string[];
  nodes: BaseNode[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  selectedNodeId?: string | null;
  selectedCardId?: string | null;
  initialExpandedNodeIds?: string[];
  extraExpandedNodeIds?: string[];
  scrollToCardId?: string | null;
  emptyMessage?: string;
  nodesClickable?: boolean;
  treeVisibility?: BaseDetailTreeVisibility | null;
  displaySettings?: BaseDetailDisplaySettings | null;
  onSelectNode?: (nodeId: string) => void;
  onSelectCard?: (card: Card) => void;
}) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => (
    new Set(initialExpandedNodeIds || collectDefaultExpandedNodeIds(nodes, edges))
  ));

  useEffect(() => {
    setExpandedNodes(new Set(
      initialExpandedNodeIds || collectDefaultExpandedNodeIds(nodes, edges),
    ));
  }, [edges, initialExpandedNodeIds, nodes]);

  useEffect(() => {
    if (!treeVisibility?.forceExpandedNodeIds.size) return;
    setExpandedNodes((prev) => new Set([...prev, ...treeVisibility.forceExpandedNodeIds]));
  }, [treeVisibility]);

  useEffect(() => {
    if (!extraExpandedNodeIds?.length) return;
    setExpandedNodes((prev) => new Set([...prev, ...extraExpandedNodeIds]));
  }, [extraExpandedNodeIds]);

  const expandRetryKey = extraExpandedNodeIds?.join(':') || '';
  useBaseDetailCardScroll(scrollToCardId || null, expandRetryKey);

  const onToggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  if (rootNodeIds.length === 0) {
    return (
      <p className="roadmap-detail-drawer__empty">
        {emptyMessage || i18n('Base detail tree empty')}
      </p>
    );
  }

  const visibleRootIds = treeVisibility
    ? rootNodeIds.filter((rootId) => treeVisibility.visibleNodeIds.has(rootId))
    : rootNodeIds;

  if (visibleRootIds.length === 0) {
    return (
      <p className="roadmap-detail-drawer__empty">
        {i18n('Roadmap detail search no results')}
      </p>
    );
  }

  return (
    <div className="base-detail-tree">
      {visibleRootIds.map((rootId) => (
        <TreeBranch
          key={rootId}
          nodeId={rootId}
          level={0}
          nodes={nodes}
          edges={edges}
          nodeCardsMap={nodeCardsMap}
          expandedNodes={expandedNodes}
          selectedNodeId={selectedNodeId}
          selectedCardId={selectedCardId}
          nodesClickable={nodesClickable}
          treeVisibility={treeVisibility}
          displaySettings={displaySettings}
          onToggleNode={onToggleNode}
          onSelectNode={onSelectNode}
          onSelectCard={onSelectCard}
        />
      ))}
    </div>
  );
}

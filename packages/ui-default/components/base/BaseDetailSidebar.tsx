import React, { useMemo } from 'react';
import ReactDOM from 'react-dom';
import { i18n } from 'vj/utils';
import type { BaseEdge, BaseNode, Card } from './types';
import { BaseDetailTree } from './BaseDetailTree';
import { collectDefaultExpandedNodeIds, getRootNodeIds } from './detail_tree';
import { useDrawerTransition } from './useDrawerTransition';

import type { BaseDetailTreeVisibility } from './detail_tree_filter';
import type { BaseDetailDisplaySettings } from './detail_display_settings';

export function BaseDetailTreeDrawer({
  open,
  nodes,
  edges,
  nodeCardsMap,
  selectedNodeId,
  selectedCardId,
  treeVisibility,
  displaySettings,
  onClose,
  onSelectNode,
  onSelectCard,
}: {
  open: boolean;
  nodes: BaseNode[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  selectedNodeId?: string | null;
  selectedCardId?: string | null;
  treeVisibility?: BaseDetailTreeVisibility | null;
  displaySettings?: BaseDetailDisplaySettings | null;
  onClose: () => void;
  onSelectNode?: (nodeId: string) => void;
  onSelectCard?: (card: Card) => void;
}) {
  const rootNodeIds = useMemo(() => getRootNodeIds(nodes, edges), [nodes, edges]);
  const initialExpandedNodeIds = useMemo(
    () => collectDefaultExpandedNodeIds(nodes, edges),
    [nodes, edges],
  );
  const nodeCount = nodes.length;
  const cardCount = useMemo(
    () => Object.values(nodeCardsMap).reduce((sum, cards) => sum + cards.length, 0),
    [nodeCardsMap],
  );
  const { visible, closing } = useDrawerTransition(open);

  React.useEffect(() => {
    if (!visible || closing) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closing, onClose, visible]);

  if (!visible) return null;

  return ReactDOM.createPortal(
    <>
      <button
        type="button"
        className={`roadmap-detail-backdrop base-detail-tree-backdrop${closing ? ' is-closing' : ''}`}
        onClick={onClose}
        aria-label={i18n('Close')}
      />
      <aside
        className={`roadmap-detail-drawer roadmap-detail-drawer--left${closing ? ' is-closing' : ''}`}
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
          <BaseDetailTree
            rootNodeIds={rootNodeIds}
            nodes={nodes}
            edges={edges}
            nodeCardsMap={nodeCardsMap}
            selectedNodeId={selectedNodeId}
            selectedCardId={selectedCardId}
            initialExpandedNodeIds={initialExpandedNodeIds}
            emptyMessage={String(i18n('Base detail tree empty'))}
            treeVisibility={treeVisibility}
            displaySettings={displaySettings}
            onSelectNode={onSelectNode}
            onSelectCard={onSelectCard}
          />
        </div>
      </aside>
    </>,
    document.body,
  );
}

/** @deprecated Use BaseDetailTreeDrawer */
export const BaseDetailSidebar = BaseDetailTreeDrawer;

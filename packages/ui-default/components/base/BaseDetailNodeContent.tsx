import React, { useMemo } from 'react';
import type { BaseEdge, BaseNode, Card } from './types';
import { BaseDetailTree } from './BaseDetailTree';
import type { BaseDetailTreeVisibility } from './detail_tree_filter';
import { collectSubtreeDefaultExpandedNodeIds } from './detail_tree';

export function BaseDetailNodeContent({
  nodeId,
  nodes,
  edges,
  nodeCardsMap,
  selectedCardId,
  treeVisibility,
  onSelectCard,
}: {
  nodeId: string;
  nodes: BaseNode[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  selectedCardId?: string | null;
  treeVisibility?: BaseDetailTreeVisibility | null;
  onSelectCard: (card: Card) => void;
}) {
  const initialExpandedNodeIds = useMemo(
    () => collectSubtreeDefaultExpandedNodeIds(nodeId, nodes, edges),
    [nodeId, nodes, edges],
  );

  return (
    <div className="base-detail-node-tree">
      <BaseDetailTree
        rootNodeIds={[nodeId]}
        nodes={nodes}
        edges={edges}
        nodeCardsMap={nodeCardsMap}
        selectedCardId={selectedCardId}
        initialExpandedNodeIds={initialExpandedNodeIds}
        nodesClickable={false}
        treeVisibility={treeVisibility}
        onSelectCard={onSelectCard}
      />
    </div>
  );
}

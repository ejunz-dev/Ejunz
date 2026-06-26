import React, { useMemo } from 'react';
import type { BaseEdge, BaseNode, Card } from './types';
import { BaseDetailTree } from './BaseDetailTree';
import { collectSubtreeDefaultExpandedNodeIds } from './detail_tree';

export function BaseDetailNodeContent({
  nodeId,
  nodes,
  edges,
  nodeCardsMap,
  selectedNodeId,
  selectedCardId,
  onSelectNode,
  onSelectCard,
}: {
  nodeId: string;
  nodes: BaseNode[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  selectedNodeId?: string | null;
  selectedCardId?: string | null;
  onSelectNode: (nodeId: string) => void;
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
        selectedNodeId={selectedNodeId}
        selectedCardId={selectedCardId}
        initialExpandedNodeIds={initialExpandedNodeIds}
        onSelectNode={onSelectNode}
        onSelectCard={onSelectCard}
      />
    </div>
  );
}

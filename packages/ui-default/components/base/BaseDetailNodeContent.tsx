import React, { useMemo } from 'react';
import type { BaseEdge, BaseNode, Card } from './types';
import { BaseDetailTree } from './BaseDetailTree';
import type { BaseDetailTreeVisibility } from './detail_tree_filter';
import type { BaseDetailDisplaySettings } from './detail_display_settings';
import { collectSubtreeDefaultExpandedNodeIds } from './detail_tree';

export function BaseDetailNodeContent({
  nodeId,
  nodes,
  edges,
  nodeCardsMap,
  selectedCardId,
  selectedProblemId,
  onSelectProblem,
  treeVisibility,
  displaySettings,
  extraExpandedNodeIds,
  scrollToCardId,
  onSelectCard,
  onSelectNode,
  expandedNodes: controlledExpandedNodes,
  onExpandedNodesChange,
}: {
  nodeId: string;
  nodes: BaseNode[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  selectedCardId?: string | null;
  selectedProblemId?: string | null;
  onSelectProblem?: (pid: string) => void;
  treeVisibility?: BaseDetailTreeVisibility | null;
  displaySettings?: BaseDetailDisplaySettings | null;
  extraExpandedNodeIds?: string[];
  scrollToCardId?: string | null;
  onSelectCard: (card: Card) => void;
  onSelectNode?: (nodeId: string) => void;
  expandedNodes?: Set<string>;
  onExpandedNodesChange?: (nodeIds: Set<string>) => void;
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
        selectedProblemId={selectedProblemId}
        onSelectProblem={onSelectProblem}
        initialExpandedNodeIds={initialExpandedNodeIds}
        expandedNodes={controlledExpandedNodes}
        nodesClickable={true}
        treeVisibility={treeVisibility}
        displaySettings={displaySettings}
        extraExpandedNodeIds={extraExpandedNodeIds}
        scrollToCardId={scrollToCardId}
        onSelectCard={onSelectCard}
        onSelectNode={onSelectNode}
        onExpandedNodesChange={onExpandedNodesChange}
      />
    </div>
  );
}

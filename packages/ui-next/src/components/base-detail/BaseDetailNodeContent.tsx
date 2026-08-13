import { i18n } from '../../i18n';
import { BaseDetailTree } from './BaseDetailTree';
import type { BaseDetailFilter } from './detail-filter';
import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode } from './types';

interface Props {
  rootNodeId: string;
  nodes: BaseDetailNode[];
  edges: BaseDetailEdge[];
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  expandedNodes: Set<string>;
  onToggle: (nodeId: string) => void;
  selectedNodeId: string | null;
  selectedCardId: string | null;
  selectedProblemId?: string | null;
  onSelectCard: (card: BaseDetailCard) => void;
  onSelectNode: (nodeId: string) => void;
  onSelectProblem?: (card: BaseDetailCard, pid: string) => void;
  filter?: string;
  filters?: BaseDetailFilter;
}

export function BaseDetailNodeContent({
  rootNodeId,
  nodes,
  edges,
  nodeCardsMap,
  expandedNodes,
  onToggle,
  selectedNodeId,
  selectedCardId,
  selectedProblemId,
  onSelectCard,
  onSelectNode,
  onSelectProblem,
  filter = '',
  filters = { filterNode: '', filterCard: '', filterProblem: '', filterCardTag: '', filterProblemTag: '' },
}: Props) {
  return (
    <div className="bd-content bd-content--tree">
      <BaseDetailTree
        rootNodeIds={[rootNodeId]}
        nodes={nodes}
        edges={edges}
        nodeCardsMap={nodeCardsMap}
        expandedNodes={expandedNodes}
        onToggle={onToggle}
        selectedNodeId={selectedNodeId}
        selectedCardId={selectedCardId}
        selectedProblemId={selectedProblemId}
        onSelectNode={onSelectNode}
        onSelectCard={onSelectCard}
        onSelectProblem={onSelectProblem}
        filter={filter}
        filters={filters}
        emptyMessage={i18n('Base detail node empty')}
      />
    </div>
  );
}

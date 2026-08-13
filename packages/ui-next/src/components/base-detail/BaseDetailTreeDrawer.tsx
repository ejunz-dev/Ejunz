import { createPortal } from 'react-dom';
import { getRootNodeIds } from './tree';
import { BaseDetailTree } from './BaseDetailTree';
import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode } from './types';

interface Props {
  open: boolean;
  nodes: BaseDetailNode[];
  edges: BaseDetailEdge[];
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  expandedNodes: Set<string>;
  selectedNodeId: string | null;
  selectedCardId: string | null;
  onToggle: (nodeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onSelectCard: (card: BaseDetailCard) => void;
  onClose: () => void;
  filter?: string;
}

export function BaseDetailTreeDrawer({ open, nodes, edges, nodeCardsMap, expandedNodes, selectedNodeId, selectedCardId, onToggle, onSelectNode, onSelectCard, onClose, filter = '' }: Props) {
  if (!open) return null;
  const roots = getRootNodeIds(nodes, edges);
  return createPortal(
    <>
      <button type="button" className="bd-backdrop" onClick={onClose} aria-label="Close document structure" />
      <aside className="bd-drawer bd-drawer--tree" role="dialog" aria-modal="true" aria-label="Document structure">
        <header className="bd-drawer__header">
          <div><strong>Document structure</strong><span className="bd-drawer__count">{nodes.length + Object.values(nodeCardsMap).reduce((sum, cards) => sum + cards.length, 0)}</span></div>
          <button type="button" className="bd-drawer__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="bd-drawer__body"><BaseDetailTree rootNodeIds={roots} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={onToggle} selectedNodeId={selectedNodeId} selectedCardId={selectedCardId} onSelectNode={onSelectNode} onSelectCard={onSelectCard} filter={filter} /></div>
      </aside>
    </>,
    document.body,
  );
}

import { createPortal } from 'react-dom';
import { i18n } from '../../i18n';
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
  filters?: import('./detail-filter').BaseDetailFilter;
}

export function BaseDetailTreeDrawer({ open, nodes, edges, nodeCardsMap, expandedNodes, selectedNodeId, selectedCardId, onToggle, onSelectNode, onSelectCard, onClose, filter = '', filters }: Props) {
  if (!open) return null;
  const roots = getRootNodeIds(nodes, edges);
  return createPortal(
    <>
      <button type="button" className="bd-backdrop bd-tree-backdrop" onClick={onClose} aria-label={i18n('Close')} />
      <aside className="bd-drawer bd-drawer--tree bd-tree-drawer" role="dialog" aria-modal="true" aria-label={i18n('Document Structure')}>
        <header className="bd-drawer__header">
          <div><strong>{i18n('Document Structure')}</strong><span className="bd-drawer__count">{nodes.length + Object.values(nodeCardsMap).reduce((sum, cards) => sum + cards.length, 0)}</span></div>
          <button type="button" className="bd-drawer__close" onClick={onClose} aria-label={i18n('Close')}>×</button>
        </header>
        <div className="bd-drawer__body"><BaseDetailTree rootNodeIds={roots} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={onToggle} selectedNodeId={selectedNodeId} selectedCardId={selectedCardId} onSelectNode={onSelectNode} onSelectCard={onSelectCard} filter={filter} filters={filters} /></div>
      </aside>
    </>,
    document.body,
  );
}

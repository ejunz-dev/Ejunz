import { createPortal } from 'react-dom';
import { i18n } from '../../i18n';
import { getRootNodeIds } from './tree';
import { BaseDetailTree } from './BaseDetailTree';
import { useDrawerPresence, useDrawerResize, useDrawerSwipe } from './drawer-hooks';
import { treeDrawerWidthRange, type BaseDetailDisplaySettings } from './display-settings';
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
  displaySettings?: BaseDetailDisplaySettings;
  drawerWidth?: number;
  onResize?: (width: number) => void;
}

export function BaseDetailTreeDrawer({ open, nodes, edges, nodeCardsMap, expandedNodes, selectedNodeId, selectedCardId, onToggle, onSelectNode, onSelectCard, onClose, filter = '', filters, displaySettings, drawerWidth, onResize }: Props) {
  const { present, closing } = useDrawerPresence(open);
  const swipe = useDrawerSwipe('left', onClose);
  const width = drawerWidth ?? 420;
  const drawerWidthStyle = `min(${width}px, calc(100vw - 1rem))`;
  const resize = useDrawerResize({
    side: 'left',
    width,
    min: treeDrawerWidthRange.min,
    max: treeDrawerWidthRange.max,
    onWidth: onResize ?? (() => {}),
  });
  if (!present) return null;
  const roots = getRootNodeIds(nodes, edges);
  return createPortal(
    <>
      <button type="button" className={`bd-backdrop bd-tree-backdrop${closing ? ' is-closing' : ''}`} onClick={onClose} aria-label={i18n('Close')} />
      {onResize ? <div className="bd-drawer__resize bd-drawer__resize--tree" style={{ left: drawerWidthStyle }} data-dragging={resize.dragging || undefined} role="separator" aria-orientation="vertical" aria-label={i18n('Resize')} {...resize.handleProps} /> : null}
      <aside className={`bd-drawer bd-drawer--tree bd-tree-drawer${closing ? ' is-closing' : ''}`} style={{ width: drawerWidthStyle, ...swipe.style }} data-resizing={resize.dragging || undefined} onPointerDown={swipe.onPointerDown} onPointerMove={swipe.onPointerMove} onPointerUp={swipe.onPointerUp} onPointerCancel={swipe.onPointerCancel} role="dialog" aria-modal="true" aria-label={i18n('Document Structure')}>
        <header className="bd-drawer__header">
          <div><strong>{i18n('Document Structure')}</strong><span className="bd-drawer__count">{nodes.length + Object.values(nodeCardsMap).reduce((sum, cards) => sum + cards.length, 0)}</span></div>
          <button type="button" className="bd-drawer__close" onClick={onClose} aria-label={i18n('Close')}>×</button>
        </header>
        <div className="bd-drawer__body"><BaseDetailTree rootNodeIds={roots} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} onToggle={onToggle} expandedNodes={expandedNodes} selectedNodeId={selectedNodeId} selectedCardId={selectedCardId} onSelectNode={onSelectNode} onSelectCard={onSelectCard} filter={filter} filters={filters} displaySettings={displaySettings} /></div>
      </aside>
    </>,
    document.body,
  );
}

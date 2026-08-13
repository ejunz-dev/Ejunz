import React, { useCallback, useEffect, useRef } from 'react';
import { BaseDetailTree } from './BaseDetailTree';
import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode } from './types';
import { getRootNodeIds } from './tree';

export interface BaseDetailTreeDrawerProps {
  open: boolean;
  nodes: BaseDetailNode[];
  edges: BaseDetailEdge[];
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  selectedNodeId: string | null;
  selectedCardId: string | null;
  expandedNodes: Set<string>;
  drawerWidth?: number;
  onDrawerWidthChange?(width: number): void;
  onClose(): void;
  onSelectNode(nodeId: string): void;
  onSelectCard(card: BaseDetailCard): void;
  onToggle(nodeId: string): void;
  filter: string;
  unnamedNode: string;
  unnamedCard: string;
  labels: { close: string; title: string; empty: string };
}

export function BaseDetailTreeDrawer({
  open, nodes, edges, nodeCardsMap, selectedNodeId, selectedCardId, expandedNodes,
  drawerWidth = 352, onDrawerWidthChange, onClose, onSelectNode, onSelectCard, onToggle,
  filter, unnamedNode, unnamedCard, labels,
}: BaseDetailTreeDrawerProps) {
  const widthRef = useRef(drawerWidth);
  widthRef.current = drawerWidth;
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { startX: event.clientX, startWidth: widthRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !onDrawerWidthChange) return;
    onDrawerWidthChange(Math.max(240, Math.min(window.innerWidth - 40, dragRef.current.startWidth + event.clientX - dragRef.current.startX)));
  }, [onDrawerWidthChange]);
  const onPointerUp = useCallback(() => { dragRef.current = null; }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  return (
    <>
      <button type="button" className="roadmap-detail-backdrop base-detail-tree-backdrop ej-bd__backdrop" onClick={onClose} aria-label={labels.close} />
      <aside className="roadmap-detail-drawer roadmap-detail-drawer--left ej-bd__drawer ej-bd__drawer--left" style={{ width: drawerWidth }} aria-label={labels.title}>
        <div
          className="roadmap-detail-drawer__resize-handle"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        <div className="roadmap-detail-drawer__header ej-bd__drawer-head">
          <div className="roadmap-detail-drawer__tabs"><h2>{labels.title}</h2></div>
          <button type="button" className="roadmap-detail-drawer__close ej-bd__drawer-close" onClick={onClose} aria-label={labels.close}>×</button>
        </div>
        <div className="roadmap-detail-drawer__body">
          {nodes.length ? (
            <BaseDetailTree
              rootNodeIds={getRootNodeIds(nodes, edges)}
              nodes={nodes}
              edges={edges}
              nodeCardsMap={nodeCardsMap}
              expanded={expandedNodes}
              onToggle={onToggle}
              selectedNodeId={selectedNodeId}
              selectedCardId={selectedCardId}
              onSelectNode={onSelectNode}
              onSelectCard={onSelectCard}
              filter={filter}
              unnamedNode={unnamedNode}
              unnamedCard={unnamedCard}
            />
          ) : <p className="roadmap-detail-drawer__empty ej-bd-muted">{labels.empty}</p>}
        </div>
      </aside>
    </>
  );
}

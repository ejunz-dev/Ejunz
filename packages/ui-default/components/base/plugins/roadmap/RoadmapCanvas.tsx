import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import ReactFlow, {
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  useNodesState,
  useEdgesState,
  Controls,
  addEdge,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  roadmapShNodeTypes,
  RoadmapLaneOverlay,
  toRoadmapViewNodes,
  toRoadmapViewEdges,
  installRoadmapResizeObserverErrorGuard,
  useRoadmapEditorLayout,
  roadmapEditorFlowProps,
} from './flow_shared';
import {
  baseNodeToFlowNode,
  baseEdgeToFlowEdge,
  flowNodeToBaseNode,
  flowEdgeToBaseEdge,
  roadmapUntitledCardLabel,
} from './shared';
import {
  snapNodeToLane,
  nearestLaneFromX,
  getNodeLane,
  laneNodeX,
  getRoadmapNodeWidth,
  nextLaneNodeY,
} from './lanes';
import {
  ROADMAP_NODE_KINDS,
  roadmapCardKindLabel,
  defaultNodeDataForKind,
} from './node_kinds';
import {
  computeAdjacentNodePlacement,
  buildEdgeForNodes,
  connectionFromEdge,
  placementYForBottom,
  placementYForTop,
  getBlockedAddAdjacentDirections,
  type AddAdjacentDirection,
} from './add_adjacent';
import {
  alignNodesInSolidComponents,
  shouldAlignSolidConnection,
  getSolidLinkedNodeIds,
} from './solid_links';
import type { BaseNode, BaseEdge } from 'vj/components/base/types';
import { i18n } from 'vj/utils';

export type RoadmapCanvasKind = 'main' | 'sub' | 'hook' | 'text';

export interface RoadmapCanvasProps {
  childNodes: BaseNode[];
  childEdges: BaseEdge[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onFlowChange: (nodes: BaseNode[], edges: BaseEdge[]) => void;
  themeStyles: Record<string, string>;
}

function newCardId(): string {
  return `temp-node-${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
function newEdgeId(source: string, target: string): string {
  return `edge_${source}_${target}_${Date.now().toString(36)}`;
}

type CtxState =
  | null
  | { kind: 'pane'; x: number; y: number; flowX: number; flowY: number }
  | { kind: 'node'; x: number; y: number; nodeId: string };

type NodeAddState = {
  nodeId: string;
  direction: AddAdjacentDirection;
  x: number;
  y: number;
} | null;

function RoadmapCanvasContent({
  childNodes,
  childEdges,
  selectedNodeId,
  onSelectNode,
  onFlowChange,
  themeStyles,
}: RoadmapCanvasProps) {
  const initialFlowNodes = useMemo(
    () =>
      (childNodes || []).map((n, i) => {
        const flowNode = baseNodeToFlowNode(
          {
            id: n.id,
            text: n.text || roadmapUntitledCardLabel(),
            x: (n.data as any)?.posX,
            y: (n.data as any)?.posY,
            width: n.width,
            height: n.height,
            shape: n.shape,
            color: n.color,
            backgroundColor: n.backgroundColor,
            fontSize: n.fontSize,
            data: n.data || {},
          },
          i,
        );
        return snapNodeToLane(flowNode, getNodeLane(flowNode));
      }),
    [childNodes],
  );
  const initialFlowEdges = useMemo(
    () => (childEdges || []).map(baseEdgeToFlowEdge),
    [childEdges],
  );

  const flowStructureKey = useMemo(
    () => [
      childNodes.map((n) => n.id).sort().join(','),
      childEdges.map((e) => e.id).sort().join(','),
    ].join('|'),
    [childNodes, childEdges],
  );
  const syncedStructureKeyRef = useRef(flowStructureKey);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlowEdges);
  const { outerRef, flowRef, onFlowInit, fitToContent } = useRoadmapEditorLayout(nodes);

  useEffect(() => {
    installRoadmapResizeObserverErrorGuard();
  }, []);

  // Only remount flow state when node/edge membership changes — not on every parent pos refresh.
  useEffect(() => {
    if (syncedStructureKeyRef.current === flowStructureKey) return;
    syncedStructureKeyRef.current = flowStructureKey;
    setNodes(initialFlowNodes);
    setEdges(initialFlowEdges);
  }, [flowStructureKey, initialFlowNodes, initialFlowEdges, setNodes, setEdges]);

  const flowContentKey = useMemo(
    () => childNodes.map((n) => `${n.id}:${n.text || ''}`).sort().join('|'),
    [childNodes],
  );

  // Sync canvas labels when card titles change without remounting the whole flow.
  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(childNodes.map((n) => [n.id, n]));
      let changed = false;
      const next = current.map((node) => {
        const baseNode = byId.get(node.id);
        if (!baseNode) return node;
        const label = baseNode.text || roadmapUntitledCardLabel();
        if (String(node.data?.label || '') === label) return node;
        changed = true;
        return { ...node, data: { ...node.data, label } };
      });
      return changed ? next : current;
    });
  }, [flowContentKey, childNodes, setNodes]);

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxState>(null);
  const [nodeAddMenu, setNodeAddMenu] = useState<NodeAddState>(null);

  const flowCardsToBase = useCallback((flowNodes: Node[], flowEdges: Edge[]) => {
    const baseCards = flowNodes.map((node) => {
      const bn = flowNodeToBaseNode(node);
      return {
        id: bn.id,
        text: bn.text,
        x: bn.x,
        y: bn.y,
        width: bn.width,
        height: bn.height,
        data: { ...bn.data, posX: bn.x, posY: bn.y, lane: node.data?.lane },
      } as BaseNode;
    });
    const baseEdgesOut = flowEdges.map((edge) => flowEdgeToBaseEdge(edge));
    onFlowChange(baseCards, baseEdgesOut);
  }, [onFlowChange]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const applied: NodeChange[] = [];
    changes.forEach((change) => {
      if (change.type === 'select') return;
      if (change.type !== 'position' || !change.position || !('id' in change)) {
        applied.push(change);
        return;
      }
      const id = String(change.id);
      const draggedCard = nodes.find((node) => node.id === id);
      const cardWidth = draggedCard ? getRoadmapNodeWidth(draggedCard) : undefined;
      const lane = nearestLaneFromX(change.position.x + (cardWidth || 260) / 2);
      const x = laneNodeX(lane, cardWidth);
      const y = change.position.y;
      const linked = getSolidLinkedNodeIds(id, edges, nodes);
      const sharedY = linked.size > 1 ? y : y;

      applied.push({
        ...change,
        position: { x, y: sharedY },
      });

      if (linked.size > 1) {
        linked.forEach((peerId) => {
          if (peerId === id) return;
          const peer = nodes.find((node) => node.id === peerId);
          if (!peer) return;
          applied.push({
            type: 'position',
            id: peerId,
            position: {
              x: laneNodeX(
                nearestLaneFromX(peer.position.x + getRoadmapNodeWidth(peer) / 2),
                getRoadmapNodeWidth(peer),
              ),
              y: sharedY,
            },
            dragging: change.dragging,
          });
        });
      }
    });
    onNodesChange(applied);
  }, [edges, nodes, onNodesChange]);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    onEdgesChange(changes.filter((change) => change.type !== 'select'));
  }, [onEdgesChange]);

  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, dragged: Node) => {
      setNodes((current) => {
        const linked = getSolidLinkedNodeIds(dragged.id, edges, current);
        const snapped = current.map((node) => {
          if (node.id !== dragged.id && !linked.has(node.id)) return node;
          return snapNodeToLane(node, nearestLaneFromX(node.position.x + getRoadmapNodeWidth(node) / 2));
        });
        const aligned = alignNodesInSolidComponents(snapped, edges);
        window.setTimeout(() => flowCardsToBase(aligned, edges), 0);
        return aligned;
      });
    },
    [edges, setNodes, flowCardsToBase],
  );

  const scheduleFlowSync = useCallback((flowNodes: Node[], flowEdges: Edge[]) => {
    window.setTimeout(() => flowCardsToBase(flowNodes, flowEdges), 0);
  }, [flowCardsToBase]);

  const addRoadmapCardAt = useCallback(
    (flowPosition?: { x: number; y: number }, kind: RoadmapCanvasKind = 'sub') => {
      const id = newCardId();
      const lane = flowPosition ? nearestLaneFromX(flowPosition.x) : 1;
      const card: Node = {
        id,
        type: 'roadmap',
        position: {
          x: 0,
          y: flowPosition?.y ?? 0,
        },
        data: {
          label: kind === 'text' ? '' : roadmapUntitledCardLabel(),
          lane,
          ...defaultNodeDataForKind(kind),
        },
      };
      setNodes((current) => {
        const next = [...current, snapNodeToLane(card, lane)];
        scheduleFlowSync(next, edges);
        return next;
      });
      onSelectNode(id);
      setSelectedEdgeId(null);
    },
    [edges, setNodes, onSelectNode, scheduleFlowSync],
  );

  const addAdjacentCard = useCallback(
    (sourceCardId: string, direction: AddAdjacentDirection, kind: RoadmapCanvasKind) => {
      const sourceCard = nodes.find((node) => node.id === sourceCardId);
      if (!sourceCard) return;
      const placement = computeAdjacentNodePlacement(sourceCard, direction, nodes);
      if (!placement) return;
      const newId = newCardId();
      const pos = { ...placement.position };
      if (direction === 'bottom') pos.y = placementYForBottom(nodes, placement.lane, pos.y);
      else if (direction === 'top') pos.y = placementYForTop(nodes, placement.lane, pos.y);
      const newCard: Node = {
        id: newId,
        type: 'roadmap',
        position: pos,
        data: {
          label: kind === 'text' ? '' : roadmapUntitledCardLabel(),
          lane: placement.lane,
          ...defaultNodeDataForKind(kind),
        },
      };
      const sourceId = placement.sourceId || newId;
      const targetId = placement.targetId || newId;
      const sourceType = sourceId === newId ? kind : nodes.find((n) => n.id === sourceId)?.data?.roadmapNodeType;
      const targetType = targetId === newId ? kind : nodes.find((n) => n.id === targetId)?.data?.roadmapNodeType;
      const edge = buildEdgeForNodes(sourceId, targetId, placement.sourceHandle, placement.targetHandle, sourceType, targetType, newEdgeId(sourceId, targetId));
      const conn = connectionFromEdge(edge);
      setEdges((cur) => {
        const nextEdges = addEdge(edge, cur);
        setNodes((curNodes) => {
          const withNew = [...curNodes, snapNodeToLane(newCard, placement.lane)];
          const nextNodes = shouldAlignSolidConnection(conn) ? alignNodesInSolidComponents(withNew, nextEdges) : withNew;
          scheduleFlowSync(nextNodes, nextEdges);
          return nextNodes;
        });
        return nextEdges;
      });
      onSelectNode(newId);
      setSelectedEdgeId(null);
      setNodeAddMenu(null);
    },
    [nodes, setEdges, setNodes, onSelectNode, scheduleFlowSync],
  );

  const deleteCard = useCallback(
    (cardId: string) => {
      const nextNodes = nodes.filter((n) => n.id !== cardId);
      const nextEdges = edges.filter((e) => e.source !== cardId && e.target !== cardId);
      setNodes(nextNodes);
      setEdges(nextEdges);
      scheduleFlowSync(nextNodes, nextEdges);
      if (selectedNodeId === cardId) onSelectNode(null);
    },
    [edges, nodes, selectedNodeId, setEdges, setNodes, onSelectNode, scheduleFlowSync],
  );

  const deleteSelection = useCallback(() => {
    if (selectedEdgeId) {
      const nextEdges = edges.filter((e) => e.id !== selectedEdgeId);
      setEdges(nextEdges);
      scheduleFlowSync(nodes, nextEdges);
      setSelectedEdgeId(null);
      return;
    }
    if (selectedNodeId) deleteCard(selectedNodeId);
  }, [deleteCard, edges, nodes, selectedEdgeId, selectedNodeId, setEdges, scheduleFlowSync]);

  const closeCtx = useCallback(() => {
    setCtxMenu(null);
    setNodeAddMenu(null);
  }, []);

  useEffect(() => {
    if (!ctxMenu && !nodeAddMenu) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCtx();
    };
    const onDocClose = (ev: MouseEvent) => {
      if ((ev.target as Element | null)?.closest?.('[data-rm-ctx]')) return;
      closeCtx();
    };
    const tid = window.setTimeout(() => window.addEventListener('click', onDocClose), 0);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.clearTimeout(tid);
      window.removeEventListener('click', onDocClose);
      window.removeEventListener('keydown', onEsc);
    };
  }, [closeCtx, ctxMenu, nodeAddMenu]);

  const viewNodes = useMemo(() => {
    return toRoadmapViewNodes(nodes, selectedNodeId).map((node) => ({
      ...node,
      data: {
        ...node.data,
        editable: true,
        blockedAddDirections: [...getBlockedAddAdjacentDirections(node.id, edges, nodes)],
        onRequestAddAdjacent: (direction: AddAdjacentDirection, event: React.MouseEvent) => {
          event.stopPropagation();
          setNodeAddMenu({ nodeId: node.id, direction, x: event.clientX, y: event.clientY });
          setCtxMenu(null);
        },
      },
    }));
  }, [nodes, selectedNodeId, edges]);

  const viewEdges = useMemo(() => toRoadmapViewEdges(edges, selectedEdgeId, undefined, 'light'), [edges, selectedEdgeId]);

  const shellStyle: React.CSSProperties = {
    position: 'fixed',
    backgroundColor: themeStyles.bgPrimary,
    border: `1px solid ${themeStyles.borderSecondary}`,
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    zIndex: 1100,
    minWidth: '180px',
    padding: '4px 0',
  };
  const itemStyle: React.CSSProperties = {
    padding: '6px 16px',
    cursor: 'pointer',
    fontSize: '13px',
    color: themeStyles.textPrimary,
  };
  const dangerStyle: React.CSSProperties = { ...itemStyle, color: themeStyles.error };
  const sep: React.CSSProperties = { height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' };

  useEffect(() => {
    const styleId = 'roadmap-canvas-css';
    if (document.getElementById(styleId)) return;
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = [
      '.roadmap-sh-node{position:relative;width:260px;min-width:260px;max-width:260px;box-sizing:border-box;padding:10px 16px;border:2px solid #4135d6;border-radius:8px;background:#ffe599;color:#111;text-align:center;cursor:default}',
      '.roadmap-sh-node.is-selected{border-color:#1a5fb4!important;box-shadow:0 0 0 3px rgba(26,95,180,0.35)!important}',
      '.roadmap-sh-node--kind-main{background:#ffeb3b;border-color:#e6c200}',
      '.roadmap-sh-node--kind-sub{background:#fff9c4;border-color:#e8d44a;width:100%;min-width:180px;max-width:100%}',
      '.roadmap-sh-node--kind-hook{background:#6eb3ff;border-color:#2b78e4}',
      '.roadmap-sh-node--kind-text{background:#fff;border-color:#d8d8d8;text-align:left;max-width:360px}',
      '.roadmap-sh-node__title{font-size:15px;font-weight:500;line-height:1.35;word-break:break-word}',
      '.roadmap-sh-node__handle{width:10px;height:10px;border:2px solid #fff;background:#2b78e4}',
      '.roadmap-sh-node__add{position:absolute;width:22px;height:22px;border-radius:50%;border:2px solid #1a5fb4;background:#fff;color:#1a5fb4;font-size:16px;line-height:1;padding:0;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2;box-shadow:0 1px 4px rgba(0,0,0,0.15)}',
      '.roadmap-sh-node__add:hover{background:#1a5fb4;color:#fff}',
      '.roadmap-sh-node__add--top{top:-11px;left:50%;transform:translateX(-50%)}',
      '.roadmap-sh-node__add--bottom{bottom:-11px;left:50%;transform:translateX(-50%)}',
      '.roadmap-sh-node__add--left{left:-11px;top:50%;transform:translateY(-50%)}',
      '.roadmap-sh-node__add--right{right:-11px;top:50%;transform:translateY(-50%)}',
      '.roadmap-sh-node__problem-badge{position:absolute;top:-8px;right:-8px;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#4135d6;color:#fff;font-size:11px;font-weight:700;line-height:20px;text-align:center;pointer-events:none}',
      '.roadmap-sh-node__number{position:absolute;top:-8px;left:-8px;font-size:12px;font-weight:700;color:#2e7d32;pointer-events:none}',
      '.roadmap-lane-overlay{position:absolute;top:0;left:0;pointer-events:none;z-index:1;overflow:hidden}',
      '.roadmap-lane-overlay__world{position:absolute;top:0;left:0;transform-origin:0 0}',
      '.roadmap-lane-guide{position:absolute;top:0;pointer-events:none;border-left:1px dashed rgba(65,53,214,0.22);border-right:1px dashed rgba(65,53,214,0.22);background:linear-gradient(180deg,rgba(65,53,214,0.05) 0%,rgba(65,53,214,0.02) 100%);border-radius:12px;box-sizing:border-box}',
      '.roadmap-lane-guide__label{position:absolute;top:12px;left:50%;transform:translateX(-50%);width:28px;height:28px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#4135d6;background:rgba(255,255,255,0.92);border:1px solid rgba(65,53,214,0.28)}',
      '.roadmap-flow--workspace{flex:1;min-height:0;height:100%;overflow:hidden;display:flex;flex-direction:column}',
      '.roadmap-flow__canvas{flex:1;min-height:0;height:100%;width:100%}',
      '.roadmap-flow__canvas .react-flow{width:100%;height:100%}',
    ].join('');
    document.head.appendChild(s);
  }, []);

  return (
    <div ref={outerRef} className="roadmap-flow roadmap-flow--workspace">
      <div className="roadmap-flow__canvas">
      <ReactFlow
        nodes={viewNodes}
        edges={viewEdges}
        nodeTypes={roadmapShNodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onInit={onFlowInit}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, node) => {
          if (!node.data?.isPendingGhost) {
            setCtxMenu(null);
            onSelectNode(node.id);
          }
        }}
        onEdgeClick={(_, edge) => {
          if (!edge.data?.isPendingGhost) {
            setSelectedEdgeId(edge.id);
          }
        }}
        onPaneClick={() => {
          onSelectNode(null);
          setSelectedEdgeId(null);
          setNodeAddMenu(null);
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          const pos = flowRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY })
            || { x: 0, y: nextLaneNodeY(nodes, 1) };
          setNodeAddMenu(null);
          setCtxMenu({ kind: 'pane', x: e.clientX, y: e.clientY, flowX: pos.x, flowY: pos.y });
        }}
        onNodeContextMenu={(e, node) => {
          if (node.data?.isPendingGhost) return;
          e.preventDefault();
          e.stopPropagation();
          onSelectNode(node.id);
          setNodeAddMenu(null);
          setCtxMenu({ kind: 'node', x: e.clientX, y: e.clientY, nodeId: node.id });
        }}
        elementsSelectable
        edgesFocusable={false}
        nodesConnectable={false}
        {...roadmapEditorFlowProps}
      >
        <RoadmapLaneOverlay />
        <Controls showInteractive={false} />
      </ReactFlow>
      </div>

      {ctxMenu && (
        <div data-rm-ctx style={{ ...shellStyle, left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          {ctxMenu.kind === 'pane' ? (
            <>
              <div style={{ padding: '6px 12px 4px', fontSize: '11px', color: themeStyles.textSecondary }}>{i18n('Base roadmap new card')}</div>
              {ROADMAP_NODE_KINDS.map((kind) => (
                <div
                  key={kind}
                  style={itemStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                  onClick={() => { addRoadmapCardAt({ x: ctxMenu.flowX || 0, y: ctxMenu.flowY || 0 }, kind); closeCtx(); }}
                >
                  {roadmapCardKindLabel(kind)}
                </div>
              ))}
              <div style={sep} />
              <div
                style={itemStyle}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                onClick={() => { fitToContent(); closeCtx(); }}
              >
                适应画布
              </div>
              {(selectedNodeId || selectedEdgeId) ? (
                <>
                  <div style={sep} />
                  <div
                    style={dangerStyle}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                    onClick={() => { deleteSelection(); closeCtx(); }}
                  >
                    删除
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <>
              <div style={{ padding: '6px 12px 4px', fontSize: '11px', color: themeStyles.textSecondary }}>{i18n('Base roadmap new card')}</div>
              {ROADMAP_NODE_KINDS.map((kind) => (
                <div
                  key={kind}
                  style={itemStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                  onClick={() => { addRoadmapCardAt(undefined, kind); closeCtx(); }}
                >
                  {roadmapCardKindLabel(kind)}
                </div>
              ))}
              <div style={sep} />
              <div
                style={itemStyle}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                onClick={() => { fitToContent(); closeCtx(); }}
              >
                适应画布
              </div>
              <div style={sep} />
              <div
                style={dangerStyle}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                onClick={() => { if (ctxMenu.kind === 'node' && ctxMenu.nodeId) deleteCard(ctxMenu.nodeId); closeCtx(); }}
              >
                删除
              </div>
            </>
          )}
        </div>
      )}

      {nodeAddMenu && (
        <div data-rm-ctx style={{ ...shellStyle, left: nodeAddMenu.x, top: nodeAddMenu.y }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <div style={{ padding: '6px 12px 4px', fontSize: '11px', color: themeStyles.textSecondary }}>{i18n('Base roadmap new card')}</div>
          {ROADMAP_NODE_KINDS.map((kind) => (
            <div
              key={kind}
              style={itemStyle}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              onClick={() => { addAdjacentCard(nodeAddMenu.nodeId, nodeAddMenu.direction, kind); }}
            >
              {roadmapCardKindLabel(kind)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const RoadmapCanvas = React.memo(RoadmapCanvasContent);

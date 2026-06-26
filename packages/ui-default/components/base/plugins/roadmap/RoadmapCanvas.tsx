import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import ReactFlow, {
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  ReactFlowInstance,
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

function newNodeId(): string {
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
  const fitStructureKeyRef = useRef<string | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlowEdges);
  const flowRef = useRef<ReactFlowInstance | null>(null);

  useEffect(() => {
    installRoadmapResizeObserverErrorGuard();
  }, []);

  // Only remount flow state when node/edge membership changes — not on every parent pos refresh.
  useEffect(() => {
    if (syncedStructureKeyRef.current === flowStructureKey) return;
    syncedStructureKeyRef.current = flowStructureKey;
    setNodes(initialFlowNodes);
    setEdges(initialFlowEdges);
    if (initialFlowNodes.length === 0 || fitStructureKeyRef.current === flowStructureKey) return;
    fitStructureKeyRef.current = flowStructureKey;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      flowRef.current?.fitView({ padding: 0.2, duration: 0 });
    });
    return () => cancelAnimationFrame(frame);
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

  const outerRef = useRef<HTMLDivElement>(null);
  const fitToContent = useCallback(() => {
    requestAnimationFrame(() => {
      flowRef.current?.fitView({ padding: 0.2, duration: 200 });
    });
  }, []);
  const onFlowInit = useCallback((instance: ReactFlowInstance) => {
    flowRef.current = instance;
  }, []);

  const syncToParent = useCallback(() => {
    const baseOut = nodes.map((node) => {
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
    const edgeOut = edges.map((edge) => flowEdgeToBaseEdge(edge));
    onFlowChange(baseOut, edgeOut);
  }, [nodes, edges, onFlowChange]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const applied: NodeChange[] = [];
    let shouldSync = false;
    changes.forEach((change) => {
      if (change.type === 'select') return;
      if (change.type === 'dimensions') {
        applied.push(change);
        return;
      }
      if (change.type !== 'position' || !change.position || !('id' in change)) {
        applied.push(change);
        shouldSync = true;
        return;
      }
      const id = String(change.id);
      applied.push({ ...change, position: { x: laneNodeX(nearestLaneFromX(change.position.x + 130)), y: change.position.y } });
      if (!change.dragging) shouldSync = true;
    });
    if (applied.length) onNodesChange(applied);
    if (shouldSync) window.setTimeout(syncToParent, 0);
  }, [onNodesChange, syncToParent]);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    onEdgesChange(changes.filter((c) => c.type !== 'select'));
    window.setTimeout(syncToParent, 0);
  }, [onEdgesChange, syncToParent]);

  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, dragged: Node) => {
      setNodes((current) => {
        const snapped = current.map((node) => {
          if (node.id !== dragged.id) return node;
          return snapNodeToLane(node, nearestLaneFromX(node.position.x + 130));
        });
        return alignNodesInSolidComponents(snapped, edges);
      });
      window.setTimeout(syncToParent, 0);
    },
    [edges, setNodes, syncToParent],
  );

  const addRoadmapNodeAt = useCallback(
    (flowPosition?: { x: number; y: number }, kind: RoadmapCanvasKind = 'sub') => {
      const id = newNodeId();
      const lane = flowPosition ? nearestLaneFromX(flowPosition.x) : 1;
      const node: Node = {
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
      setNodes((current) => [...current, snapNodeToLane(node, lane)]);
      onSelectNode(id);
      setSelectedEdgeId(null);
      window.setTimeout(syncToParent, 0);
    },
    [setNodes, onSelectNode, syncToParent],
  );

  const addAdjacentNode = useCallback(
    (sourceNodeId: string, direction: AddAdjacentDirection, kind: RoadmapCanvasKind) => {
      const sourceNode = nodes.find((node) => node.id === sourceNodeId);
      if (!sourceNode) return;
      const placement = computeAdjacentNodePlacement(sourceNode, direction, nodes);
      if (!placement) return;
      const newId = newNodeId();
      const pos = { ...placement.position };
      if (direction === 'bottom') pos.y = placementYForBottom(nodes, placement.lane, pos.y);
      else if (direction === 'top') pos.y = placementYForTop(nodes, placement.lane, pos.y);
      const newNode: Node = {
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
          const withNew = [...curNodes, snapNodeToLane(newNode, placement.lane)];
          if (shouldAlignSolidConnection(conn)) return alignNodesInSolidComponents(withNew, nextEdges);
          return withNew;
        });
        return nextEdges;
      });
      onSelectNode(newId);
      setSelectedEdgeId(null);
      setNodeAddMenu(null);
      window.setTimeout(syncToParent, 0);
    },
    [nodes, setEdges, setNodes, onSelectNode, syncToParent],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((cur) => cur.filter((n) => n.id !== nodeId));
      setEdges((cur) => cur.filter((e) => e.source !== nodeId && e.target !== nodeId));
      if (selectedNodeId === nodeId) onSelectNode(null);
      window.setTimeout(syncToParent, 0);
    },
    [selectedNodeId, setEdges, setNodes, onSelectNode, syncToParent],
  );

  const deleteSelection = useCallback(() => {
    if (selectedEdgeId) {
      setEdges((cur) => cur.filter((e) => e.id !== selectedEdgeId));
      setSelectedEdgeId(null);
      window.setTimeout(syncToParent, 0);
      return;
    }
    if (selectedNodeId) deleteNode(selectedNodeId);
  }, [deleteNode, selectedEdgeId, selectedNodeId, setEdges, syncToParent]);

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
    ].join('');
    document.head.appendChild(s);
  }, []);

  return (
    <div ref={outerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
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
          const pos = flowRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) || { x: 0, y: 0 };
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
        onMoveEnd={(_, vp) => {
          // viewport tracked if needed
        }}
        elementsSelectable
        edgesFocusable={false}
        nodesConnectable={false}
        panOnDrag={false}
        panOnScroll={true}
        zoomOnScroll={true}
        zoomOnPinch={true}
        zoomOnDoubleClick={true}
        preventScrolling={true}
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <RoadmapLaneOverlay />
        <Controls showInteractive={false} />
      </ReactFlow>

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
                  onClick={() => { addRoadmapNodeAt({ x: ctxMenu.flowX || 0, y: ctxMenu.flowY || 0 }, kind); closeCtx(); }}
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
                  onClick={() => { addRoadmapNodeAt(undefined, kind); closeCtx(); }}
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
                onClick={() => { if (ctxMenu.kind === 'node' && ctxMenu.nodeId) deleteNode(ctxMenu.nodeId); closeCtx(); }}
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
              onClick={() => { addAdjacentNode(nodeAddMenu.nodeId, nodeAddMenu.direction, kind); }}
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

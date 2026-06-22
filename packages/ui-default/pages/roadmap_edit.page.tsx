import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import Editor from 'vj/components/editor';
import { request, i18n } from 'vj/utils';
import ReactFlow, {
  addEdge,
  EdgeChange,
  Connection,
  ConnectionMode,
  Controls,
  Node,
  NodeChange,
  Edge,
  ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  roadmapEditorFlowProps,
  roadmapFlowNodeTypes,
  RoadmapLaneOverlay,
  toRoadmapViewEdges,
  toRoadmapViewNodes,
  useRoadmapEditorLayout,
} from 'vj/components/roadmap/flow_shared';
import {
  alignNodesInSolidComponents,
  applySharedSolidY,
  getSolidLinkedNodeIds,
  shouldAlignSolidConnection,
} from 'vj/components/roadmap/solid_links';
import {
  getNodeLane,
  laneCenterX,
  nearestLaneFromX,
  nextLaneNodeY,
  snapNodeToLane,
} from 'vj/components/roadmap/lanes';
import {
  EditorWorkspaceShell,
  useEditorTheme,
  useEditorThemeStyles,
  useRailIconButtonStyle,
  buildAiTerminalStyles,
  type EditorThemeStyles,
} from 'vj/components/editor_workspace';
import {
  baseEdgeToFlowEdge,
  baseNodeToFlowNode,
  newNodeLabel,
  flowEdgeToBaseEdge,
  flowNodeToBaseNode,
  getRoadmapDocFromContext,
  getRoadmapQueryContext,
  normalizeRoadmapDoc,
  roadmapApiPath,
  roadmapFlowEdgeType,
  RoadmapDoc,
  RoadmapEdgeLineStyle,
  roadmapEdgeDashStyle,
  roadmapEdgeLineStyleFromStyle,
} from 'vj/components/roadmap/shared';
import {
  initialRoadmapSelectedNodeId,
  useRoadmapNodeUrlSync,
} from 'vj/components/roadmap/url_sync';
import {
  buildRoadmapSnapshot,
  buildDeletedGhostEdges,
  buildDeletedGhostNodes,
  buildRoadmapPendingStatusMaps,
  computeRoadmapPendingChanges,
  countRoadmapPendingChanges,
  type RoadmapSnapshot,
  type RoadmapViewport,
} from 'vj/components/roadmap/pending_changes';
import { RoadmapPendingPanel } from 'vj/components/roadmap/RoadmapPendingPanel';
import { RoadmapGitPanel, RoadmapGitHubRailIcon } from 'vj/components/roadmap/RoadmapGitPanel';

function newNodeId(): string {
  return `node_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function newEdgeId(source: string, target: string): string {
  return `edge_${source}_${target}_${Date.now().toString(36)}`;
}

function patchNodeData(nodes: Node[], selectedNodeId: string | null, patch: Record<string, any>): Node[] {
  if (!selectedNodeId) return nodes;
  return nodes.map((node) => {
    if (node.id !== selectedNodeId) return node;
    return {
      ...node,
      data: {
        ...node.data,
        ...patch,
      },
    };
  });
}

function toLaneFlowNodes(
  baseNodes: ReturnType<typeof normalizeRoadmapDoc>['nodes'],
  baseEdges: ReturnType<typeof normalizeRoadmapDoc>['edges'],
) {
  const flowEdges = (baseEdges || []).map(baseEdgeToFlowEdge);
  const flowNodes = (baseNodes || []).map((node, index) => {
    const flowNode = baseNodeToFlowNode(node, index);
    return snapNodeToLane(flowNode, getNodeLane(flowNode));
  });
  return alignNodesInSolidComponents(flowNodes, flowEdges);
}

type RoadmapContextMenuState =
  | null
  | { kind: 'pane'; x: number; y: number; flowX: number; flowY: number }
  | { kind: 'node'; x: number; y: number; nodeId: string }
  | { kind: 'edge'; x: number; y: number; edgeId: string };

function roadmapContextMenuShellStyle(themeStyles: EditorThemeStyles, theme: 'light' | 'dark'): React.CSSProperties {
  return {
    position: 'fixed',
    backgroundColor: themeStyles.bgPrimary,
    border: `1px solid ${themeStyles.borderSecondary}`,
    borderRadius: '4px',
    boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
    zIndex: 1100,
    minWidth: '180px',
    padding: '4px 0',
  };
}

function roadmapContextMenuItemStyle(themeStyles: EditorThemeStyles, danger = false): React.CSSProperties {
  return {
    padding: '6px 16px',
    cursor: 'pointer',
    fontSize: '13px',
    color: danger ? themeStyles.error : themeStyles.textPrimary,
  };
}

type RoadmapLeftPanelTab = 'canvas' | 'pending' | 'git';

function RoadmapCanvasRailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="2.5" y="3" width="4.5" height="3" rx="0.5" />
      <rect x="9" y="3" width="4.5" height="3" rx="0.5" />
      <rect x="5.5" y="10" width="5" height="3" rx="0.5" />
      <path d="M4.75 6v2.5M11.25 6v2.5" />
    </svg>
  );
}

function RoadmapPendingRailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M4 2.5h8v11H4z" />
      <path d="M6 6h4M6 8.5h4M6 11h3" />
    </svg>
  );
}

function RoadmapEditor({ initialDoc, mount }: { initialDoc: RoadmapDoc; mount: HTMLElement }) {
  const context = useMemo(() => getRoadmapQueryContext(mount), [mount]);
  const [doc, setDoc] = useState(() => normalizeRoadmapDoc(initialDoc));
  const initialFlowNodes = useMemo(() => toLaneFlowNodes(doc.nodes, doc.edges), [doc.nodes, doc.edges]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState((doc.edges || []).map(baseEdgeToFlowEdge));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    () => initialRoadmapSelectedNodeId(initialFlowNodes.map((node) => node.id)),
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [leftPanelTab, setLeftPanelTab] = useState<RoadmapLeftPanelTab>('canvas');
  const [branches, setBranches] = useState<string[]>(() => {
    const list = initialDoc.branches?.length ? [...initialDoc.branches] : ['main'];
    if (!list.includes('main')) list.unshift('main');
    return list;
  });
  const currentBranch = doc.currentBranch || (window as any).UiContext?.currentBranch || 'main';
  const [contextMenu, setContextMenu] = useState<RoadmapContextMenuState>(null);
  const [viewport, setViewport] = useState<RoadmapViewport>(() => doc.viewport || { x: 0, y: 0, zoom: 1 });
  const [savedSnapshot, setSavedSnapshot] = useState<RoadmapSnapshot>(() => buildRoadmapSnapshot(
    initialFlowNodes,
    (doc.edges || []).map(baseEdgeToFlowEdge),
    doc.viewport,
  ));
  const [terminalInput, setTerminalInput] = useState('');
  const theme = useEditorTheme();
  const themeStyles = useEditorThemeStyles(theme);
  const terminalStyles = useMemo(() => buildAiTerminalStyles(theme), [theme]);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editorInstanceRef = useRef<InstanceType<typeof Editor> | null>(null);
  const isInitializingEditorRef = useRef(false);
  const updateSelectedNodeRef = useRef<(patch: Record<string, any>) => void>(() => {});
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const roadmapNodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const {
    outerRef,
    onFlowInit,
    fitToContent,
  } = useRoadmapEditorLayout(nodes);

  const currentSnapshot = useMemo(
    () => buildRoadmapSnapshot(nodes, edges, viewport),
    [nodes, edges, viewport],
  );
  const pendingChanges = useMemo(
    () => computeRoadmapPendingChanges(savedSnapshot, currentSnapshot),
    [savedSnapshot, currentSnapshot],
  );
  const pendingCount = useMemo(() => countRoadmapPendingChanges(pendingChanges), [pendingChanges]);
  const pendingStatusMaps = useMemo(
    () => buildRoadmapPendingStatusMaps(pendingChanges),
    [pendingChanges],
  );
  const deletedNodeIds = useMemo(
    () => new Set(pendingChanges.deletedNodes.map((item) => item.id)),
    [pendingChanges.deletedNodes],
  );
  const deletedEdgeIds = useMemo(
    () => new Set(pendingChanges.deletedEdges.map((item) => item.id)),
    [pendingChanges.deletedEdges],
  );
  const viewNodes = useMemo(() => {
    const live = toRoadmapViewNodes(nodes, selectedNodeId, pendingStatusMaps);
    if (!deletedNodeIds.size) return live;
    const ghosts = toRoadmapViewNodes(
      buildDeletedGhostNodes(savedSnapshot, deletedNodeIds),
      null,
      pendingStatusMaps,
    );
    return [...live, ...ghosts];
  }, [nodes, selectedNodeId, pendingStatusMaps, deletedNodeIds, savedSnapshot]);
  const viewEdges = useMemo(() => {
    const live = toRoadmapViewEdges(edges, selectedEdgeId, pendingStatusMaps);
    if (!deletedEdgeIds.size) return live;
    const ghosts = toRoadmapViewEdges(
      buildDeletedGhostEdges(savedSnapshot, deletedEdgeIds),
      null,
      pendingStatusMaps,
    );
    return [...live, ...ghosts];
  }, [edges, selectedEdgeId, pendingStatusMaps, deletedEdgeIds, savedSnapshot]);
  useRoadmapNodeUrlSync({
    nodeIds: roadmapNodeIds,
    selectedNodeId,
    setSelectedNodeId,
  });

  const refreshSavedSnapshot = useCallback((
    nextNodes: Node[],
    nextEdges: Edge[],
    nextViewport?: RoadmapViewport | null,
  ) => {
    const vp = nextViewport || viewport;
    if (nextViewport) setViewport(nextViewport);
    setSavedSnapshot(buildRoadmapSnapshot(nextNodes, nextEdges, vp));
  }, [viewport]);

  const applyRoadmapData = useCallback((data: RoadmapDoc) => {
    const next = normalizeRoadmapDoc(data);
    setDoc(next);
    const nextNodes = toLaneFlowNodes(next.nodes, next.edges);
    const nextEdges = (next.edges || []).map(baseEdgeToFlowEdge);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedNodeId(initialRoadmapSelectedNodeId(nextNodes.map((node) => node.id)));
    if (next.viewport) setViewport(next.viewport);
    refreshSavedSnapshot(nextNodes, nextEdges, next.viewport || null);
    if (next.branches?.length) {
      const list = [...next.branches];
      if (!list.includes('main')) list.unshift('main');
      setBranches(list);
    }
  }, [refreshSavedSnapshot, setEdges, setNodes]);

  const refetchRoadmapData = useCallback(async () => {
    if (!context.docId) return;
    const data: any = await request.get(roadmapApiPath('/data', context.domainId), {
      docId: context.docId,
      branch: currentBranch,
    });
    applyRoadmapData(data);
  }, [applyRoadmapData, context.docId, context.domainId, currentBranch]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const applied: NodeChange[] = [];
    changes.forEach((change) => {
      if (change.type === 'select') return;
      if (change.type !== 'position' || !change.position || !('id' in change)) {
        applied.push(change);
        return;
      }
      const id = String(change.id);
      const x = laneCenterX(nearestLaneFromX(change.position.x));
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
              x: laneCenterX(nearestLaneFromX(peer.position.x)),
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

  useEffect(() => {
    if (doc.nodes?.length || !context.docId) return;
    request.get(roadmapApiPath('/data', context.domainId), {
      docId: context.docId,
      branch: currentBranch,
    })
      .then((data: any) => applyRoadmapData(data))
      .catch((err) => Notification.error(err.message || i18n('Roadmap load failed')));
  }, [applyRoadmapData, context.docId, context.domainId, currentBranch, doc.nodes?.length]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );

  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId) || null,
    [edges, selectedEdgeId],
  );

  const addRoadmapNodeAt = useCallback((flowPosition?: { x: number; y: number }) => {
    const id = newNodeId();
    const lane = flowPosition
      ? nearestLaneFromX(flowPosition.x)
      : (selectedNode ? getNodeLane(selectedNode) : 1);
    const node: Node = {
      id,
      type: 'roadmap',
      position: {
        x: 0,
        y: flowPosition?.y ?? nextLaneNodeY(nodes, lane),
      },
      data: {
        label: newNodeLabel(),
        status: 'planned',
        priority: 'medium',
        description: '',
        lane,
      },
    };
    setNodes((current) => [...current, snapNodeToLane(node, lane)]);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  }, [nodes, selectedNode, setNodes]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const sourceId = connection.source;
    const targetId = connection.target;
    const edgeId = newEdgeId(sourceId, targetId);
    const newEdge = {
      ...connection,
      id: edgeId,
      type: roadmapFlowEdgeType('solid'),
      data: { lineStyle: 'solid' as const },
      style: { stroke: '#2b78e4', strokeWidth: 3 },
      animated: false,
    };
    setEdges((current) => {
      const nextEdges = addEdge(newEdge, current);
      if (shouldAlignSolidConnection(connection)) {
        setNodes((currentNodes) => {
          const source = currentNodes.find((node) => node.id === sourceId);
          if (!source) return currentNodes;
          return applySharedSolidY(currentNodes, sourceId, source.position.y, nextEdges);
        });
      }
      return nextEdges;
    });
  }, [setEdges, setNodes]);

  const updateSelectedNode = useCallback((patch: Record<string, any>) => {
    setNodes((current) => patchNodeData(current, selectedNodeId, patch));
  }, [selectedNodeId, setNodes]);

  updateSelectedNodeRef.current = updateSelectedNode;

  useEffect(() => {
    if (!selectedNodeId) {
      if (editorInstanceRef.current) {
        try {
          editorInstanceRef.current.destroy();
        } catch {
          /* ignore */
        }
        editorInstanceRef.current = null;
      }
      return undefined;
    }

    isInitializingEditorRef.current = true;
    let currentEditor: InstanceType<typeof Editor> | null = null;
    const node = nodesRef.current.find((item) => item.id === selectedNodeId);
    const content = String(node?.data?.description || '');

    const timer = window.setTimeout(() => {
      const el = editorRef.current;
      if (!el) {
        isInitializingEditorRef.current = false;
        return;
      }
      const $textarea = $(el);
      $textarea.attr('data-markdown', 'true');
      $textarea.val(content);
      try {
        currentEditor = new Editor($textarea, {
          value: content,
          onChange: (value: string) => {
            if (isInitializingEditorRef.current) return;
            updateSelectedNodeRef.current({ description: value });
          },
        });
        editorInstanceRef.current = currentEditor;
        window.setTimeout(() => {
          isInitializingEditorRef.current = false;
        }, 100);
      } catch {
        isInitializingEditorRef.current = false;
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
      if (currentEditor) {
        try {
          currentEditor.destroy();
        } catch {
          /* ignore */
        }
      }
      editorInstanceRef.current = null;
      isInitializingEditorRef.current = false;
    };
  }, [selectedNodeId]);

  const onNodeDragStop = useCallback((_: React.MouseEvent, dragged: Node) => {
    setNodes((current) => {
      const linked = getSolidLinkedNodeIds(dragged.id, edges, current);
      const snapped = current.map((node) => {
        if (node.id !== dragged.id && !linked.has(node.id)) return node;
        return snapNodeToLane(node, nearestLaneFromX(node.position.x));
      });
      return alignNodesInSolidComponents(snapped, edges);
    });
  }, [edges, setNodes]);

  const updateEdge = useCallback((edgeId: string, patch: { label?: string; lineStyle?: RoadmapEdgeLineStyle }) => {
    setEdges((current) => {
      const nextEdges = current.map((edge) => {
        if (edge.id !== edgeId) return edge;
        const nextStyle = { ...(edge.style || {}) };
        const nextLineStyle = patch.lineStyle || roadmapEdgeLineStyleFromStyle(nextStyle);
        if (patch.lineStyle) {
          if (patch.lineStyle === 'dashed') {
            Object.assign(nextStyle, roadmapEdgeDashStyle('dashed'));
          } else {
            delete nextStyle.strokeDasharray;
          }
        }
        return {
          ...edge,
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          type: roadmapFlowEdgeType(nextLineStyle),
          data: {
            ...(edge.data || {}),
            lineStyle: nextLineStyle,
          },
          style: nextStyle,
        };
      });
      if (patch.lineStyle === 'solid') {
        setNodes((nodes) => alignNodesInSolidComponents(nodes, nextEdges));
      }
      return nextEdges;
    });
  }, [setEdges, setNodes]);

  const updateSelectedEdge = useCallback((patch: { label?: string; lineStyle?: RoadmapEdgeLineStyle }) => {
    if (!selectedEdgeId) return;
    updateEdge(selectedEdgeId, patch);
  }, [selectedEdgeId, updateEdge]);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  }, [selectedNodeId, setEdges, setNodes]);

  const deleteEdge = useCallback((edgeId: string) => {
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
    if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
  }, [selectedEdgeId, setEdges]);

  const deleteSelection = useCallback(() => {
    if (selectedEdgeId) {
      deleteEdge(selectedEdgeId);
      return;
    }
    if (selectedNodeId) {
      deleteNode(selectedNodeId);
    }
  }, [deleteEdge, deleteNode, selectedEdgeId, selectedNodeId]);

  const deleteSelectedEdge = useCallback(() => {
    if (!selectedEdgeId) return;
    deleteEdge(selectedEdgeId);
  }, [deleteEdge, selectedEdgeId]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const runContextAction = useCallback((action: () => void) => {
    action();
    closeContextMenu();
  }, [closeContextMenu]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
    const onDocClose = (ev: MouseEvent) => {
      if ((ev.target as Element | null)?.closest?.('[data-roadmap-ctx-root]')) return;
      closeContextMenu();
    };
    const tid = window.setTimeout(() => {
      window.addEventListener('click', onDocClose);
    }, 0);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.clearTimeout(tid);
      window.removeEventListener('click', onDocClose);
      window.removeEventListener('keydown', onEsc);
    };
  }, [closeContextMenu, contextMenu]);

  const saveRoadmap = useCallback(async () => {
    setSaving(true);
    try {
      const nextViewport = reactFlow?.getViewport?.() || viewport;
      await request.post(roadmapApiPath('/save', context.domainId), {
        docId: Number(context.docId || doc.docId),
        branch: currentBranch,
        nodes: nodes.map(flowNodeToBaseNode),
        edges: edges.map(flowEdgeToBaseEdge),
        layout: doc.layout || { type: 'manual', direction: 'TB', spacing: { x: 260, y: 140 } },
        viewport: nextViewport,
        operationDescription: i18n('Roadmap save operation'),
      });
      setViewport(nextViewport);
      setDoc((prev) => ({ ...prev, viewport: nextViewport }));
      refreshSavedSnapshot(nodes, edges, nextViewport);
      Notification.success(i18n('Roadmap saved'));
    } catch (err: any) {
      Notification.error(err.message || i18n('Roadmap save failed'));
    } finally {
      setSaving(false);
    }
  }, [context.domainId, context.docId, currentBranch, doc.docId, doc.layout, edges, nodes, reactFlow, refreshSavedSnapshot, viewport]);

  const saveRoadmapRef = useRef(saveRoadmap);
  saveRoadmapRef.current = saveRoadmap;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!saving) saveRoadmapRef.current();
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if (target.closest('.md-editor') || target.closest('.monaco-editor')) return;
      if (!selectedEdgeId && !selectedNodeId) return;
      e.preventDefault();
      deleteSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelection, saving, selectedEdgeId, selectedNodeId]);

  const handleFlowInit = useCallback((instance: ReactFlowInstance) => {
    setReactFlow(instance);
    onFlowInit(instance);
  }, [onFlowInit]);

  const canvasRailBtn = useRailIconButtonStyle(themeStyles, leftPanelTab === 'canvas');
  const pendingRailBtn = useRailIconButtonStyle(themeStyles, leftPanelTab === 'pending');
  const gitRailBtn = useRailIconButtonStyle(themeStyles, leftPanelTab === 'git');
  const edgeRailBtn = useRailIconButtonStyle(themeStyles, rightPanelOpen);
  const contextEdge = contextMenu?.kind === 'edge'
    ? edges.find((edge) => edge.id === contextMenu.edgeId) || null
    : null;

  const centerHeader = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: themeStyles.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {doc.title || i18n('Roadmap')}
        </span>
        <span style={{ fontSize: '11px', color: themeStyles.textSecondary, flexShrink: 0 }}>
          {currentBranch}
        </span>
        {selectedNode ? (
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1, fontSize: '12px', color: themeStyles.textSecondary }}>
            <span style={{ flexShrink: 0 }}>{i18n('Title')}</span>
            <input
              value={selectedNode.data?.label || ''}
              onChange={(e) => updateSelectedNode({ label: e.currentTarget.value })}
              style={{
                flex: 1,
                minWidth: 0,
                borderRadius: '4px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                background: themeStyles.bgPrimary,
                color: themeStyles.textPrimary,
                padding: '4px 8px',
                fontSize: '13px',
              }}
            />
          </label>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
        {pendingCount > 0 ? (
          <span style={{ fontSize: '12px', color: themeStyles.textSecondary }}>
            {i18n('Uncommitted changes')}
            {' '}
            (
            {pendingCount}
            )
          </span>
        ) : null}
        <button
          type="button"
          onClick={saveRoadmap}
          disabled={saving || pendingCount === 0}
          style={{
            padding: '4px 12px',
            minHeight: '28px',
            border: `1px solid ${themeStyles.borderSecondary}`,
            borderRadius: '3px',
            backgroundColor: themeStyles.success,
            color: themeStyles.textOnPrimary,
            cursor: (saving || pendingCount === 0) ? 'not-allowed' : 'pointer',
            fontSize: '12px',
            fontWeight: 500,
            opacity: (saving || pendingCount === 0) ? 0.6 : 1,
          }}
        >
          {saving ? i18n('Saving...') : `${i18n('Save')}${pendingCount > 0 ? ` (${pendingCount})` : ''}`}
        </button>
      </div>
    </>
  );

  return (
    <>
    <EditorWorkspaceShell
      layoutStorageKey="roadmapEditorLayout"
      leftRail={(
        <>
          <button
            type="button"
            onClick={() => setLeftPanelTab('canvas')}
            style={canvasRailBtn}
            title={i18n('Roadmap canvas')}
            aria-label={i18n('Roadmap canvas')}
          >
            <RoadmapCanvasRailIcon />
          </button>
          <button
            type="button"
            onClick={() => setLeftPanelTab('pending')}
            style={{ ...pendingRailBtn, position: 'relative' }}
            title={i18n('View pending changes')}
            aria-label={i18n('View pending changes')}
          >
            <RoadmapPendingRailIcon />
            {pendingCount > 0 ? (
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  minWidth: 14,
                  height: 14,
                  padding: '0 3px',
                  borderRadius: 7,
                  background: themeStyles.error,
                  color: themeStyles.textOnPrimary,
                  fontSize: 9,
                  lineHeight: '14px',
                  fontWeight: 700,
                  textAlign: 'center',
                  pointerEvents: 'none',
                }}
              >
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setLeftPanelTab('git')}
            style={gitRailBtn}
            title="GitHub 同步"
            aria-label="GitHub 同步"
          >
            <RoadmapGitHubRailIcon />
          </button>
        </>
      )}
      leftPanelTitle={
        leftPanelTab === 'canvas'
          ? i18n('Roadmap canvas')
          : leftPanelTab === 'pending'
            ? i18n('Uncommitted changes')
            : 'GitHub'
      }
      leftPanel={(
        leftPanelTab === 'canvas' ? (
          <div ref={outerRef} className="roadmap-flow roadmap-flow--workspace">
            <div className="roadmap-flow__canvas">
              <ReactFlow
                nodes={viewNodes}
                edges={viewEdges}
                nodeTypes={roadmapFlowNodeTypes}
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                onConnect={onConnect}
                onInit={handleFlowInit}
                onNodeDragStop={onNodeDragStop}
                onMoveEnd={(_, nextViewport) => setViewport(nextViewport)}
                defaultViewport={viewport}
                onNodeClick={(_, node) => {
                  if (node.type !== 'roadmap' || node.data?.isPendingGhost) return;
                  setSelectedNodeId(node.id);
                }}
                onEdgeClick={(_, edge) => {
                  if (edge.data?.isPendingGhost) return;
                  setSelectedEdgeId(edge.id);
                  setRightPanelOpen(true);
                }}
                onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
                onPaneContextMenu={(e) => {
                  e.preventDefault();
                  const flowPosition = reactFlow?.screenToFlowPosition({ x: e.clientX, y: e.clientY })
                    || { x: 0, y: nextLaneNodeY(nodes, 1) };
                  setContextMenu({
                    kind: 'pane',
                    x: e.clientX,
                    y: e.clientY,
                    flowX: flowPosition.x,
                    flowY: flowPosition.y,
                  });
                }}
                onNodeContextMenu={(e, node) => {
                  if (node.type !== 'roadmap' || node.data?.isPendingGhost) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectedNodeId(node.id);
                  setContextMenu({ kind: 'node', x: e.clientX, y: e.clientY, nodeId: node.id });
                }}
                onEdgeContextMenu={(e, edge) => {
                  if (edge.data?.isPendingGhost) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectedEdgeId(edge.id);
                  setRightPanelOpen(true);
                  setContextMenu({ kind: 'edge', x: e.clientX, y: e.clientY, edgeId: edge.id });
                }}
                elementsSelectable
                edgesFocusable
                connectionMode={ConnectionMode.Loose}
                {...roadmapEditorFlowProps}
              >
                <RoadmapLaneOverlay />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          </div>
        ) : leftPanelTab === 'pending' ? (
          <RoadmapPendingPanel
            pending={pendingChanges}
            themeStyles={themeStyles}
            onSelectNode={(nodeId) => {
              setLeftPanelTab('canvas');
              setSelectedNodeId(nodeId);
              setSelectedEdgeId(null);
            }}
            onSelectEdge={(edgeId) => {
              setLeftPanelTab('canvas');
              setSelectedEdgeId(edgeId);
              setRightPanelOpen(true);
            }}
          />
        ) : (
          <RoadmapGitPanel
            domainId={context.domainId}
            docId={String(context.docId || doc.docId || '')}
            currentBranch={currentBranch}
            branches={branches}
            themeStyles={themeStyles}
            onPullComplete={refetchRoadmapData}
            onBranchesChange={setBranches}
          />
        )
      )}
      centerHeader={centerHeader}
      centerMain={selectedNode ? (
        <div className="roadmap-node-markdown-editor">
          <textarea
            key={selectedNode.id}
            ref={editorRef}
            defaultValue={String(selectedNode.data?.description || '')}
            className="roadmap-node-markdown-editor__textarea"
          />
        </div>
      ) : null}
      centerMainId="editor-container"
      rightPanelTitle={i18n('Roadmap edge inspector')}
      rightPanelOpen={rightPanelOpen}
      onRightPanelOpenChange={setRightPanelOpen}
      rightPanel={(
        <div className="roadmap-inspector roadmap-inspector--workspace">
          {selectedEdge ? (
            <>
              <label>
                {i18n('Roadmap edge label')}
                <input value={String(selectedEdge.label || '')} onChange={(e) => updateSelectedEdge({ label: e.currentTarget.value })} />
              </label>
              <label>
                {i18n('Roadmap line style')}
                <select
                  value={roadmapEdgeLineStyleFromStyle(selectedEdge.style as Record<string, any>)}
                  onChange={(e) => updateSelectedEdge({ lineStyle: e.currentTarget.value as RoadmapEdgeLineStyle })}
                >
                  <option value="solid">{i18n('Roadmap line solid')}</option>
                  <option value="dashed">{i18n('Roadmap line dashed')}</option>
                </select>
              </label>
              <p>{i18n('Roadmap edge source')}: {selectedEdge.source}</p>
              <p>{i18n('Roadmap edge target')}: {selectedEdge.target}</p>
              <button type="button" className="roadmap-tool-button roadmap-tool-button--danger" onClick={deleteSelectedEdge}>
                {i18n('Roadmap delete edge')}
              </button>
            </>
          ) : null}
        </div>
      )}
      rightRail={(
        <button
          type="button"
          onClick={() => setRightPanelOpen((open) => !open)}
          style={edgeRailBtn}
          title={i18n('Roadmap edge inspector')}
          aria-label={i18n('Roadmap edge inspector')}
        >
          线
        </button>
      )}
      bottomTerminal={(
        <div style={{ color: terminalStyles.textDim, fontSize: '12px' }}>
          <span style={{ color: terminalStyles.promptAi }}>[ai]</span>
          {' '}
          {i18n('Roadmap AI terminal hint')}
        </div>
      )}
      bottomTerminalInputValue={terminalInput}
      onBottomTerminalInputChange={setTerminalInput}
      bottomTerminalInputDisabled
    />
    {contextMenu ? (
      <div
        data-roadmap-ctx-root
        style={{
          ...roadmapContextMenuShellStyle(themeStyles, theme),
          left: contextMenu.x,
          top: contextMenu.y,
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {contextMenu.kind === 'pane' ? (
          <>
            <div
              style={roadmapContextMenuItemStyle(themeStyles)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              onClick={() => runContextAction(() => addRoadmapNodeAt({ x: contextMenu.flowX, y: contextMenu.flowY }))}
            >
              {i18n('Roadmap add node')}
            </div>
            <div
              style={roadmapContextMenuItemStyle(themeStyles)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              onClick={() => runContextAction(fitToContent)}
            >
              {i18n('Roadmap fit canvas')}
            </div>
            {(selectedNodeId || selectedEdgeId) ? (
              <div
                style={roadmapContextMenuItemStyle(themeStyles, true)}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                onClick={() => runContextAction(deleteSelection)}
              >
                {selectedEdgeId ? i18n('Roadmap delete edge') : i18n('Delete')}
              </div>
            ) : null}
          </>
        ) : null}
        {contextMenu.kind === 'node' ? (
          <>
            <div
              style={roadmapContextMenuItemStyle(themeStyles)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              onClick={() => runContextAction(() => addRoadmapNodeAt())}
            >
              {i18n('Roadmap add node')}
            </div>
            <div
              style={roadmapContextMenuItemStyle(themeStyles)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              onClick={() => runContextAction(fitToContent)}
            >
              {i18n('Roadmap fit canvas')}
            </div>
            <div
              style={roadmapContextMenuItemStyle(themeStyles, true)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              onClick={() => runContextAction(() => deleteNode(contextMenu.nodeId))}
            >
              {i18n('Delete')}
            </div>
          </>
        ) : null}
        {contextMenu.kind === 'edge' && contextEdge ? (
          <>
            <div style={{ padding: '6px 12px 4px', fontSize: '11px', color: themeStyles.textSecondary }}>
              {i18n('Roadmap edge label')}
            </div>
            <div style={{ padding: '0 12px 6px' }}>
              <input
                value={String(contextEdge.label || '')}
                onChange={(e) => updateEdge(contextMenu.edgeId, { label: e.currentTarget.value })}
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  borderRadius: '4px',
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  background: themeStyles.bgPrimary,
                  color: themeStyles.textPrimary,
                  padding: '4px 8px',
                  fontSize: '12px',
                }}
              />
            </div>
            <div
              style={roadmapContextMenuItemStyle(themeStyles)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              onClick={() => runContextAction(() => updateEdge(contextMenu.edgeId, { lineStyle: 'solid' }))}
            >
              {i18n('Roadmap line solid')}
            </div>
            <div
              style={roadmapContextMenuItemStyle(themeStyles)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              onClick={() => runContextAction(() => updateEdge(contextMenu.edgeId, { lineStyle: 'dashed' }))}
            >
              {i18n('Roadmap line dashed')}
            </div>
            <div
              style={roadmapContextMenuItemStyle(themeStyles, true)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              onClick={() => runContextAction(() => deleteEdge(contextMenu.edgeId))}
            >
              {i18n('Roadmap delete edge')}
            </div>
          </>
        ) : null}
      </div>
    ) : null}
    </>
  );
}

const page = new NamedPage('roadmap_edit', async () => {
  const $editor = $('#roadmap-editor');
  if (!$editor.length) return;
  const initialDoc = normalizeRoadmapDoc(getRoadmapDocFromContext());
  ReactDOM.render(<RoadmapEditor initialDoc={initialDoc} mount={$editor[0]} />, $editor[0]);
});

export default page;

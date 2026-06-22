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
  const viewNodes = useMemo(() => toRoadmapViewNodes(nodes, selectedNodeId), [nodes, selectedNodeId]);
  const viewEdges = useMemo(() => toRoadmapViewEdges(edges, selectedEdgeId), [edges, selectedEdgeId]);
  const roadmapNodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);
  useRoadmapNodeUrlSync({
    nodeIds: roadmapNodeIds,
    selectedNodeId,
    setSelectedNodeId,
  });
  const {
    outerRef,
    onFlowInit,
    fitToContent,
  } = useRoadmapEditorLayout(nodes);

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
    request.get(roadmapApiPath('/data', context.domainId), { docId: context.docId })
      .then((data: any) => {
        const next = normalizeRoadmapDoc(data);
        setDoc(next);
        const nextNodes = toLaneFlowNodes(next.nodes, next.edges);
        setNodes(nextNodes);
        setEdges((next.edges || []).map(baseEdgeToFlowEdge));
        setSelectedNodeId(initialRoadmapSelectedNodeId(nextNodes.map((node) => node.id)));
      })
      .catch((err) => Notification.error(err.message || i18n('Roadmap load failed')));
  }, [context.docId, context.domainId, doc.nodes?.length, setEdges, setNodes]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );

  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId) || null,
    [edges, selectedEdgeId],
  );

  const addRoadmapNode = useCallback(() => {
    const id = newNodeId();
    const lane = selectedNode ? getNodeLane(selectedNode) : 1;
    const node: Node = {
      id,
      type: 'roadmap',
      position: {
        x: 0,
        y: nextLaneNodeY(nodes, lane),
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

  const updateSelectedEdge = useCallback((patch: { label?: string; lineStyle?: RoadmapEdgeLineStyle }) => {
    if (!selectedEdgeId) return;
    setEdges((current) => {
      const nextEdges = current.map((edge) => {
        if (edge.id !== selectedEdgeId) return edge;
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
  }, [selectedEdgeId, setEdges, setNodes]);

  const deleteSelection = useCallback(() => {
    if (selectedEdgeId) {
      setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
      return;
    }
    if (selectedNodeId) {
      setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
      setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
      setSelectedNodeId(null);
    }
  }, [selectedEdgeId, selectedNodeId, setEdges, setNodes]);

  const deleteSelectedEdge = useCallback(() => {
    if (!selectedEdgeId) return;
    setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
    setSelectedEdgeId(null);
  }, [selectedEdgeId, setEdges]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
  }, [deleteSelection, selectedEdgeId, selectedNodeId]);

  const saveRoadmap = useCallback(async () => {
    setSaving(true);
    try {
      const viewport = reactFlow?.getViewport?.() || doc.viewport || { x: 0, y: 0, zoom: 1 };
      await request.post(roadmapApiPath('/save', context.domainId), {
        docId: Number(context.docId || doc.docId),
        nodes: nodes.map(flowNodeToBaseNode),
        edges: edges.map(flowEdgeToBaseEdge),
        layout: doc.layout || { type: 'manual', direction: 'TB', spacing: { x: 260, y: 140 } },
        viewport,
        operationDescription: i18n('Roadmap save operation'),
      });
      Notification.success(i18n('Roadmap saved'));
    } catch (err: any) {
      Notification.error(err.message || i18n('Roadmap save failed'));
    } finally {
      setSaving(false);
    }
  }, [context.domainId, context.docId, doc.docId, doc.layout, doc.viewport, edges, nodes, reactFlow]);

  const handleFlowInit = useCallback((instance: ReactFlowInstance) => {
    setReactFlow(instance);
    onFlowInit(instance);
  }, [onFlowInit]);

  const railBtn = useRailIconButtonStyle(themeStyles, false);
  const edgeRailBtn = useRailIconButtonStyle(themeStyles, rightPanelOpen);

  const centerHeader = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: themeStyles.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {doc.title || i18n('Roadmap')}
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
        <button
          type="button"
          onClick={saveRoadmap}
          disabled={saving}
          style={{
            padding: '4px 12px',
            minHeight: '28px',
            border: `1px solid ${themeStyles.borderSecondary}`,
            borderRadius: '3px',
            backgroundColor: themeStyles.success,
            color: themeStyles.textOnPrimary,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontSize: '12px',
            fontWeight: 500,
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? i18n('Saving...') : i18n('Save')}
        </button>
      </div>
    </>
  );

  return (
    <EditorWorkspaceShell
      layoutStorageKey="roadmapEditorLayout"
      leftPanelTitle={i18n('Roadmap canvas')}
      leftRail={(
        <>
          <button type="button" onClick={addRoadmapNode} style={railBtn} title={i18n('Roadmap add node')} aria-label={i18n('Roadmap add node')}>+</button>
          <button type="button" onClick={fitToContent} style={railBtn} title={i18n('Roadmap fit canvas')} aria-label={i18n('Roadmap fit canvas')}>⊡</button>
          <button
            type="button"
            onClick={deleteSelection}
            disabled={!selectedNodeId && !selectedEdgeId}
            style={{ ...railBtn, color: themeStyles.error, opacity: (!selectedNodeId && !selectedEdgeId) ? 0.45 : 1 }}
            title={selectedEdgeId ? i18n('Roadmap delete edge') : i18n('Delete')}
            aria-label={selectedEdgeId ? i18n('Roadmap delete edge') : i18n('Delete')}
          >
            ×
          </button>
        </>
      )}
      leftPanel={(
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
              onNodeClick={(_, node) => {
                if (node.type !== 'roadmap') return;
                setSelectedNodeId(node.id);
              }}
              onEdgeClick={(_, edge) => {
                setSelectedEdgeId(edge.id);
                setRightPanelOpen(true);
              }}
              onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
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
  );
}

const page = new NamedPage('roadmap_edit', async () => {
  const $editor = $('#roadmap-editor');
  if (!$editor.length) return;
  const initialDoc = normalizeRoadmapDoc(getRoadmapDocFromContext());
  ReactDOM.render(<RoadmapEditor initialDoc={initialDoc} mount={$editor[0]} />, $editor[0]);
});

export default page;

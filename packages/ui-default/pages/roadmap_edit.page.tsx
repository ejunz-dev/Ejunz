import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request, i18n } from 'vj/utils';
import ReactFlow, {
  addEdge,
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
  RoadmapLane,
  ROADMAP_LANES,
  snapNodeToLane,
} from 'vj/components/roadmap/lanes';
import {
  baseEdgeToFlowEdge,
  baseNodeToFlowNode,
  defaultNodeLabel,
  flowEdgeToBaseEdge,
  flowNodeToBaseNode,
  getRoadmapDocFromContext,
  getRoadmapQueryContext,
  nodeTypeLabel,
  normalizeRoadmapDoc,
  roadmapApiPath,
  roadmapFlowEdgeType,
  RoadmapDoc,
  RoadmapEdgeLineStyle,
  RoadmapNodeType,
  RoadmapPriority,
  RoadmapStatus,
  roadmapEdgeDashStyle,
  roadmapEdgeLineStyleFromStyle,
  priorityLabel,
  statusLabel,
} from 'vj/components/roadmap/shared';

const NODE_TYPES: RoadmapNodeType[] = ['milestone', 'task', 'decision', 'release'];
const STATUSES: RoadmapStatus[] = ['planned', 'in_progress', 'done', 'blocked'];
const PRIORITIES: RoadmapPriority[] = ['low', 'medium', 'high'];

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
  const [nodes, setNodes, onNodesChange] = useNodesState(toLaneFlowNodes(doc.nodes, doc.edges));
  const [edges, setEdges, onEdgesChange] = useEdgesState((doc.edges || []).map(baseEdgeToFlowEdge));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(nodes[0]?.id || null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance | null>(null);
  const viewEdges = useMemo(() => toRoadmapViewEdges(edges, selectedEdgeId), [edges, selectedEdgeId]);
  const {
    outerRef,
    onFlowInit,
    fitToContent,
  } = useRoadmapEditorLayout(nodes);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const applied: NodeChange[] = [];
    changes.forEach((change) => {
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

  useEffect(() => {
    if (doc.nodes?.length || !context.docId) return;
    request.get(roadmapApiPath('/data', context.domainId), { docId: context.docId })
      .then((data: any) => {
        const next = normalizeRoadmapDoc(data);
        setDoc(next);
        const nextNodes = toLaneFlowNodes(next.nodes, next.edges);
        setNodes(nextNodes);
        setEdges((next.edges || []).map(baseEdgeToFlowEdge));
        setSelectedNodeId(nextNodes[0]?.id || null);
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

  const addRoadmapNode = useCallback((type: RoadmapNodeType) => {
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
        label: defaultNodeLabel(type),
        roadmapNodeType: type,
        status: 'planned',
        priority: type === 'milestone' || type === 'release' ? 'high' : 'medium',
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
    setNodes((current) => {
      const next = patchNodeData(current, selectedNodeId, patch);
      if (!patch.lane || !selectedNodeId) return next;
      return next.map((node) => (
        node.id === selectedNodeId
          ? snapNodeToLane(node, Number(patch.lane) as RoadmapLane)
          : node
      ));
    });
  }, [selectedNodeId, setNodes]);

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

  return (
    <div className="roadmap-editor-layout">
      <div className="roadmap-toolbar">
        <div>
          <div className="roadmap-hero__eyebrow">{i18n('Roadmap Editor')}</div>
          <div className="roadmap-toolbar__title">{doc.title || i18n('Roadmap')}</div>
        </div>
        <div className="roadmap-toolbar__actions">
          {NODE_TYPES.map((type) => (
            <button key={type} type="button" className="roadmap-tool-button" onClick={() => addRoadmapNode(type)}>
              + {nodeTypeLabel(type)}
            </button>
          ))}
          <button type="button" className="roadmap-tool-button" onClick={fitToContent}>
            {i18n('Roadmap fit canvas')}
          </button>
          <button type="button" className="roadmap-tool-button roadmap-tool-button--danger" onClick={deleteSelection} disabled={!selectedNodeId && !selectedEdgeId}>
            {selectedEdgeId ? i18n('Roadmap delete edge') : i18n('Delete')}
          </button>
          <button type="button" className="roadmap-tool-button roadmap-tool-button--save" onClick={saveRoadmap} disabled={saving}>
            {saving ? i18n('Saving...') : i18n('Save')}
          </button>
        </div>
      </div>

      <div className="roadmap-editor-grid">
        <div ref={outerRef} className="roadmap-flow roadmap-flow--editor">
          <div className="roadmap-flow__canvas">
            <ReactFlow
              nodes={nodes}
              edges={viewEdges}
              nodeTypes={roadmapFlowNodeTypes}
              onNodesChange={handleNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onInit={handleFlowInit}
              onNodeDragStop={onNodeDragStop}
              onNodeClick={(_, node) => {
                if (node.type !== 'roadmap') return;
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
              onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
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

        <aside className="roadmap-inspector">
          {selectedNode ? (
            <>
              <div className="roadmap-inspector__kicker">{i18n('Roadmap node inspector')}</div>
              <label>
                {i18n('Title')}
                <input value={selectedNode.data?.label || ''} onChange={(e) => updateSelectedNode({ label: e.currentTarget.value })} />
              </label>
              <label>
                {i18n('Roadmap lane')}
                <select
                  value={String(getNodeLane(selectedNode))}
                  onChange={(e) => updateSelectedNode({ lane: Number(e.currentTarget.value) as RoadmapLane })}
                >
                  {ROADMAP_LANES.map((lane) => <option key={lane} value={lane}>{i18n('Roadmap lane option', lane)}</option>)}
                </select>
              </label>
              <label>
                {i18n('Type')}
                <select value={selectedNode.data?.roadmapNodeType || 'task'} onChange={(e) => updateSelectedNode({ roadmapNodeType: e.currentTarget.value })}>
                  {['root', ...NODE_TYPES].map((type) => <option key={type} value={type}>{nodeTypeLabel(type as RoadmapNodeType)}</option>)}
                </select>
              </label>
              <label>
                {i18n('Status')}
                <select value={selectedNode.data?.status || 'planned'} onChange={(e) => updateSelectedNode({ status: e.currentTarget.value })}>
                  {STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                </select>
              </label>
              <label>
                {i18n('Roadmap priority')}
                <select value={selectedNode.data?.priority || 'medium'} onChange={(e) => updateSelectedNode({ priority: e.currentTarget.value })}>
                  {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priorityLabel(priority)}</option>)}
                </select>
              </label>
              <label>
                {i18n('Roadmap owner')}
                <input value={selectedNode.data?.owner || ''} onChange={(e) => updateSelectedNode({ owner: e.currentTarget.value })} />
              </label>
              <label>
                {i18n('Date')}
                <input type="date" value={selectedNode.data?.dueDate || ''} onChange={(e) => updateSelectedNode({ dueDate: e.currentTarget.value })} />
              </label>
              <label>
                {i18n('Description')}
                <textarea rows={5} value={selectedNode.data?.description || ''} onChange={(e) => updateSelectedNode({ description: e.currentTarget.value })} />
              </label>
            </>
          ) : selectedEdge ? (
            <>
              <div className="roadmap-inspector__kicker">{i18n('Roadmap edge inspector')}</div>
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
          ) : (
            <div className="roadmap-inspector__empty">
              <div>{i18n('Roadmap inspector empty title')}</div>
              <p>{i18n('Roadmap inspector empty hint')}</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

const page = new NamedPage('roadmap_edit', async () => {
  const $editor = $('#roadmap-editor');
  if (!$editor.length) return;
  const initialDoc = normalizeRoadmapDoc(getRoadmapDocFromContext());
  ReactDOM.render(<RoadmapEditor initialDoc={initialDoc} mount={$editor[0]} />, $editor[0]);
});

export default page;

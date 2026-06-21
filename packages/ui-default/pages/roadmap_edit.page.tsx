import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
import ReactFlow, {
  addEdge,
  Background,
  BackgroundVariant,
  Connection,
  Controls,
  Edge,
  Handle,
  MiniMap,
  Node,
  NodeProps,
  NodeTypes,
  Position,
  ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  baseEdgeToFlowEdge,
  baseNodeToFlowNode,
  flowEdgeToBaseEdge,
  flowNodeToBaseNode,
  getRoadmapDocFromContext,
  getRoadmapQueryContext,
  nodeTypeLabel,
  normalizeRoadmapDoc,
  roadmapApiPath,
  RoadmapDoc,
  RoadmapNodeType,
  RoadmapPriority,
  RoadmapStatus,
  statusColor,
  statusLabel,
} from './roadmap_shared';

const NODE_TYPES: RoadmapNodeType[] = ['milestone', 'task', 'decision', 'release'];
const STATUSES: RoadmapStatus[] = ['planned', 'in_progress', 'done', 'blocked'];
const PRIORITIES: RoadmapPriority[] = ['low', 'medium', 'high'];

const RoadmapEditNode = ({ data, selected }: NodeProps) => {
  const status = (data.status || 'planned') as RoadmapStatus;
  const accent = statusColor(status);
  return (
    <div className={`roadmap-node roadmap-node--${status} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="roadmap-node__handle" />
      <div className="roadmap-node__topline">
        <span className="roadmap-node__type" style={{ borderColor: accent }}>{nodeTypeLabel(data.roadmapNodeType)}</span>
        <span className={`roadmap-node__priority roadmap-node__priority--${data.priority || 'medium'}`}>{data.priority || 'medium'}</span>
      </div>
      <div className="roadmap-node__title">{data.label || '未命名节点'}</div>
      {data.description ? <div className="roadmap-node__desc">{data.description}</div> : null}
      <div className="roadmap-node__meta">
        <span style={{ color: accent }}>● {statusLabel(status)}</span>
        {data.dueDate ? <span>{data.dueDate}</span> : null}
      </div>
      <Handle type="source" position={Position.Right} className="roadmap-node__handle" />
    </div>
  );
};

const nodeTypes: NodeTypes = { roadmap: RoadmapEditNode };

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

function RoadmapEditor({ initialDoc, mount }: { initialDoc: RoadmapDoc; mount: HTMLElement }) {
  const context = useMemo(() => getRoadmapQueryContext(mount), [mount]);
  const [doc, setDoc] = useState(() => normalizeRoadmapDoc(initialDoc));
  const [nodes, setNodes, onNodesChange] = useNodesState(
    (doc.nodes || []).map((node, index) => baseNodeToFlowNode(node, index)),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState((doc.edges || []).map(baseEdgeToFlowEdge));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(nodes[0]?.id || null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance | null>(null);

  useEffect(() => {
    if (doc.nodes?.length || !context.docId) return;
    request.get(roadmapApiPath('/data', context.domainId), { docId: context.docId })
      .then((data: any) => {
        const next = normalizeRoadmapDoc(data);
        setDoc(next);
        const nextNodes = (next.nodes || []).map((node, index) => baseNodeToFlowNode(node, index));
        setNodes(nextNodes);
        setEdges((next.edges || []).map(baseEdgeToFlowEdge));
        setSelectedNodeId(nextNodes[0]?.id || null);
      })
      .catch((err) => Notification.error(err.message || '加载路线图失败'));
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
    const flowPosition = reactFlow?.project({ x: 260 + nodes.length * 18, y: 180 + nodes.length * 12 }) || {
      x: 180 + nodes.length * 40,
      y: 180 + nodes.length * 20,
    };
    const node: Node = {
      id,
      type: 'roadmap',
      position: flowPosition,
      data: {
        label: type === 'milestone' ? '新里程碑' : type === 'release' ? '新发布' : type === 'decision' ? '新决策' : '新任务',
        roadmapNodeType: type,
        status: 'planned',
        priority: type === 'milestone' || type === 'release' ? 'high' : 'medium',
        description: '',
      },
    };
    setNodes((current) => [...current, node]);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  }, [nodes.length, reactFlow, setNodes]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    setEdges((current) => addEdge({
      ...connection,
      id: newEdgeId(connection.source!, connection.target!),
      type: 'smoothstep',
      style: { stroke: '#d8b46a', strokeWidth: 2 },
      animated: false,
    }, current));
  }, [setEdges]);

  const updateSelectedNode = useCallback((patch: Record<string, any>) => {
    setNodes((current) => patchNodeData(current, selectedNodeId, patch));
  }, [selectedNodeId, setNodes]);

  const deleteSelection = useCallback(() => {
    if (selectedNodeId) {
      setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
      setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
      setSelectedNodeId(null);
      return;
    }
    if (selectedEdgeId) {
      setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  }, [selectedEdgeId, selectedNodeId, setEdges, setNodes]);

  const saveRoadmap = useCallback(async () => {
    setSaving(true);
    try {
      const viewport = reactFlow?.getViewport?.() || doc.viewport || { x: 0, y: 0, zoom: 1 };
      await request.post(roadmapApiPath('/save', context.domainId), {
        docId: Number(context.docId || doc.docId),
        nodes: nodes.map(flowNodeToBaseNode),
        edges: edges.map(flowEdgeToBaseEdge),
        layout: doc.layout || { type: 'manual', direction: 'LR', spacing: { x: 260, y: 140 } },
        viewport,
        operationDescription: '保存路线图',
      });
      Notification.success('路线图已保存');
    } catch (err: any) {
      Notification.error(err.message || '保存路线图失败');
    } finally {
      setSaving(false);
    }
  }, [context.domainId, context.docId, doc.docId, doc.layout, doc.viewport, edges, nodes, reactFlow]);

  return (
    <div className="roadmap-editor-layout">
      <div className="roadmap-toolbar">
        <div>
          <div className="roadmap-hero__eyebrow">Roadmap foundry</div>
          <div className="roadmap-toolbar__title">{doc.title || 'Roadmap'}</div>
        </div>
        <div className="roadmap-toolbar__actions">
          {NODE_TYPES.map((type) => (
            <button key={type} type="button" className="roadmap-tool-button" onClick={() => addRoadmapNode(type)}>
              + {nodeTypeLabel(type)}
            </button>
          ))}
          <button type="button" className="roadmap-tool-button roadmap-tool-button--danger" onClick={deleteSelection} disabled={!selectedNodeId && !selectedEdgeId}>
            删除
          </button>
          <button type="button" className="roadmap-tool-button roadmap-tool-button--save" onClick={saveRoadmap} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      <div className="roadmap-editor-grid">
        <div className="roadmap-flow roadmap-flow--editor">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setReactFlow}
            onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
            onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
            onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            fitView
          >
            <Background variant={BackgroundVariant.Lines} gap={30} size={1} color="#464234" />
            <MiniMap pannable zoomable nodeColor={(node) => statusColor(node.data?.status)} />
            <Controls />
          </ReactFlow>
        </div>

        <aside className="roadmap-inspector">
          {selectedNode ? (
            <>
              <div className="roadmap-inspector__kicker">Node inspector</div>
              <label>
                标题
                <input value={selectedNode.data?.label || ''} onChange={(e) => updateSelectedNode({ label: e.currentTarget.value })} />
              </label>
              <label>
                类型
                <select value={selectedNode.data?.roadmapNodeType || 'task'} onChange={(e) => updateSelectedNode({ roadmapNodeType: e.currentTarget.value })}>
                  {['root', ...NODE_TYPES].map((type) => <option key={type} value={type}>{nodeTypeLabel(type as RoadmapNodeType)}</option>)}
                </select>
              </label>
              <label>
                状态
                <select value={selectedNode.data?.status || 'planned'} onChange={(e) => updateSelectedNode({ status: e.currentTarget.value })}>
                  {STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                </select>
              </label>
              <label>
                优先级
                <select value={selectedNode.data?.priority || 'medium'} onChange={(e) => updateSelectedNode({ priority: e.currentTarget.value })}>
                  {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                </select>
              </label>
              <label>
                负责人
                <input value={selectedNode.data?.owner || ''} onChange={(e) => updateSelectedNode({ owner: e.currentTarget.value })} />
              </label>
              <label>
                日期
                <input type="date" value={selectedNode.data?.dueDate || ''} onChange={(e) => updateSelectedNode({ dueDate: e.currentTarget.value })} />
              </label>
              <label>
                描述
                <textarea rows={5} value={selectedNode.data?.description || ''} onChange={(e) => updateSelectedNode({ description: e.currentTarget.value })} />
              </label>
            </>
          ) : selectedEdge ? (
            <>
              <div className="roadmap-inspector__kicker">Edge inspector</div>
              <label>
                依赖说明
                <input value={String(selectedEdge.label || '')} onChange={(e) => {
                  const value = e.currentTarget.value;
                  setEdges((current) => current.map((edge) => edge.id === selectedEdge.id ? { ...edge, label: value } : edge));
                }} />
              </label>
              <p>Source: {selectedEdge.source}</p>
              <p>Target: {selectedEdge.target}</p>
            </>
          ) : (
            <div className="roadmap-inspector__empty">
              <div>选择一个节点或边</div>
              <p>编辑标题、状态、负责人、截止日期，或拖动画布创建一张清晰的路线图。</p>
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

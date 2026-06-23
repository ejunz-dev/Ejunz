import $ from 'jquery';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request, i18n } from 'vj/utils';
import ReactFlow, { ConnectionMode, useEdgesState, useNodesState } from 'reactflow';
import 'reactflow/dist/style.css';
import {
  roadmapFlowNodeTypes,
  roadmapScrollFlowProps,
  toRoadmapViewEdges,
  toRoadmapViewNodes,
  useRoadmapScrollLayout,
} from 'vj/components/roadmap/flow_shared';
import { useEditorTheme } from 'vj/components/editor_workspace';
import { alignNodesInSolidComponents } from 'vj/components/roadmap/solid_links';
import {
  getNodeLane,
  isRoadmapFlowNode,
  snapNodeToLane,
} from 'vj/components/roadmap/lanes';
import {
  baseEdgeToFlowEdge,
  baseNodeToFlowNode,
  getRoadmapDocFromContext,
  getRoadmapQueryContext,
  normalizeRoadmapDoc,
  roadmapApiPath,
  RoadmapDoc,
} from 'vj/components/roadmap/shared';
import {
  initialRoadmapSelectedNodeId,
  useRoadmapNodeUrlScroll,
  useRoadmapNodeUrlSync,
} from 'vj/components/roadmap/url_sync';
import { RoadmapNodeDrawer } from 'vj/components/roadmap/RoadmapNodeDrawer';
import { RoadmapDetailHeader } from 'vj/components/roadmap/RoadmapDetailHeader';
import { isHookNodeType, isTextNodeType } from 'vj/components/roadmap/node_kinds';
import type { RoadmapStatus } from 'vj/components/roadmap/shared';

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

function RoadmapFlowViewer({ initialDoc, mount }: { initialDoc: RoadmapDoc; mount: HTMLElement }) {
  const context = useMemo(() => getRoadmapQueryContext(mount), [mount]);
  const [doc, setDoc] = useState(() => normalizeRoadmapDoc(initialDoc));
  const initialFlowNodes = useMemo(() => toLaneFlowNodes(doc.nodes, doc.edges), [doc.nodes, doc.edges]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState((doc.edges || []).map(baseEdgeToFlowEdge));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    () => initialRoadmapSelectedNodeId(initialFlowNodes.map((node) => node.id)),
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const theme = useEditorTheme();
  const layoutNodes = useMemo(() => nodes.filter(isRoadmapFlowNode), [nodes]);
  const viewNodes = useMemo(() => toRoadmapViewNodes(layoutNodes, selectedNodeId), [layoutNodes, selectedNodeId]);
  const viewEdges = useMemo(() => toRoadmapViewEdges(edges, null, undefined, theme), [edges, theme]);
  const roadmapNodeIds = useMemo(() => layoutNodes.map((node) => node.id), [layoutNodes]);
  useRoadmapNodeUrlSync({
    nodeIds: roadmapNodeIds,
    selectedNodeId,
    setSelectedNodeId,
  });
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );
  const {
    outerRef,
    canvasHeight,
    lockedZoom,
    viewport,
    layoutReady,
    onFlowInit,
  } = useRoadmapScrollLayout(layoutNodes, { fillContainer: false });

  useRoadmapNodeUrlScroll({
    selectedNodeId,
    nodes: layoutNodes,
    viewport,
    canvasRef,
    canvasHeight,
  });

  useEffect(() => {
    if (doc.nodes?.length || !context.docId) return;
    request.get(roadmapApiPath('/data', context.domainId), { docId: context.docId })
      .then((data: any) => {
        const next = normalizeRoadmapDoc(data);
        setDoc(next);
        const nextFlowNodes = toLaneFlowNodes(next.nodes, next.edges);
        setNodes(nextFlowNodes);
        setEdges((next.edges || []).map(baseEdgeToFlowEdge));
        setSelectedNodeId(initialRoadmapSelectedNodeId(
          nextFlowNodes.filter(isRoadmapFlowNode).map((node) => node.id),
        ));
      })
      .catch((err) => Notification.error(err.message || i18n('Roadmap load failed')));
  }, [context.docId, context.domainId, doc.nodes?.length, setEdges, setNodes]);

  useEffect(() => {
    const contentDiv = contentRef.current;
    if (!contentDiv || !selectedNode) return undefined;

    const markdown = String(selectedNode.data?.description || '');
    if (!markdown.trim()) {
      contentDiv.innerHTML = `<p>${i18n('Roadmap node content empty')}</p>`;
      return undefined;
    }

    let cancelled = false;
    contentDiv.innerHTML = `<p>${i18n('Loading...')}</p>`;

    fetch('/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: markdown, inline: false }),
    })
      .then((response) => {
        if (!response.ok) throw new Error('Failed to render markdown');
        return response.text();
      })
      .then((html) => {
        if (cancelled) return;
        contentDiv.innerHTML = html;
        $(contentDiv).trigger('vjContentNew');
      })
      .catch(() => {
        if (cancelled) return;
        contentDiv.innerHTML = `<p>${i18n('Roadmap markdown preview failed')}</p>`;
      });

    return () => {
      cancelled = true;
    };
  }, [selectedNode, selectedNodeId]);

  useEffect(() => {
    if (!selectedNodeId) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest('.roadmap-detail-drawer')) return;
      if (target.closest('.react-flow__node')) return;
      setSelectedNodeId(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [selectedNodeId]);

  const roadmapTitle = doc.title || i18n('Roadmap');
  const roadmapBranch = doc.currentBranch || 'main';
  const headerProps = {
    title: roadmapTitle,
    description: doc.content,
    domainId: context.domainId,
    docId: context.docId,
    branch: roadmapBranch,
    nodes: doc.nodes || [],
    edges: doc.edges || [],
  };

  if (!doc.nodes?.length) {
    return (
      <div className="roadmap-detail-layout">
        <RoadmapDetailHeader {...headerProps} />
        <div className="roadmap-view__empty">
          <p>{i18n('Roadmap detail empty')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="roadmap-detail-layout">
      <RoadmapDetailHeader {...headerProps} />
      <div className="roadmap-view">
        <div ref={outerRef} className="roadmap-flow roadmap-flow--scroll">
          <div ref={canvasRef} className="roadmap-flow__canvas" style={{ height: canvasHeight }}>
            {layoutReady ? (
              <ReactFlow
                nodes={viewNodes}
                edges={viewEdges}
                nodeTypes={roadmapFlowNodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onInit={onFlowInit}
                defaultViewport={viewport}
                onNodeClick={(_, node) => {
                  if (node.type !== 'roadmap') return;
                  if (isHookNodeType(node.data?.roadmapNodeType)) return;
                  if (isTextNodeType(node.data?.roadmapNodeType)) return;
                  setSelectedNodeId(node.id);
                }}
                onPaneClick={() => setSelectedNodeId(null)}
                connectionMode={ConnectionMode.Loose}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                nodesFocusable={false}
                edgesFocusable={false}
                minZoom={lockedZoom}
                maxZoom={lockedZoom}
                {...roadmapScrollFlowProps}
              />
            ) : null}
          </div>
        </div>
      </div>

      <RoadmapNodeDrawer
        open={!!selectedNode && !isTextNodeType(selectedNode.data?.roadmapNodeType)}
        nodeId={selectedNodeId || ''}
        nodeLabel={String(selectedNode?.data?.label || i18n('Unnamed Node'))}
        nodeStatus={selectedNode?.data?.status as RoadmapStatus | undefined}
        contentRef={contentRef}
        onClose={() => setSelectedNodeId(null)}
      />
    </div>
  );
}

const page = new NamedPage('roadmap_detail', async () => {
  const $viewer = $('#roadmap-viewer');
  if (!$viewer.length) return;
  const initialDoc = normalizeRoadmapDoc(getRoadmapDocFromContext());
  ReactDOM.render(<RoadmapFlowViewer initialDoc={initialDoc} mount={$viewer[0]} />, $viewer[0]);
});

export default page;

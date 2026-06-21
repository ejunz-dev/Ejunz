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
  const [nodes, setNodes, onNodesChange] = useNodesState(toLaneFlowNodes(doc.nodes, doc.edges));
  const [edges, setEdges, onEdgesChange] = useEdgesState((doc.edges || []).map(baseEdgeToFlowEdge));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const layoutNodes = useMemo(() => nodes.filter(isRoadmapFlowNode), [nodes]);
  const viewNodes = useMemo(() => toRoadmapViewNodes(layoutNodes, selectedNodeId), [layoutNodes, selectedNodeId]);
  const viewEdges = useMemo(() => toRoadmapViewEdges(edges), [edges]);
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );
  const {
    outerRef,
    canvasHeight,
    lockedZoom,
    onFlowInit,
  } = useRoadmapScrollLayout(layoutNodes);

  useEffect(() => {
    if (doc.nodes?.length || !context.docId) return;
    request.get(roadmapApiPath('/data', context.domainId), { docId: context.docId })
      .then((data: any) => {
        const next = normalizeRoadmapDoc(data);
        setDoc(next);
        setNodes(toLaneFlowNodes(next.nodes, next.edges));
        setEdges((next.edges || []).map(baseEdgeToFlowEdge));
        setSelectedNodeId(null);
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

  if (!doc.nodes?.length) {
    return (
      <div className="roadmap-view__empty">
        <p>{i18n('Roadmap detail empty')}</p>
      </div>
    );
  }

  return (
    <div className={`roadmap-detail-layout${selectedNode ? ' roadmap-detail-layout--open' : ''}`}>
      <div className="roadmap-view">
        <div ref={outerRef} className="roadmap-flow roadmap-flow--scroll">
          <div className="roadmap-flow__canvas" style={{ height: canvasHeight }}>
            <ReactFlow
              nodes={viewNodes}
              edges={viewEdges}
              nodeTypes={roadmapFlowNodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onInit={onFlowInit}
              onNodeClick={(_, node) => {
                if (node.type !== 'roadmap') return;
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
          </div>
        </div>
      </div>

      {selectedNode ? (
        <aside className="roadmap-detail-sidebar">
          <div className="roadmap-detail-sidebar__header">
            <div className="roadmap-inspector__kicker">{i18n('Roadmap node content')}</div>
            <button
              type="button"
              className="roadmap-detail-sidebar__close"
              onClick={() => setSelectedNodeId(null)}
              aria-label={i18n('Close')}
            >
              ×
            </button>
          </div>
          {selectedNode.data?.label ? (
            <h2 className="roadmap-node-markdown-preview__title">{String(selectedNode.data.label)}</h2>
          ) : null}
          <div ref={contentRef} className="roadmap-node-markdown-preview__body typo" />
        </aside>
      ) : null}
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

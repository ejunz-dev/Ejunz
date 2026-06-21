import $ from 'jquery';
import React, { useEffect, useMemo, useState } from 'react';
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
  const viewEdges = useMemo(() => toRoadmapViewEdges(edges), [edges]);
  const layoutNodes = useMemo(() => nodes.filter(isRoadmapFlowNode), [nodes]);
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
      })
      .catch((err) => Notification.error(err.message || i18n('Roadmap load failed')));
  }, [context.docId, context.domainId, doc.nodes?.length, setEdges, setNodes]);

  if (!doc.nodes?.length) {
    return (
      <div className="roadmap-view__empty">
        <p>{i18n('Roadmap detail empty')}</p>
      </div>
    );
  }

  return (
    <div className="roadmap-view">
      <div ref={outerRef} className="roadmap-flow roadmap-flow--scroll">
        <div className="roadmap-flow__canvas" style={{ height: canvasHeight }}>
          <ReactFlow
            nodes={nodes}
            edges={viewEdges}
            nodeTypes={roadmapFlowNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onInit={onFlowInit}
            connectionMode={ConnectionMode.Loose}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            minZoom={lockedZoom}
            maxZoom={lockedZoom}
            {...roadmapScrollFlowProps}
          />
        </div>
      </div>
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

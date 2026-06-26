import $ from 'jquery';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, { ConnectionMode, useEdgesState, useNodesState } from 'reactflow';
import 'reactflow/dist/style.css';
import { i18n } from 'vj/utils';
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
  type BaseRoadmapEdge,
  type BaseRoadmapNode,
  type RoadmapStatus,
} from 'vj/components/roadmap/shared';
import { RoadmapNodeDrawer } from 'vj/components/roadmap/RoadmapNodeDrawer';
import {
  buildRoadmapNodeProblemCountMap,
  readRoadmapDetailDisplaySettings,
} from 'vj/components/roadmap/detail_display_settings';
import { computeRoadmapNodeNumbers } from 'vj/components/roadmap/node_numbering';
import { isHookNodeType, isTextNodeType, supportsRoadmapPracticeProblems } from 'vj/components/roadmap/node_kinds';
import type { BaseEdge, BaseNode, Card } from './types';

function toLaneFlowNodes(childNodes: BaseNode[], childEdges: BaseEdge[]) {
  const flowEdges = (childEdges || []).map((edge) => baseEdgeToFlowEdge(edge as BaseRoadmapEdge));
  const flowNodes = (childNodes || []).map((node, index) => {
    const flowNode = baseNodeToFlowNode(node as BaseRoadmapNode, index);
    return snapNodeToLane(flowNode, getNodeLane(flowNode));
  });
  return alignNodesInSolidComponents(flowNodes, flowEdges);
}

export function BaseDetailEmbeddedRoadmapViewer({
  childNodes,
  childEdges,
  nodeCardsMap,
  onSelectedNodeChange,
}: {
  childNodes: BaseNode[];
  childEdges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  onSelectedNodeChange?: (nodeId: string | null, label: string | null) => void;
}) {
  const initialFlowNodes = useMemo(
    () => toLaneFlowNodes(childNodes, childEdges),
    [childEdges, childNodes],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    (childEdges || []).map((edge) => baseEdgeToFlowEdge(edge as BaseRoadmapEdge)),
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const displaySettings = useMemo(() => readRoadmapDetailDisplaySettings(), []);
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const theme = useEditorTheme();

  useEffect(() => {
    const nextFlowNodes = toLaneFlowNodes(childNodes, childEdges);
    setNodes(nextFlowNodes);
    setEdges((childEdges || []).map((edge) => baseEdgeToFlowEdge(edge as BaseRoadmapEdge)));
    setSelectedNodeId(null);
  }, [childEdges, childNodes, setEdges, setNodes]);

  const layoutNodes = useMemo(() => nodes.filter(isRoadmapFlowNode), [nodes]);
  const problemCountByNodeId = useMemo(
    () => buildRoadmapNodeProblemCountMap(layoutNodes, nodeCardsMap),
    [layoutNodes, nodeCardsMap],
  );
  const nodeNumberMap = useMemo(
    () => computeRoadmapNodeNumbers(layoutNodes, edges),
    [layoutNodes, edges],
  );
  const viewNodes = useMemo(() => (
    toRoadmapViewNodes(layoutNodes, selectedNodeId).map((node) => ({
      ...node,
      data: {
        ...node.data,
        showProblemCountBadge: displaySettings.showProblemCount
          && supportsRoadmapPracticeProblems(node.data?.roadmapNodeType),
        problemCount: problemCountByNodeId.get(node.id) || 0,
        showNodeNumber: displaySettings.showNodeNumber,
        nodeNumber: nodeNumberMap.get(node.id) || '',
      },
    }))
  ), [
    displaySettings.showNodeNumber,
    displaySettings.showProblemCount,
    layoutNodes,
    nodeNumberMap,
    problemCountByNodeId,
    selectedNodeId,
  ]);
  const viewEdges = useMemo(
    () => toRoadmapViewEdges(edges, null, undefined, theme),
    [edges, theme],
  );
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );

  useEffect(() => {
    if (!onSelectedNodeChange) return;
    if (!selectedNodeId || !selectedNode) {
      onSelectedNodeChange(null, null);
      return;
    }
    onSelectedNodeChange(
      selectedNodeId,
      String(selectedNode.data?.label || i18n('Unnamed Node')),
    );
  }, [onSelectedNodeChange, selectedNode, selectedNodeId]);

  const {
    outerRef,
    canvasHeight,
    lockedZoom,
    viewport,
    layoutReady,
    onFlowInit,
  } = useRoadmapScrollLayout(layoutNodes, { fillContainer: false });

  useEffect(() => {
    const contentDiv = contentRef.current;
    if (!contentDiv || !selectedNode || isTextNodeType(selectedNode.data?.roadmapNodeType)) return undefined;

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
      if (target.closest('.roadmap-detail-drawer--left')) return;
      if (target.closest('.base-detail-tree-backdrop')) return;
      if (target.closest('.react-flow__node')) return;
      setSelectedNodeId(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [selectedNodeId]);

  if (!childNodes.length) {
    return (
      <div className="roadmap-view__empty">
        <p>{i18n('Roadmap detail empty')}</p>
      </div>
    );
  }

  return (
    <>
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

      <RoadmapNodeDrawer
        open={!!selectedNode && !isTextNodeType(selectedNode.data?.roadmapNodeType)}
        nodeId={selectedNodeId || ''}
        nodeLabel={String(selectedNode?.data?.label || i18n('Unnamed Node'))}
        nodeStatus={selectedNode?.data?.status as RoadmapStatus | undefined}
        roadmapNodeType={selectedNode?.data?.roadmapNodeType}
        contentRef={contentRef}
        onClose={() => setSelectedNodeId(null)}
      />
    </>
  );
}

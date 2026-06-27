import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import ReactFlow, { ConnectionMode } from 'reactflow';
import 'reactflow/dist/style.css';
import { i18n } from 'vj/utils';
import {
  roadmapFlowNodeTypes,
  roadmapScrollFlowProps,
  toRoadmapViewEdges,
  toRoadmapViewNodes,
  useRoadmapScrollLayout,
  buildLaneFlowNodesFromCanvas,
} from 'vj/components/roadmap/flow_shared';
import { useEditorTheme } from 'vj/components/editor_workspace';
import { isRoadmapFlowNode } from 'vj/components/roadmap/lanes';
import {
  baseEdgeToFlowEdge,
  normalizeRoadmapCanvasNode,
  type BaseRoadmapEdge,
  type BaseRoadmapNode,
  type RoadmapStatus,
} from 'vj/components/roadmap/shared';
import { RoadmapNodeDrawer } from 'vj/components/roadmap/RoadmapNodeDrawer';
import { attachTypoImagePreviewHandlers, isTypoImagePreviewOverlay } from './typo_image_preview';
import { useRoadmapCanvasNodeScroll } from './url_sync';
import {
  buildRoadmapNodeProblemCountMap,
  type RoadmapDetailDisplaySettings,
} from 'vj/components/roadmap/detail_display_settings';
import { computeRoadmapNodeNumbers } from 'vj/components/roadmap/node_numbering';
import { isHookNodeType, isTextNodeType, supportsRoadmapPracticeProblems } from 'vj/components/roadmap/node_kinds';
import type { BaseEdge, BaseNode, Card } from './types';

export function BaseDetailEmbeddedRoadmapViewer({
  childNodes,
  childEdges,
  nodeCardsMap,
  displaySettings,
  matchedNodeIds = null,
  selectedCanvasNodeId = null,
  scrollToCanvasNodeId = null,
  suppressNodeDrawer = false,
  onCanvasNodeSelect,
}: {
  childNodes: BaseNode[];
  childEdges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  displaySettings: RoadmapDetailDisplaySettings;
  matchedNodeIds?: Set<string> | null;
  selectedCanvasNodeId?: string | null;
  scrollToCanvasNodeId?: string | null;
  suppressNodeDrawer?: boolean;
  onCanvasNodeSelect?: (nodeId: string | null, label: string | null) => void;
}) {
  const normalizedChildNodes = useMemo(
    () => (childNodes || []).map((node) => normalizeRoadmapCanvasNode(node as BaseRoadmapNode)),
    [childNodes],
  );
  const layoutNodes = useMemo(
    () => buildLaneFlowNodesFromCanvas(normalizedChildNodes, childEdges as BaseRoadmapEdge[]),
    [childEdges, normalizedChildNodes],
  );
  const edges = useMemo(
    () => (childEdges || []).map((edge) => baseEdgeToFlowEdge(edge as BaseRoadmapEdge, normalizedChildNodes)),
    [childEdges, normalizedChildNodes],
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const theme = useEditorTheme();
  const selectedNodeId = selectedCanvasNodeId;

  const problemCountByNodeId = useMemo(
    () => buildRoadmapNodeProblemCountMap(layoutNodes, nodeCardsMap),
    [layoutNodes, nodeCardsMap],
  );
  const nodeNumberMap = useMemo(
    () => computeRoadmapNodeNumbers(layoutNodes, edges),
    [layoutNodes, edges],
  );
  const viewNodes = useMemo(() => {
    const base = toRoadmapViewNodes(layoutNodes, selectedNodeId).map((node) => ({
      ...node,
      draggable: false,
      data: {
        ...node.data,
        showProblemCountBadge: displaySettings.showProblemCount
          && supportsRoadmapPracticeProblems(node.data?.roadmapNodeType),
        problemCount: problemCountByNodeId.get(node.id) || 0,
        showNodeNumber: displaySettings.showNodeNumber,
        nodeNumber: nodeNumberMap.get(node.id) || '',
      },
    }));
    if (!matchedNodeIds) return base;
    return base.map((node) => {
      const matched = matchedNodeIds.has(node.id);
      const dimmed = !matched;
      return {
        ...node,
        selectable: matched,
        data: {
          ...node.data,
          explorerDimmed: dimmed,
        },
        style: {
          ...(node.style || {}),
          opacity: dimmed ? 0.2 : 1,
          pointerEvents: dimmed ? 'none' as const : 'all' as const,
          transition: 'opacity 0.2s ease',
        },
      };
    });
  }, [
    displaySettings.showNodeNumber,
    displaySettings.showProblemCount,
    layoutNodes,
    matchedNodeIds,
    nodeNumberMap,
    problemCountByNodeId,
    selectedNodeId,
  ]);
  const viewEdges = useMemo(() => {
    const base = toRoadmapViewEdges(edges, null, undefined, theme);
    if (!matchedNodeIds) return base;
    return base.map((edge) => {
      const visible = matchedNodeIds.has(edge.source) && matchedNodeIds.has(edge.target);
      return {
        ...edge,
        selectable: visible,
        style: {
          ...(edge.style || {}),
          opacity: visible ? 1 : 0.1,
          pointerEvents: visible ? 'all' as const : 'none' as const,
          transition: 'opacity 0.2s ease',
        },
      };
    });
  }, [edges, matchedNodeIds, theme]);
  const selectedNode = useMemo(
    () => layoutNodes.find((node) => node.id === selectedNodeId) || null,
    [layoutNodes, selectedNodeId],
  );

  const {
    outerRef,
    canvasHeight,
    lockedZoom,
    viewport,
    layoutReady,
    onFlowInit,
  } = useRoadmapScrollLayout(layoutNodes, { fillContainer: false });

  const scrollTargetNodeId = scrollToCanvasNodeId || selectedNodeId;
  useRoadmapCanvasNodeScroll({
    nodeId: scrollTargetNodeId,
    nodes: layoutNodes,
    viewport,
    canvasRef,
    canvasHeight,
  });

  const noopNodesChange = useCallback(() => {}, []);
  const noopEdgesChange = useCallback(() => {}, []);

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
        attachTypoImagePreviewHandlers(contentDiv);
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
      if (isTypoImagePreviewOverlay(target)) return;
      onCanvasNodeSelect?.(null, null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onCanvasNodeSelect, selectedNodeId]);

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
              onNodesChange={noopNodesChange}
              onEdgesChange={noopEdgesChange}
              onInit={onFlowInit}
              defaultViewport={viewport}
              onNodeClick={(_, node) => {
                if (node.type !== 'roadmap') return;
                if (isHookNodeType(node.data?.roadmapNodeType)) return;
                onCanvasNodeSelect?.(
                  node.id,
                  String(node.data?.label || i18n('Unnamed Node')),
                );
              }}
              onPaneClick={() => onCanvasNodeSelect?.(null, null)}
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
        open={!suppressNodeDrawer && !!selectedNode && !isTextNodeType(selectedNode.data?.roadmapNodeType)}
        nodeId={selectedNodeId || ''}
        nodeLabel={String(selectedNode?.data?.label || i18n('Unnamed Node'))}
        nodeStatus={selectedNode?.data?.status as RoadmapStatus | undefined}
        roadmapNodeType={selectedNode?.data?.roadmapNodeType}
        contentRef={contentRef}
        onClose={() => onCanvasNodeSelect?.(null, null)}
      />
    </>
  );
}

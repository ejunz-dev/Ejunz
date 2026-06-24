import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { RoadmapAiTutor } from 'vj/components/roadmap/RoadmapAiTutor';
import { RoadmapDetailExplorer } from 'vj/components/roadmap/RoadmapDetailExplorer';
import { RoadmapDetailSettingsPanel } from 'vj/components/roadmap/RoadmapDetailSettingsPanel';
import {
  buildRoadmapNodeProblemCountMap,
  readRoadmapDetailDisplaySettings,
  type RoadmapDetailDisplaySettings,
} from 'vj/components/roadmap/detail_display_settings';
import {
  computeRoadmapDetailMatchedNodeIds,
  emptyRoadmapDetailFilter,
  isRoadmapDetailFilterActive,
  readRoadmapDetailFilterFromLocation,
  type RoadmapDetailFilter,
} from 'vj/components/roadmap/detail_explorer';
import { isHookNodeType, isTextNodeType, supportsRoadmapPracticeProblems } from 'vj/components/roadmap/node_kinds';
import type { RoadmapStatus } from 'vj/components/roadmap/shared';
import type { EditorCard } from 'vj/components/editor_workspace/card_problems_panel';

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
  const [aiTutorOpen, setAiTutorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [displaySettings, setDisplaySettings] = useState<RoadmapDetailDisplaySettings>(() => (
    readRoadmapDetailDisplaySettings()
  ));
  const [displaySettingsSaving, setDisplaySettingsSaving] = useState(false);
  const [detailFilters, setDetailFilters] = useState<RoadmapDetailFilter>(() => readRoadmapDetailFilterFromLocation());
  const [nodeCardsMap, setNodeCardsMap] = useState<Record<string, EditorCard[]>>(
    () => (((window as any).UiContext?.nodeCardsMap || {}) as Record<string, EditorCard[]>),
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const theme = useEditorTheme();
  const layoutNodes = useMemo(() => nodes.filter(isRoadmapFlowNode), [nodes]);
  const matchedNodeIds = useMemo(
    () => computeRoadmapDetailMatchedNodeIds(layoutNodes, detailFilters, nodeCardsMap),
    [detailFilters, layoutNodes, nodeCardsMap],
  );
  const detailFiltersActive = useMemo(
    () => isRoadmapDetailFilterActive(detailFilters),
    [detailFilters],
  );
  const problemCountByNodeId = useMemo(
    () => buildRoadmapNodeProblemCountMap(layoutNodes, nodeCardsMap),
    [layoutNodes, nodeCardsMap],
  );
  const viewNodes = useMemo(() => {
    let base = toRoadmapViewNodes(layoutNodes, selectedNodeId).map((node) => ({
      ...node,
      data: {
        ...node.data,
        showProblemCountBadge: displaySettings.showProblemCount
          && supportsRoadmapPracticeProblems(node.data?.roadmapNodeType),
        problemCount: problemCountByNodeId.get(node.id) || 0,
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
  }, [displaySettings.showProblemCount, layoutNodes, matchedNodeIds, problemCountByNodeId, selectedNodeId]);
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
        if (data.nodeCardsMap) {
          const nextMap = data.nodeCardsMap as Record<string, EditorCard[]>;
          (window as any).UiContext.nodeCardsMap = nextMap;
          setNodeCardsMap(nextMap);
        }
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
      if (target.closest('.roadmap-ai-tutor-modal')) return;
      if (target.closest('.roadmap-ai-tutor-bar')) return;
      if (target.closest('.roadmap-detail-explorer')) return;
      if (target.closest('.roadmap-detail-explorer__dialog')) return;
      if (target.closest('.roadmap-detail-settings__dialog')) return;
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
    aiTutorActive: aiTutorOpen,
    onAiTutorClick: () => setAiTutorOpen(true),
    onSettingsClick: () => setSettingsOpen(true),
    settingsActive: settingsOpen,
  };

  const handleDisplaySettingsSave = useCallback(async (next: RoadmapDetailDisplaySettings) => {
    if (!context.docId) return;
    setDisplaySettingsSaving(true);
    try {
      await request.post(roadmapApiPath('/detail-ui-prefs', context.domainId), {
        docId: Number(context.docId),
        branch: doc.currentBranch || 'main',
        displayPrefs: next,
      });
      setDisplaySettings(next);
      setSettingsOpen(false);
      Notification.success(i18n('Roadmap detail settings saved'));
    } catch (err: any) {
      Notification.error(err?.message || i18n('Roadmap detail settings save failed'));
    } finally {
      setDisplaySettingsSaving(false);
    }
  }, [context.docId, context.domainId, doc.currentBranch]);

  if (!doc.nodes?.length) {
    return (
      <div className="roadmap-detail-layout">
        <RoadmapDetailHeader {...headerProps} />
        <div className="roadmap-view__empty">
          <p>{i18n('Roadmap detail empty')}</p>
        </div>
        <RoadmapDetailSettingsPanel
          open={settingsOpen}
          settings={displaySettings}
          saving={displaySettingsSaving}
          onClose={() => setSettingsOpen(false)}
          onSave={handleDisplaySettingsSave}
        />
      </div>
    );
  }

  return (
    <div className="roadmap-detail-layout">
      <RoadmapDetailHeader {...headerProps} />
      <RoadmapDetailExplorer
        nodes={layoutNodes}
        nodeCardsMap={nodeCardsMap}
        filters={detailFilters}
        filtersActive={detailFiltersActive}
        matchedCount={matchedNodeIds?.size ?? layoutNodes.length}
        onApplyFilters={setDetailFilters}
        onClearFilters={() => setDetailFilters(emptyRoadmapDetailFilter())}
        onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
      />
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
        roadmapNodeType={selectedNode?.data?.roadmapNodeType}
        contentRef={contentRef}
        onClose={() => setSelectedNodeId(null)}
      />

      <RoadmapAiTutor
        nodes={layoutNodes}
        edges={edges}
        docTitle={roadmapTitle}
        branch={roadmapBranch}
        docDescription={doc.content}
        selectedNode={selectedNode}
        open={aiTutorOpen}
        onOpenChange={setAiTutorOpen}
      />

      <RoadmapDetailSettingsPanel
        open={settingsOpen}
        settings={displaySettings}
        saving={displaySettingsSaving}
        onClose={() => setSettingsOpen(false)}
        onSave={handleDisplaySettingsSave}
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

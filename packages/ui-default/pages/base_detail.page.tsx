import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { domainApiPath, request, i18n } from 'vj/utils';
import type { BaseDoc, Card } from 'vj/components/base/types';
import { BaseDetailCardDrawer } from 'vj/components/base/BaseDetailCardDrawer';
import { BaseDetailExplorer } from 'vj/components/base/BaseDetailExplorer';
import { BaseDetailHeader } from 'vj/components/base/BaseDetailHeader';
import { BaseDetailEmbeddedRoadmapViewer } from 'vj/components/base/BaseDetailEmbeddedRoadmapViewer';
import { BaseDetailNodeContent } from 'vj/components/base/BaseDetailNodeContent';
import { BaseDetailTreeDrawer } from 'vj/components/base/BaseDetailSidebar';
import { RoadmapDetailSettingsPanel } from 'vj/components/roadmap/RoadmapDetailSettingsPanel';
import { cardDisplayLabel, getRoadmapChildGraph, nodeDisplayLabel, collectNodePathFromRoot, findCardHostNodeId, findRoadmapContainerAncestor, getPrimaryCardForNode, isRoadmapCanvasNodeId } from 'vj/components/base/detail_tree';
import {
  initialBaseDetailSelectedNodeId,
  resolveContentNodeIdForCard,
  useBaseDetailUrlSync,
} from 'vj/components/base/url_sync';
import {
  readBaseDetailDisplaySettings,
  type BaseDetailDisplaySettings,
} from 'vj/components/base/detail_display_settings';
import {
  computeBaseDetailTreeSearchVisibility,
  computeBaseDetailTreeVisibility,
  emptyBaseDetailFilter,
  mergeBaseDetailTreeVisibility,
  readBaseDetailFilterFromLocation,
  type BaseDetailFilter,
} from 'vj/components/base/detail_tree_filter';

type BaseDetailContext = {
  domainId?: string;
  docId?: string;
  bid?: number;
  currentBranch?: string;
  title?: string;
  content?: string;
  nodes?: BaseDoc['nodes'];
  edges?: BaseDoc['edges'];
};

function getBaseDetailFromContext(): BaseDetailContext {
  const ctx = ((window as any).UiContext?.base || {}) as BaseDetailContext;
  return {
    domainId: ctx.domainId || (window as any).UiContext?.domainId || 'system',
    docId: String(ctx.docId || ''),
    bid: ctx.bid,
    currentBranch: ctx.currentBranch || 'main',
    title: ctx.title || '',
    content: ctx.content || '',
    nodes: ctx.nodes || [],
    edges: ctx.edges || [],
  };
}

function BaseDetailViewer() {
  const base = useMemo(() => getBaseDetailFromContext(), []);
  const nodeCardsMap = useMemo(
    () => (((window as any).UiContext?.nodeCardsMap || {}) as Record<string, Card[]>),
    [],
  );
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => (
    initialBaseDetailSelectedNodeId(base.nodes || [])
  ));
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [scrollToCardId, setScrollToCardId] = useState<string | null>(null);
  const [scrollToCanvasNodeId, setScrollToCanvasNodeId] = useState<string | null>(null);
  const [detailFilters, setDetailFilters] = useState<BaseDetailFilter>(() => readBaseDetailFilterFromLocation());
  const [treeSearchQuery, setTreeSearchQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [displaySettings, setDisplaySettings] = useState<BaseDetailDisplaySettings>(() => (
    readBaseDetailDisplaySettings()
  ));
  const [displaySettingsSaving, setDisplaySettingsSaving] = useState(false);
  const title = base.title?.trim() || String(i18n('Knowledge Base'));
  const branch = base.currentBranch || 'main';
  const nodes = base.nodes || [];
  const edges = base.edges || [];
  const nodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);

  const cardExpandNodeIds = useMemo(() => {
    if (!selectedNodeId || !selectedCard || isRoadmapCanvasNodeId(selectedNodeId, nodes, edges)) return [];
    const hostNodeId = findCardHostNodeId(selectedCard.docId, nodeCardsMap);
    if (!hostNodeId) return [];
    const contentRootId = findRoadmapContainerAncestor(selectedNodeId, nodes, edges) || selectedNodeId;
    return collectNodePathFromRoot(hostNodeId, contentRootId, edges);
  }, [edges, nodeCardsMap, nodes, selectedCard, selectedNodeId]);

  const handleRestoreCardFromUrl = useCallback((cardId: string, hostNodeId: string) => {
    if (findRoadmapContainerAncestor(hostNodeId, nodes, edges)) {
      setScrollToCanvasNodeId(hostNodeId);
      setScrollToCardId(null);
      return;
    }
    setScrollToCardId(cardId);
    setScrollToCanvasNodeId(null);
  }, [edges, nodes]);

  const handleRestoreCanvasNodeFromUrl = useCallback((nodeId: string) => {
    setScrollToCanvasNodeId(nodeId);
  }, []);

  useBaseDetailUrlSync({
    nodes,
    nodeIds,
    edges,
    nodeCardsMap,
    selectedNodeId,
    setSelectedNodeId,
    selectedCard,
    setSelectedCard,
    onRestoreCard: handleRestoreCardFromUrl,
    onRestoreCanvasNode: handleRestoreCanvasNodeFromUrl,
    onClearCard: () => {
      setScrollToCardId(null);
      setScrollToCanvasNodeId(null);
    },
  });

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );
  const roadmapContainerId = useMemo(() => {
    if (!selectedNodeId) return null;
    return findRoadmapContainerAncestor(selectedNodeId, nodes, edges);
  }, [edges, nodes, selectedNodeId]);
  const isRoadmapView = !!roadmapContainerId;
  const canvasFocusedNodeId = useMemo(() => {
    if (!isRoadmapView || !selectedNodeId || selectedNodeId === roadmapContainerId) return null;
    return selectedNodeId;
  }, [isRoadmapView, roadmapContainerId, selectedNodeId]);
  const explorerScopeRootId = roadmapContainerId ?? selectedNodeId;
  const contentTreeRootId = selectedNodeId && !isRoadmapView ? selectedNodeId : null;

  const selectedRoadmapGraph = useMemo(() => {
    if (!roadmapContainerId) return { childNodes: [], childEdges: [] };
    return getRoadmapChildGraph(roadmapContainerId, nodes, edges);
  }, [edges, nodes, roadmapContainerId]);

  const contentTreeVisibility = useMemo(() => {
    if (!explorerScopeRootId) return null;
    const scope = [explorerScopeRootId];
    const filterVisibility = computeBaseDetailTreeVisibility(
      nodes,
      edges,
      nodeCardsMap,
      detailFilters,
      scope,
    );
    const searchVisibility = computeBaseDetailTreeSearchVisibility(
      nodes,
      edges,
      nodeCardsMap,
      treeSearchQuery,
      scope,
    );
    return mergeBaseDetailTreeVisibility(filterVisibility, searchVisibility);
  }, [detailFilters, edges, explorerScopeRootId, nodeCardsMap, nodes, treeSearchQuery]);

  const roadmapMatchedNodeIds = useMemo(() => {
    if (!isRoadmapView || !contentTreeVisibility) return null;
    return contentTreeVisibility.visibleNodeIds;
  }, [contentTreeVisibility, isRoadmapView]);

  const handleCanvasNodeSelect = useCallback((nodeId: string | null, _label: string | null) => {
    setScrollToCanvasNodeId(null);
    if (nodeId) {
      const primaryCard = getPrimaryCardForNode(nodeId, nodeCardsMap);
      setSelectedNodeId(nodeId);
      if (primaryCard) {
        setSelectedCard(primaryCard);
        setScrollToCanvasNodeId(nodeId);
        setScrollToCardId(null);
      } else {
        setSelectedCard(null);
        setScrollToCardId(null);
      }
      return;
    }
    if (roadmapContainerId) {
      setSelectedNodeId(roadmapContainerId);
      setSelectedCard(null);
      setScrollToCardId(null);
    }
  }, [nodeCardsMap, roadmapContainerId]);

  const handleSelectNode = useCallback((nodeId: string, keepTreeDrawerOpen = false) => {
    setSelectedNodeId(nodeId);
    setSelectedCard(null);
    setScrollToCardId(null);
    setScrollToCanvasNodeId(null);
    setTreeSearchQuery('');
    if (!keepTreeDrawerOpen) {
      setTreeDrawerOpen(false);
    }
  }, []);

  const handleSelectCard = useCallback((card: Card) => {
    const hostNodeId = resolveContentNodeIdForCard(
      card.docId,
      selectedNodeId,
      edges,
      nodeCardsMap,
    );
    if (hostNodeId) {
      setSelectedNodeId(hostNodeId);
    }
    setSelectedCard(card);
    if (hostNodeId && findRoadmapContainerAncestor(hostNodeId, nodes, edges)) {
      setScrollToCanvasNodeId(hostNodeId);
      setScrollToCardId(null);
    } else {
      setScrollToCardId(card.docId);
      setScrollToCanvasNodeId(null);
    }
  }, [edges, nodeCardsMap, nodes, selectedNodeId]);

  const handleCloseCardDrawer = useCallback(() => {
    setSelectedCard(null);
    setScrollToCardId(null);
  }, []);

  const handleDisplaySettingsSave = useCallback(async (next: BaseDetailDisplaySettings) => {
    if (!base.docId) return;
    setDisplaySettingsSaving(true);
    try {
      await request.post(domainApiPath('/base/detail-ui-prefs', base.domainId || 'system'), {
        docId: Number(base.docId),
        branch,
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
  }, [base.docId, base.domainId, branch]);

  useEffect(() => {
    if (!selectedCard) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest('.roadmap-detail-drawer')) return;
      handleCloseCardDrawer();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [handleCloseCardDrawer, selectedCard]);

  const headerTitle = useMemo(() => {
    if (selectedCard) return cardDisplayLabel(selectedCard);
    if (canvasFocusedNodeId) {
      const canvasNode = nodes.find((node) => node.id === canvasFocusedNodeId);
      if (canvasNode) return nodeDisplayLabel(canvasNode);
    }
    if (selectedNode) return nodeDisplayLabel(selectedNode);
    return title;
  }, [canvasFocusedNodeId, nodes, selectedCard, selectedNode, title]);

  const headerDescription = useMemo(() => {
    if (selectedCard && selectedNode) return nodeDisplayLabel(selectedNode);
    if (selectedNode) {
      if (canvasFocusedNodeId && roadmapContainerId) {
        const container = nodes.find((node) => node.id === roadmapContainerId);
        if (container) return nodeDisplayLabel(container);
      }
      return title;
    }
    return base.content;
  }, [base.content, canvasFocusedNodeId, nodes, roadmapContainerId, selectedCard, selectedNode, title]);

  return (
    <div className="roadmap-detail-layout">
      <BaseDetailHeader
        title={headerTitle}
        description={headerDescription}
        domainId={base.domainId || 'system'}
        docId={base.docId || ''}
        branch={branch}
        treeDrawerOpen={treeDrawerOpen}
        onTreeDrawerOpen={() => setTreeDrawerOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        settingsActive={settingsOpen}
      />
      {explorerScopeRootId ? (
        <BaseDetailExplorer
          searchQuery={treeSearchQuery}
          filters={detailFilters}
          matchedCount={contentTreeVisibility?.matchCount ?? 0}
          onSearchQueryChange={setTreeSearchQuery}
          onApplyFilters={setDetailFilters}
          onClearFilters={() => setDetailFilters(emptyBaseDetailFilter())}
        />
      ) : null}
      <div className="roadmap-view">
        {isRoadmapView ? (
          <div className="base-detail-roadmap-panel">
            <BaseDetailEmbeddedRoadmapViewer
              childNodes={selectedRoadmapGraph.childNodes}
              childEdges={selectedRoadmapGraph.childEdges}
              nodeCardsMap={nodeCardsMap}
              displaySettings={displaySettings}
              matchedNodeIds={roadmapMatchedNodeIds}
              selectedCanvasNodeId={canvasFocusedNodeId}
              scrollToCanvasNodeId={scrollToCanvasNodeId}
              suppressNodeDrawer={!!selectedCard}
              onCanvasNodeSelect={handleCanvasNodeSelect}
            />
          </div>
        ) : selectedNode ? (
          <main className="base-detail-main base-detail-main--node" aria-label={String(i18n('Content'))}>
            <BaseDetailNodeContent
              nodeId={selectedNode.id}
              nodes={nodes}
              edges={edges}
              nodeCardsMap={nodeCardsMap}
              selectedCardId={selectedCard?.docId || null}
              treeVisibility={contentTreeVisibility}
              displaySettings={displaySettings}
              extraExpandedNodeIds={cardExpandNodeIds}
              scrollToCardId={scrollToCardId}
              onSelectCard={handleSelectCard}
            />
          </main>
        ) : (
          <main className="base-detail-main" aria-label={String(i18n('Content'))}>
            <div className="base-detail-main__placeholder">
              <p>{i18n('Base detail content placeholder')}</p>
            </div>
          </main>
        )}
      </div>
      <BaseDetailTreeDrawer
        open={treeDrawerOpen}
        nodes={nodes}
        edges={edges}
        nodeCardsMap={nodeCardsMap}
        selectedNodeId={selectedNodeId}
        selectedCardId={selectedCard?.docId || null}
        displaySettings={displaySettings}
        onClose={() => setTreeDrawerOpen(false)}
        onSelectNode={handleSelectNode}
        onSelectCard={handleSelectCard}
      />
      <BaseDetailCardDrawer
        open={!!selectedCard}
        card={selectedCard}
        onClose={handleCloseCardDrawer}
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

const page = new NamedPage('base_detail', async () => {
  const $viewer = $('#base-detail-viewer');
  if (!$viewer.length) return;
  ReactDOM.render(<BaseDetailViewer />, $viewer[0]);
});

export default page;

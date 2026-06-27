import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import type { BaseDoc, Card } from 'vj/components/base/types';
import { BaseDetailCardDrawer } from 'vj/components/base/BaseDetailCardDrawer';
import { BaseDetailExplorer } from 'vj/components/base/BaseDetailExplorer';
import { BaseDetailHeader } from 'vj/components/base/BaseDetailHeader';
import { BaseDetailEmbeddedRoadmapViewer } from 'vj/components/base/BaseDetailEmbeddedRoadmapViewer';
import { BaseDetailNodeContent } from 'vj/components/base/BaseDetailNodeContent';
import { BaseDetailTreeDrawer } from 'vj/components/base/BaseDetailSidebar';
import { cardDisplayLabel, getRoadmapChildGraph, nodeDisplayLabel } from 'vj/components/base/detail_tree';
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedCanvasNodeLabel, setSelectedCanvasNodeLabel] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [detailFilters, setDetailFilters] = useState<BaseDetailFilter>(() => readBaseDetailFilterFromLocation());
  const [treeSearchQuery, setTreeSearchQuery] = useState('');
  const title = base.title?.trim() || String(i18n('Knowledge Base'));
  const branch = base.currentBranch || 'main';
  const nodes = base.nodes || [];
  const edges = base.edges || [];

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );
  const isRoadmapSelection = selectedNode?.type === 'roadmap';
  const contentTreeRootId = selectedNode && !isRoadmapSelection ? selectedNode.id : null;

  const selectedRoadmapGraph = useMemo(() => {
    if (!selectedNodeId || !isRoadmapSelection) return { childNodes: [], childEdges: [] };
    return getRoadmapChildGraph(selectedNodeId, nodes, edges);
  }, [edges, isRoadmapSelection, nodes, selectedNodeId]);

  const contentTreeVisibility = useMemo(() => {
    if (!contentTreeRootId) return null;
    const scope = [contentTreeRootId];
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
  }, [contentTreeRootId, detailFilters, edges, nodeCardsMap, nodes, treeSearchQuery]);

  const handleSelectNode = useCallback((nodeId: string, keepTreeDrawerOpen = false) => {
    setSelectedNodeId(nodeId);
    setSelectedCanvasNodeLabel(null);
    setSelectedCard(null);
    setTreeSearchQuery('');
    if (!keepTreeDrawerOpen) {
      setTreeDrawerOpen(false);
    }
  }, []);

  const handleSelectCard = useCallback((card: Card) => {
    setSelectedCard(card);
  }, []);

  const handleCloseCardDrawer = useCallback(() => {
    setSelectedCard(null);
  }, []);

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
    if (selectedCanvasNodeLabel) return selectedCanvasNodeLabel;
    if (selectedNode) return nodeDisplayLabel(selectedNode);
    return title;
  }, [selectedCanvasNodeLabel, selectedCard, selectedNode, title]);

  const headerDescription = useMemo(() => {
    if (selectedCard && selectedNode) return nodeDisplayLabel(selectedNode);
    if (selectedNode) {
      if (selectedCanvasNodeLabel && isRoadmapSelection) return nodeDisplayLabel(selectedNode);
      return title;
    }
    return base.content;
  }, [base.content, isRoadmapSelection, selectedCanvasNodeLabel, selectedCard, selectedNode, title]);

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
      />
      {contentTreeRootId ? (
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
        {selectedNode && isRoadmapSelection ? (
          <div className="base-detail-roadmap-panel">
            <BaseDetailEmbeddedRoadmapViewer
              childNodes={selectedRoadmapGraph.childNodes}
              childEdges={selectedRoadmapGraph.childEdges}
              nodeCardsMap={nodeCardsMap}
              onSelectedNodeChange={(_nodeId, label) => setSelectedCanvasNodeLabel(label)}
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
        onClose={() => setTreeDrawerOpen(false)}
        onSelectNode={handleSelectNode}
        onSelectCard={handleSelectCard}
      />
      <BaseDetailCardDrawer
        open={!!selectedCard}
        card={selectedCard}
        onClose={handleCloseCardDrawer}
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

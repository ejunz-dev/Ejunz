import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { ActionDialog } from 'vj/components/dialog';
import { domainApiPath, domainScopedPath, request, i18n, tpl } from 'vj/utils';
import type { BaseDoc, Card } from 'vj/components/base/types';
import { BaseDetailAiTutor } from 'vj/components/base/BaseDetailAiTutor';
import { BaseDetailCardDrawer } from 'vj/components/base/BaseDetailCardDrawer';
import { BaseDetailExplorer } from 'vj/components/base/BaseDetailExplorer';
import { BaseDetailHeader } from 'vj/components/base/BaseDetailHeader';
import { BaseDetailEmbeddedRoadmapViewer } from 'vj/components/base/BaseDetailEmbeddedRoadmapViewer';
import { BaseDetailNodeContent } from 'vj/components/base/BaseDetailNodeContent';
import { BaseDetailTreeDrawer } from 'vj/components/base/BaseDetailSidebar';
import { RoadmapDetailSettingsPanel } from 'vj/components/roadmap/RoadmapDetailSettingsPanel';
import { cardDisplayLabel, getRoadmapChildGraph, getSortedNodeChildren, nodeDisplayLabel, collectNodePathFromRoot, findCardHostNodeId, findRoadmapContainerAncestor, getPrimaryCardForNode, isRoadmapCanvasNodeId } from 'vj/components/base/detail_tree';
import { isTypoImagePreviewOverlay } from 'vj/components/base/typo_image_preview';
import {
  initialBaseDetailSelectedNodeId,
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
  const [aiTutorOpen, setAiTutorOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => (
    initialBaseDetailSelectedNodeId(base.nodes || [])
  ));
  const [contentRootNodeId, setContentRootNodeId] = useState<string | null>(() => (
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
  const [learnBusy, setLearnBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const title = base.title?.trim() || String(i18n('Knowledge Base'));
  const branch = base.currentBranch || 'main';
  const nodes = base.nodes || [];
  const edges = base.edges || [];
  const nodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);

  const cardExpandNodeIds = useMemo(() => {
    if (!contentRootNodeId || !selectedCard || isRoadmapCanvasNodeId(contentRootNodeId, nodes, edges)) return [];
    const hostNodeId = findCardHostNodeId(selectedCard.docId, nodeCardsMap);
    if (!hostNodeId) return [];
    const contentRootId = findRoadmapContainerAncestor(contentRootNodeId, nodes, edges) || contentRootNodeId;
    return collectNodePathFromRoot(hostNodeId, contentRootId, edges);
  }, [contentRootNodeId, edges, nodeCardsMap, nodes, selectedCard]);

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
    contentRootNodeId,
    setContentRootNodeId,
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
  const explorerScopeRootId = roadmapContainerId ?? contentRootNodeId;
  const contentRootNode = useMemo(
    () => (contentRootNodeId ? nodes.find((node) => node.id === contentRootNodeId) || null : null),
    [contentRootNodeId, nodes],
  );

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
    setContentRootNodeId(nodeId);
    setSelectedCard(null);
    setScrollToCardId(null);
    setScrollToCanvasNodeId(null);
    setTreeSearchQuery('');
    if (!keepTreeDrawerOpen) {
      setTreeDrawerOpen(false);
    }
  }, []);

  const handleSelectCardInContent = useCallback((card: Card) => {
    setSelectedCard(card);
    setScrollToCardId(card.docId);
    setScrollToCanvasNodeId(null);
  }, []);

  const handleSelectNodeInContent = useCallback(async (targetNodeId: string) => {
    if (targetNodeId === contentRootNodeId) return;
    const targetNode = nodes.find((n) => n.id === targetNodeId);
    if (!targetNode) return;
    const nodeLabel = nodeDisplayLabel(targetNode);
    const dialogMsg = `${i18n('Switch to node:')}\n${nodeLabel}`;
    const dialogBody = tpl.typoMsg(dialogMsg);
    const dialog = new ActionDialog({ $body: dialogBody, width: '420px' });
    const action = await dialog.open();
    if (action !== 'ok') return;
    handleSelectNode(targetNodeId);
  }, [contentRootNodeId, nodes, handleSelectNode]);

  const handleSelectCardInStructure = useCallback((card: Card) => {
    const hostNodeId = findCardHostNodeId(card.docId, nodeCardsMap);
    if (hostNodeId) {
      setSelectedNodeId(hostNodeId);
      setContentRootNodeId(hostNodeId);
    }
    setSelectedCard(card);
    if (hostNodeId && findRoadmapContainerAncestor(hostNodeId, nodes, edges)) {
      setScrollToCanvasNodeId(hostNodeId);
      setScrollToCardId(null);
    } else {
      setScrollToCardId(card.docId);
      setScrollToCanvasNodeId(null);
    }
    setTreeSearchQuery('');
    setTreeDrawerOpen(false);
  }, [edges, nodeCardsMap, nodes]);

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
      if (target.closest('.roadmap-ai-tutor-modal')) return;
      if (target.closest('.roadmap-ai-tutor-bar')) return;
      if (isTypoImagePreviewOverlay(target)) return;
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
    if (selectedCard) {
      const hostId = findCardHostNodeId(selectedCard.docId, nodeCardsMap);
      const hostNode = hostId ? nodes.find((node) => node.id === hostId) : null;
      if (hostNode) return nodeDisplayLabel(hostNode);
    }
    if (selectedNode) {
      if (canvasFocusedNodeId && roadmapContainerId) {
        const container = nodes.find((node) => node.id === roadmapContainerId);
        if (container) return nodeDisplayLabel(container);
      }
      return title;
    }
    return base.content;
  }, [base.content, canvasFocusedNodeId, nodeCardsMap, nodes, roadmapContainerId, selectedCard, selectedNode, title]);

  // Collect all descendant node ids recursively
  const collectDescendantNodeIds = useCallback((rootId: string): string[] => {
    const ids: string[] = [];
    const visit = (nodeId: string) => {
      const children = getSortedNodeChildren(nodeId, nodes, edges);
      children.forEach((child) => {
        ids.push(child.id);
        visit(child.id);
      });
    };
    visit(rootId);
    return ids;
  }, [nodes, edges]);

  const learnTargetNodeId = contentRootNodeId;

  const startSingleNodeLearn = useCallback(async () => {
    const nodeId = String(learnTargetNodeId || '').trim();
    if (!nodeId || learnBusy) return;
    const baseDocNum = Number(base.docId);
    if (!Number.isFinite(baseDocNum) || baseDocNum <= 0) {
      Notification.error(i18n('Outline editor start invalid base'));
      return;
    }

    // Build node stats for the confirmation dialog
    const descendantIds = collectDescendantNodeIds(nodeId);
    const childNodeCount = descendantIds.length;
    let cardCount = 0;
    let problemCount = 0;
    descendantIds.forEach((id) => {
      const cards = nodeCardsMap[id] || [];
      cardCount += cards.length;
      problemCount += cards.reduce((sum, card) => sum + (card.problems?.length || 0), 0);
    });
    // Also count current node's own cards
    const selfCards = nodeCardsMap[nodeId] || [];
    cardCount += selfCards.length;
    problemCount += selfCards.reduce((sum, card) => sum + (card.problems?.length || 0), 0);
    const nodeLabel = nodeDisplayLabel(
      nodes.find((n) => n.id === nodeId) || { id: nodeId, text: '' },
    );

    // Show confirmation dialog
    const statsParts: string[] = [];
    if (childNodeCount > 0) statsParts.push(i18n('Child nodes: {0}', childNodeCount));
    if (cardCount > 0) statsParts.push(i18n('Cards: {0}', cardCount));
    if (problemCount > 0) statsParts.push(i18n('Problems: {0}', problemCount));
    const dialogMsg = statsParts.length > 0
      ? `${i18n('Start learning session for node:')}\n${nodeLabel}\n${statsParts.join('，')}`
      : `${i18n('Start learning session for node:')}\n${nodeLabel}`;
    const dialogBody = tpl.typoMsg(dialogMsg);
    const dialog = new ActionDialog({ $body: dialogBody, width: '420px' });
    const action = await dialog.open();
    if (action !== 'ok') return;

    const domainId = base.domainId || 'system';
    setLearnBusy(true);
    try {
      const res: any = await request.post(domainApiPath('/learn/lesson/start', domainId), {
        mode: 'node',
        nodeId,
        baseDocId: baseDocNum,
        branch,
      });
      const redir = res?.redirect ?? res?.body?.redirect ?? res?.data?.redirect;
      const url = redir || domainScopedPath('/learn/lesson', domainId);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        opened.opener = null;
      } else {
        Notification.error(i18n('Outline editor popup blocked'));
      }
    } catch (e: any) {
      const raw = typeof e?.message === 'string' ? e.message : String(e ?? '');
      const cleaned = raw.replace(/^[A-Za-z]+Error:\s*/i, '').trim();
      const msg = cleaned === 'No cards match session card filter'
        || cleaned === 'Learn requires cards with problems'
        ? i18n('Learn requires cards with problems')
        : (cleaned || i18n('Outline learn start failed'));
      Notification.error(msg);
    } finally {
      setLearnBusy(false);
    }
  }, [base.docId, base.domainId, branch, learnBusy, learnTargetNodeId, nodes, edges, nodeCardsMap]);

  const startEditorSession = useCallback(async () => {
    const nodeId = String(contentRootNodeId || '').trim();
    if (!nodeId || editorBusy) return;
    const baseDocNum = Number(base.docId);
    if (!Number.isFinite(baseDocNum) || baseDocNum <= 0) {
      Notification.error(i18n('Outline editor start invalid base'));
      return;
    }

    // Build subtree stats for the confirmation dialog
    const descendantIds = collectDescendantNodeIds(nodeId);
    const childNodeCount = descendantIds.length;
    let cardCount = 0;
    let problemCount = 0;
    descendantIds.forEach((id) => {
      const cards = nodeCardsMap[id] || [];
      cardCount += cards.length;
      problemCount += cards.reduce((sum, card) => sum + (card.problems?.length || 0), 0);
    });
    // Also count current node's own cards
    const selfCards = nodeCardsMap[nodeId] || [];
    cardCount += selfCards.length;
    problemCount += selfCards.reduce((sum, card) => sum + (card.problems?.length || 0), 0);
    const nodeLabel = nodeDisplayLabel(
      nodes.find((n) => n.id === nodeId) || { id: nodeId, text: '' },
    );

    // Show confirmation dialog
    const statsParts: string[] = [];
    if (childNodeCount > 0) statsParts.push(i18n('Child nodes: {0}', childNodeCount));
    if (cardCount > 0) statsParts.push(i18n('Cards: {0}', cardCount));
    if (problemCount > 0) statsParts.push(i18n('Problems: {0}', problemCount));
    const dialogMsg = statsParts.length > 0
      ? `${i18n('Start develop session for node:')}\n${nodeLabel}\n${statsParts.join('，')}`
      : `${i18n('Start develop session for node:')}\n${nodeLabel}`;
    const dialogBody = tpl.typoMsg(dialogMsg);
    const dialog = new ActionDialog({ $body: dialogBody, width: '420px' });
    const action = await dialog.open();
    if (action !== 'ok') return;

    const domainId = base.domainId || 'system';
    const branchName = base.currentBranch || 'main';
    setEditorBusy(true);
    try {
      const payload: Record<string, unknown> = {
        baseDocId: baseDocNum,
        branch: branchName,
        nodeId,
        developMapDocType: 70,
      };
      const res: any = await request.post(domainApiPath('/session/develop/start', domainId), payload);
      const sessionId = res?.sessionId ?? res?.body?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        Notification.error(i18n('Outline editor start failed'));
        return;
      }
      const sp = new URLSearchParams({
        session: sessionId.trim(),
        nodeId,
      });
      const editorUrl = domainApiPath('/develop/editor', domainId);
      const sep = editorUrl.includes('?') ? '&' : '?';
      const opened = window.open(`${editorUrl}${sep}${sp.toString()}`, '_blank');
      if (opened) {
        opened.opener = null;
      } else {
        Notification.error(i18n('Outline editor popup blocked'));
      }
    } catch (e: any) {
      const msg = e?.message ?? i18n('Outline editor start failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setEditorBusy(false);
    }
  }, [base.docId, base.currentBranch, base.domainId, contentRootNodeId, editorBusy, nodes, nodeCardsMap]);

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
        aiTutorActive={aiTutorOpen}
        onAiTutorClick={() => setAiTutorOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        settingsActive={settingsOpen}
        onStartLearningClick={startSingleNodeLearn}
        learnBusy={learnBusy}
        learnDisabled={!learnTargetNodeId}
        onStartEditorSession={startEditorSession}
        editorBusy={editorBusy}
        editorDisabled={!contentRootNodeId}
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
        ) : contentRootNode ? (
          <main className="base-detail-main base-detail-main--node" aria-label={String(i18n('Content'))}>
            <BaseDetailNodeContent
              nodeId={contentRootNode.id}
              nodes={nodes}
              edges={edges}
              nodeCardsMap={nodeCardsMap}
              selectedCardId={selectedCard?.docId || null}
              treeVisibility={contentTreeVisibility}
              displaySettings={displaySettings}
              extraExpandedNodeIds={cardExpandNodeIds}
              scrollToCardId={scrollToCardId}
              onSelectCard={handleSelectCardInContent}
              onSelectNode={handleSelectNodeInContent}
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
        onSelectCard={handleSelectCardInStructure}
      />
      <BaseDetailCardDrawer
        open={!!selectedCard}
        card={selectedCard}
        onClose={handleCloseCardDrawer}
      />
      <BaseDetailAiTutor
        nodes={nodes}
        edges={edges}
        nodeCardsMap={nodeCardsMap}
        docTitle={title}
        branch={branch}
        docDescription={base.content}
        selectedNode={selectedNode}
        selectedCard={selectedCard}
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

const page = new NamedPage('base_detail', async () => {
  const $viewer = $('#base-detail-viewer');
  if (!$viewer.length) return;
  ReactDOM.render(<BaseDetailViewer />, $viewer[0]);
});

export default page;

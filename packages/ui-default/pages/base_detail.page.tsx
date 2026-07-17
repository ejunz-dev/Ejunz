import $ from 'jquery';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { ActionDialog } from 'vj/components/dialog';
import { domainApiPath, domainScopedPath, request, i18n, tpl } from 'vj/utils';
import type { BaseDoc, Card } from 'vj/components/base/types';
import { BaseDetailAiTutor } from 'vj/components/base/BaseDetailAiTutor';
import { BaseDetailCardDrawer } from 'vj/components/base/BaseDetailCardDrawer';
import { CardEditModal } from 'vj/components/base/CardEditModal';
import { ProblemEditModal } from 'vj/components/base/ProblemEditModal';
import { BaseDetailExplorer } from 'vj/components/base/BaseDetailExplorer';
import { BaseDetailHeader } from 'vj/components/base/BaseDetailHeader';
import { BaseDetailSemanticSearch, type SemanticSearchItem } from 'vj/components/base/BaseDetailSemanticSearch';
import { BaseDetailEmbeddedRoadmapViewer } from 'vj/components/base/BaseDetailEmbeddedRoadmapViewer';
import { BaseDetailNodeContent } from 'vj/components/base/BaseDetailNodeContent';
import { BaseDetailTreeDrawer } from 'vj/components/base/BaseDetailSidebar';
import { StatusIndicator } from 'vj/components/base/StatusIndicator';
import { FloatingToolbar } from 'vj/components/base/FloatingToolbar';
import { BaseDetailSettingsPanel } from 'vj/components/base/BaseDetailSettingsPanel';
import { getRoadmapChildGraph, getSortedNodeChildren, nodeDisplayLabel, collectNodePathFromRoot, findCardByDocId, findCardHostNodeId, findRoadmapContainerAncestor, getPrimaryCardForNode, isRoadmapCanvasNodeId } from 'vj/components/base/detail_tree';
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
  const [nodeCardsMap, setNodeCardsMap] = useState<Record<string, Card[]>>(
    () => ((window as any).UiContext?.nodeCardsMap || {}) as Record<string, Card[]>,
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
  const [semanticSearchOpen, setSemanticSearchOpen] = useState(false);
  const [highlightNodeId, setHighlightNodeId] = useState<string | null>(null);
  const [highlightText, setHighlightText] = useState<string | null>(null);
  const [displaySettings, setDisplaySettings] = useState<BaseDetailDisplaySettings>(() => (
    readBaseDetailDisplaySettings()
  ));
  const [displaySettingsSaving, setDisplaySettingsSaving] = useState(false);
  const [learnBusy, setLearnBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editCard, setEditCard] = useState<Card | null>(null);
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  const [editProblem, setEditProblem] = useState<{ pid: string; index: number } | null>(null);
  const [expandDirty, setExpandDirty] = useState(false);
  const expandSaveBusyRef = useRef(false);
  const expandedSnapshotRef = useRef<Set<string> | null>(null);
  const title = base.title?.trim() || String(i18n('Knowledge Base'));
  const branch = base.currentBranch || 'main';
  const [liveNodes, setLiveNodes] = useState(base.nodes || []);
  const [liveEdges, setLiveEdges] = useState(base.edges || []);
  const nodes = liveNodes;
  const edges = liveEdges;
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const fromContext = (window as any).UiContext?.baseExpandState;
    const loaded = (window as any).UiContext?.baseExpandStateLoaded;
    let s: Set<string>;
    if (Array.isArray(fromContext) && loaded && fromContext.length > 0) {
      s = new Set(fromContext);
    } else {
      s = new Set((base.nodes || []).filter((n: BaseNode) => n.expanded !== false).map((n: BaseNode) => n.id));
    }
    expandedSnapshotRef.current = s;
    return s;
  });
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
    selectedProblemId,
    setSelectedProblemId,
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
    setSelectedProblemId(null);
    setEditProblem(null);
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
    setSelectedProblemId(null);
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
    setHighlightText(null);
    setSelectedProblemId(null);
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

  const handleExpandedNodesChange = useCallback((nodeIds: Set<string>) => {
    // Mark dirty — user must save manually (Ctrl+S / Cmd+S)
    setExpandedNodes(nodeIds);
    expandedSnapshotRef.current = nodeIds;
    setExpandDirty(true);
  }, []);

  const handleSaveExpandState = useCallback(async () => {
    const nodeIds = expandedSnapshotRef.current;
    if (!expandDirty || expandSaveBusyRef.current) return;
    expandSaveBusyRef.current = true;
    try {
      const promises: Promise<unknown>[] = [];
      if (nodeIds) {
        promises.push(
          request.post(domainApiPath('/base/expand-state', base.domainId || 'system'), {
            docId: Number(base.docId),
            expandedNodeIds: Array.from(nodeIds),
          }),
        );
      }
      promises.push(
        request.post(domainApiPath('/base/detail-ui-prefs', base.domainId || 'system'), {
          docId: Number(base.docId),
          branch,
          displayPrefs: {
            showToolbar: displaySettings.showToolbar,
            indicatorX: displaySettings.indicatorX,
            indicatorY: displaySettings.indicatorY,
            toolbarOpen: displaySettings.toolbarOpen,
            toolbarX: displaySettings.toolbarX,
            toolbarY: displaySettings.toolbarY,
          },
        }),
      );
      await Promise.all(promises);
      setExpandDirty(false);
      Notification.success(i18n('Saved'));
    } catch { /* silent */ }
    expandSaveBusyRef.current = false;
  }, [base.docId, base.domainId, branch, displaySettings.indicatorX, displaySettings.indicatorY, displaySettings.toolbarOpen, displaySettings.toolbarX, displaySettings.toolbarY, expandDirty]);

  // Ctrl+S / Cmd+S saves expand state
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void handleSaveExpandState();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleSaveExpandState]);

  // Clear search highlights on any click outside
  useEffect(() => {
    if (!highlightNodeId && !highlightText) return undefined;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest('.roadmap-semantic-search-modal')) return;
      setHighlightNodeId(null);
      setHighlightText(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [highlightNodeId, highlightText]);

  useEffect(() => {
    if (!selectedCard) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest('.roadmap-detail-drawer')) return;
      if (target.closest('.roadmap-ai-tutor-modal')) return;
      if (target.closest('.roadmap-ai-tutor-bar')) return;
      if (target.closest('[data-card-edit-overlay]')) return;
      if (isTypoImagePreviewOverlay(target)) return;
      handleCloseCardDrawer();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [handleCloseCardDrawer, selectedCard]);

  // WebSocket: receive live base updates
  useEffect(() => {
    const socketUrl = (window as any).UiContext?.socketUrl;
    const wsPrefix = (window as any).UiContext?.ws_prefix || '';
    const domainId = base.domainId || 'system';
    const docId = base.docId || '';
    if (!socketUrl || !domainId || !docId) return;
    let closed = false;
    let lastNotifyKey = '';
    const apiQs: Record<string, string> = { docId, branch };
    const dataUrl = domainApiPath('/base/data', domainId);

    const connect = async () => {
      try {
        const { default: WebSocket } = await import('../components/socket');
        const wsUrl = wsPrefix + socketUrl;
        const sock = new WebSocket(wsUrl, false, true);
        sock.onmessage = (_: any, data: string) => {
          if (closed) return;
          try {
            const msg = JSON.parse(data);
            if (msg.type === 'init') {
              // initial SSR data already loaded; nothing to do
              return;
            }
            if (msg.type !== 'update') return;
            // Ignore updates for a different branch
            if (msg.sourceBranch && branch && msg.sourceBranch !== branch) return;
            // Re-fetch latest data
            request.get(dataUrl, apiQs).then((newData: any) => {
              if (closed || !newData) return;
              if (newData.nodes) setLiveNodes(newData.nodes);
              if (newData.edges) setLiveEdges(newData.edges);
              if (newData.nodeCardsMap) {
                setNodeCardsMap(newData.nodeCardsMap);
                // If a card is selected, refresh it from the new map
                setSelectedCard((prev) => {
                  if (!prev) return null;
                  for (const cards of Object.values(newData.nodeCardsMap) as Card[][]) {
                    const found = cards.find((c: Card) => c.docId === prev.docId);
                    if (found) return found;
                  }
                  return prev;
                });
              }
            }).catch(() => {});
            // Skip notification for changes triggered by THIS window's save
            const ownSaveTs = (window as any).__baseJustSaved;
            if (ownSaveTs && Date.now() - ownSaveTs < 3000) return;
            // Skip notification for session/sidecar side-effects (no real actionKey)
            if (!msg.actionKey || msg.actionKey === 'unknown') return;
            const notifyKey = String(msg.sourceUid ?? '');
            if (notifyKey === lastNotifyKey) return;
            lastNotifyKey = notifyKey;
            setTimeout(() => { lastNotifyKey = ''; }, 3000);
            const buildSummary = (ak: string, det: any): string => {
              switch (ak) {
                case 'batch_update': {
                  const parts: string[] = [];
                  if (det?.nodeCreates) parts.push(i18n('{0} new nodes', det.nodeCreates));
                  if (det?.nodeUpdates) parts.push(i18n('{0} nodes updated', det.nodeUpdates));
                  if (det?.nodeDeletes) parts.push(i18n('{0} nodes deleted', det.nodeDeletes));
                  if (det?.cardCreates) parts.push(i18n('{0} new cards', det.cardCreates));
                  if (det?.cardUpdates) parts.push(i18n('{0} cards updated', det.cardUpdates) + (det?.problemUpdates ? ` (${i18n('{0} problems', det.problemUpdates)})` : ''));
                  if (det?.cardDeletes) parts.push(i18n('{0} cards deleted', det.cardDeletes));
                  if (det?.edgeCreates) parts.push(i18n('{0} new edges', det.edgeCreates));
                  if (det?.edgeDeletes) parts.push(i18n('{0} edges deleted', det.edgeDeletes));
                  return parts.join('，') || i18n('Saved');
                }
                case 'full_save': return i18n('Saved');
                case 'sidecar_save': return i18n('Settings saved');
                case 'expand_save': return i18n('Tree state saved');
                case 'update_card': {
                  const changed = (det?.changed || []).map((k: string) => {
                    const map: Record<string, string> = { title: i18n('Title'), content: i18n('Content'), problems: i18n('Problems'), nodeId: i18n('Node'), order: i18n('Order') };
                    return map[k] || k;
                  });
                  return i18n('Card updated: ') + changed.join('，');
                }
                case 'delete_card': return i18n('Card deleted');
                case 'git_commit': return det?.message ? i18n('Committed: {0}', det.message) : i18n('Committed');
                case 'migrate_node': return i18n('Node migrated to new base');
                case 'add_tag': return det?.tag ? i18n('Tag added: {0}', det.tag) : i18n('Tag added');
                default: return i18n('Content has been updated');
              }
            };
            new Notification({
              title: msg.sourceUname || '',
              message: buildSummary(msg.actionKey, msg.actionDetail),
              closable: true,
              position: 'top-right',
              duration: 0,
            }).show();
          } catch { /* ignore parse errors */ }
        };
      } catch { /* WS init failed — no-op */ }
    };
    connect();
    return () => { closed = true; };
  }, []);

  const headerTitle = useMemo(() => {
    if (canvasFocusedNodeId) {
      const canvasNode = nodes.find((node) => node.id === canvasFocusedNodeId);
      if (canvasNode) return nodeDisplayLabel(canvasNode);
    }
    if (selectedNode) return nodeDisplayLabel(selectedNode);
    return title;
  }, [canvasFocusedNodeId, nodes, selectedNode, title]);

  const headerDescription = useMemo(() => {
    if (selectedNode) {
      if (canvasFocusedNodeId && roadmapContainerId) {
        const container = nodes.find((node) => node.id === roadmapContainerId);
        if (container) return nodeDisplayLabel(container);
      }
      return title;
    }
    return base.content;
  }, [base.content, canvasFocusedNodeId, nodeCardsMap, nodes, roadmapContainerId, selectedNode, title]);

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

  const handleStartEditCard = useCallback(() => {
    if (selectedCard) setEditCard(selectedCard);
  }, [selectedCard]);

  const handleEditCardSave = useCallback((updatedCard: Card) => {
    setSelectedCard(updatedCard);
    // Also patch the card in nodeCardsMap so node/tree views reflect the update
    setNodeCardsMap((prev) => {
      const next: Record<string, Card[]> = {};
      for (const [nodeId, cards] of Object.entries(prev)) {
        next[nodeId] = cards.map((c) => (c.docId === updatedCard.docId ? updatedCard : c));
      }
      return next;
    });
    setEditCard(null);
  }, []);

  const handleCloseEditCard = useCallback(() => {
    setEditCard(null);
  }, []);

  const handleSelectProblem = useCallback((pid: string) => {
    setSelectedProblemId((prev) => (prev === pid ? null : pid));
  }, []);

  const handleEditProblem = useCallback((_pid: string, index: number) => {
    setEditProblem({ pid: _pid, index });
  }, []);

  const handleProblemEditSave = useCallback((updatedCard: Card) => {
    setSelectedCard(updatedCard);
    setNodeCardsMap((prev) => {
      const next: Record<string, Card[]> = {};
      for (const [nodeId, cards] of Object.entries(prev)) {
        next[nodeId] = cards.map((c) => (c.docId === updatedCard.docId ? updatedCard : c));
      }
      return next;
    });
    setEditProblem(null);
  }, []);

  const handleCloseEditProblem = useCallback(() => {
    setEditProblem(null);
  }, []);

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
        onSearchClick={() => setSemanticSearchOpen(true)}
        searchActive={semanticSearchOpen}
      />
      {displaySettings.showExpandSaveIndicator ? (
        <StatusIndicator
          dirty={expandDirty}
          posX={displaySettings.indicatorX}
          posY={displaySettings.indicatorY}
          onPosChange={(x, y) => {
            setDisplaySettings((prev) => ({ ...prev, indicatorX: x, indicatorY: y }));
            setExpandDirty(true);
          }}
        />
      ) : null}
      {displaySettings.showToolbar ? (
        <FloatingToolbar
          open={displaySettings.toolbarOpen}
          posX={displaySettings.toolbarX}
          posY={displaySettings.toolbarY}
          onOpenChange={(v) => {
            setDisplaySettings((prev) => ({ ...prev, toolbarOpen: v }));
            setExpandDirty(true);
          }}
          onPosChange={(x, y) => {
            setDisplaySettings((prev) => ({ ...prev, toolbarX: x, toolbarY: y }));
            setExpandDirty(true);
          }}
          onTreeOpen={() => setTreeDrawerOpen(true)}
          onSearchOpen={() => setSemanticSearchOpen(true)}
        />
      ) : null}
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
              selectedProblemId={selectedProblemId}
              onSelectProblem={handleSelectProblem}
              treeVisibility={contentTreeVisibility}
              displaySettings={displaySettings}
              extraExpandedNodeIds={cardExpandNodeIds}
              scrollToCardId={scrollToCardId}
              onSelectCard={handleSelectCardInContent}
              onSelectNode={handleSelectNodeInContent}
              expandedNodes={expandedNodes}
              onExpandedNodesChange={handleExpandedNodesChange}
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
        expandedNodes={expandedNodes}
        drawerWidth={displaySettings.treeDrawerWidth}
        onDrawerWidthChange={(w) => {
          setDisplaySettings((prev) => ({ ...prev, treeDrawerWidth: w }));
          setExpandDirty(true);
        }}
        onClose={() => setTreeDrawerOpen(false)}
        onSelectNode={handleSelectNode}
        onSelectCard={handleSelectCardInStructure}
        onExpandedNodesChange={handleExpandedNodesChange}
      />
      <BaseDetailCardDrawer
        open={!!selectedCard}
        card={selectedCard}
        onClose={handleCloseCardDrawer}
        highlightText={highlightText}
        baseDocId={base.docId}
        domainId={base.domainId}
        drawerWidth={displaySettings.cardDrawerWidth}
        onDrawerWidthChange={(w) => {
          setDisplaySettings((prev) => ({ ...prev, cardDrawerWidth: w }));
          setExpandDirty(true);
        }}
        onEditCard={handleStartEditCard}
        editorBusy={editCard !== null}
        selectedProblemId={selectedProblemId}
        onSelectProblem={handleSelectProblem}
        onEditProblem={handleEditProblem}
      />
      {displaySettings.showAiTutor ? (
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
          docId={base.docId}
        />
      ) : null}
      <BaseDetailSettingsPanel
        open={settingsOpen}
        settings={displaySettings}
        saving={displaySettingsSaving}
        onClose={() => setSettingsOpen(false)}
        onSave={handleDisplaySettingsSave}
      />
      <BaseDetailSemanticSearch
        domainId={base.domainId || 'system'}
        docId={base.docId || ''}
        branch={branch}
        open={semanticSearchOpen}
        onOpenChange={setSemanticSearchOpen}
        onSelectResult={(result) => {
          if (result.kind === 'node') {
            const node = nodes.find((n) => n.id === result.nodeId);
            if (node) {
              setHighlightText(null);
              setHighlightNodeId(result.nodeId);
              handleSelectNode(result.nodeId);
            }
          } else if (result.kind === 'card') {
            const card = findCardByDocId(result.cardDocId || '', nodeCardsMap);
            const hostNodeId = findCardHostNodeId(result.cardDocId || '', nodeCardsMap);
            setHighlightNodeId(null);
            setHighlightText(result.text || null);
            if (hostNodeId) {
              handleSelectNode(hostNodeId);
              if (card) handleSelectCardInStructure(card);
            }
          }
        }}
      />
      {editCard ? (
        <CardEditModal
          card={editCard}
          domainId={base.domainId}
          onSave={handleEditCardSave}
          onClose={handleCloseEditCard}
        />
      ) : null}
      {editProblem && selectedCard ? (
        <ProblemEditModal
          card={selectedCard}
          problem={(selectedCard.problems || [])[editProblem.index]}
          problemIndex={editProblem.index}
          domainId={base.domainId}
          baseDocId={base.docId}
          onSave={handleProblemEditSave}
          onClose={handleCloseEditProblem}
        />
      ) : null}
    </div>
  );
}

const page = new NamedPage('base_detail', async () => {
  const $viewer = $('#base-detail-viewer');
  if (!$viewer.length) return;
  ReactDOM.render(<BaseDetailViewer />, $viewer[0]);
});

export default page;

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePageData } from '../../context/page-data';
import Notification from '../notification';
import { i18n } from '../../i18n';
import { BaseDetailCardDrawer } from './BaseDetailCardDrawer';
import { BaseDetailCardEditDialog } from './BaseDetailCardEditDialog';
import { BaseDetailConfirmDialog } from './BaseDetailConfirmDialog';
import { BaseDetailProblemEditDialog } from './BaseDetailProblemEditDialog';
import { BaseDetailSettingsDialog } from './BaseDetailSettingsDialog';
import { BaseDetailStatusIndicator } from './BaseDetailStatusIndicator';
import { BaseDetailFloatingToolbar } from './BaseDetailFloatingToolbar';
import { BaseDetailWSStatusIndicator } from './BaseDetailWSStatusIndicator';
import { requestJson, updateBaseCard } from './base-detail-api';
import { BaseDetailExplorer } from './BaseDetailExplorer';
import { BaseDetailHeader } from './BaseDetailHeader';
import { BaseDetailNodeContent } from './BaseDetailNodeContent';
import { BaseDetailTreeDrawer } from './BaseDetailTreeDrawer';
import { BaseDetailTree } from './BaseDetailTree';
import {
  defaultExpandedNodeIds,
  findCardByDocId,
  findCardHostNodeId,
  collectSubtreeNodeIds,
  getRootNodeIds,
  stringId,
} from './tree';
import {
  countBaseDetailMatches,
  countBaseDetailStats,
  emptyBaseDetailFilter,
  filterTags,
  readBaseDetailFilterFromLocation,
  type BaseDetailFilter,
} from './detail-filter';
import { readBaseDetailDisplaySettings, type BaseDetailDisplaySettings } from './display-settings';
import { useBaseDetailWebSocket } from './useBaseDetailWebSocket';
import type { BaseDetailBase, BaseDetailCard, BaseDetailData, BaseDetailEdge, BaseDetailNode } from './types';
import './base-detail.css';

function normalizeData(args: Record<string, any>): BaseDetailData {
  const context = args.UiContext || {};
  const rawBase = (args.base && typeof args.base === 'object' ? args.base : context.base) || {};
  const nodes = Array.isArray(rawBase.nodes) ? rawBase.nodes.map((node: BaseDetailNode) => ({ ...node, id: stringId(node.id) })) : [];
  const edges = Array.isArray(rawBase.edges) ? rawBase.edges.map((edge: BaseDetailEdge) => ({ ...edge, source: stringId(edge.source), target: stringId(edge.target) })) : [];
  const rawMap = (args.nodeCardsMap || context.nodeCardsMap || {}) as Record<string, BaseDetailCard[]>;
  const nodeCardsMap = Object.fromEntries(Object.entries(rawMap).map(([id, cards]) => [stringId(id), (cards || []).map((card) => ({ ...card, docId: stringId(card.docId), nodeId: card.nodeId ? stringId(card.nodeId) : id }))]));
  const base: BaseDetailBase = { ...rawBase, docId: rawBase.docId ?? rawBase.bid, nodes, edges, domainId: stringId(rawBase.domainId || context.domainId || 'system') };
  return {
    base,
    nodeCardsMap,
    baseDetailUiPrefs: (args.baseDetailUiPrefs || context.baseDetailUiPrefs || {}) as BaseDetailData['baseDetailUiPrefs'],
    socketUrl: args.socketUrl || context.socketUrl,
    wsPrefix: typeof context.ws_prefix === 'string' && context.ws_prefix ? context.ws_prefix : '/',
    domainId: stringId(base.domainId || context.domainId || 'system'),
  };
}

function readQuery() {
  return new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
}

export default function BaseDetailApp() {
  const { args } = usePageData();
  const data = useMemo(() => normalizeData(args), [args]);
  const { base, domainId } = data;
  const { status: wsStatus, viewerCount, viewers, send: sendWsMessage } = useBaseDetailWebSocket({ socketUrl: data.socketUrl, wsPrefix: data.wsPrefix });
  const [nodeCardsMap, setNodeCardsMap] = useState(data.nodeCardsMap);
  const [editCard, setEditCard] = useState<BaseDetailCard | null>(null);
  const [editProblem, setEditProblem] = useState<{ cardId: string; pid: string; index: number } | null>(null);
  const nodes = base.nodes || [];
  const edges = base.edges || [];
  const docId = stringId(base.docId || base.bid || base.slug);
  const query = readQuery();
  const initialCardId = query.get('cardId');
  const initialNodeId = query.get('nodeId');
  const initialCard = initialCardId ? findCardByDocId(initialCardId, nodeCardsMap) : null;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => initialNodeId && nodes.some((node) => node.id === initialNodeId) ? initialNodeId : initialCard ? findCardHostNodeId(initialCard.docId, nodeCardsMap) : null);
  const [selectedCard, setSelectedCard] = useState<BaseDetailCard | null>(initialCard);
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(() => query.get('problemId'));
  const initialExpandedNodeIds: string[] = data.baseDetailUiPrefs.expandedNodeIds?.length
    ? [...data.baseDetailUiPrefs.expandedNodeIds]
    : [...defaultExpandedNodeIds(nodes, edges)];
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set(initialExpandedNodeIds));
  const expandedSnapshotRef = useRef<string[]>(initialExpandedNodeIds);
  const [treeOpen, setTreeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [uiPrefsDirty, setUiPrefsDirty] = useState(false);
  const [displaySettings, setDisplaySettings] = useState<BaseDetailDisplaySettings>(() => readBaseDetailDisplaySettings(data.baseDetailUiPrefs));
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<BaseDetailFilter>(() => readBaseDetailFilterFromLocation());
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);

  useEffect(() => {
    setNodeCardsMap(data.nodeCardsMap);
  }, [data.nodeCardsMap]);

  useEffect(() => {
    if (!editCard && !editProblem) return undefined;
    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
    };
  }, [editCard, editProblem]);

  useEffect(() => {
    const syncFilters = () => setFilters(readBaseDetailFilterFromLocation());
    window.addEventListener('popstate', syncFilters);
    return () => window.removeEventListener('popstate', syncFilters);
  }, []);

  const updateUrl = useCallback((patch: { nodeId?: string | null; cardId?: string | null; problemId?: string | null }) => {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', next);
  }, []);

  const selectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedCard(null);
    setSelectedProblemId(null);
    updateUrl({ nodeId, cardId: null, problemId: null });
  }, [updateUrl]);

  const selectCard = useCallback((card: BaseDetailCard, switchNode = true) => {
    const cardId = stringId(card.docId);
    const host = findCardHostNodeId(cardId, nodeCardsMap);
    setSelectedCard(card);
    if (host && switchNode) {
      setSelectedNodeId(host);
      setExpandedNodes((current) => new Set([...current, host]));
    }
    setSelectedProblemId(null);
    updateUrl({ nodeId: switchNode ? host : selectedNodeId || host, cardId, problemId: null });
  }, [nodeCardsMap, selectedNodeId, updateUrl]);

  const selectNodeFromContent = useCallback((nodeId: string) => {
    if (nodeId === selectedNodeId) return;
    setPendingNodeId(nodeId);
  }, [selectedNodeId]);

  const confirmNodeSwitch = useCallback(() => {
    if (pendingNodeId) selectNode(pendingNodeId);
    setPendingNodeId(null);
  }, [pendingNodeId, selectNode]);

  const cancelNodeSwitch = useCallback(() => setPendingNodeId(null), []);

  const selectProblem = useCallback((pid: string) => {
    setSelectedProblemId(pid);
    updateUrl({ problemId: pid });
  }, [updateUrl]);

  const replaceCard = useCallback((updatedCard: BaseDetailCard) => {
    const cardId = stringId(updatedCard.docId);
    setNodeCardsMap((current) => Object.fromEntries(Object.entries(current).map(([nodeId, cards]) => [
      nodeId,
      cards.map((card) => stringId(card.docId) === cardId ? updatedCard : card),
    ])));
    setSelectedCard((current) => current && stringId(current.docId) === cardId ? updatedCard : current);
  }, []);

  const saveCard = useCallback(async (updatedCard: BaseDetailCard) => {
    await updateBaseCard(domainId, updatedCard.docId, {
      title: updatedCard.title,
      content: updatedCard.content,
      tags: updatedCard.tags,
    });
    replaceCard(updatedCard);
    setEditCard(null);
    void Notification.success(i18n('Saved'));
  }, [domainId, replaceCard]);

  const saveProblemCard = useCallback(async (updatedCard: BaseDetailCard) => {
    await updateBaseCard(domainId, updatedCard.docId, { problems: updatedCard.problems });
    replaceCard(updatedCard);
    setEditProblem(null);
    void Notification.success(i18n('Saved'));
  }, [domainId, replaceCard]);

  const persistDisplayPrefs = useCallback(async (next: BaseDetailDisplaySettings, nextExpandedNodes: Set<string>) => {
    const expandedNodeIds = [...nextExpandedNodes];
    await requestJson('/base/detail-ui-prefs', {
      domainId,
      body: { docId, displayPrefs: { ...next, expandedNodeIds } },
    });
    setDisplaySettings(next);
    expandedSnapshotRef.current = expandedNodeIds;
    setUiPrefsDirty(false);
  }, [docId, domainId]);

  const saveDisplaySettings = useCallback(async (next: BaseDetailDisplaySettings) => {
    setSettingsSaving(true);
    try {
      await persistDisplayPrefs(next, expandedNodes);
      setSettingsOpen(false);
      void Notification.success(i18n('Saved'));
    } catch (cause) {
      void Notification.error(cause instanceof Error ? cause.message : i18n('Save failed'));
    } finally {
      setSettingsSaving(false);
    }
  }, [expandedNodes, persistDisplayPrefs]);

  const saveUiPrefs = useCallback(async () => {
    if (settingsSaving || !uiPrefsDirty) return;
    setSettingsSaving(true);
    try {
      await persistDisplayPrefs(displaySettings, expandedNodes);
      void Notification.success(i18n('Saved'));
    } catch (cause) {
      void Notification.error(cause instanceof Error ? cause.message : i18n('Save failed'));
    } finally {
      setSettingsSaving(false);
    }
  }, [displaySettings, expandedNodes, persistDisplayPrefs, settingsSaving, uiPrefsDirty]);

  useEffect(() => {
    if (JSON.stringify([...expandedNodes]) !== JSON.stringify(expandedSnapshotRef.current)) setUiPrefsDirty(true);
  }, [expandedNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && uiPrefsDirty) {
        event.preventDefault();
        void saveUiPrefs();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveUiPrefs, uiPrefsDirty]);

  const openCardEditor = useCallback(() => {
    if (selectedCard) setEditCard(selectedCard);
  }, [selectedCard]);

  const openProblemEditor = useCallback((pid: string, index: number) => {
    if (!selectedCard) return;
    setSelectedProblemId(pid);
    setEditProblem({ cardId: stringId(selectedCard.docId), pid, index });
  }, [selectedCard]);

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
      return next;
    });
  }, []);

  const currentNodeIds = selectedNodeId ? [selectedNodeId, ...collectSubtreeNodeIds(selectedNodeId, nodes, edges)] : [];
  const currentStats = countBaseDetailStats(nodes, nodeCardsMap, currentNodeIds, search, filters);
  const matchedCount = countBaseDetailMatches(nodes, nodeCardsMap, search, filters);
  const availableCardTags = [...new Set([...(base.cardTags || []), ...filterTags(Object.values(nodeCardsMap).flat())])].sort();
  const availableProblemTags = [...new Set([...(base.problemTags || []), ...filterTags(Object.values(nodeCardsMap).flat(), true)])].sort();
  const rootNode = nodes.find((node) => node.id === selectedNodeId) || nodes.find((node) => node.id === getRootNodeIds(nodes, edges)[0]);
  const title = base.title?.trim() || i18n('Knowledge Base');
  const editingProblemCard = editProblem ? findCardByDocId(editProblem.cardId, nodeCardsMap) : null;
  const editingProblem = editingProblemCard?.problems?.[editProblem?.index ?? -1] || null;

  return (
    <div className="bd-page">
      <BaseDetailHeader title={rootNode && selectedNodeId !== getRootNodeIds(nodes, edges)[0] ? rootNode.text || i18n('Unnamed Node') : title} description={rootNode && selectedNodeId !== getRootNodeIds(nodes, edges)[0] ? title : base.content} domainId={domainId} docId={docId} treeOpen={treeOpen} onToggleTree={() => setTreeOpen((open) => !open)} onShare={() => undefined} onOpenSettings={() => setSettingsOpen(true)} />
      <BaseDetailExplorer value={search} onChange={setSearch} filters={filters} matchedCount={matchedCount} onApplyFilters={setFilters} onClearFilters={() => setFilters(emptyBaseDetailFilter())} availableCardTags={availableCardTags} availableProblemTags={availableProblemTags} />
      <div className="bd-page__stats"><strong>{currentStats.nodes}</strong> {i18n('nodes')} <span>·</span> <strong>{currentStats.cards}</strong> {i18n('cards')} <span>·</span> <strong>{currentStats.problems}</strong> {i18n('problems')}</div>
      <main className="bd-page__main">
        <section className="bd-page__structure" aria-label={i18n('Document Structure')}>
          <BaseDetailTree rootNodeIds={getRootNodeIds(nodes, edges)} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={toggleNode} selectedNodeId={selectedNodeId} selectedCardId={selectedCard?.docId || null} selectedProblemId={selectedProblemId} onSelectNode={selectNode} onSelectCard={selectCard} onSelectProblem={(card, pid) => { selectCard(card); selectProblem(pid); }} filter={search} filters={filters} displaySettings={displaySettings} />
        </section>
        <section className="bd-page__content" aria-label={i18n('Content')}>
          {selectedNodeId ? <BaseDetailNodeContent rootNodeId={selectedNodeId} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={toggleNode} selectedNodeId={selectedNodeId} selectedCardId={selectedCard?.docId || null} selectedProblemId={selectedProblemId} onSelectCard={(card) => selectCard(card, false)} onSelectNode={selectNodeFromContent} onSelectProblem={(card, pid) => { selectCard(card, false); selectProblem(pid); }} filter={search} filters={filters} displaySettings={displaySettings} /> : <div className="bd-empty">{i18n('Base detail tree empty')}</div>}
        </section>
      </main>
      <BaseDetailTreeDrawer open={treeOpen} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} selectedNodeId={selectedNodeId} selectedCardId={selectedCard?.docId || null} onToggle={toggleNode} onSelectNode={(id) => { selectNode(id); setTreeOpen(false); }} onSelectCard={(card) => { selectCard(card); setTreeOpen(false); }} onClose={() => setTreeOpen(false)} filter={search} filters={filters} displaySettings={displaySettings} drawerWidth={displaySettings.treeDrawerWidth} />
      <BaseDetailCardDrawer
        card={selectedCard}
        onClose={() => { setSelectedCard(null); setSelectedProblemId(null); updateUrl({ cardId: null, problemId: null }); }}
        onSelectProblem={selectProblem}
        onEditCard={openCardEditor}
        onEditProblem={openProblemEditor}
        editorBusy={Boolean(editCard || editProblem)}
        selectedProblemId={selectedProblemId}
        baseDocId={docId}
        domainId={domainId}
        drawerWidth={displaySettings.cardDrawerWidth}
      />
      {editCard ? <BaseDetailCardEditDialog card={editCard} availableTags={availableCardTags} onSave={saveCard} onClose={() => setEditCard(null)} /> : null}
      {editProblem && editingProblemCard && editingProblem ? (
        <BaseDetailProblemEditDialog
          card={editingProblemCard}
          problem={editingProblem}
          problemIndex={editProblem.index}
          domainId={domainId}
          baseDocId={docId}
          availableTags={availableProblemTags}
          onSave={saveProblemCard}
          onClose={() => setEditProblem(null)}
        />
      ) : null}
      {displaySettings.showExpandSaveIndicator ? <BaseDetailStatusIndicator dirty={uiPrefsDirty} posX={displaySettings.indicatorX} posY={displaySettings.indicatorY} onPosChange={(indicatorX, indicatorY) => { setDisplaySettings((current) => ({ ...current, indicatorX, indicatorY })); setUiPrefsDirty(true); }} onClickSave={() => void saveUiPrefs()} /> : null}
      {displaySettings.showWsIndicator ? <BaseDetailWSStatusIndicator status={wsStatus} viewerCount={viewerCount} viewers={viewers} open={displaySettings.wsIndicatorOpen} posX={displaySettings.wsIndicatorX} posY={displaySettings.wsIndicatorY} onPosChange={(wsIndicatorX, wsIndicatorY) => { setDisplaySettings((current) => ({ ...current, wsIndicatorX, wsIndicatorY })); setUiPrefsDirty(true); }} onToggle={() => { setDisplaySettings((current) => ({ ...current, wsIndicatorOpen: !current.wsIndicatorOpen })); setUiPrefsDirty(true); }} onRequestViewers={() => sendWsMessage({ type: 'request_viewers' })} /> : null}
      {displaySettings.showToolbar ? <BaseDetailFloatingToolbar open={displaySettings.toolbarOpen} posX={displaySettings.toolbarX} posY={displaySettings.toolbarY} onOpenChange={(toolbarOpen) => { setDisplaySettings((current) => ({ ...current, toolbarOpen })); setUiPrefsDirty(true); }} onPosChange={(toolbarX, toolbarY) => { setDisplaySettings((current) => ({ ...current, toolbarX, toolbarY })); setUiPrefsDirty(true); }} onTreeOpen={() => setTreeOpen(true)} onSearchOpen={() => document.querySelector<HTMLInputElement>('.bd-explorer__search input')?.focus()} /> : null}
      <BaseDetailSettingsDialog open={settingsOpen} settings={displaySettings} saving={settingsSaving} onClose={() => setSettingsOpen(false)} onSave={saveDisplaySettings} />
      {pendingNodeId ? (
        <BaseDetailConfirmDialog
          nodeLabel={nodes.find((node) => node.id === pendingNodeId)?.text?.trim() || i18n('Unnamed Node')}
          onConfirm={confirmNodeSwitch}
          onCancel={cancelNodeSwitch}
        />
      ) : null}
    </div>
  );
}

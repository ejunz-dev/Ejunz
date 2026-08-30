import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePageData } from '../../context/page-data';
import Notification from '../notification';
import { i18n } from '../../i18n';
import { useNavigationActions } from '../navigation/context';
import { BaseDetailAiTutor } from './BaseDetailAiTutor';
import { BaseDetailCardDrawer } from './BaseDetailCardDrawer';
import { BaseDetailCardEditDialog } from './BaseDetailCardEditDialog';
import { BaseDetailConfirmDialog } from './BaseDetailConfirmDialog';
import { BaseDetailProblemEditDialog } from './BaseDetailProblemEditDialog';
import { BaseDetailSettingsDialog } from './BaseDetailSettingsDialog';
import { BaseDetailSemanticSearch, type EmbeddingStatusView, type SemanticSearchItem } from './BaseDetailSemanticSearch';
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

function buildBaseUpdateSummary(actionKey: unknown, actionDetail: unknown): string {
  const key = String(actionKey || '');
  const detail = actionDetail && typeof actionDetail === 'object' && !Array.isArray(actionDetail)
    ? actionDetail as Record<string, any>
    : {};
  switch (key) {
    case 'batch_update': {
      const parts: string[] = [];
      if (detail.nodeCreates) parts.push(i18n('{0} new nodes', detail.nodeCreates));
      if (detail.nodeUpdates) parts.push(i18n('{0} nodes updated', detail.nodeUpdates));
      if (detail.nodeDeletes) parts.push(i18n('{0} nodes deleted', detail.nodeDeletes));
      if (detail.cardCreates) parts.push(i18n('{0} new cards', detail.cardCreates));
      if (detail.cardUpdates) parts.push(i18n('{0} cards updated', detail.cardUpdates) + (detail.problemUpdates ? ` (${i18n('{0} problems', detail.problemUpdates)})` : ''));
      if (detail.cardDeletes) parts.push(i18n('{0} cards deleted', detail.cardDeletes));
      if (detail.edgeCreates) parts.push(i18n('{0} new edges', detail.edgeCreates));
      if (detail.edgeDeletes) parts.push(i18n('{0} edges deleted', detail.edgeDeletes));
      return parts.join('，') || i18n('Saved');
    }
    case 'full_save': return i18n('Saved');
    case 'sidecar_save': return i18n('Settings saved');
    case 'expand_save': return i18n('Tree state saved');
    case 'update_card': {
      const changed = (Array.isArray(detail.changed) ? detail.changed : []).map((field: string) => {
        const labels: Record<string, string> = { title: i18n('Title'), content: i18n('Content'), problems: i18n('Problems'), nodeId: i18n('Node'), order: i18n('Order'), tags: i18n('Tags') };
        return labels[field] || field;
      });
      return changed.length ? i18n('Card updated: ') + changed.join('，') : i18n('Card updated');
    }
    case 'delete_card':
    case 'card_delete': return i18n('Card deleted');
    case 'card_create': return i18n('Card created');
    case 'card_update': return i18n('Card updated');
    case 'node_create': return i18n('Node created');
    case 'node_update': return i18n('Node updated');
    case 'node_delete': return i18n('Node deleted');
    case 'problem_create': return i18n('Problem created');
    case 'problem_update': return i18n('Problem updated');
    case 'problem_delete': return i18n('Problem deleted');
    case 'node_file_create': return i18n('File added');
    case 'node_file_delete': return i18n('File deleted');
    case 'git_pull': return i18n('Base pulled');
    case 'git_commit': return detail.message ? i18n('Committed: {0}', detail.message) : i18n('Committed');
    case 'migrate_node': return i18n('Node migrated to new base');
    case 'add_tag': return detail.tag ? i18n('Tag added: {0}', detail.tag) : i18n('Tag added');
    default: return i18n('Content has been updated');
  }
}

export default function BaseDetailApp() {
  const { args } = usePageData();
  const { setMobileNavActions } = useNavigationActions();
  const data = useMemo(() => normalizeData(args), [args]);
  const { base: initialBase, domainId } = data;
  const refreshBaseRef = useRef<(() => Promise<boolean>) | null>(null);
  const refreshVersionRef = useRef(0);
  const lastNotifyRef = useRef({ key: '', at: 0 });
  const localSaveAtRef = useRef(0);
  const { status: wsStatus, viewerCount, viewers, send: sendWsMessage } = useBaseDetailWebSocket({
    socketUrl: data.socketUrl,
    wsPrefix: data.wsPrefix,
    onMessage: (message) => {
      if ((message.type === 'init' || message.type === 'embedding_status') && message.embeddingStatus) {
        setEmbeddingStatus(message.embeddingStatus as EmbeddingStatusView);
      }
      if (message.type === 'update') {
        const actionKey = String(message.actionKey || '');
        const isTagAction = actionKey === 'add_card_tag' || actionKey === 'delete_card_tag' || actionKey === 'rename_card_tag'
          || actionKey === 'add_problem_tag' || actionKey === 'delete_problem_tag' || actionKey === 'rename_problem_tag';
        const now = Date.now();
        const isOwnSave = localSaveAtRef.current > 0 && now - localSaveAtRef.current < 3000;
        const notifyKey = `${String(message.sourceUid ?? '')}:${actionKey}`;
        const shouldNotify = Boolean(actionKey && actionKey !== 'unknown' && !isOwnSave && !isTagAction
          && (notifyKey !== lastNotifyRef.current.key || now - lastNotifyRef.current.at >= 3000));
        if (shouldNotify) lastNotifyRef.current = { key: notifyKey, at: now };
        const refresh = refreshBaseRef.current?.();
        if (refresh) {
          void refresh.then((synced) => {
            if (!shouldNotify) return;
            if (synced) {
              void Notification.show({
                title: String(message.sourceUname || ''),
                message: buildBaseUpdateSummary(message.actionKey, message.actionDetail),
                type: 'info',
                closable: true,
                position: 'top-right',
                duration: 5000,
              });
            } else {
              void Notification.error(i18n('Content update sync failed'));
            }
          });
        }
      }
    },
  });
  const [base, setBase] = useState(initialBase);
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
  const [semanticSearchOpen, setSemanticSearchOpen] = useState(false);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatusView>(null);
  const [aiTutorOpen, setAiTutorOpen] = useState(false);
  const [uiPrefsDirty, setUiPrefsDirty] = useState(false);
  const [displaySettings, setDisplaySettings] = useState<BaseDetailDisplaySettings>(() => readBaseDetailDisplaySettings(data.baseDetailUiPrefs));
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<BaseDetailFilter>(() => readBaseDetailFilterFromLocation());
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);
  const refreshBase = useCallback(async (): Promise<boolean> => {
    const version = ++refreshVersionRef.current;
    try {
      const payload = await requestJson<Record<string, any>>(`/base/data?docId=${encodeURIComponent(docId)}`, { domainId });
      if (version !== refreshVersionRef.current) return true;
      if (!Array.isArray(payload.nodes) || !payload.nodeCardsMap || typeof payload.nodeCardsMap !== 'object') return false;
      const refreshed = normalizeData({ base: payload, nodeCardsMap: payload.nodeCardsMap, UiContext: { domainId } });
      setBase(refreshed.base);
      setNodeCardsMap(refreshed.nodeCardsMap);
      setSelectedCard((current) => current ? findCardByDocId(stringId(current.docId), refreshed.nodeCardsMap) : null);
      if (selectedCard && !findCardByDocId(stringId(selectedCard.docId), refreshed.nodeCardsMap)) setSelectedProblemId(null);
      if (!uiPrefsDirty && payload.baseDetailUiPrefs && typeof payload.baseDetailUiPrefs === 'object' && !Array.isArray(payload.baseDetailUiPrefs)) {
        setDisplaySettings((current) => ({ ...current, ...readBaseDetailDisplaySettings(payload.baseDetailUiPrefs) }));
        if (Array.isArray(payload.baseDetailUiPrefs.expandedNodeIds)) setExpandedNodes(new Set(payload.baseDetailUiPrefs.expandedNodeIds.filter((id: unknown) => typeof id === 'string')));
      }
      return true;
    } catch {
      return false;
    }
  }, [domainId, docId, selectedCard, uiPrefsDirty]);
  refreshBaseRef.current = refreshBase;

  useEffect(() => {
    setBase(data.base);
    setNodeCardsMap(data.nodeCardsMap);
  }, [data.base, data.nodeCardsMap]);

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

  const handleSemanticSelect = useCallback((result: SemanticSearchItem) => {
    if (result.kind === 'node') {
      if (nodes.some((node) => node.id === stringId(result.nodeId))) selectNode(stringId(result.nodeId));
    } else if (result.kind === 'card') {
      const cardId = stringId(result.cardDocId || '');
      const card = findCardByDocId(cardId, nodeCardsMap);
      if (card) {
        selectCard(card);
      } else {
        const hostNodeId = findCardHostNodeId(cardId, nodeCardsMap);
        if (hostNodeId) selectNode(hostNodeId);
      }
    }
  }, [nodes, nodeCardsMap, selectCard, selectNode]);

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
    localSaveAtRef.current = Date.now();
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
    localSaveAtRef.current = Date.now();
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

  const toggleMobileWsIndicator = useCallback(() => {
    setDisplaySettings((current) => ({ ...current, wsIndicatorOpen: !current.wsIndicatorOpen }));
    setUiPrefsDirty(true);
  }, []);
  const openMobileTree = useCallback(() => setTreeOpen(true), []);
  const openMobileSearch = useCallback(() => setSemanticSearchOpen(true), []);
  const scrollTop = useCallback(() => {
    document.documentElement.scrollTo({ top: 0, behavior: 'smooth' });
    document.body.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);
  const scrollBottom = useCallback(() => {
    const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    document.documentElement.scrollTo({ top: height, behavior: 'smooth' });
    document.body.scrollTo({ top: height, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const wsDotClass = wsStatus === 'connected' ? '' : wsStatus === 'connecting' ? ' is-connecting' : ' is-disconnected';
    const wsPopup = wsStatus === 'connected' ? (
      <div className="uix-mobile-header__popup uix-mobile-header__popup--right">
        {viewers.length ? viewers.map((viewer) => (
          <div className="uix-mobile-header__popup-viewer" key={viewer.uid}>
            <span>{viewer.pageType === 'detail' ? '📖' : '✏️'}</span>
            <span>{viewer.uname}</span>
            <small>{viewer.pageType === 'detail' ? 'Detail' : 'Editor'}</small>
          </div>
        )) : <div className="uix-mobile-header__popup-viewer uix-mobile-header__popup-viewer--empty">{i18n('No other viewers')}</div>}
      </div>
    ) : null;
    setMobileNavActions(
      displaySettings.showToolbar ? [
        { id: 'base-scroll-top', label: i18n('Scroll to top'), icon: '↑', onClick: scrollTop },
        { id: 'base-tree', label: i18n('Document Structure'), icon: '☷', onClick: openMobileTree },
        { id: 'base-search', label: i18n('Semantic Search'), icon: '⌕', onClick: openMobileSearch },
        { id: 'base-scroll-bottom', label: i18n('Scroll to bottom'), icon: '↓', onClick: scrollBottom },
      ] : [],
      [
        ...(displaySettings.showExpandSaveIndicator ? [{ id: 'base-save-status', label: uiPrefsDirty ? i18n('Unsaved changes — click to save') : i18n('Saved'), icon: <span className={`uix-mobile-header__status-dot${uiPrefsDirty ? ' is-dirty' : ''}`} />, active: uiPrefsDirty, onClick: () => void saveUiPrefs() }] : []),
        ...(displaySettings.showWsIndicator ? [{ id: 'base-ws-status', label: wsStatus === 'connected' ? i18n('Online: {0}', viewerCount ?? 1) : wsStatus === 'connecting' ? i18n('Connecting…') : i18n('Disconnected'), icon: <span className={`uix-mobile-header__ws-count${wsDotClass}`}>{wsStatus === 'connected' ? viewerCount ?? 1 : 0}</span>, active: displaySettings.wsIndicatorOpen, popup: wsPopup, popupOpen: displaySettings.wsIndicatorOpen && wsStatus === 'connected', onClick: toggleMobileWsIndicator }] : []),
      ],
    );
  }, [displaySettings.showExpandSaveIndicator, displaySettings.showToolbar, displaySettings.showWsIndicator, displaySettings.wsIndicatorOpen, openMobileSearch, openMobileTree, saveUiPrefs, scrollBottom, scrollTop, setMobileNavActions, toggleMobileWsIndicator, uiPrefsDirty, viewerCount, viewers, wsStatus]);

  useEffect(() => () => setMobileNavActions([], []), [setMobileNavActions]);

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
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) || null;
  const title = base.title?.trim() || i18n('Knowledge Base');
  const editingProblemCard = editProblem ? findCardByDocId(editProblem.cardId, nodeCardsMap) : null;
  const editingProblem = editingProblemCard?.problems?.[editProblem?.index ?? -1] || null;

  return (
    <div className="bd-page">
      <BaseDetailHeader title={rootNode && selectedNodeId !== getRootNodeIds(nodes, edges)[0] ? rootNode.text || i18n('Unnamed Node') : title} description={rootNode && selectedNodeId !== getRootNodeIds(nodes, edges)[0] ? title : base.content} domainId={domainId} docId={docId} treeOpen={treeOpen} onToggleTree={() => setTreeOpen((open) => !open)} onShare={() => undefined} onOpenSettings={() => setSettingsOpen(true)} onSearchClick={() => setSemanticSearchOpen(true)} searchActive={semanticSearchOpen} onAiTutorClick={() => setAiTutorOpen(true)} aiTutorActive={aiTutorOpen} />
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
      {displaySettings.showToolbar ? <BaseDetailFloatingToolbar open={displaySettings.toolbarOpen} posX={displaySettings.toolbarX} posY={displaySettings.toolbarY} onOpenChange={(toolbarOpen) => { setDisplaySettings((current) => ({ ...current, toolbarOpen })); setUiPrefsDirty(true); }} onPosChange={(toolbarX, toolbarY) => { setDisplaySettings((current) => ({ ...current, toolbarX, toolbarY })); setUiPrefsDirty(true); }} onTreeOpen={() => setTreeOpen(true)} onSearchOpen={() => setSemanticSearchOpen(true)} /> : null}
      <BaseDetailSettingsDialog open={settingsOpen} settings={displaySettings} saving={settingsSaving} onClose={() => setSettingsOpen(false)} onSave={saveDisplaySettings} />
      <BaseDetailSemanticSearch
        domainId={domainId}
        docId={docId}
        open={semanticSearchOpen}
        onOpenChange={setSemanticSearchOpen}
        embeddingStatus={embeddingStatus}
        onSelectResult={handleSemanticSelect}
      />
      {displaySettings.showAiTutor ? (
        <BaseDetailAiTutor
          nodes={nodes}
          edges={edges}
          nodeCardsMap={nodeCardsMap}
          docTitle={title}
          docDescription={base.content}
          selectedNode={selectedNode}
          selectedCard={selectedCard}
          open={aiTutorOpen}
          onOpenChange={setAiTutorOpen}
          docId={docId}
          domainId={domainId}
        />
      ) : null}
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

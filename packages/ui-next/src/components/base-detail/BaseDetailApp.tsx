import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePageData } from '../../context/page-data';
import { i18n } from '../../i18n';
import { BaseDetailCardDrawer } from './BaseDetailCardDrawer';
import { BaseDetailConfirmDialog } from './BaseDetailConfirmDialog';
import { BaseDetailExplorer } from './BaseDetailExplorer';
import { BaseDetailHeader } from './BaseDetailHeader';
import { BaseDetailNodeContent } from './BaseDetailNodeContent';
import { BaseDetailTreeDrawer } from './BaseDetailTreeDrawer';
import { BaseDetailTree } from './BaseDetailTree';
import {
  defaultExpandedNodeIds,
  findCardByDocId,
  findCardHostNodeId,
  getRootNodeIds,
  stringId,
} from './tree';
import {
  countBaseDetailMatches,
  emptyBaseDetailFilter,
  filterTags,
  readBaseDetailFilterFromLocation,
  type BaseDetailFilter,
} from './detail-filter';
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
    domainId: stringId(base.domainId || context.domainId || 'system'),
  };
}

function readQuery() {
  return new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
}

export default function BaseDetailApp() {
  const { args } = usePageData();
  const data = useMemo(() => normalizeData(args), [args]);
  const { base, nodeCardsMap, domainId } = data;
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
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const saved = data.baseDetailUiPrefs.expandedNodeIds;
    return new Set(saved?.length ? saved : defaultExpandedNodeIds(nodes, edges));
  });
  const [treeOpen, setTreeOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<BaseDetailFilter>(() => readBaseDetailFilterFromLocation());
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);

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

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
      return next;
    });
  }, []);

  const cardCount = Object.values(nodeCardsMap).reduce((sum, cards) => sum + cards.length, 0);
  const matchedCount = countBaseDetailMatches(nodes, nodeCardsMap, search, filters);
  const availableCardTags = filterTags(Object.values(nodeCardsMap).flat());
  const availableProblemTags = filterTags(Object.values(nodeCardsMap).flat(), true);
  const rootNode = nodes.find((node) => node.id === selectedNodeId) || nodes.find((node) => node.id === getRootNodeIds(nodes, edges)[0]);
  const title = base.title?.trim() || i18n('Knowledge Base');

  return (
    <div className="bd-page">
      <BaseDetailHeader title={rootNode && selectedNodeId !== getRootNodeIds(nodes, edges)[0] ? rootNode.text || i18n('Unnamed Node') : title} description={rootNode && selectedNodeId !== getRootNodeIds(nodes, edges)[0] ? title : base.content} domainId={domainId} docId={docId} treeOpen={treeOpen} onToggleTree={() => setTreeOpen((open) => !open)} onShare={() => undefined} />
      <BaseDetailExplorer value={search} onChange={setSearch} filters={filters} matchedCount={matchedCount} onApplyFilters={setFilters} onClearFilters={() => setFilters(emptyBaseDetailFilter())} availableCardTags={availableCardTags} availableProblemTags={availableProblemTags} />
      <div className="bd-page__stats"><strong>{nodes.length}</strong> {i18n('nodes')} <span>·</span> <strong>{cardCount}</strong> {i18n('cards')}</div>
      <main className="bd-page__main">
        <section className="bd-page__structure" aria-label={i18n('Document Structure')}>
          <BaseDetailTree rootNodeIds={getRootNodeIds(nodes, edges)} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={toggleNode} selectedNodeId={selectedNodeId} selectedCardId={selectedCard?.docId || null} selectedProblemId={selectedProblemId} onSelectNode={selectNode} onSelectCard={selectCard} onSelectProblem={(card, pid) => { selectCard(card); selectProblem(pid); }} filter={search} filters={filters} />
        </section>
        <section className="bd-page__content" aria-label={i18n('Content')}>
          {selectedNodeId ? <BaseDetailNodeContent rootNodeId={selectedNodeId} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={toggleNode} selectedNodeId={selectedNodeId} selectedCardId={selectedCard?.docId || null} selectedProblemId={selectedProblemId} onSelectCard={(card) => selectCard(card, false)} onSelectNode={selectNodeFromContent} onSelectProblem={(card, pid) => { selectCard(card, false); selectProblem(pid); }} filter={search} filters={filters} /> : <div className="bd-empty">{i18n('Base detail tree empty')}</div>}
        </section>
      </main>
      <BaseDetailTreeDrawer open={treeOpen} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} selectedNodeId={selectedNodeId} selectedCardId={selectedCard?.docId || null} onToggle={toggleNode} onSelectNode={(id) => { selectNode(id); setTreeOpen(false); }} onSelectCard={(card) => { selectCard(card); setTreeOpen(false); }} onClose={() => setTreeOpen(false)} filter={search} filters={filters} />
      <BaseDetailCardDrawer card={selectedCard} onClose={() => { setSelectedCard(null); setSelectedProblemId(null); updateUrl({ cardId: null, problemId: null }); }} onSelectProblem={selectProblem} selectedProblemId={selectedProblemId} baseDocId={docId} domainId={domainId} />
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

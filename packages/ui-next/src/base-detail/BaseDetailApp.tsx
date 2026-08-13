import { useCallback, useMemo, useState } from 'react';
import { usePageData } from '../context/page-data';
import { BaseDetailCardDrawer } from './BaseDetailCardDrawer';
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => initialNodeId && nodes.some((node) => node.id === initialNodeId) ? initialNodeId : initialCard ? findCardHostNodeId(initialCard.docId, nodeCardsMap) : getRootNodeIds(nodes, edges)[0] || null);
  const [selectedCard, setSelectedCard] = useState<BaseDetailCard | null>(initialCard);
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(() => query.get('problemId'));
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const saved = data.baseDetailUiPrefs.expandedNodeIds;
    return new Set(saved?.length ? saved : defaultExpandedNodeIds(nodes, edges));
  });
  const [treeOpen, setTreeOpen] = useState(false);
  const [search, setSearch] = useState('');

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

  const selectCard = useCallback((card: BaseDetailCard) => {
    const cardId = stringId(card.docId);
    const host = findCardHostNodeId(cardId, nodeCardsMap);
    setSelectedCard(card);
    if (host) {
      setSelectedNodeId(host);
      setExpandedNodes((current) => new Set([...current, host]));
    }
    setSelectedProblemId(null);
    updateUrl({ nodeId: host, cardId, problemId: null });
  }, [nodeCardsMap, updateUrl]);

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
  const rootNode = nodes.find((node) => node.id === selectedNodeId) || nodes.find((node) => node.id === getRootNodeIds(nodes, edges)[0]);
  const title = base.title?.trim() || 'Knowledge base';

  return (
    <div className="bd-page">
      <BaseDetailHeader title={rootNode && selectedNodeId !== getRootNodeIds(nodes, edges)[0] ? rootNode.text || 'Unnamed node' : title} description={rootNode && selectedNodeId !== getRootNodeIds(nodes, edges)[0] ? title : base.content} domainId={domainId} docId={docId} treeOpen={treeOpen} onToggleTree={() => setTreeOpen((open) => !open)} onShare={() => undefined} />
      <BaseDetailExplorer value={search} onChange={setSearch} nodeCount={nodes.length} cardCount={cardCount} />
      <div className="bd-page__stats"><strong>{nodes.length}</strong> nodes <span>·</span> <strong>{cardCount}</strong> cards</div>
      <main className="bd-page__main">
        <section className="bd-page__structure" aria-label="Document structure">
          <BaseDetailTree rootNodeIds={getRootNodeIds(nodes, edges)} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={toggleNode} selectedNodeId={selectedNodeId} selectedCardId={selectedCard?.docId || null} selectedProblemId={selectedProblemId} onSelectNode={selectNode} onSelectCard={selectCard} onSelectProblem={(card, pid) => { selectCard(card); selectProblem(pid); }} filter={search} />
        </section>
        <section className="bd-page__content" aria-label="Base content">
          {selectedNodeId ? <BaseDetailNodeContent rootNodeId={selectedNodeId} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} selectedCardId={selectedCard?.docId || null} onSelectCard={selectCard} onSelectNode={selectNode} filter={search} /> : <div className="bd-empty">This base has no nodes yet.</div>}
        </section>
      </main>
      <BaseDetailTreeDrawer open={treeOpen} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} selectedNodeId={selectedNodeId} selectedCardId={selectedCard?.docId || null} onToggle={toggleNode} onSelectNode={(id) => { selectNode(id); setTreeOpen(false); }} onSelectCard={(card) => { selectCard(card); setTreeOpen(false); }} onClose={() => setTreeOpen(false)} filter={search} />
      <BaseDetailCardDrawer card={selectedCard} onClose={() => { setSelectedCard(null); setSelectedProblemId(null); updateUrl({ cardId: null, problemId: null }); }} onSelectProblem={selectProblem} selectedProblemId={selectedProblemId} baseDocId={docId} domainId={domainId} />
    </div>
  );
}

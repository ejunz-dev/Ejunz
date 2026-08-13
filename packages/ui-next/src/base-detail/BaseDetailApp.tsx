import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BaseDetailCardDrawer } from './BaseDetailCardDrawer';
import { BaseDetailExplorer } from './BaseDetailExplorer';
import { BaseDetailHeader } from './BaseDetailHeader';
import { BaseDetailNodeContent } from './BaseDetailNodeContent';
import { BaseDetailTreeDrawer } from './BaseDetailTreeDrawer';
import {
  collectNodePathFromRoot,
  defaultExpandedNodeIds,
  findCardHostNodeId,
  getRootNodeIds,
  nodeDisplayLabel,
  stringId,
} from './tree';
import type {
  BaseDetailCard, BaseDetailData, BaseDetailDomContext, BaseDetailI18n,
} from './types';
import { i18nText } from './types';

function readInitialData(ctx: BaseDetailDomContext): BaseDetailData {
  const args = ctx.args || {};
  const ui = args.UiContext || {};
  const base = (ui.base && typeof ui.base === 'object' ? ui.base : args.base) || {};
  return {
    base: {
      ...base,
      nodes: Array.isArray(base.nodes) ? base.nodes : [],
      edges: Array.isArray(base.edges) ? base.edges : [],
    },
    nodeCardsMap: (ui.nodeCardsMap || args.nodeCardsMap || {}) as Record<string, BaseDetailCard[]>,
    prefs: (ui.baseDetailUiPrefs || args.baseDetailUiPrefs || {}) as BaseDetailData['prefs'],
    socketUrl: ui.socketUrl || args.socketUrl || '',
    wsPrefix: ui.ws_prefix || '',
    domainId: String(base.domainId || ui.domainId || args.domainId || 'system'),
  };
}

function readQuery(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export interface BaseDetailAppProps {
  ctx: BaseDetailDomContext;
  i18n?: BaseDetailI18n;
}

export function BaseDetailApp({ ctx, i18n }: BaseDetailAppProps) {
  const [data, setData] = useState<BaseDetailData>(() => readInitialData(ctx));
  const { base, nodeCardsMap, domainId } = data;
  const nodes = base.nodes || [];
  const edges = base.edges || [];

  const t = useCallback((key: string, fallback: string) => i18nText(i18n, key, fallback), [i18n]);
  const unnamedNode = t('Unnamed Node', 'Unnamed Node');
  const unnamedCard = t('Unnamed Card', 'Unnamed Card');

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => {
    const params = readQuery();
    const nodeId = params.get('nodeId');
    if (nodeId && nodes.some((node) => node.id === nodeId)) return nodeId;
    const cardId = params.get('cardId');
    if (cardId) return findCardHostNodeId(cardId, nodeCardsMap);
    return null;
  });
  const [selectedCard, setSelectedCard] = useState<BaseDetailCard | null>(() => {
    const cardId = readQuery().get('cardId');
    return cardId ? Object.values(nodeCardsMap).flat().find((card) => String(card.docId) === cardId) || null : null;
  });
  const [filter, setFilter] = useState('');
  const [structureOpen, setStructureOpen] = useState(false);
  const [treeDrawerWidth, setTreeDrawerWidth] = useState(352);
  const [cardDrawerWidth, setCardDrawerWidth] = useState(608);
  const [wsStatus, setWsStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  const [viewerCount, setViewerCount] = useState(0);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const saved = data.prefs?.expandedNodeIds;
    if (Array.isArray(saved) && saved.length) return new Set(saved);
    return defaultExpandedNodeIds(nodes, edges);
  });
  const expandDirtyRef = useRef(false);
  const expandedRef = useRef(expandedNodes);
  expandedRef.current = expandedNodes;

  const docId = stringId(base.docId || base.bid || '');

  const saveExpandState = useCallback(async () => {
    if (!docId || typeof fetch === 'undefined') return;
    const prefix = domainId && domainId !== 'system' ? `/d/${domainId}` : '';
    try {
      await fetch(`${prefix}/base/detail-ui-prefs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docId: Number(docId),
          displayPrefs: { expandedNodeIds: Array.from(expandedRef.current) },
        }),
      });
      expandDirtyRef.current = false;
    } catch { /* silent */ }
  }, [docId, domainId]);

  const handleToggle = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      expandDirtyRef.current = true;
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        if (expandDirtyRef.current) void saveExpandState();
        return;
      }
      if (event.key === 'Escape') {
        setStructureOpen(false);
        setSelectedCard(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [saveExpandState]);

  const handleSelectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedCard(null);
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      params.set('nodeId', nodeId);
      params.delete('cardId');
      window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    }
  }, []);

  const handleSelectCard = useCallback((card: BaseDetailCard) => {
    setSelectedCard(card);
    const hostNodeId = findCardHostNodeId(String(card.docId), nodeCardsMap);
    if (hostNodeId) {
      setSelectedNodeId(hostNodeId);
      setExpandedNodes((prev) => {
        const next = new Set(prev);
        collectNodePathFromRoot(hostNodeId, getRootNodeIds(nodes, edges)[0] || hostNodeId, edges)
          .forEach((id) => next.add(id));
        return next;
      });
    }
  }, [nodeCardsMap, nodes, edges]);

  // WebSocket live updates
  useEffect(() => {
    const socketUrl = data.socketUrl;
    if (!socketUrl || typeof WebSocket === 'undefined') return undefined;
    let closed = false;
    let sock: WebSocket | null = null;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = socketUrl.startsWith('ws') ? socketUrl : `${protocol}//${window.location.host}/${socketUrl.replace(/^\//, '')}`;
    const prefix = domainId && domainId !== 'system' ? `/d/${domainId}` : '';
    const dataUrl = `${prefix}/base/data?docId=${encodeURIComponent(docId)}`;

    const refresh = () => {
      fetch(dataUrl, { headers: { Accept: 'application/json' } })
        .then((res) => res.json())
        .then((next: any) => {
          if (closed || !next) return;
          setData((prev) => ({
            ...prev,
            base: next.nodes ? { ...prev.base, nodes: next.nodes, edges: next.edges || [] } : prev.base,
            nodeCardsMap: next.nodeCardsMap || prev.nodeCardsMap,
          }));
          if (Array.isArray(next.baseDetailUiPrefs?.expandedNodeIds)) {
            setExpandedNodes(new Set(next.baseDetailUiPrefs.expandedNodeIds));
          }
        })
        .catch(() => {});
    };

    const connect = () => {
      if (closed) return;
      setWsStatus('connecting');
      try {
        sock = new WebSocket(url);
      } catch {
        setWsStatus('disconnected');
        return;
      }
      sock.onopen = () => setWsStatus('connected');
      sock.onclose = () => {
        setWsStatus('disconnected');
        if (!closed) setTimeout(connect, 5000);
      };
      sock.onmessage = (event) => {
        if (closed) return;
        try {
          const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
          if (msg.type === 'init' && typeof msg.viewerCount === 'number') setViewerCount(msg.viewerCount);
          if (msg.type === 'viewer_count') setViewerCount(msg.count ?? 0);
          if (msg.type === 'update') refresh();
        } catch { /* ignore */ }
      };
    };
    connect();
    return () => {
      closed = true;
      try { sock?.close(); } catch { /* ignore */ }
    };
  }, [data.socketUrl, docId, domainId]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );

  const nodeCount = nodes.length;
  const cardCount = Object.values(nodeCardsMap).reduce((sum, cards) => sum + cards.length, 0);
  const problemCount = Object.values(nodeCardsMap)
    .reduce((sum, cards) => sum + cards.reduce((s, card) => s + (card.problems?.length || 0), 0), 0);

  const headerLabels = {
    allBases: t('All Bases', 'All Bases'),
    knowledgeBase: t('Knowledge Base', 'Knowledge Base'),
    documentStructure: t('Document Structure', 'Document Structure'),
    share: t('Share', 'Share'),
    baseOperations: t('Base operations', 'Base operations'),
  };
  const explorerLabels = {
    filter: t('Filter', 'Filter'),
    search: t('Search nodes and cards', 'Search nodes and cards'),
    clear: t('Clear search', 'Clear search'),
    explore: t('Explore base', 'Explore base'),
  };

  const docKey = docId || String(base.slug || '');
  const operations = [
    { name: 'base_study', label: t('Study', 'Study'), cls: 'ej-web-button ej-web-button--primary' },
    { name: 'base_edit', label: t('Edit', 'Edit'), cls: 'ej-web-button ej-web-button--outline' },
    { name: 'base_editor', label: t('Editor', 'Editor'), cls: 'ej-web-button ej-web-button--outline' },
  ].map((op) => ({ ...op, url: docKey ? ctx.buildUrl(op.name, { docId: docKey }) : '#' }))
    .filter((op) => op.url && op.url !== '#');

  const title = base.title?.trim() || t('Knowledge Base', 'Knowledge Base');
  const listUrl = ctx.buildUrl('base_list');
  const headerTitle = selectedNode ? nodeDisplayLabel(selectedNode, unnamedNode) : title;
  const headerDescription = selectedNode && selectedNode.id !== getRootNodeIds(nodes, edges)[0]
    ? title
    : base.content;

  return (
    <div className="ej-bd" data-base-detail-root>
      <BaseDetailHeader
        title={headerTitle}
        description={headerDescription}
        listUrl={listUrl}
        treeDrawerOpen={structureOpen}
        onTreeDrawerOpen={() => setStructureOpen((open) => !open)}
        labels={headerLabels}
      />
      <BaseDetailExplorer filter={filter} onFilterChange={setFilter} labels={explorerLabels} />
      <div className="ej-bd__summary">{nodeCount} {t('nodes', 'nodes')} · {cardCount} {t('cards', 'cards')} · {problemCount} {t('problems', 'problems')}</div>
      <main className="ej-bd__main">
        {selectedNodeId ? (
          <BaseDetailNodeContent
            rootNodeId={selectedNodeId}
            nodes={nodes}
            edges={edges}
            nodeCardsMap={nodeCardsMap}
            selectedCardId={selectedCard ? String(selectedCard.docId) : null}
            onSelectCard={handleSelectCard}
            onSelectNode={handleSelectNode}
            filter={filter}
            unnamedNode={unnamedNode}
            unnamedCard={unnamedCard}
            noCardsText={t('No cards under this node.', 'No cards under this node.')}
          />
        ) : null}
      </main>
      <BaseDetailTreeDrawer
        open={structureOpen}
        nodes={nodes}
        edges={edges}
        nodeCardsMap={nodeCardsMap}
        selectedNodeId={selectedNodeId}
        selectedCardId={selectedCard ? String(selectedCard.docId) : null}
        expandedNodes={expandedNodes}
        drawerWidth={treeDrawerWidth}
        onDrawerWidthChange={setTreeDrawerWidth}
        onClose={() => setStructureOpen(false)}
        onToggle={handleToggle}
        onSelectNode={(nodeId) => { handleSelectNode(nodeId); setStructureOpen(false); }}
        onSelectCard={(card) => { handleSelectCard(card); setStructureOpen(false); }}
        filter={filter}
        unnamedNode={unnamedNode}
        unnamedCard={unnamedCard}
        labels={{
          close: t('Close', 'Close'),
          title: t('Document Structure', 'Document Structure'),
          empty: t('No nodes yet.', 'No nodes yet.'),
        }}
      />
      <BaseDetailCardDrawer
        card={selectedCard}
        onClose={() => setSelectedCard(null)}
        unnamedCard={unnamedCard}
        drawerWidth={cardDrawerWidth}
        onDrawerWidthChange={setCardDrawerWidth}
      />
    </div>
  );
}

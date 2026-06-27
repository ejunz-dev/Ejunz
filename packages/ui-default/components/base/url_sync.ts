import { useEffect, useRef, type RefObject } from 'react';
import type { Node, Viewport } from 'reactflow';
import { scrollToRoadmapNode } from 'vj/components/roadmap/node_scroll';
import type { BaseEdge, BaseNode, Card } from './types';
import {
  findCardByDocId,
  findCardHostNodeId,
  findRoadmapContainerAncestor,
  getPrimaryCardForNode,
  isNodeDescendantOf,
} from './detail_tree';

export type BaseDetailUrlState = {
  nodeId: string | null;
  cardId: string | null;
};

function isCardValidForUrlNode(
  cardHostNodeId: string,
  urlNodeId: string | null,
  edges: BaseEdge[],
): boolean {
  if (!urlNodeId) return true;
  if (urlNodeId === cardHostNodeId) return true;
  return isNodeDescendantOf(cardHostNodeId, urlNodeId, edges);
}

export function getBaseDetailUrlState(): BaseDetailUrlState {
  const params = new URLSearchParams(window.location.search);
  const nodeId = params.get('nodeId')?.trim() || null;
  const cardId = params.get('cardId')?.trim() || null;
  return { nodeId, cardId };
}

export function initialBaseDetailSelectedNodeId(nodeIds: readonly string[]): string | null {
  const { nodeId } = getBaseDetailUrlState();
  if (!nodeId) return null;
  return nodeIds.includes(nodeId) ? nodeId : null;
}

export function updateBaseDetailUrl(
  state: BaseDetailUrlState,
  options?: { replace?: boolean },
) {
  const params = new URLSearchParams(window.location.search);
  if (state.nodeId) params.set('nodeId', state.nodeId);
  else params.delete('nodeId');
  if (state.cardId) params.set('cardId', state.cardId);
  else params.delete('cardId');

  const qs = params.toString();
  const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (newUrl === currentUrl) return;

  const historyState = {
    nodeId: state.nodeId,
    cardId: state.cardId,
  };
  if (options?.replace) {
    window.history.replaceState(historyState, '', newUrl);
  } else {
    window.history.pushState(historyState, '', newUrl);
  }
}

export function resolveContentNodeIdForCard(
  cardId: string,
  _currentContentNodeId: string | null,
  _edges: BaseEdge[],
  nodeCardsMap: Record<string, Card[]>,
): string | null {
  return findCardHostNodeId(cardId, nodeCardsMap);
}

export function useBaseDetailUrlSync(options: {
  nodes: BaseNode[];
  nodeIds: readonly string[];
  edges: BaseEdge[];
  nodeCardsMap: Record<string, Card[]>;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  selectedCard: Card | null;
  setSelectedCard: (card: Card | null) => void;
  onRestoreCard?: (cardId: string, hostNodeId: string) => void;
  onRestoreCanvasNode?: (nodeId: string) => void;
  onClearCard?: () => void;
}) {
  const {
    nodes,
    nodeIds,
    edges,
    nodeCardsMap,
    selectedNodeId,
    setSelectedNodeId,
    selectedCard,
    setSelectedCard,
    onRestoreCard,
    onRestoreCanvasNode,
    onClearCard,
  } = options;

  const skipNextUrlWriteRef = useRef(false);
  const appliedInitialUrlRef = useRef(false);
  const nodeIdsRef = useRef(nodeIds);
  nodeIdsRef.current = nodeIds;

  useEffect(() => {
    if (appliedInitialUrlRef.current) return;
    if (nodeIds.length === 0) return;
    appliedInitialUrlRef.current = true;

    const { nodeId, cardId } = getBaseDetailUrlState();
    if (!nodeId && !cardId) return;

    skipNextUrlWriteRef.current = true;

    let contentNodeId = nodeId;
    if (!contentNodeId && cardId) {
      contentNodeId = findCardHostNodeId(cardId, nodeCardsMap);
    }
    if (contentNodeId && nodeIds.includes(contentNodeId)) {
      setSelectedNodeId(contentNodeId);
      const containerId = findRoadmapContainerAncestor(contentNodeId, nodes, edges);
      if (!cardId && containerId && containerId !== contentNodeId) {
        const primaryCard = getPrimaryCardForNode(contentNodeId, nodeCardsMap);
        if (primaryCard) {
          setSelectedCard(primaryCard);
          onRestoreCard?.(primaryCard.docId, contentNodeId);
        } else {
          onRestoreCanvasNode?.(contentNodeId);
        }
      }
    }

    if (!cardId) return;
    const card = findCardByDocId(cardId, nodeCardsMap);
    const hostNodeId = findCardHostNodeId(cardId, nodeCardsMap);
    if (!card || !hostNodeId) return;
    const urlNodeId = contentNodeId || hostNodeId;
    if (!isCardValidForUrlNode(hostNodeId, urlNodeId, edges)) return;

    if (hostNodeId !== urlNodeId && nodeIds.includes(hostNodeId)) {
      setSelectedNodeId(hostNodeId);
    }
    setSelectedCard(card);
    onRestoreCard?.(cardId, hostNodeId);
  }, [
    edges,
    nodeCardsMap,
    nodeIds,
    nodes,
    onRestoreCanvasNode,
    onRestoreCard,
    setSelectedCard,
    setSelectedNodeId,
  ]);

  useEffect(() => {
    if (skipNextUrlWriteRef.current) {
      skipNextUrlWriteRef.current = false;
      return;
    }

    const url = getBaseDetailUrlState();
    const nextNodeId = selectedNodeId;
    const nextCardId = selectedCard?.docId || null;

    if (nextNodeId === url.nodeId && nextCardId === url.cardId) return;

    if (!nextNodeId && !nextCardId) {
      if (url.nodeId || url.cardId) {
        updateBaseDetailUrl({ nodeId: null, cardId: null }, { replace: true });
      }
      return;
    }

    updateBaseDetailUrl({ nodeId: nextNodeId, cardId: nextCardId });
  }, [selectedCard?.docId, selectedNodeId]);

  useEffect(() => {
    const handlePopState = () => {
      const { nodeId, cardId } = getBaseDetailUrlState();
      skipNextUrlWriteRef.current = true;

      if (cardId) {
        const card = findCardByDocId(cardId, nodeCardsMap);
        const hostNodeId = findCardHostNodeId(cardId, nodeCardsMap);
        const urlNodeId = nodeId || hostNodeId;
        if (
          card
          && hostNodeId
          && isCardValidForUrlNode(hostNodeId, urlNodeId, edges)
        ) {
          if (nodeId && nodeIdsRef.current.includes(nodeId)) {
            setSelectedNodeId(nodeId);
          } else if (hostNodeId && nodeIdsRef.current.includes(hostNodeId)) {
            setSelectedNodeId(hostNodeId);
          }
          setSelectedCard(card);
          onRestoreCard?.(cardId, hostNodeId);
          return;
        }
      }

      if (nodeId && nodeIdsRef.current.includes(nodeId)) {
        setSelectedNodeId(nodeId);
        const containerId = findRoadmapContainerAncestor(nodeId, nodes, edges);
        if (containerId && containerId !== nodeId) {
          const primaryCard = getPrimaryCardForNode(nodeId, nodeCardsMap);
          if (primaryCard) {
            setSelectedCard(primaryCard);
            onRestoreCard?.(primaryCard.docId, nodeId);
            return;
          }
          onRestoreCanvasNode?.(nodeId);
        }
        setSelectedCard(null);
        onClearCard?.();
        return;
      }

      setSelectedNodeId(null);
      setSelectedCard(null);
      onClearCard?.();
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [edges, nodeCardsMap, nodes, onClearCard, onRestoreCanvasNode, onRestoreCard, setSelectedCard, setSelectedNodeId]);
}

export function useBaseDetailCardScroll(
  scrollToCardId: string | null,
  retryKey?: string,
) {
  const lastScrollKeyRef = useRef('');

  useEffect(() => {
    if (!scrollToCardId) return undefined;

    const scrollKey = `${scrollToCardId}:${retryKey || ''}`;
    let cancelled = false;
    let attempts = 0;
    let outerFrame = 0;

    const tryScroll = () => {
      if (cancelled) return;
      const el = document.querySelector(
        `[data-base-detail-card-id="${CSS.escape(scrollToCardId)}"]`,
      );
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        lastScrollKeyRef.current = scrollKey;
        return;
      }
      if (attempts >= 12) return;
      attempts += 1;
      outerFrame = requestAnimationFrame(tryScroll);
    };

    if (scrollKey === lastScrollKeyRef.current) return undefined;
    outerFrame = requestAnimationFrame(tryScroll);

    return () => {
      cancelled = true;
      cancelAnimationFrame(outerFrame);
    };
  }, [retryKey, scrollToCardId]);
}

export function useRoadmapCanvasNodeScroll(options: {
  nodeId: string | null;
  nodes: Node[];
  viewport: Viewport;
  canvasRef: RefObject<HTMLElement | null>;
  canvasHeight: number;
}) {
  const { nodeId, nodes, viewport, canvasRef, canvasHeight } = options;
  const lastScrollKeyRef = useRef('');

  useEffect(() => {
    if (!nodeId || !canvasRef.current || canvasHeight < 120) return undefined;

    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return undefined;

    const scrollKey = [
      nodeId,
      canvasHeight,
      viewport.x,
      viewport.y,
      viewport.zoom,
      node.position.x,
      node.position.y,
    ].join(':');
    if (scrollKey === lastScrollKeyRef.current) return undefined;

    let outerFrame = 0;
    let innerFrame = 0;
    outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        if (!canvasRef.current) return;
        scrollToRoadmapNode(node, viewport, canvasRef.current, { behavior: 'smooth' });
        lastScrollKeyRef.current = scrollKey;
      });
    });

    return () => {
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
    };
  }, [canvasHeight, canvasRef, nodeId, nodes, viewport]);
}

import { useEffect, useRef } from 'react';

export function getRoadmapNodeIdFromUrl(): string | null {
  const nodeId = new URLSearchParams(window.location.search).get('nodeId');
  const trimmed = nodeId?.trim();
  return trimmed || null;
}

export function initialRoadmapSelectedNodeId(nodeIds: readonly string[]): string | null {
  const urlNodeId = getRoadmapNodeIdFromUrl();
  if (!urlNodeId) return null;
  return nodeIds.includes(urlNodeId) ? urlNodeId : null;
}

export function updateRoadmapNodeUrl(nodeId: string | null, options?: { replace?: boolean }) {
  const params = new URLSearchParams(window.location.search);
  if (nodeId) {
    params.set('nodeId', nodeId);
  } else {
    params.delete('nodeId');
  }
  const qs = params.toString();
  const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (newUrl === currentUrl) return;

  const state = nodeId ? { nodeId } : {};
  if (options?.replace) {
    window.history.replaceState(state, '', newUrl);
  } else {
    window.history.pushState(state, '', newUrl);
  }
}

export function useRoadmapNodeUrlSync(options: {
  nodeIds: readonly string[];
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
}) {
  const { nodeIds, selectedNodeId, setSelectedNodeId } = options;
  const skipNextUrlWriteRef = useRef(false);
  const appliedInitialUrlRef = useRef(false);
  const nodeIdsRef = useRef(nodeIds);
  nodeIdsRef.current = nodeIds;

  // Apply URL node once when the node list first becomes available (async load).
  useEffect(() => {
    if (appliedInitialUrlRef.current) return;
    if (nodeIds.length === 0) return;
    appliedInitialUrlRef.current = true;

    const urlNodeId = getRoadmapNodeIdFromUrl();
    if (!urlNodeId || !nodeIds.includes(urlNodeId)) return;

    skipNextUrlWriteRef.current = true;
    setSelectedNodeId(urlNodeId);
  }, [nodeIds, setSelectedNodeId]);

  // Selection -> URL (never force selection back from URL here).
  useEffect(() => {
    if (skipNextUrlWriteRef.current) {
      skipNextUrlWriteRef.current = false;
      return;
    }
    const urlNodeId = getRoadmapNodeIdFromUrl();
    if (selectedNodeId) {
      if (urlNodeId !== selectedNodeId) {
        updateRoadmapNodeUrl(selectedNodeId);
      }
      return;
    }
    if (urlNodeId) {
      updateRoadmapNodeUrl(null, { replace: true });
    }
  }, [selectedNodeId]);

  useEffect(() => {
    const handlePopState = () => {
      const urlNodeId = getRoadmapNodeIdFromUrl();
      skipNextUrlWriteRef.current = true;
      if (urlNodeId && nodeIdsRef.current.includes(urlNodeId)) {
        setSelectedNodeId(urlNodeId);
      } else {
        setSelectedNodeId(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setSelectedNodeId]);
}

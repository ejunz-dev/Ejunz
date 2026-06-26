import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import Notification from 'vj/components/notification';
import { i18n } from 'vj/utils';
import type { BaseNode, BaseEdge, Card, FileItem, PendingCreate } from 'vj/components/base/types';
import type { RoadmapPluginApi, RoadmapPluginDeps, RoadmapPanelTab, RoadmapRightPanelTab, RoadmapCanvasEdgeEditorApi } from '../types';
import { RoadmapCanvas } from './RoadmapCanvas';
import { mergeRoadmapCanvasIntoBase, roadmapChildIdSet } from './canvas_persist';
import { getRoadmapNodeKind, supportsRoadmapPracticeProblems } from './node_kinds';
import { roadmapUntitledCardLabel } from './shared';
import {
  defaultRoadmapDetailDisplaySettings,
  displaySettingsFromRoadmapNode,
  roadmapDetailDisplaySettingsEqual,
  type RoadmapDetailDisplaySettings,
} from './detail_display_settings';
import { RoadmapEditorSettingsPanel } from './RoadmapEditorSettingsPanel';
import { ConnectedRoadmapEdgeInspectorPanel } from './RoadmapEdgeInspectorPanel';

function pickDefaultRoadmapChildId(childNodes: BaseNode[]): string | null {
  if (!childNodes.length) return null;
  const main = childNodes.find(
    (n) => getRoadmapNodeKind((n.data as { roadmapNodeType?: string } | undefined)?.roadmapNodeType) === 'main',
  );
  return (main || childNodes[0]).id;
}

function roadmapChildNodes(base: { nodes: BaseNode[]; edges: BaseEdge[] }, roadmapId: string): BaseNode[] {
  return base.edges
    .filter((e) => e.source === roadmapId)
    .map((e) => base.nodes.find((n) => n.id === e.target))
    .filter(Boolean) as BaseNode[];
}

// ─── Hook — owns all roadmap-specific state, handlers, and slot components ──

export function useRoadmapPlugin(deps: RoadmapPluginDeps): RoadmapPluginApi {
  const {
    base, setBase, baseRef,
    pendingCreatesRef, setPendingCreatesCount,
    setPendingDeletes,
    setNodeCardsMapVersion,
    setExpandedNodes, expandedNodesRef, triggerExpandAutoSave,
    setContextMenu, setEmptyAreaContextMenu,
    setPendingPluginNodeDataIds,
    setRightPanelOpen,
    isPluginEditor,
  } = deps;
  const [roadmapNodeId, setRoadmapNodeId] = useState<string | null>(null);
  const [roadmapSubSelectedNodeId, setRoadmapSubSelectedNodeId] = useState<string | null>(null);
  const [roadmapSelectedEdgeId, setRoadmapSelectedEdgeId] = useState<string | null>(null);
  const [roadmapSelectedEdgeSnapshot, setRoadmapSelectedEdgeSnapshot] = useState<BaseEdge | null>(null);
  const [roadmapPanelTab, setRoadmapPanelTab] = useState<RoadmapPanelTab>('canvas');
  const [roadmapRightPanelTab, setRoadmapRightPanelTab] = useState<RoadmapRightPanelTab>('problems');
  const [displaySettings, setDisplaySettings] = useState<RoadmapDetailDisplaySettings>(
    () => defaultRoadmapDetailDisplaySettings(),
  );

  // ── Refs for stable component (ExplorerContent must never change identity) ──
  const roadmapNodeIdRef = useRef(roadmapNodeId);
  roadmapNodeIdRef.current = roadmapNodeId;
  const roadmapSubRef = useRef(roadmapSubSelectedNodeId);
  roadmapSubRef.current = roadmapSubSelectedNodeId;
  const autoFileSelectKeyRef = useRef<string | null>(null);
  const canvasEdgeApiRef = useRef<RoadmapCanvasEdgeEditorApi | null>(null);

  const handleSelectEdge = useCallback((edgeId: string | null, edgeSnapshot?: BaseEdge | null) => {
    setRoadmapSelectedEdgeId(edgeId);
    setRoadmapSelectedEdgeSnapshot(edgeSnapshot ?? null);
    if (edgeId) {
      setRoadmapRightPanelTab('edge');
      setRightPanelOpen(true);
    } else {
      setRoadmapSelectedEdgeSnapshot(null);
    }
  }, [setRightPanelOpen]);

  const resolveCardRoadmapNodeType = useCallback((
    nodeId: string,
    childNodes: BaseNode[] = [],
  ): string | undefined => {
    const fromCanvas = canvasEdgeApiRef.current?.getCardNodeType(nodeId);
    if (fromCanvas) return fromCanvas;
    const fromChild = childNodes.find((n) => n.id === nodeId);
    const fromChildData = (fromChild?.data as { roadmapNodeType?: string } | undefined)?.roadmapNodeType;
    if (fromChildData) return fromChildData;
    const pending = pendingCreatesRef.current.get(nodeId);
    if (pending?.data && typeof pending.data === 'object') {
      const fromPending = (pending.data as { roadmapNodeType?: string }).roadmapNodeType;
      if (fromPending) return fromPending;
    }
    const fromBase = (baseRef.current as { nodes: BaseNode[] }).nodes.find((n) => n.id === nodeId);
    return (fromBase?.data as { roadmapNodeType?: string } | undefined)?.roadmapNodeType;
  }, [baseRef, pendingCreatesRef]);

  const selectedCardSupportsPractice = useMemo(() => {
    if (!roadmapSubSelectedNodeId || !roadmapNodeId) return false;
    const childNodes = roadmapChildNodes(base, roadmapNodeId);
    return supportsRoadmapPracticeProblems(
      resolveCardRoadmapNodeType(roadmapSubSelectedNodeId, childNodes),
    );
  }, [base.edges, base.nodes, resolveCardRoadmapNodeType, roadmapNodeId, roadmapSubSelectedNodeId]);

  useEffect(() => {
    if (!roadmapNodeId || selectedCardSupportsPractice) return;
    if (roadmapRightPanelTab === 'problems') {
      setRightPanelOpen(false);
    }
  }, [roadmapNodeId, roadmapRightPanelTab, selectedCardSupportsPractice, setRightPanelOpen]);

  const syncDisplaySettingsFromRoadmap = useCallback((roadmapId: string | null) => {
    if (!roadmapId) {
      setDisplaySettings(defaultRoadmapDetailDisplaySettings());
      return;
    }
    const currentBase = baseRef.current as { nodes: BaseNode[] };
    const roadmapNode = currentBase.nodes.find((n) => n.id === roadmapId);
    const next = displaySettingsFromRoadmapNode(roadmapNode);
    setDisplaySettings((prev) => (roadmapDetailDisplaySettingsEqual(prev, next) ? prev : next));
  }, [baseRef]);

  const applyDisplaySettings = useCallback((next: RoadmapDetailDisplaySettings) => {
    const roadmapId = roadmapNodeIdRef.current;
    if (!roadmapId) return;
    setDisplaySettings(next);
    setBase((prev: { nodes: BaseNode[]; edges: BaseEdge[] }) => {
      const updated = {
        ...prev,
        nodes: prev.nodes.map((n) => (
          n.id === roadmapId
            ? { ...n, data: { ...(n.data || {}), editorUi: next } }
            : n
        )),
      };
      baseRef.current = updated;
      return updated;
    });
    if (roadmapId.startsWith('temp-node-')) {
      const create = pendingCreatesRef.current.get(roadmapId);
      if (create) {
        create.data = { ...(create.data || {}), editorUi: next };
        pendingCreatesRef.current.set(roadmapId, create);
      }
    } else {
      setPendingPluginNodeDataIds((prev) => new Set(prev).add(roadmapId));
    }
    Notification.success(i18n('Roadmap editor settings applied pending'));
  }, [baseRef, pendingCreatesRef, setBase, setPendingPluginNodeDataIds]);

  const canvasCardDisplayTitle = useCallback((nodeId: string, fallbackCardTitle?: string): string => {
    const currentBase = baseRef.current as { nodes: BaseNode[] };
    const node = currentBase.nodes.find((n) => n.id === nodeId);
    const fromNode = String(node?.text || '').trim();
    if (fromNode) return fromNode;
    const fromCard = String(fallbackCardTitle || '').trim();
    if (fromCard) return fromCard;
    return roadmapUntitledCardLabel();
  }, [baseRef]);

  const focusRoadmapCardSelection = useCallback((
    nodeId: string,
    onSelectFile: (file: FileItem) => void,
  ) => {
    setRoadmapSelectedEdgeId(null);
    setRoadmapSelectedEdgeSnapshot(null);
    roadmapSubRef.current = nodeId;
    setRoadmapSubSelectedNodeId(nodeId);
    const roadmapId = roadmapNodeIdRef.current;
    if (roadmapId) {
      autoFileSelectKeyRef.current = `${roadmapId}:${nodeId}`;
    }

    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const cards = nodeCardsMap[nodeId] || [];
    if (cards.length > 0) {
      const card = cards[0];
      onSelectFile({
        type: 'card',
        id: 'card-' + card.docId,
        name: canvasCardDisplayTitle(nodeId, card.title),
        nodeId,
        cardId: card.docId,
        parentId: nodeId,
        level: 0,
      });
    } else {
      const tempId = 'temp-card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      const cardTitle = canvasCardDisplayTitle(nodeId);
      const newCard: PendingCreate = { type: 'card', nodeId, title: cardTitle, tempId };
      pendingCreatesRef.current.set(tempId, newCard);
      setPendingCreatesCount(pendingCreatesRef.current.size);
      if (!nodeCardsMap[nodeId]) nodeCardsMap[nodeId] = [];
      const tempCard: Card = {
        docId: tempId,
        cid: 0,
        nodeId,
        title: cardTitle,
        content: '',
        order: 0,
        updateAt: new Date().toISOString(),
      } as Card;
      nodeCardsMap[nodeId].push(tempCard);
      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
      setNodeCardsMapVersion((prev: number) => prev + 1);
      onSelectFile({
        type: 'card',
        id: 'card-' + tempId,
        name: cardTitle,
        nodeId,
        cardId: tempId,
        parentId: nodeId,
        level: 0,
      });
    }

    setRoadmapRightPanelTab('problems');
    setRightPanelOpen(true);
  }, [
    canvasCardDisplayTitle,
    pendingCreatesRef,
    setNodeCardsMapVersion,
    setPendingCreatesCount,
    setRightPanelOpen,
  ]);

  // ── View transitions ──
  const enterRoadmapView = useCallback((nodeId: string, options?: { childNodeId?: string | null }) => {
    autoFileSelectKeyRef.current = null;
    setRoadmapNodeId(nodeId);
    setRoadmapPanelTab('canvas');
    setRoadmapRightPanelTab('problems');
    setRoadmapSelectedEdgeId(null);
    setRoadmapSelectedEdgeSnapshot(null);
    syncDisplaySettingsFromRoadmap(nodeId);

    const currentBase = baseRef.current as { nodes: BaseNode[]; edges: BaseEdge[] };
    const children = roadmapChildNodes(currentBase, nodeId);
    const childIds = new Set(children.map((child) => child.id));
    const requestedChild = options?.childNodeId && childIds.has(options.childNodeId)
      ? options.childNodeId
      : null;
    const selectedId = requestedChild || pickDefaultRoadmapChildId(children);
    roadmapSubRef.current = selectedId;
    setRoadmapSubSelectedNodeId(selectedId);
    if (selectedId) {
      autoFileSelectKeyRef.current = `${nodeId}:${selectedId}`;
    }

    // Roadmap canvas cards live in the canvas view only — keep the tree entry collapsed.
    setExpandedNodes((prev) => {
      if (!prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.delete(nodeId);
      expandedNodesRef.current = next;
      triggerExpandAutoSave();
      return next;
    });
  }, [baseRef, expandedNodesRef, setExpandedNodes, syncDisplaySettingsFromRoadmap, triggerExpandAutoSave]);

  const exitRoadmapView = useCallback(() => {
    setRoadmapNodeId(null);
    setRoadmapSubSelectedNodeId(null);
    setRoadmapSelectedEdgeId(null);
    setRoadmapSelectedEdgeSnapshot(null);
    setRoadmapPanelTab('canvas');
    setRoadmapRightPanelTab('problems');
    setDisplaySettings(defaultRoadmapDetailDisplaySettings());
    autoFileSelectKeyRef.current = null;
  }, []);

  const remapNodeIds = useCallback((nodeIdMap: Map<string, string>) => {
    if (!nodeIdMap.size) return;
    setRoadmapNodeId((prev) => {
      if (!prev) return prev;
      return nodeIdMap.get(prev) || prev;
    });
    setRoadmapSubSelectedNodeId((prev) => {
      if (!prev) return prev;
      return nodeIdMap.get(prev) || prev;
    });
    autoFileSelectKeyRef.current = null;
  }, []);

  // If base was reloaded/saved and the active roadmap id no longer exists, recover when unambiguous.
  useEffect(() => {
    if (!roadmapNodeId) return;
    if (base.nodes.some((n) => n.id === roadmapNodeId)) return;
    const roadmaps = base.nodes.filter((n) => n.type === 'roadmap');
    if (roadmaps.length !== 1) return;
    setRoadmapNodeId(roadmaps[0].id);
    autoFileSelectKeyRef.current = null;
  }, [base.nodes, base.edges, roadmapNodeId]);

  useEffect(() => {
    if (!roadmapNodeId) return;
    syncDisplaySettingsFromRoadmap(roadmapNodeId);
  }, [roadmapNodeId, base.nodes, syncDisplaySettingsFromRoadmap]);

  // ── Detection helpers ──
  const isRoadmapNode = useCallback((node?: BaseNode | null): boolean => {
    return node?.type === 'roadmap';
  }, []);

  const getFileIcon = useCallback((node?: BaseNode | null): string | undefined => {
    return node?.type === 'roadmap' ? '🗺️' : undefined;
  }, []);

  // ── Handlers (extracted from BaseEditor lines 3853–3968) ──

  const handleNewRoadmapChildNode = useCallback((parentNodeId: string) => {
    if (isPluginEditor) return;
    const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const childNodes = base.edges
      .filter((e: BaseEdge) => e.source === parentNodeId)
      .map((e: BaseEdge) => base.nodes.find((n: BaseNode) => n.id === e.target))
      .filter(Boolean) as BaseNode[];
    const maxNodeOrder = childNodes.length > 0
      ? Math.max(...childNodes.map((n: BaseNode) => n.order || 0))
      : 0;

    const newChildNode: PendingCreate = {
      type: 'node',
      nodeType: 'roadmap',
      nodeId: parentNodeId,
      text: '新路线图',
      tempId,
    };
    pendingCreatesRef.current.set(tempId, newChildNode);
    setPendingCreatesCount(pendingCreatesRef.current.size);

    const tempNode: BaseNode = {
      id: tempId,
      text: '新路线图',
      type: 'roadmap',
      order: maxNodeOrder + 1,
    };
    const newEdge: BaseEdge = {
      id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      source: parentNodeId,
      target: tempId,
    };

    setBase((prev: any) => {
      const updated = {
        ...prev,
        nodes: [...prev.nodes, tempNode].map((n: BaseNode) =>
          n.id === parentNodeId ? { ...n, expanded: true } : n,
        ),
        edges: [...prev.edges, newEdge],
      };
      baseRef.current = updated;
      return updated;
    });

    setExpandedNodes((prev) => {
      const newSet = new Set(prev);
      newSet.add(tempId);
      if (!newSet.has(parentNodeId)) {
        newSet.add(parentNodeId);
        expandedNodesRef.current = newSet;
        triggerExpandAutoSave();
      }
      return newSet;
    });

    setContextMenu(null);
  }, [
    base, isPluginEditor, setBase, baseRef, pendingCreatesRef, setPendingCreatesCount,
    setExpandedNodes, expandedNodesRef, triggerExpandAutoSave, setContextMenu,
  ]);

  const handleNewRoadmapRootNode = useCallback(() => {
    if (isPluginEditor) return;
    const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const rootNodes = base.nodes.filter((node: BaseNode) =>
      !base.edges.some((edge: BaseEdge) => edge.target === node.id),
    );
    const maxOrder = rootNodes.length > 0
      ? Math.max(...rootNodes.map((n: BaseNode) => n.order || 0))
      : 0;

    const newRootNode: PendingCreate = {
      type: 'node',
      nodeType: 'roadmap',
      nodeId: '',
      text: '新路线图',
      tempId,
    };
    pendingCreatesRef.current.set(tempId, newRootNode);
    setPendingCreatesCount(pendingCreatesRef.current.size);

    const tempNode: BaseNode = {
      id: tempId,
      text: '新路线图',
      type: 'roadmap',
      order: maxOrder + 1,
    };

    setBase((prev: any) => {
      const updated = { ...prev, nodes: [...prev.nodes, tempNode] };
      baseRef.current = updated;
      return updated;
    });

    setExpandedNodes((prev) => {
      const newSet = new Set(prev);
      newSet.add(tempId);
      return newSet;
    });

    setEmptyAreaContextMenu(null);
  }, [
    base, isPluginEditor, setBase, baseRef, pendingCreatesRef, setPendingCreatesCount,
    setExpandedNodes, setEmptyAreaContextMenu,
  ]);

  // ── Stable ExplorerContent component ──
  // Identity never changes (useMemo with stable deps) so RoadmapCanvas (React Flow) won't remount.
  // Volatile values (roadmapNodeId, roadmapSubSelectedNodeId) are read from refs at render time.

  const ExplorerContent = useMemo(() => {
    function ExplorerContentInner(props: {
      childNodes: BaseNode[];
      childEdges: BaseEdge[];
      themeStyles: Record<string, string>;
      onSelectFile: (file: FileItem) => void;
      displaySettings: RoadmapDetailDisplaySettings;
      nodeCardsMapVersion: number;
      selectedEdgeId: string | null;
      onSelectEdge: (edgeId: string | null, edgeSnapshot?: BaseEdge | null) => void;
      edgeEditorApiRef: React.MutableRefObject<RoadmapCanvasEdgeEditorApi | null>;
      pendingEdgeIds?: ReadonlySet<string>;
      onEdgeChanged?: (edgeId: string, kind: 'update' | 'create' | 'delete') => void;
    }) {
      const selectedNodeId = roadmapSubRef.current;
      const childStructureKey = useMemo(
        () => props.childNodes.map((n) => n.id).sort().join(','),
        [props.childNodes],
      );

      useEffect(() => {
        const roadmapId = roadmapNodeIdRef.current;
        const subId = roadmapSubRef.current;
        if (!roadmapId || !subId) return;
        if (!childStructureKey.includes(subId)) return;

        const selectKey = `${roadmapId}:${subId}`;
        if (autoFileSelectKeyRef.current === selectKey) return;
        autoFileSelectKeyRef.current = selectKey;
        const frame = requestAnimationFrame(() => {
          focusRoadmapCardSelection(subId, props.onSelectFile);
        });
        return () => cancelAnimationFrame(frame);
      }, [childStructureKey, focusRoadmapCardSelection, props.onSelectFile]);

      return (
        <RoadmapCanvas
          childNodes={props.childNodes}
          childEdges={props.childEdges}
          selectedNodeId={selectedNodeId}
          onSelectNode={(nodeId: string | null) => {
            if (nodeId !== null) {
              focusRoadmapCardSelection(nodeId, props.onSelectFile);
            } else {
              setRoadmapSubSelectedNodeId(null);
            }
          }}
          onFlowChange={(updatedNodes, updatedEdges) => {
            setBase((prev: any) => {
              const rId = roadmapNodeIdRef.current;
              if (!rId) return prev;

              const merged = mergeRoadmapCanvasIntoBase(prev, rId, updatedNodes, updatedEdges);
              if (!merged) return prev;

              const { nodes: nextNodes, edges: nextEdges } = merged;
              const prevChildIds = roadmapChildIdSet(prev, rId);
              const updatedNodeIds = new Set(updatedNodes.map((n: BaseNode) => n.id));
              const added = updatedNodes.filter((n: BaseNode) => !prevChildIds.has(n.id));
              for (const n of added) {
                if (!pendingCreatesRef.current.has(n.id)) {
                  pendingCreatesRef.current.set(n.id, {
                    type: 'node',
                    nodeId: rId,
                    text: n.text,
                    tempId: n.id,
                    data: n.data,
                  });
                }
              }
              if (added.length) setPendingCreatesCount(pendingCreatesRef.current.size);

              const deadIds = [...prevChildIds].filter((id: string) => !updatedNodeIds.has(id));
              if (deadIds.length) {
                setPendingDeletes((prevDel: Map<string, { type: 'node'; id: string; nodeId: string }>) => {
                  const next = new Map(prevDel);
                  for (const nid of deadIds) next.set(nid, { type: 'node', id: nid, nodeId: nid });
                  return next;
                });
              }

              const result = { ...prev, nodes: nextNodes, edges: nextEdges };
              baseRef.current = result;
              return result;
            });
          }}
          displaySettings={props.displaySettings}
          nodeCardsMapVersion={props.nodeCardsMapVersion}
          selectedEdgeId={props.selectedEdgeId}
          onSelectEdge={props.onSelectEdge}
          edgeEditorApiRef={props.edgeEditorApiRef}
          pendingEdgeIds={props.pendingEdgeIds}
          onEdgeChanged={props.onEdgeChanged}
          themeStyles={props.themeStyles}
        />
      );
    }
    return ExplorerContentInner;
  }, [
    setBase, baseRef,
    pendingCreatesRef, setPendingCreatesCount, setPendingDeletes,
    focusRoadmapCardSelection,
  ]);

  const SettingsPanel = useMemo(() => {
    function SettingsPanelInner(props: { themeStyles: Record<string, string> }) {
      return (
        <RoadmapEditorSettingsPanel
          settings={displaySettings}
          themeStyles={props.themeStyles}
          onApply={applyDisplaySettings}
        />
      );
    }
    return SettingsPanelInner;
  }, [applyDisplaySettings, displaySettings]);

  const EdgeInspectorPanel = useCallback((props: { themeStyles: Record<string, string> }) => (
    <ConnectedRoadmapEdgeInspectorPanel
      edgeId={roadmapSelectedEdgeId}
      edgeSnapshot={roadmapSelectedEdgeSnapshot}
      edgeEditorApiRef={canvasEdgeApiRef}
      themeStyles={props.themeStyles}
    />
  ), [roadmapSelectedEdgeId, roadmapSelectedEdgeSnapshot]);

  // ── Slot: NodeContextMenuExtra ──
  const NodeContextMenuExtra = useCallback(
    (props: { node: BaseNode; file: FileItem; themeStyles: Record<string, string>; onClose: () => void; handleNewCard: (nodeId: string) => void }) => {
      const sItem: React.CSSProperties = {
        padding: '6px 16px',
        cursor: 'pointer',
        fontSize: '13px',
        color: props.themeStyles.textPrimary,
      };
      const hoverEnter = (e: React.MouseEvent) => { (e.currentTarget as HTMLElement).style.backgroundColor = props.themeStyles.bgHover; };
      const hoverLeave = (e: React.MouseEvent) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; };
      return (
        <>
          {props.node?.type === 'roadmap' && (
            <div style={sItem} onMouseEnter={hoverEnter} onMouseLeave={hoverLeave}
              onClick={() => { props.handleNewCard(props.file.nodeId || ''); props.onClose(); }}>
              🗺️ 新建 Roadmap Card
            </div>
          )}
          <div style={sItem} onMouseEnter={hoverEnter} onMouseLeave={hoverLeave}
            onClick={() => { handleNewRoadmapChildNode(props.file.nodeId || ''); props.onClose(); }}>
            🗺️ 新建Roadmap
          </div>
        </>
      );
    },
    [handleNewRoadmapChildNode],
  );

  // ── Slot: EmptyAreaContextMenuExtra ──
  const EmptyAreaContextMenuExtra = useCallback(
    (props: { themeStyles: Record<string, string>; onClose: () => void }) => {
      const sItem: React.CSSProperties = {
        padding: '6px 16px',
        cursor: 'pointer',
        fontSize: '13px',
        color: props.themeStyles.textPrimary,
      };
      return (
        <div style={sItem}
          onMouseEnter={(e: React.MouseEvent) => { (e.currentTarget as HTMLElement).style.backgroundColor = props.themeStyles.bgHover; }}
          onMouseLeave={(e: React.MouseEvent) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
          onClick={() => { handleNewRoadmapRootNode(); props.onClose(); }}>
          🗺️ 新建 Roadmap
        </div>
      );
    },
    [handleNewRoadmapRootNode],
  );

  // ── Return API object ──

  return {
    roadmapNodeId,
    roadmapSubSelectedNodeId,
    roadmapPanelTab,
    roadmapRightPanelTab,
    roadmapSelectedEdgeId,
    selectedCardSupportsPractice,
    displaySettings,
    enterRoadmapView,
    exitRoadmapView,
    setRoadmapPanelTab,
    setRoadmapRightPanelTab,
    selectRoadmapEdge: handleSelectEdge,
    setRoadmapSubSelectedNodeId,
    remapNodeIds,
    handleNewRoadmapChildNode,
    handleNewRoadmapRootNode,
    isRoadmapNode,
    getFileIcon,
    ExplorerContent,
    SettingsPanel,
    EdgeInspectorPanel,
    roadmapCanvasEdgeApiRef: canvasEdgeApiRef,
    NodeContextMenuExtra,
    EmptyAreaContextMenuExtra,
  };
}

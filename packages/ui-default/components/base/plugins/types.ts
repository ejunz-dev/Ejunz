import type { BaseNode, BaseEdge, Card, FileItem, PendingCreate, CardFileInfo, EditorRightPanelTab } from 'vj/components/base/types';

// ─── Plugin Slot API ────────────────────────────────────────────────────

export type RoadmapPanelTab = 'canvas' | 'settings';
export type RoadmapRightPanelTab = 'problems' | 'edge';

export interface RoadmapPluginApi {
  // State
  roadmapNodeId: string | null;
  roadmapSubSelectedNodeId: string | null;
  roadmapPanelTab: RoadmapPanelTab;
  roadmapRightPanelTab: RoadmapRightPanelTab;
  roadmapSelectedEdgeId: string | null;
  selectedCardSupportsPractice: boolean;
  displaySettings: {
    showProblemCount: boolean;
    showNodeNumber: boolean;
  };

  // Actions
  enterRoadmapView: (nodeId: string, options?: { childNodeId?: string | null }) => void;
  exitRoadmapView: () => void;
  setRoadmapPanelTab: (tab: RoadmapPanelTab) => void;
  setRoadmapRightPanelTab: (tab: RoadmapRightPanelTab) => void;
  selectRoadmapEdge: (edgeId: string | null, edgeSnapshot?: BaseEdge | null) => void;
  setRoadmapSubSelectedNodeId: (id: string | null) => void;
  /** Remap active roadmap/canvas selection after batch-save temp id → real id. */
  remapNodeIds: (nodeIdMap: Map<string, string>) => void;
  handleNewRoadmapChildNode: (parentNodeId: string) => void;
  handleNewRoadmapRootNode: () => void;

  // Detection helpers
  isRoadmapNode: (node?: BaseNode | null) => boolean;
  getFileIcon: (node?: BaseNode | null) => string | undefined;

  // ── Slot components ──

  /** Renders RoadmapCanvas inside the explorer when a roadmap node is active. */
  ExplorerContent: React.ComponentType<ExplorerContentProps>;

  /** Display settings panel for the active roadmap (left sidebar settings tab). */
  SettingsPanel: React.ComponentType<{ themeStyles: Record<string, string> }>;

  /** Edge inspector for the active roadmap canvas selection. */
  EdgeInspectorPanel: React.ComponentType<{ themeStyles: Record<string, string> }>;

  /** Canvas edge mutation API (filled while roadmap canvas is mounted). */
  roadmapCanvasEdgeApiRef: React.MutableRefObject<RoadmapCanvasEdgeEditorApi | null>;

  /** Extra context-menu items for roadmap nodes (shown under normal items). */
  NodeContextMenuExtra: React.ComponentType<NodeCtxMenuExtraProps>;

  /** Root empty-area context-menu items. */
  EmptyAreaContextMenuExtra: React.ComponentType<EmptyAreaCtxMenuExtraProps>;
}

// ─── Props for slot components ──────────────────────────────────────────

export interface RoadmapCanvasEdgeEditorApi {
  updateEdge: (edgeId: string, patch: { label?: string; lineStyle?: import('./shared').RoadmapEdgeLineStyle }) => void;
  deleteEdge: (edgeId: string) => void;
  getEdge: (edgeId: string) => (BaseEdge & { lineStyle?: string; label?: string; style?: Record<string, unknown> }) | null;
  updateCardTitle: (nodeId: string, title: string) => void;
  getCardNodeType: (nodeId: string) => string | undefined;
}

export interface ExplorerContentProps {
  childNodes: BaseNode[];
  childEdges: BaseEdge[];
  themeStyles: Record<string, string>;
  onSelectFile: (file: FileItem) => void;
  displaySettings: {
    showProblemCount: boolean;
    showNodeNumber: boolean;
  };
  nodeCardsMapVersion: number;
  selectedEdgeId: string | null;
  onSelectEdge: (edgeId: string | null, edgeSnapshot?: BaseEdge | null) => void;
  edgeEditorApiRef: React.MutableRefObject<RoadmapCanvasEdgeEditorApi | null>;
  pendingEdgeIds?: ReadonlySet<string>;
  onEdgeChanged?: (edgeId: string, kind: 'update' | 'create' | 'delete') => void;
}

export interface NodeCtxMenuExtraProps {
  node: BaseNode;
  file: FileItem;
  themeStyles: Record<string, string>;
  onClose: () => void;
  handleNewCard: (nodeId: string) => void;
}

export interface EmptyAreaCtxMenuExtraProps {
  themeStyles: Record<string, string>;
  onClose: () => void;
}

// ─── Dependencies passed to the hook ────────────────────────────────────

export interface RoadmapPluginDeps {
  base: { nodes: BaseNode[]; edges: BaseEdge[] };
  setBase: React.Dispatch<React.SetStateAction<any>>;
  baseRef: React.MutableRefObject<any>;
  pendingCreatesRef: React.MutableRefObject<Map<string, PendingCreate>>;
  setPendingCreatesCount: React.Dispatch<React.SetStateAction<number>>;
  setPendingDeletes: React.Dispatch<React.SetStateAction<any>>;
  setNodeCardsMapVersion: React.Dispatch<React.SetStateAction<number>>;
  setExpandedNodes: React.Dispatch<React.SetStateAction<Set<string>>>;
  expandedNodesRef: React.MutableRefObject<Set<string>>;
  triggerExpandAutoSave: () => void;
  setContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; file: FileItem } | null>>;
  setEmptyAreaContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  setPendingPluginNodeDataIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setRightPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isPluginEditor: boolean;
}

import type { BaseNode, BaseEdge, Card, FileItem, PendingCreate, CardFileInfo } from 'vj/components/base/types';

// ─── Plugin Slot API ────────────────────────────────────────────────────

export interface RoadmapPluginApi {
  // State
  roadmapNodeId: string | null;
  roadmapSubSelectedNodeId: string | null;

  // Actions
  enterRoadmapView: (nodeId: string) => void;
  exitRoadmapView: () => void;
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

  /** Extra context-menu items for roadmap nodes (shown under normal items). */
  NodeContextMenuExtra: React.ComponentType<NodeCtxMenuExtraProps>;

  /** Root empty-area context-menu items. */
  EmptyAreaContextMenuExtra: React.ComponentType<EmptyAreaCtxMenuExtraProps>;
}

// ─── Props for slot components ──────────────────────────────────────────

export interface ExplorerContentProps {
  childNodes: BaseNode[];
  childEdges: BaseEdge[];
  themeStyles: Record<string, string>;
  onSelectFile: (file: FileItem) => void;
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
  isPluginEditor: boolean;
}

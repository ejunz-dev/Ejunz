import type {
  Problem,
} from 'ejun/src/interface';

export type PluginNodeType = 'folder';

export interface PluginNodeData {
  pluginNodeType?: PluginNodeType;
  slug?: string;
  description?: string;
  enabled?: boolean;
}

export type AvailableMcpToolForPlugin = {
  uniqueId: string;
  name: string;
  description?: string;
  kind?: string;
  toolDocId?: string;
  toolKey?: string;
  edgeDocId?: string;
  edgeId?: number;
  type?: string;
};

export type AvailableMcpServiceForPlugin = {
  mid: number;
  kind: string;
  sourceLabel?: string;
  name: string;
  description?: string;
  status: string;
  online?: boolean;
  assignable?: boolean;
  toolCount?: number;
  tools?: AvailableMcpToolForPlugin[];
};

export type EditorRightPanelTab = 'problems' | 'develop_queue' | 'plugin_node' | 'plugin_mcp_services' | 'roadmap_edge';

export interface BaseNode {
  id: string;
  text: string;
  type?: 'normal' | 'roadmap';
  x?: number;
  y?: number;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond';
  parentId?: string;
  children?: string[];
  expanded?: boolean;
  level?: number;
  order?: number;
  style?: Record<string, any>;
  data?: PluginNodeData | Record<string, any>;
  files?: CardFileInfo[];
}

export interface BaseEdge {
  id: string;
  source: string;
  target: string;
}

/** Aggregated file item for inheritance: file + source (self / descendant node / card) */
export interface AggregatedFileItem extends CardFileInfo {
  sourceType: 'self' | 'node' | 'card';
  sourceNodeId: string;
  sourceNodeText?: string;
  sourceCardId?: string;
  sourceCardTitle?: string;
}

export interface BaseDoc {
  docId?: string;
  bid?: number;
  title?: string;
  content?: string;
  nodes: BaseNode[];
  edges: BaseEdge[];
  currentBranch?: string;
  branches?: string[];
  /** Problem tag registry at base level; edit in lesson, not in the base editor UI. */
  problemTags?: unknown;
  nodeCardsMap?: Record<string, Card[]>;
  files?: Array<{ _id: string; name: string; size: number; etag?: string; lastModified?: Date | string }>;
}

export interface CardFileInfo {
  _id: string;
  name: string;
  size: number;
  lastModified?: Date | string;
}

export interface Card {
  docId: string;
  cid: number;
  title: string;
  content: string;
  /** Shown in lesson with Know it / No impression */
  cardFace?: string;
  updateAt: string;
  createdAt?: string;
  order?: number;
  nodeId?: string;
  problems?: Problem[];
  files?: CardFileInfo[];
}

export type FileItem = {
  type: 'node' | 'card' | 'roadmap';
  id: string;
  name: string;
  nodeId?: string;
  cardId?: string;
  parentId?: string;
  level: number;
  hasPendingChanges?: boolean;
  clipboardType?: 'copy' | 'cut';
};

/** Titles + tree order only, for copy/paste structure (card bodies omitted). */
export type EditorStructureEntry =
  | { kind: 'card'; title: string; order: number }
  | { kind: 'node'; title: string; order: number; children: EditorStructureEntry[] };

/** Clipboard JSON for node context menu Export structure+content: children cards/nodes under the node (excluding the node itself). */
export const BASE_SUBTREE_CLIPBOARD_MARKER = 'ejunz-base-subtree-v1';

export type EditorSubtreeCardSnapshot = {
  title: string;
  content: string;
  cardFace?: string;
  cid?: number;
  problems?: Problem[];
  files?: CardFileInfo[];
};

export type EditorSubtreeExportEntry =
  | { kind: 'card'; order: number; card: EditorSubtreeCardSnapshot }
  | {
      kind: 'node';
      order: number;
      title: string;
      node?: Pick<BaseNode, 'color' | 'backgroundColor' | 'fontSize' | 'shape'>;
      children: EditorSubtreeExportEntry[];
    };

export type EditorSubtreeExportPayload = {
  marker: typeof BASE_SUBTREE_CLIPBOARD_MARKER;
  version: 1;
  exportedAt: string;
  entries: EditorSubtreeExportEntry[];
};

export interface PendingChange {
  file: FileItem;
  content: string;
  originalContent: string;
}

export type ExecuteAiOpsFn = (
  operations: any[],
  execOpts?: { quiet?: boolean },
) => Promise<{ success: boolean; errors: string[] }>;

/** AI terminal @-refs in the input bar (node / card / practice problem on current card). */
export type AiChatBarRef =
  | { type: 'node'; id: string; name: string; path: string[] }
  | { type: 'card'; id: string; name: string; path: string[] }
  | { type: 'problem'; id: string; name: string; path: string[]; cardDocId: string; pid: string };

export interface PendingRename {
  file: FileItem;
  newName: string;
  originalName: string;
}

export interface PendingCreate {
  type: 'card' | 'node';
  nodeId: string;
  title?: string;
  text?: string;
  tempId: string;
  data?: PluginNodeData;
  nodeType?: 'normal' | 'roadmap';
}

export interface PendingDelete {
  type: 'card' | 'node';
  id: string;
  nodeId?: string;
}

export interface PendingFileMove {
  id: string;
  fileName: string;
  originalSourceType: 'node' | 'card';
  originalSourceNodeId: string;
  originalSourceCardId?: string;
  targetNodeId: string;
  file: CardFileInfo;
}

/** Serializable snapshot to revert one AI assistant turn's `operations[]` effects. */
export interface AiEditorRevertSnapshot {
  base: BaseDoc;
  nodeCardsMap: Record<string, Card[]>;
  pendingCreatesEntries: [string, PendingCreate][];
  pendingChangesEntries: [string, PendingChange][];
  pendingRenamesEntries: [string, PendingRename][];
  pendingDeletesEntries: [string, PendingDelete][];
  pendingDragChangesArr: string[];
  pendingPluginNodeDataIdsArr: string[];
  expandedNodesArr: string[];
  pendingProblemCardIdsArr: string[];
  pendingNewProblemCardIdsArr: string[];
  pendingEditedProblemIdsEntries: [string, string[]][];
  newProblemIdsArr: string[];
  editedProblemIdsArr: string[];
  fileContent: string;
  originalProblemsCardEntries: [string, [string, Problem][]][];
  originalProblemsOrderEntries: [string, string[]][];
  pendingCardFaceChanges: Record<string, string>;
}

export type SavedEditorLayout = {
  explorerMode: 'tree' | 'pending' | 'branches' | 'git';
  rightPanelOpen: boolean;
  aiBottomOpen: boolean;
  explorerPanelWidth: number;
  problemsPanelWidth: number;
  aiPanelHeight: number;
};

export type DevelopEditorContextWire = {
  dateUtc: string;
  current: {
    baseDocId: number;
    branch: string;
    baseTitle: string;
    editorUrl: string;
    dailyNodeGoal: number;
    dailyCardGoal: number;
    dailyProblemGoal: number;
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
    goalsMet: boolean;
  };
  othersIncomplete: Array<{
    baseDocId: number;
    branch: string;
    baseTitle: string;
    dailyNodeGoal: number;
    dailyCardGoal: number;
    dailyProblemGoal: number;
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
    editorUrl: string;
  }>;
};

export interface NodeFileFolder {
  nodeId: string;
  nodeText: string;
  order: number;
  files: AggregatedFileItem[];
  subfolders: NodeFileFolder[];
}

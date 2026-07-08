import { nanoid } from 'nanoid';
import { jsonrepair } from 'jsonrepair';
import { request, i18n } from 'vj/utils';
import type { Problem, ProblemKind } from 'ejun/src/interface';
import { migrateRawProblem } from 'ejun/src/model/problem';
import type {
  AggregatedFileItem,
  AiChatBarRef,
  AiEditorRevertSnapshot,
  BaseDoc,
  BaseEdge,
  BaseNode,
  Card,
  CardFileInfo,
  DevelopEditorContextWire,
  EditorRightPanelTab,
  EditorSubtreeExportPayload,
  FileItem,
  PendingChange,
  PendingCreate,
  PendingDelete,
  PendingRename,
  SavedEditorLayout,
  NodeFileFolder,
} from './types';
import type { LearnProblemNotesDraftBatch } from 'vj/components/editor_workspace/editable_problem';
import { BASE_SUBTREE_CLIPBOARD_MARKER } from './types';

/* ------------------------------------------------------------------ */
/*  parseSubtreeExportPayload                                          */
/* ------------------------------------------------------------------ */
export function parseSubtreeExportPayload(raw: string): EditorSubtreeExportPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.marker !== BASE_SUBTREE_CLIPBOARD_MARKER || o.version !== 1 || !Array.isArray(o.entries)) return null;
  return o as EditorSubtreeExportPayload;
}

/* ------------------------------------------------------------------ */
/*  cloneProblemsWithNewPid                                            */
/* ------------------------------------------------------------------ */
export function cloneProblemsWithNewPid(problems: Problem[] | undefined): Problem[] | undefined {
  if (!problems?.length) return undefined;
  return problems.map((p) => migrateRawProblem({ ...JSON.parse(JSON.stringify(p)), pid: nanoid() }));
}

/* ------------------------------------------------------------------ */
/*  sameCardDocId                                                      */
/* ------------------------------------------------------------------ */
export function sameCardDocId(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/* ------------------------------------------------------------------ */
/*  findNodeIdForCardMap                                               */
/* ------------------------------------------------------------------ */
export function findNodeIdForCardMap(nodeCardsMap: Record<string, Card[]>, cardId: string): string {
  for (const nid of Object.keys(nodeCardsMap || {})) {
    const cards = nodeCardsMap[nid] || [];
    if (cards.some((c: Card) => sameCardDocId(c.docId, cardId))) return nid;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/*  mergeLearnProblemNoteDraftsIntoBatch                               */
/* ------------------------------------------------------------------ */
export function mergeLearnProblemNoteDraftsIntoBatch(
  batchSaveData: { cardUpdates: any[] },
  draftMap: Map<string, LearnProblemNotesDraftBatch>,
) {
  const byCard = new Map<string, LearnProblemNotesDraftBatch[]>();
  for (const batch of draftMap.values()) {
    const cid = String(batch.cardId);
    if (cid.startsWith('temp-card-')) continue;
    if (!byCard.has(cid)) byCard.set(cid, []);
    byCard.get(cid)!.push(batch);
  }
  const nodeCardsMap = (typeof window !== 'undefined' ? (window as any).UiContext?.nodeCardsMap : null) || {};
  for (const [cardId, blocks] of byCard) {
    const nodeId = findNodeIdForCardMap(nodeCardsMap, cardId);
    if (!nodeId) continue;
    const learnProblemNotes = blocks.map((b) => {
      const o: Record<string, unknown> = { pid: b.pid };
      if (b.create.length) o.create = b.create;
      if (b.update.length) o.update = b.update;
      if (b.deleteIds.length) o.deleteIds = b.deleteIds;
      return o;
    });
    const existing = batchSaveData.cardUpdates.find((u: any) => sameCardDocId(u.cardId, cardId));
    if (existing) {
      const prev = Array.isArray((existing as any).learnProblemNotes)
        ? (existing as any).learnProblemNotes
        : [];
      (existing as any).learnProblemNotes = [...prev, ...learnProblemNotes];
    } else {
      batchSaveData.cardUpdates.push({
        cardId,
        nodeId,
        learnProblemNotes,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/*  cloneAiChatBarRefs                                                 */
/* ------------------------------------------------------------------ */
export function cloneAiChatBarRefs(refs: AiChatBarRef[]): AiChatBarRef[] {
  return refs.map((r) => ({ ...r, path: [...r.path] }));
}

/* ------------------------------------------------------------------ */
/*  aiBarRefChipAccent / aiBarRefChipBg / aiBarRefChipLetter           */
/* ------------------------------------------------------------------ */
export function aiBarRefChipAccent(ref: AiChatBarRef, themeStyles: { statNode: string; statCard: string; statProblem: string }): string {
  if (ref.type === 'node') return themeStyles.statNode;
  if (ref.type === 'card') return themeStyles.statCard;
  return themeStyles.statProblem;
}

export function aiBarRefChipBg(ref: AiChatBarRef, theme: string): string {
  const isDark = theme === 'dark';
  if (ref.type === 'node') {
    return isDark ? 'rgba(100, 181, 246, 0.12)' : 'rgba(33, 150, 243, 0.08)';
  }
  if (ref.type === 'card') {
    return isDark ? 'rgba(129, 199, 132, 0.12)' : 'rgba(76, 175, 80, 0.08)';
  }
  return isDark ? 'rgba(255, 183, 77, 0.14)' : 'rgba(255, 152, 0, 0.1)';
}

export function aiBarRefChipLetter(ref: AiChatBarRef): string {
  if (ref.type === 'node') return 'N';
  if (ref.type === 'card') return 'C';
  return 'P';
}

/* ------------------------------------------------------------------ */
/*  problemKindToI18nKey                                               */
/* ------------------------------------------------------------------ */
export function problemKindToI18nKey(kind: ProblemKind): string {
  switch (kind) {
    case 'single': return 'Problem kind single';
    case 'multi': return 'Problem kind multi';
    case 'true_false': return 'Problem kind true false';
    case 'flip': return 'Problem kind flip';
    case 'fill_blank': return 'Problem kind fill blank';
    case 'matching': return 'Problem kind matching';
    case 'super_flip': return 'Problem kind super flip';
    case 'ai_eval': return 'Problem kind ai eval';
    default: {
      const _x: never = kind;
      return String(_x);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  resolveCardExportBody                                              */
/* ------------------------------------------------------------------ */
export function resolveCardExportBody(
  card: Card,
  pendingChanges: Map<string, PendingChange>,
  opts?: { selectedFile: FileItem | null; editorInstance: any },
): string {
  const cid = String(card.docId);
  const pendingKeys =
    cid.startsWith('temp-card-') ? [cid, `card-${cid}`] : [`card-${cid}`, cid];
  if (opts?.selectedFile?.type === 'card' && sameCardDocId(opts.selectedFile.cardId, card.docId)) {
    const ed = opts.editorInstance;
    try {
      if (ed && typeof ed.value === 'function') {
        const live = ed.value();
        if (typeof live === 'string') return live;
      }
    } catch {
      /* fall through */
    }
  }
  for (const k of pendingKeys) {
    const p = pendingChanges.get(k);
    if (p?.content !== undefined && p.content !== null) return p.content;
  }
  return typeof card.content === 'string' ? card.content : '';
}

/* ------------------------------------------------------------------ */
/*  splitAiAssistantStream                                             */
/* ------------------------------------------------------------------ */
export function splitAiAssistantStream(accumulated: string): {
  visibleProse: string;
  inFence: boolean;
  fenceBody: string;
} {
  const m = accumulated.match(/```\s*json\s*\r?\n/i);
  if (!m || m.index === undefined) {
    return { visibleProse: accumulated, inFence: false, fenceBody: '' };
  }
  const openStart = m.index;
  const openEnd = openStart + m[0].length;
  const tail = accumulated.slice(openEnd);
  let closeRel = tail.search(/\r?\n```/);
  if (closeRel === -1 && tail.endsWith('```') && tail.length >= 3) {
    closeRel = tail.length - 3;
  }
  if (closeRel === -1) {
    return {
      visibleProse: accumulated.slice(0, openStart).replace(/\s+$/u, ''),
      inFence: true,
      fenceBody: tail,
    };
  }
  const fenceBody = tail.slice(0, closeRel);
  let afterClose = tail.slice(closeRel);
  const nlClose = afterClose.match(/^(\r?\n```)/);
  if (nlClose) {
    afterClose = afterClose.slice(nlClose[1].length);
  } else if (afterClose.startsWith('```')) {
    afterClose = afterClose.slice(3);
  } else {
    afterClose = afterClose.replace(/^[\r\n]*```\s*/, '');
  }
  const proseBefore = accumulated.slice(0, openStart).replace(/\s+$/u, '');
  const visibleProse = [proseBefore, afterClose.trim()].filter(Boolean).join('\n').trim();
  return { visibleProse, inFence: false, fenceBody };
}

/* ------------------------------------------------------------------ */
/*  extractAiOperationTypesPartial                                     */
/* ------------------------------------------------------------------ */
export function extractAiOperationTypesPartial(partial: string): string[] {
  const types: string[] = [];
  const re = /"type"\s*:\s*"([a-z_]+)"/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(partial)) !== null) {
    types.push(mm[1]);
  }
  return types;
}

/* ------------------------------------------------------------------ */
/*  friendlyAiOperationLabel                                           */
/* ------------------------------------------------------------------ */
export function friendlyAiOperationLabel(t: string): string {
  const labels: Record<string, string> = {
    create_node: 'Create node',
    create_card: 'Create card',
    move_node: 'Move node',
    move_card: 'Move card',
    rename_node: 'Rename node',
    rename_card: 'Rename card',
    update_card_content: 'Update card content',
    delete_node: 'Delete node',
    delete_card: 'Delete card',
    create_problem: 'Create problem',
  };
  return labels[t] || t;
}

/* ------------------------------------------------------------------ */
/*  extractNextJsonObject                                              */
/* ------------------------------------------------------------------ */
export function extractNextJsonObject(s: string, start: number): { raw: string; next: number } | null {
  let i = start;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length || s[i] !== '{') return null;
  let depth = 0;
  let inString = false;
  let esc = false;
  const objStart = i;
  for (; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inString) {
      if (c === '\\') esc = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const raw = s.slice(objStart, i + 1);
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (j < s.length && s[j] === ',') j++;
        return { raw, next: j };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  extractParsedOperationsFromPartialFence                            */
/* ------------------------------------------------------------------ */
export function extractParsedOperationsFromPartialFence(fenceBody: string): any[] {
  const m = fenceBody.match(/"operations"\s*:\s*\[/);
  if (!m || m.index === undefined) return [];
  let pos = m.index + m[0].length;
  const out: any[] = [];
  while (true) {
    while (pos < fenceBody.length && /\s/.test(fenceBody[pos])) pos++;
    if (pos < fenceBody.length && fenceBody[pos] === ']') break;
    const ext = extractNextJsonObject(fenceBody, pos);
    if (!ext) break;
    try {
      const normalized = ext.raw
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, '\'')
        .replace(/,\s*([}\]])/g, '$1');
      let parsed: any;
      try {
        parsed = JSON.parse(normalized);
      } catch {
        parsed = JSON.parse(jsonrepair(normalized));
      }
      out.push(parsed);
    } catch {
      break;
    }
    pos = ext.next;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  summarizeAiOperationOneLine                                        */
/* ------------------------------------------------------------------ */
export function summarizeAiOperationOneLine(op: any): string {
  const t = op?.type;
  if (!t) return '(unknown operation)';
  const short = (x: unknown, max = 12) => {
    const s = x != null ? String(x) : '';
    if (!s) return '—';
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  switch (t) {
    case 'create_node': {
      const pluginType = op.pluginNodeType || op.nodeType || op.data?.pluginNodeType || op.pluginData?.pluginNodeType;
      const typePrefix = pluginType ? `${String(pluginType)} ` : '';
      return `Create ${typePrefix}node "${String(op.text || '').slice(0, 40)}${String(op.text || '').length > 40 ? '…' : ''}" under ${short(op.parentId)}`;
    }
    case 'create_card':
      return `Create card "${String(op.title || '').slice(0, 36)}${String(op.title || '').length > 36 ? '…' : ''}" on ${short(op.nodeId)}`;
    case 'move_node':
      return `Move node ${short(op.nodeId)} → parent ${short(op.targetParentId)}`;
    case 'move_card':
      return `Move card ${short(op.cardId)} → node ${short(op.targetNodeId)}`;
    case 'rename_node':
      return `Rename node ${short(op.nodeId)} → "${String(op.newText || '').slice(0, 32)}${String(op.newText || '').length > 32 ? '…' : ''}"`;
    case 'rename_card':
      return `Rename card ${short(op.cardId)} → "${String(op.newTitle || '').slice(0, 32)}${String(op.newTitle || '').length > 32 ? '…' : ''}"`;
    case 'update_card_content':
      return `Update content of card ${short(op.cardId)}`;
    case 'delete_node':
      return `Delete node ${short(op.nodeId)}`;
    case 'delete_card':
      return `Delete card ${short(op.cardId)}`;
    case 'create_problem': {
      const ttl = typeof op.title === 'string' && op.title.trim() ? ` "${op.title.trim().slice(0, 28)}${op.title.trim().length > 28 ? '…' : ''}"` : '';
      const rpid = typeof op.pid === 'string' && op.pid.trim()
        ? op.pid.trim()
        : typeof op.problemPid === 'string' && op.problemPid.trim()
          ? op.problemPid.trim()
          : '';
      if (rpid) {
        return `Update practice problem ${short(rpid)} (${String(op.problemKind || 'single')})${ttl} on card ${short(op.cardId)}`;
      }
      return `Create ${String(op.problemKind || 'single')} problem${ttl} on card ${short(op.cardId)}`;
    }
    default:
      return String(t);
  }
}

/* ------------------------------------------------------------------ */
/*  collectOutlineAncestors                                            */
/* ------------------------------------------------------------------ */
export function collectOutlineAncestors(nodeId: string, nodes: BaseNode[], edges: BaseEdge[]): string[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const acc: string[] = [];
  let cur = nodeId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const edge = edges.find((e) => e.target === cur);
    if (edge?.source && nodeMap.has(edge.source)) {
      acc.push(edge.source);
      cur = edge.source;
      continue;
    }
    const pid = nodeMap.get(cur)?.parentId;
    if (pid && nodeMap.has(pid)) {
      acc.push(pid);
      cur = pid;
      continue;
    }
    break;
  }
  return acc;
}

/* ------------------------------------------------------------------ */
/*  normalizeCardContentForCompare                                     */
/* ------------------------------------------------------------------ */
export function normalizeCardContentForCompare(s: string | undefined | null): string {
  return String(s ?? '').replace(/\r\n/g, '\n');
}

/* ------------------------------------------------------------------ */
/*  buildAiEditorRevertSnapshot                                        */
/* ------------------------------------------------------------------ */
export function buildAiEditorRevertSnapshot(opts: {
  baseDoc: BaseDoc;
  nodeCardsMap: Record<string, Card[]>;
  pendingCreates: Map<string, PendingCreate>;
  pendingChanges: Map<string, PendingChange>;
  pendingRenames: Map<string, PendingRename>;
  pendingDeletes: Map<string, PendingDelete>;
  pendingDragChanges: Set<string>;
  pendingPluginNodeDataIds: Set<string>;
  expandedNodes: ReadonlySet<string>;
  pendingProblemCardIds: Set<string>;
  pendingNewProblemCardIds: Set<string>;
  pendingEditedProblemIds: Map<string, Set<string>>;
  newProblemIds: Set<string>;
  editedProblemIds: Set<string>;
  fileContent: string;
  pendingCardFaceChanges: Record<string, string>;
  originalProblemsRef: { current: Map<string, Map<string, Problem>> };
  originalProblemsOrderRef: { current: Map<string, string[]> };
}): AiEditorRevertSnapshot {
  const origCardEntries: [string, [string, Problem][]][] = [];
  for (const [cid, inner] of opts.originalProblemsRef.current.entries()) {
    origCardEntries.push([cid, Array.from(inner.entries())]);
  }
  return {
    base: JSON.parse(JSON.stringify(opts.baseDoc)),
    nodeCardsMap: JSON.parse(JSON.stringify(opts.nodeCardsMap)),
    pendingCreatesEntries: Array.from(opts.pendingCreates.entries()),
    pendingChangesEntries: Array.from(opts.pendingChanges.entries()),
    pendingRenamesEntries: Array.from(opts.pendingRenames.entries()),
    pendingDeletesEntries: Array.from(opts.pendingDeletes.entries()),
    pendingDragChangesArr: Array.from(opts.pendingDragChanges),
    pendingPluginNodeDataIdsArr: Array.from(opts.pendingPluginNodeDataIds),
    expandedNodesArr: Array.from(opts.expandedNodes),
    pendingProblemCardIdsArr: Array.from(opts.pendingProblemCardIds),
    pendingNewProblemCardIdsArr: Array.from(opts.pendingNewProblemCardIds),
    pendingEditedProblemIdsEntries: Array.from(opts.pendingEditedProblemIds.entries()).map(([k, s]) => [k, Array.from(s)]),
    newProblemIdsArr: Array.from(opts.newProblemIds),
    editedProblemIdsArr: Array.from(opts.editedProblemIds),
    fileContent: opts.fileContent,
    originalProblemsCardEntries: origCardEntries,
    originalProblemsOrderEntries: Array.from(opts.originalProblemsOrderRef.current.entries()),
    pendingCardFaceChanges: JSON.parse(JSON.stringify(opts.pendingCardFaceChanges || {})),
  };
}

/* ------------------------------------------------------------------ */
/*  getPendingDraftCardBody                                            */
/* ------------------------------------------------------------------ */
export function getPendingDraftCardBody(card: Card, pendingChanges: Map<string, PendingChange>): string | undefined {
  const cid = String(card.docId);
  const keys = cid.startsWith('temp-card-') ? [cid, `card-${cid}`] : [`card-${cid}`, cid];
  for (const k of keys) {
    const p = pendingChanges.get(k);
    if (p?.content !== undefined && p.content !== null) return p.content;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  mergeServerNodeCardsMapWithLocalDrafts                             */
/* ------------------------------------------------------------------ */
export function mergeServerNodeCardsMapWithLocalDrafts(opts: {
  serverMap: Record<string, Card[]>;
  localMap: Record<string, Card[]>;
  pendingChanges: Map<string, PendingChange>;
  pendingRenames: Map<string, PendingRename>;
  pendingCardFaceChanges: Record<string, string>;
  pendingDragChanges: Set<string>;
  pendingCreates: Map<string, PendingCreate>;
  /** Card ids with unsubmitted problem create/edit/delete — keep local `problems[]` over server snapshot. */
  pendingProblemsMergeCardIds: Set<string>;
}): Record<string, Card[]> {
  const {
    serverMap,
    localMap,
    pendingChanges,
    pendingRenames,
    pendingCardFaceChanges,
    pendingDragChanges,
    pendingCreates,
    pendingProblemsMergeCardIds,
  } = opts;

  const out: Record<string, Card[]> = {};
  const nodeIds = new Set([...Object.keys(serverMap || {}), ...Object.keys(localMap || {})]);

  for (const nodeId of nodeIds) {
    if (String(nodeId).startsWith('temp-node-')) {
      const lc = localMap[nodeId];
      if (lc?.length) out[nodeId] = lc.map((c) => ({ ...c }));
      continue;
    }

    const serverCards = [...(serverMap[nodeId] || [])];
    const localCards = localMap[nodeId] || [];
    const localById = new Map(localCards.map((c) => [String(c.docId), c]));

    const merged: Card[] = serverCards.map((sc) => {
      const sid = String(sc.docId);
      const lc = localById.get(sid);
      let card = { ...sc } as Card;

      const draftBody = getPendingDraftCardBody(card, pendingChanges);
      if (draftBody !== undefined) card = { ...card, content: draftBody };

      const rename = pendingRenames.get(`card-${sid}`) ?? pendingRenames.get(sid);
      if (rename?.newName) card = { ...card, title: rename.newName };

      const cf = pendingCardFaceChanges[sid];
      if (cf !== undefined) card = { ...card, cardFace: cf };

      if (
        lc &&
        typeof lc.order === 'number' &&
        pendingDragChanges.has(sid)
      ) {
        card = { ...card, order: lc.order };
      }

      if (pendingProblemsMergeCardIds.has(sid) && lc && Array.isArray(lc.problems)) {
        card = { ...card, problems: lc.problems.map((pr) => ({ ...pr })) };
      }

      return card;
    });

    const seen = new Set(merged.map((c) => String(c.docId)));
    const tempLocals = localCards.filter((c) => {
      const tid = String(c.docId);
      return tid.startsWith('temp-card-') && pendingCreates.has(tid);
    });
    for (const tc of tempLocals) {
      const tid = String(tc.docId);
      if (seen.has(tid)) continue;
      seen.add(tid);
      let tcCopy = { ...tc } as Card;
      const db = getPendingDraftCardBody(tcCopy, pendingChanges);
      if (db !== undefined) tcCopy = { ...tcCopy, content: db };
      merged.push(tcCopy);
    }

    let ordered = merged;
    const needsLocalOrder = localCards.some((c) => pendingDragChanges.has(String(c.docId)));

    if (needsLocalOrder && localCards.length > 0) {
      const byId = new Map(ordered.map((c) => [String(c.docId), c]));
      const nextList: Card[] = [];
      const used = new Set<string>();
      for (const lc of localCards) {
        const id = String(lc.docId);
        const c = byId.get(id);
        if (!c || used.has(id)) continue;
        nextList.push({ ...c, order: lc.order ?? c.order ?? 0 });
        used.add(id);
      }
      for (const c of ordered) {
        const id = String(c.docId);
        if (!used.has(id)) nextList.push(c);
      }
      ordered = nextList;
    } else {
      ordered.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    out[nodeId] = ordered;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/*  migrateOrderFields                                                 */
/* ------------------------------------------------------------------ */
export function migrateOrderFields(base: BaseDoc): { base: BaseDoc; needsSave: boolean; cardUpdates: Array<{ cardId: string; nodeId: string; order: number }> } {
  const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
  let needsSave = false;
  const cardUpdates: Array<{ cardId: string; nodeId: string; order: number }> = [];

  const nodesNeedMigration = base.nodes.some(node => node.order === undefined);

  let cardsNeedMigration = false;
  for (const nodeId in nodeCardsMap) {
    const cards = nodeCardsMap[nodeId] || [];
    if (cards.some((card: Card) => card.order === undefined)) {
      cardsNeedMigration = true;
      break;
    }
  }

  if (!nodesNeedMigration && !cardsNeedMigration) {
    return { base, needsSave: false, cardUpdates: [] };
  }

  needsSave = true;

  const nodeMap = new Map<string, BaseNode>();
  base.nodes.forEach(node => {
    nodeMap.set(node.id, { ...node });
  });

  const processedNodes = new Set<string>();

  const assignOrderToChildren = (parentId: string) => {
    if (processedNodes.has(parentId)) return;
    processedNodes.add(parentId);

    const childEdges = base.edges
      .filter(e => e.source === parentId)
      .map(e => {
        const node = nodeMap.get(e.target);
        return node ? { node, edge: e } : null;
      })
      .filter(Boolean) as Array<{ node: BaseNode; edge: BaseEdge }>;

    if (childEdges.some(item => item.node.order === undefined)) {
      childEdges.forEach((item, index) => {
        if (item.node.order === undefined) {
          item.node.order = index + 1;
        }
      });
    }

    childEdges.forEach(item => {
      assignOrderToChildren(item.node.id);
    });
  };

  const rootNodes = base.nodes.filter(node =>
    !base.edges.some(edge => edge.target === node.id)
  );

  rootNodes.forEach(rootNode => {
    assignOrderToChildren(rootNode.id);
  });

  for (const nodeId in nodeCardsMap) {
    const cards = nodeCardsMap[nodeId] || [];
    const cardsNeedOrder = cards.filter((card: Card) => card.order === undefined);

    if (cardsNeedOrder.length > 0) {
      const maxOrder = cards
        .filter((card: Card) => card.order !== undefined)
        .reduce((max: number, card: Card) => Math.max(max, card.order || 0), 0);

      cardsNeedOrder.forEach((card: Card, index: number) => {
        const newOrder = maxOrder + index + 1;
        card.order = newOrder;
        cardUpdates.push({
          cardId: card.docId,
          nodeId: nodeId,
          order: newOrder,
        });
      });
    }
  }

  if (cardsNeedMigration) {
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
  }

  return {
    base: {
      ...base,
      nodes: Array.from(nodeMap.values()),
    },
    needsSave,
    cardUpdates,
  };
}

/* ------------------------------------------------------------------ */
/*  getDescendantNodeIds                                               */
/* ------------------------------------------------------------------ */
export function getDescendantNodeIds(nodeId: string, edges: BaseEdge[]): string[] {
  const children = edges.filter((e) => e.source === nodeId).map((e) => e.target);
  let desc: string[] = [];
  for (const c of children) {
    desc.push(c);
    desc = desc.concat(getDescendantNodeIds(c, edges));
  }
  return desc;
}

/* ------------------------------------------------------------------ */
/*  getAggregatedFilesForNode                                          */
/* ------------------------------------------------------------------ */
export function getAggregatedFilesForNode(
  nodeId: string,
  base: BaseDoc,
  nodeCardsMap: Record<string, Card[]>,
): AggregatedFileItem[] {
  const node = base.nodes.find((n) => n.id === nodeId);
  const descendants = getDescendantNodeIds(nodeId, base.edges);
  const result: AggregatedFileItem[] = [];
  (node?.files || []).forEach((f) => {
    result.push({
      ...f,
      sourceType: 'self',
      sourceNodeId: nodeId,
      sourceNodeText: node?.text,
    });
  });
  descendants.forEach((nid) => {
    const n = base.nodes.find((nn) => nn.id === nid);
    (n?.files || []).forEach((f) => {
      result.push({
        ...f,
        sourceType: 'node',
        sourceNodeId: nid,
        sourceNodeText: n?.text,
      });
    });
  });
  const nodeIdsToConsider = [nodeId, ...descendants];
  nodeIdsToConsider.forEach((nid) => {
    const cards = nodeCardsMap[nid] || [];
    cards.forEach((card: Card) => {
      (card.files || []).forEach((f) => {
        result.push({
          ...f,
          sourceType: 'card',
          sourceNodeId: nid,
          sourceNodeText: base.nodes.find((nn) => nn.id === nid)?.text,
          sourceCardId: card.docId,
          sourceCardTitle: card.title,
        });
      });
    });
  });
  return result;
}

/* ------------------------------------------------------------------ */
/*  collectDirectNodeFiles                                             */
/* ------------------------------------------------------------------ */
export function collectDirectNodeFiles(
  nodeId: string,
  viewRootId: string,
  base: BaseDoc,
  nodeCardsMap: Record<string, Card[]>,
): AggregatedFileItem[] {
  const node = base.nodes.find((n) => n.id === nodeId);
  const result: AggregatedFileItem[] = [];
  (node?.files || []).forEach((f) => {
    result.push({
      ...f,
      sourceType: nodeId === viewRootId ? 'self' : 'node',
      sourceNodeId: nodeId,
      sourceNodeText: node?.text,
    });
  });
  (nodeCardsMap[nodeId] || []).forEach((card: Card) => {
    (card.files || []).forEach((f) => {
      result.push({
        ...f,
        sourceType: 'card',
        sourceNodeId: nodeId,
        sourceNodeText: node?.text,
        sourceCardId: card.docId,
        sourceCardTitle: card.title,
      });
    });
  });
  return result;
}

/* ------------------------------------------------------------------ */
/*  buildChildNodeFileFolder / buildNodeFileFolderTree                  */
/* ------------------------------------------------------------------ */
export function buildChildNodeFileFolder(
  nodeId: string,
  viewRootId: string,
  base: BaseDoc,
  nodeCardsMap: Record<string, Card[]>,
): NodeFileFolder | null {
  const node = base.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const files = collectDirectNodeFiles(nodeId, viewRootId, base, nodeCardsMap);
  const childIds = base.edges.filter((e) => e.source === nodeId).map((e) => e.target);
  const subfolders = childIds
    .map((cid) => buildChildNodeFileFolder(cid, viewRootId, base, nodeCardsMap))
    .filter(Boolean) as NodeFileFolder[];
  subfolders.sort((a, b) => {
    const oa = base.nodes.find((n) => n.id === a.nodeId)?.order || 0;
    const ob = base.nodes.find((n) => n.id === b.nodeId)?.order || 0;
    return oa - ob;
  });
  return {
    nodeId,
    nodeText: node.text || nodeId,
    order: node.order || 0,
    files,
    subfolders,
  };
}

export function buildNodeFileFolderTree(
  viewRootId: string,
  base: BaseDoc,
  nodeCardsMap: Record<string, Card[]>,
): { selfFiles: AggregatedFileItem[]; subfolders: NodeFileFolder[] } {
  const selfFiles = collectDirectNodeFiles(viewRootId, viewRootId, base, nodeCardsMap);
  const childIds = base.edges.filter((e) => e.source === viewRootId).map((e) => e.target);
  const subfolders = childIds
    .map((cid) => {
      const childNode = base.nodes.find((n) => n.id === cid);
      const folder = buildChildNodeFileFolder(cid, viewRootId, base, nodeCardsMap);
      if (!folder) return null;
      return { ...folder, order: childNode?.order || 0 };
    })
    .filter(Boolean)
    .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as NodeFileFolder[];
  return { selfFiles, subfolders };
}

/* ------------------------------------------------------------------ */
/*  flattenNodeFileFolderTree                                          */
/* ------------------------------------------------------------------ */
export function flattenNodeFileFolderTree(
  selfFiles: AggregatedFileItem[],
  subfolders: NodeFileFolder[],
): AggregatedFileItem[] {
  const result = [...selfFiles];
  for (const folder of subfolders) {
    result.push(...folder.files, ...flattenNodeFileFolderTree([], folder.subfolders));
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  sortAggregatedFiles                                                */
/* ------------------------------------------------------------------ */
export function sortAggregatedFiles(
  files: AggregatedFileItem[],
  sortBy: 'name' | 'size' | 'time' | 'source',
  sortOrder: 'asc' | 'desc',
): AggregatedFileItem[] {
  const ord = sortOrder === 'asc' ? 1 : -1;
  const sourceSortKey = (row: AggregatedFileItem) =>
    row.sourceType === 'self' ? '0' : row.sourceType === 'node' ? `1${row.sourceNodeText || row.sourceNodeId}` : `2${row.sourceCardTitle || row.sourceCardId || ''}`;
  const timeMs = (row: AggregatedFileItem) => {
    const v = row.lastModified;
    if (!v) return 0;
    return (typeof v === 'string' ? new Date(v) : v).getTime();
  };
  return [...files].sort((a, b) => {
    if (sortBy === 'name') return ord * (a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (sortBy === 'size') return ord * (a.size - b.size);
    if (sortBy === 'time') return ord * (timeMs(a) - timeMs(b));
    return ord * sourceSortKey(a).localeCompare(sourceSortKey(b));
  });
}

/* ------------------------------------------------------------------ */
/*  applyFileMoveLocally                                               */
/* ------------------------------------------------------------------ */
export function applyFileMoveLocally(
  baseDoc: BaseDoc,
  nodeCardsMap: Record<string, Card[]>,
  row: AggregatedFileItem,
  targetNodeId: string,
): { base: BaseDoc; nodeCardsMap: Record<string, Card[]> } {
  const fileMeta: CardFileInfo = {
    name: row.name,
    size: row.size,
    lastModified: row.lastModified,
    _id: (row as any)._id || row.name,
    etag: (row as any).etag,
  };
  let newMap = { ...nodeCardsMap };
  let newNodes = baseDoc.nodes.map((n) => ({ ...n }));

  if (row.sourceType === 'card' && row.sourceCardId) {
    newMap = Object.fromEntries(
      Object.entries(newMap).map(([nid, cards]) => [
        nid,
        cards.map((c) =>
          String(c.docId) === String(row.sourceCardId)
            ? { ...c, files: (c.files || []).filter((f) => f.name !== row.name) }
            : c,
        ),
      ]),
    );
  } else {
    newNodes = newNodes.map((n) =>
      n.id === row.sourceNodeId ? { ...n, files: (n.files || []).filter((f) => f.name !== row.name) } : n,
    );
  }

  newNodes = newNodes.map((n) =>
    n.id === targetNodeId ? { ...n, files: [...(n.files || []), fileMeta] } : n,
  );

  return { base: { ...baseDoc, nodes: newNodes }, nodeCardsMap: newMap };
}

/* ------------------------------------------------------------------ */
/*  resolveEditorRootNodeId / canDropFileOnNode                        */
/* ------------------------------------------------------------------ */
export function resolveEditorRootNodeId(base: BaseDoc, editorRootNodeId?: string): string {
  if (editorRootNodeId && base.nodes.some((n) => n.id === editorRootNodeId)) return editorRootNodeId;
  return base.nodes.find((n) => !base.edges.some((e) => e.target === n.id))?.id || '';
}

export function canDropFileOnNode(row: AggregatedFileItem, targetNodeId: string): boolean {
  return row.sourceType === 'card' || row.sourceNodeId !== targetNodeId;
}

/* ------------------------------------------------------------------ */
/*  setBaseEditorFileDragImage                                         */
/* ------------------------------------------------------------------ */
let baseEditorFileDragGhost: HTMLDivElement | null = null;

export function setBaseEditorFileDragImage(
  e: React.DragEvent,
  fileName: string,
  styles: { bg: string; color: string; border: string },
) {
  if (typeof document === 'undefined') return;
  if (!baseEditorFileDragGhost) {
    baseEditorFileDragGhost = document.createElement('div');
    document.body.appendChild(baseEditorFileDragGhost);
  }
  baseEditorFileDragGhost.textContent = fileName;
  Object.assign(baseEditorFileDragGhost.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    padding: '6px 12px',
    background: styles.bg,
    color: styles.color,
    border: `1px solid ${styles.border}`,
    borderRadius: '4px',
    fontSize: '13px',
    fontWeight: '500',
    maxWidth: '320px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    zIndex: '99999',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
  });
  e.dataTransfer.setDragImage(baseEditorFileDragGhost, 12, 16);
}

/* ------------------------------------------------------------------ */
/*  readSavedBaseEditorUiPrefs                                         */
/* ------------------------------------------------------------------ */
function baseEditorUiPrefsLocalStorageKey(): string | null {
  if (typeof window === 'undefined') return null;
  const ctx = (window as any).UiContext || {};
  const domainId = String(ctx.domainId || 'system');
  const docId = String(ctx.base?.docId || ctx.baseDocId || '').trim();
  const branch = String(ctx.currentBranch || 'main').trim() || 'main';
  if (!docId) return null;
  return `baseEditorUiPrefs:${domainId}:${docId}:${branch}`;
}

function readLocalBaseEditorUiPrefs(): Record<string, unknown> | null {
  const key = baseEditorUiPrefsLocalStorageKey();
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSavedBaseEditorUiPrefsLocal(prefs: Record<string, unknown> | null | undefined): void {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return;
  const key = baseEditorUiPrefsLocalStorageKey();
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function readSavedBaseEditorUiPrefs(editorAiHidden: boolean): SavedEditorLayout {
  const serverRaw =
    (typeof window !== 'undefined' && (window as any).UiContext?.baseEditorUiPrefs) || null;
  const localRaw = readLocalBaseEditorUiPrefs();
  const raw = {
    ...((serverRaw && typeof serverRaw === 'object' && !Array.isArray(serverRaw)) ? serverRaw : {}),
    ...((localRaw && typeof localRaw === 'object' && !Array.isArray(localRaw)) ? localRaw : {}),
  };
  const modes = new Set(['tree', 'pending', 'branches', 'git', 'mcp']);
  const nodeTabs = new Set(['intent', 'files', 'develop_queue']);
  const rightTabs = new Set(['problems', 'develop_queue', 'plugin_node', 'plugin_mcp_services', 'roadmap_edge']);

  let explorerMode: SavedEditorLayout['explorerMode'] = 'tree';
  if (raw && typeof raw.explorerMode === 'string') {
    const rawMode = raw.explorerMode === 'training' ? 'tree' : raw.explorerMode;
    if (modes.has(rawMode)) explorerMode = rawMode as SavedEditorLayout['explorerMode'];
  }

  let nodeSidePanelTab: SavedEditorLayout['nodeSidePanelTab'] = 'intent';
  if (raw && typeof raw.nodeSidePanelTab === 'string' && nodeTabs.has(raw.nodeSidePanelTab)) {
    nodeSidePanelTab = raw.nodeSidePanelTab as SavedEditorLayout['nodeSidePanelTab'];
  }

  let editorRightPanelTab: EditorRightPanelTab = 'problems';
  if (raw && typeof raw.editorRightPanelTab === 'string' && rightTabs.has(raw.editorRightPanelTab)) {
    editorRightPanelTab = raw.editorRightPanelTab as EditorRightPanelTab;
  }

  let rightPanelOpen = true;
  if (raw && typeof raw.rightPanelOpen === 'boolean') {
    rightPanelOpen = raw.rightPanelOpen;
  }

  let aiBottomOpen = !editorAiHidden;
  if (!editorAiHidden && raw && typeof raw.aiBottomOpen === 'boolean') {
    aiBottomOpen = raw.aiBottomOpen;
  }

  let explorerPanelWidth = 250;
  if (raw && typeof raw.explorerPanelWidth === 'number' && Number.isFinite(raw.explorerPanelWidth)) {
    explorerPanelWidth = Math.round(Math.max(180, Math.min(640, raw.explorerPanelWidth)));
  }

  let problemsPanelWidth = 320;
  if (raw && typeof raw.problemsPanelWidth === 'number' && Number.isFinite(raw.problemsPanelWidth)) {
    problemsPanelWidth = Math.round(Math.max(200, Math.min(800, raw.problemsPanelWidth)));
  }

  let aiPanelHeight = 280;
  if (raw && typeof raw.aiPanelHeight === 'number' && Number.isFinite(raw.aiPanelHeight)) {
    aiPanelHeight = Math.round(Math.max(120, Math.min(640, raw.aiPanelHeight)));
  }

  return {
    explorerMode,
    nodeSidePanelTab,
    editorRightPanelTab,
    rightPanelOpen,
    aiBottomOpen,
    explorerPanelWidth,
    problemsPanelWidth,
    aiPanelHeight,
  };
}

/* ------------------------------------------------------------------ */
/*  normDevelopBranch / resolveDevelopQueueRowStats / developQueueGoalCaption */
/* ------------------------------------------------------------------ */
export function normDevelopBranch(b: string | undefined): string {
  return typeof b === 'string' && b.trim() ? b.trim() : 'main';
}

export function resolveDevelopQueueRowStats(
  ctx: DevelopEditorContextWire,
  baseDocId: number,
  branch: string,
): {
  baseTitle: string;
  dailyNodeGoal: number;
  dailyCardGoal: number;
  dailyProblemGoal: number;
  todayNodes: number;
  todayCards: number;
  todayProblems: number;
} {
  const br = normDevelopBranch(branch);
  const c = ctx.current;
  if (c.baseDocId === baseDocId && normDevelopBranch(c.branch) === br) {
    return {
      baseTitle: c.baseTitle,
      dailyNodeGoal: c.dailyNodeGoal,
      dailyCardGoal: c.dailyCardGoal,
      dailyProblemGoal: c.dailyProblemGoal,
      todayNodes: c.todayNodes,
      todayCards: c.todayCards,
      todayProblems: c.todayProblems,
    };
  }
  const o = ctx.othersIncomplete.find(
    (r) => r.baseDocId === baseDocId && normDevelopBranch(r.branch) === br,
  );
  if (o) {
    return {
      baseTitle: o.baseTitle,
      dailyNodeGoal: o.dailyNodeGoal,
      dailyCardGoal: o.dailyCardGoal,
      dailyProblemGoal: o.dailyProblemGoal,
      todayNodes: o.todayNodes,
      todayCards: o.todayCards,
      todayProblems: o.todayProblems,
    };
  }
  return {
    baseTitle: `Base ${baseDocId}`,
    dailyNodeGoal: 0,
    dailyCardGoal: 0,
    dailyProblemGoal: 0,
    todayNodes: 0,
    todayCards: 0,
    todayProblems: 0,
  };
}

export function developQueueGoalCaption(cur: number, goal: number, unsetLabel: string): string {
  if (goal > 0) return `${cur}/${goal}`;
  return `${cur}/${unsetLabel}`;
}

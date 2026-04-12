import $ from 'jquery';
import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, startTransition } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request, i18n, tpl } from 'vj/utils';
import Editor from 'vj/components/editor';
import { Dialog, ActionDialog } from 'vj/components/dialog/index';
import uploadFiles from 'vj/components/upload';
import { nanoid } from 'nanoid';
import { jsonrepair } from 'jsonrepair';
import type {
  Problem,
  ProblemSingle,
  ProblemMulti,
  ProblemTrueFalse,
  ProblemFlip,
  ProblemKind,
} from 'ejun/src/interface';
import {
  problemKind,
  problemChangeKind,
  clampOptionSlots,
  ensureOptionArrayLength,
  normalizeMultiAnswers,
  migrateRawProblem,
  isMultiProblem,
} from 'ejun/src/model/problem';
interface BaseNode {
  id: string;
  text: string;
  x?: number;
  y?: number;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond';
  parentId?: string;
  children?: string[];
  expanded?: boolean;
  order?: number;
  files?: CardFileInfo[];
}

interface BaseEdge {
  id: string;
  source: string;
  target: string;
}

/** Aggregated file item for inheritance: file + source (self / descendant node / card) */
interface AggregatedFileItem extends CardFileInfo {
  sourceType: 'self' | 'node' | 'card';
  sourceNodeId: string;
  sourceNodeText?: string;
  sourceCardId?: string;
  sourceCardTitle?: string;
}

interface BaseDoc {
  docId?: string;
  bid?: number;
  title?: string;
  content?: string;
  nodes: BaseNode[];
  edges: BaseEdge[];
  currentBranch?: string;
  branches?: string[];
  files?: Array<{ _id: string; name: string; size: number; etag?: string; lastModified?: Date | string }>;
}

interface CardFileInfo {
  _id: string;
  name: string;
  size: number;
  lastModified?: Date | string;
}

interface Card {
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

type FileItem = {
  type: 'node' | 'card';
  id: string;
  name: string;
  nodeId?: string;
  cardId?: string;
  parentId?: string;
  level: number;
  hasPendingChanges?: boolean; 
  clipboardType?: 'copy' | 'cut'; 
};

interface PendingChange {
  file: FileItem;
  content: string;
  originalContent: string;
}

type ExecuteAiOpsFn = (
  operations: any[],
  execOpts?: { quiet?: boolean },
) => Promise<{ success: boolean; errors: string[] }>;

/** Card `docId` may be numeric from API while `FileItem.cardId` is string — use for lookups. */
function sameCardDocId(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/** Prose outside ```json fences only (not generic ``` code blocks). */
function splitAiAssistantStream(accumulated: string): {
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

function extractAiOperationTypesPartial(partial: string): string[] {
  const types: string[] = [];
  const re = /"type"\s*:\s*"([a-z_]+)"/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(partial)) !== null) {
    types.push(mm[1]);
  }
  return types;
}

function friendlyAiOperationLabel(t: string): string {
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

/** Balanced `{...}` from `start` (JSON string rules). Returns parsed object or null if incomplete/invalid. */
function extractNextJsonObject(s: string, start: number): { raw: string; next: number } | null {
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

/** Parse complete `operations[]` entries from a streaming/partial ```json body. */
function extractParsedOperationsFromPartialFence(fenceBody: string): any[] {
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

function summarizeAiOperationOneLine(op: any): string {
  const t = op?.type;
  if (!t) return '(unknown operation)';
  const short = (x: unknown, max = 12) => {
    const s = x != null ? String(x) : '';
    if (!s) return '—';
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  switch (t) {
    case 'create_node':
      return `Create node "${String(op.text || '').slice(0, 40)}${String(op.text || '').length > 40 ? '…' : ''}" under ${short(op.parentId)}`;
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
    case 'create_problem':
      return `Create ${String(op.problemKind || 'single')} problem on card ${short(op.cardId)}`;
    default:
      return String(t);
  }
}

/** Walk parent links (edges target→source, else `parentId`) for expand-to-deep-link. */
function collectOutlineAncestors(nodeId: string, nodes: BaseNode[], edges: BaseEdge[]): string[] {
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

/** Line-ending normalization so save/switch does not treat CRLF as unsaved edits. */
function normalizeCardContentForCompare(s: string | undefined | null): string {
  return String(s ?? '').replace(/\r\n/g, '\n');
}

interface PendingRename {
  file: FileItem;
  newName: string;
  originalName: string;
}

interface PendingCreate {
  type: 'card' | 'node';
  nodeId: string;
  title?: string;
  text?: string;
  tempId: string;
}

interface PendingDelete {
  type: 'card' | 'node';
  id: string;
  nodeId?: string;
}

function baseProblemJsonStable(a: Problem, b: Problem): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function problemKindLabelI18n(k: ProblemKind): string {
  switch (k) {
    case 'single':
      return i18n('Problem kind single');
    case 'multi':
      return i18n('Problem kind multi');
    case 'true_false':
      return i18n('Problem kind true false');
    case 'flip':
      return i18n('Problem kind flip');
    default:
      return k;
  }
}

// Editable problem item（单选 / 多选 / 判断 / 翻转）
const EditableProblem = React.memo(({
  problem,
  index,
  cardId: _cardId,
  borderColor,
  borderStyle,
  isNew,
  isEdited,
  originalProblem: _originalProblem,
  onUpdate,
  onDelete,
  docId,
  getBaseUrl,
  themeStyles,
}: {
  problem: Problem;
  index: number;
  cardId: string;
  borderColor: string;
  borderStyle: string;
  isNew: boolean;
  isEdited: boolean;
  originalProblem?: Problem;
  onUpdate: (updated: Problem) => void;
  onDelete: () => void;
  docId: string;
  getBaseUrl: (path: string, docId: string) => string;
  themeStyles: any;
}) => {
  const [model, setModel] = useState<Problem>(problem);

  useEffect(() => {
    setModel(problem);
  }, [problem.pid]);

  useEffect(() => {
    if (baseProblemJsonStable(model, problem)) return;
    onUpdate(model);
  }, [model, problem, onUpdate]);

  const kind = problemKind(model);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const imageUrl = model.imageUrl || '';
  const imageNote = model.imageNote || '';
  const analysis = model.analysis || '';

  const setCommon = (patch: Partial<Pick<Problem, 'imageUrl' | 'imageNote' | 'analysis'>>) => {
    setModel((m) => ({ ...m, ...patch } as Problem));
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    let ext: string;
    const matches = file.type.match(/^image\/(png|jpg|jpeg|gif)$/i);
    if (matches) {
      [, ext] = matches;
    } else {
      Notification.error(i18n('Unsupported file type. Please upload an image (png, jpg, jpeg, gif).'));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setIsUploading(true);
    try {
      const filename = `${nanoid()}.${ext}`;
      await uploadFiles(getBaseUrl('/files', docId), [file], {
        filenameCallback: () => filename,
      });
      const url = getBaseUrl(`/${docId}/file/${encodeURIComponent(filename)}`, docId);
      setCommon({ imageUrl: url });
    } catch (error: any) {
      Notification.error(`${i18n('Image upload failed')}: ${error.message || i18n('Unknown error')}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handlePreviewImage = async () => {
    if (!imageUrl) return;
    try {
      const { InfoDialog } = await import('vj/components/dialog/index');
      const $ = (await import('jquery')).default;
      const { nanoid: nid } = await import('nanoid');
      const { tpl } = await import('vj/utils');
      const id = nid();
      const dialog = new InfoDialog({
        $body: tpl`<div class="typo"><img src="${imageUrl}" style="max-height: calc(80vh - 45px);"></img></div>`,
        $action: [
          tpl`<button class="rounded button" data-action="copy" id="copy-${id}">${i18n('Copy link')}</button>`,
          tpl`<button class="rounded button" data-action="cancel">${i18n('Cancel')}</button>`,
          tpl`<button class="primary rounded button" data-action="download">${i18n('Download')}</button>`,
        ],
      });
      $(`#copy-${id}`).on('click', () => {
        navigator.clipboard.writeText(imageUrl).then(() => {
          Notification.success(i18n('Link copied to clipboard'));
        });
      });
      const action = await dialog.open();
      if (action === 'download') window.open(imageUrl, '_blank');
    } catch (error) {
      console.error('预览图片失败:', error);
      Notification.error(i18n('Image preview failed'));
    }
  };

  const onKindChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const k = e.target.value as ProblemKind;
    if (k === problemKind(model)) return;
    setModel((m) => problemChangeKind(m, k));
  };

  const optionSlotsNow = (): number => {
    if (kind === 'single') {
      const m = model as ProblemSingle;
      return clampOptionSlots(m.optionSlots ?? m.options?.length);
    }
    if (kind === 'multi') {
      const m = model as ProblemMulti;
      return clampOptionSlots(m.optionSlots ?? m.options?.length);
    }
    return 4;
  };

  const applyOptionSlots = (raw: number) => {
    const slots = clampOptionSlots(raw);
    if (kind === 'single') {
      const m = model as ProblemSingle;
      const opts = ensureOptionArrayLength([...m.options], slots);
      let ans = m.answer;
      if (ans >= opts.length) ans = Math.max(0, opts.length - 1);
      setModel({ ...m, options: opts, optionSlots: slots, answer: ans });
    } else if (kind === 'multi') {
      const m = model as ProblemMulti;
      const opts = ensureOptionArrayLength([...m.options], slots);
      const cur = normalizeMultiAnswers(m.answer).filter((i) => i < opts.length);
      const nextAns = cur.length ? cur : [0];
      setModel({ ...m, options: opts, optionSlots: slots, answer: nextAns });
    }
  };

  const toggleMultiAnswer = (oi: number) => {
    const m = model as ProblemMulti;
    const cur = new Set(normalizeMultiAnswers(m.answer));
    if (cur.has(oi)) cur.delete(oi);
    else cur.add(oi);
    const arr = [...cur].sort((a, b) => a - b);
    setModel({ ...m, answer: arr.length ? arr : [oi] });
  };

  const taStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '40px',
    resize: 'vertical' as const,
    fontSize: '12px',
    padding: '4px 6px',
    boxSizing: 'border-box',
    border: `1px solid ${themeStyles.borderPrimary}`,
    borderRadius: '2px',
    backgroundColor: themeStyles.bgPrimary,
    color: themeStyles.textPrimary,
  };
  const inpStyle: React.CSSProperties = {
    fontSize: '12px',
    padding: '3px 6px',
    boxSizing: 'border-box',
    border: `1px solid ${themeStyles.borderPrimary}`,
    borderRadius: '2px',
    backgroundColor: themeStyles.bgPrimary,
    color: themeStyles.textPrimary,
  };

  return (
    <div
      style={{
        border: `1px ${borderStyle} ${borderColor}`,
        borderRadius: '4px',
        padding: '6px 8px',
        marginBottom: '6px',
        background: themeStyles.bgPrimary,
        position: 'relative',
      }}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        style={{
          position: 'absolute',
          top: '4px',
          right: '4px',
          width: '20px',
          height: '20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          borderRadius: '3px',
          backgroundColor: '#f44336',
          color: '#fff',
          fontSize: '12px',
          fontWeight: 'bold',
          userSelect: 'none',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#d32f2f';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#f44336';
        }}
        title={i18n('Delete problem')}
      >
        ×
      </div>
      <div style={{
        fontSize: '12px',
        fontWeight: 500,
        marginBottom: '6px',
        paddingRight: '24px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
      }}
      >
        <span>
          Q{index + 1}
          （
          {problemKindLabelI18n(kind)}
          ）
        </span>
        <label style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: 4, color: themeStyles.textPrimary }}>
          {i18n('Problem field type')}
          <select value={kind} onChange={onKindChange} style={{ ...inpStyle, minWidth: 88 }}>
            <option value="single">{i18n('Problem kind single')}</option>
            <option value="multi">{i18n('Problem kind multi')}</option>
            <option value="true_false">{i18n('Problem kind true false')}</option>
            <option value="flip">{i18n('Problem kind flip')}</option>
          </select>
        </label>
        {isNew && <span style={{ fontSize: '10px', color: themeStyles.success }}>{i18n('New')}</span>}
        {isEdited && !isNew && <span style={{ fontSize: '10px', color: themeStyles.warning }}>{i18n('Edited')}</span>}
      </div>

      {kind === 'flip' ? (
        <>
          <div style={{ marginBottom: '4px' }}>
            <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 2 }}>{i18n('Problem face A label')}</div>
            <textarea
              value={(model as ProblemFlip).faceA}
              onChange={(e) => setModel({ ...(model as ProblemFlip), faceA: e.target.value })}
              placeholder={i18n('Problem face A placeholder')}
              style={taStyle}
            />
          </div>
          <div style={{ marginBottom: '4px' }}>
            <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 2 }}>{i18n('Problem face B label')}</div>
            <textarea
              value={(model as ProblemFlip).faceB}
              onChange={(e) => setModel({ ...(model as ProblemFlip), faceB: e.target.value })}
              placeholder={i18n('Problem face B placeholder')}
              style={taStyle}
            />
          </div>
        </>
      ) : kind === 'true_false' ? (
        <div style={{ marginBottom: '4px' }}>
          <textarea
            value={(model as ProblemTrueFalse).stem}
            onChange={(e) => setModel({ ...(model as ProblemTrueFalse), stem: e.target.value })}
            placeholder={i18n('Stem')}
            style={taStyle}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, fontSize: 12, color: themeStyles.textPrimary }}>
            <span>{i18n('Correct answer')}:</span>
            <label style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name={`tf-${problem.pid}`}
                checked={(model as ProblemTrueFalse).answer === 1}
                onChange={() => setModel({ ...(model as ProblemTrueFalse), answer: 1 })}
                style={{ marginRight: 4 }}
              />
              {i18n('Problem answer true')}
            </label>
            <label style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name={`tf-${problem.pid}`}
                checked={(model as ProblemTrueFalse).answer === 0}
                onChange={() => setModel({ ...(model as ProblemTrueFalse), answer: 0 })}
                style={{ marginRight: 4 }}
              />
              {i18n('Problem answer false')}
            </label>
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: '4px' }}>
            <textarea
              value={kind === 'single' ? (model as ProblemSingle).stem : (model as ProblemMulti).stem}
              onChange={(e) => {
                if (kind === 'single') setModel({ ...(model as ProblemSingle), stem: e.target.value });
                else setModel({ ...(model as ProblemMulti), stem: e.target.value });
              }}
              placeholder={i18n('Stem')}
              style={taStyle}
            />
          </div>
          <div style={{ marginBottom: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: 8, color: themeStyles.textPrimary }}>
            <span>{i18n('Problem option slots')}</span>
            <select
              value={optionSlotsNow()}
              onChange={(e) => applyOptionSlots(parseInt(e.target.value, 10))}
              style={{ ...inpStyle, minWidth: 52 }}
            >
              {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            {kind === 'multi' && (
              <span style={{ color: themeStyles.textSecondary }}>{i18n('Problem multi all correct')}</span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginBottom: '4px' }}>
            {(kind === 'single' ? (model as ProblemSingle).options : (model as ProblemMulti).options).map((opt, oi) => (
              <input
                key={oi}
                value={opt}
                onChange={(e) => {
                  if (kind === 'single') {
                    const m = model as ProblemSingle;
                    const next = [...m.options];
                    next[oi] = e.target.value;
                    setModel({ ...m, options: next });
                  } else {
                    const m = model as ProblemMulti;
                    const next = [...m.options];
                    next[oi] = e.target.value;
                    setModel({ ...m, options: next });
                  }
                }}
                placeholder={`${i18n('Option')} ${String.fromCharCode(65 + oi)}`}
                style={inpStyle}
              />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px', fontSize: '12px', color: themeStyles.textPrimary, flexWrap: 'wrap', gap: 4 }}>
            <span style={{ marginRight: 4 }}>{i18n('Correct answer')}:</span>
            {kind === 'single'
              ? (model as ProblemSingle).options.map((_, oi) => (
                <label key={oi} style={{ marginRight: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name={`problem-answer-${problem.pid}`}
                    checked={(model as ProblemSingle).answer === oi}
                    onChange={() => setModel({ ...(model as ProblemSingle), answer: oi })}
                    style={{ marginRight: 2 }}
                  />
                  {String.fromCharCode(65 + oi)}
                </label>
              ))
              : (model as ProblemMulti).options.map((_, oi) => (
                <label key={oi} style={{ marginRight: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={normalizeMultiAnswers((model as ProblemMulti).answer).includes(oi)}
                    onChange={() => toggleMultiAnswer(oi)}
                    style={{ marginRight: 2 }}
                  />
                  {String.fromCharCode(65 + oi)}
                </label>
              ))}
          </div>
        </>
      )}

      <div style={{ marginBottom: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: imageUrl ? '4px' : '0' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
            onChange={handleImageUpload}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            style={{
              padding: '2px 8px',
              fontSize: '11px',
              borderRadius: '3px',
              border: `1px solid ${themeStyles.accent}`,
              background: isUploading ? themeStyles.textTertiary : themeStyles.accent,
              color: themeStyles.textOnPrimary,
              cursor: isUploading ? 'not-allowed' : 'pointer',
            }}
          >
            {isUploading ? i18n('Uploading...') : i18n('Upload image')}
          </button>
          {imageUrl ? (
            <button
              type="button"
              onClick={handlePreviewImage}
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                borderRadius: '3px',
                border: `1px solid ${themeStyles.success}`,
                background: themeStyles.success,
                color: themeStyles.textOnPrimary,
                cursor: 'pointer',
              }}
            >
              {i18n('Preview image')}
            </button>
          ) : null}
        </div>
        {imageUrl ? (
          <div style={{ marginTop: '4px' }}>
            <input
              type="text"
              value={imageNote}
              onChange={(e) => setCommon({ imageNote: e.target.value })}
              placeholder={i18n('Image note (optional)')}
              style={{ width: '100%', fontSize: '11px', padding: '3px 6px', boxSizing: 'border-box', ...inpStyle }}
            />
          </div>
        ) : null}
      </div>
      <div style={{ marginBottom: '4px' }}>
        <textarea
          value={analysis}
          onChange={(e) => setCommon({ analysis: e.target.value || undefined })}
          placeholder={i18n('Analysis (optional)')}
          style={{ ...taStyle, minHeight: '32px' }}
        />
      </div>
    </div>
  );
});

// Sort window
function SortWindow({ 
  nodeId, 
  base, 
  docId,
  getBaseUrl,
  onClose, 
  onSave,
  nodeCardsMapVersion,
  themeStyles,
  theme
}: { 
  nodeId: string; 
  base: BaseDoc; 
  docId: string;
  getBaseUrl: (path: string, docId: string) => string;
  onClose: () => void; 
  onSave: (sortedItems: Array<{ type: 'node' | 'card'; id: string; order: number }>) => Promise<void>;
  nodeCardsMapVersion?: number;
  themeStyles: any;
  theme: 'light' | 'dark';
}) {
  const [draggedItem, setDraggedItem] = useState<{ type: 'node' | 'card'; id: string; index: number } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  
  const getNodeDisplayName = useCallback((node: BaseNode) => {
    const raw = node.text ?? (node as any).label ?? (node as any).name;
    return (raw != null && String(raw).trim() !== '') ? String(raw).trim() : i18n('Unnamed Node');
  }, []);
  const childNodes = useMemo(() => {
    return base.edges
      .filter(e => e.source === nodeId)
      .map(e => {
        const node = base.nodes.find(n => n.id === e.target);
        return node ? { 
          id: node.id, 
          name: getNodeDisplayName(node),
          order: node.order || 0,
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; name: string; order: number }>;
  }, [base.edges, base.nodes, nodeId, getNodeDisplayName]);
  
  const cards = useMemo(() => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = (nodeCardsMap[nodeId] || [])
      .filter((card: Card) => !card.nodeId || card.nodeId === nodeId)
      .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    return nodeCards.map((card: Card) => ({
      id: card.docId,
      name: card.title || i18n('Unnamed Card'),
      order: card.order || 0,
    }));
  }, [nodeId, nodeCardsMapVersion]); 
  
  
  const [items, setItems] = useState<Array<{ type: 'node' | 'card'; id: string; name: string; order: number }>>(() => {
    const allItems: Array<{ type: 'node' | 'card'; id: string; name: string; order: number }> = [
      ...childNodes.map(n => ({ type: 'node' as const, id: n.id, name: n.name, order: n.order })),
      ...cards.map(c => ({ type: 'card' as const, id: c.id, name: c.name, order: c.order })),
    ];
    return allItems.sort((a, b) => (a.order || 0) - (b.order || 0));
  });
  
  useEffect(() => {
    const allItems: Array<{ type: 'node' | 'card'; id: string; name: string; order: number }> = [
      ...childNodes.map(n => ({ type: 'node' as const, id: n.id, name: n.name, order: n.order })),
      ...cards.map(c => ({ type: 'card' as const, id: c.id, name: c.name, order: c.order })),
    ];
    
    setItems(allItems.sort((a, b) => (a.order || 0) - (b.order || 0)));
  }, [childNodes, cards]);
  
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedItem({ type: items[index].type, id: items[index].id, index });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', '');
  };
  
  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedItem && draggedItem.index !== index) {
      setDragOverIndex(index);
    }
  };
  
  const handleDragLeave = () => {
    setDragOverIndex(null);
  };
  
  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (!draggedItem || draggedItem.index === index) {
      setDragOverIndex(null);
      setDraggedItem(null);
      return;
    }
    
    const newItems = [...items];
    const [removed] = newItems.splice(draggedItem.index, 1);
    newItems.splice(index, 0, removed);
    setItems(newItems);
    
    setDragOverIndex(null);
    setDraggedItem(null);
  };
  
  const handleDragEnd = () => {
    setDragOverIndex(null);
    setDraggedItem(null);
  };
  
  const handleSave = async () => {
    const sortedItems: Array<{ type: 'node' | 'card'; id: string; order: number }> = [];
    
    for (let i = 0; i < items.length; i++) {
      sortedItems.push({
        type: items[i].type,
        id: items[i].id,
        order: i + 1,
      });
    }
    
    await onSave(sortedItems);
  };
  
  const currentNode = base.nodes.find(n => n.id === nodeId);
  
  return (
    <>
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 2000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      >
        <div
          style={{
            backgroundColor: themeStyles.bgPrimary,
            borderRadius: '8px',
            padding: '20px',
            minWidth: '500px',
            maxWidth: '80%',
            maxHeight: '80%',
            overflow: 'auto',
            boxShadow: theme === 'dark' ? '0 4px 20px rgba(0,0,0,0.5)' : '0 4px 20px rgba(0,0,0,0.3)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: themeStyles.textPrimary }}>
              {i18n('Sort')}: {currentNode?.text || i18n('Unnamed Node')}
            </h3>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '20px',
                cursor: 'pointer',
                color: themeStyles.textTertiary,
                padding: '0',
                width: '24px',
                height: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ×
            </button>
          </div>
          
          <div style={{ marginBottom: '16px', fontSize: '13px', color: themeStyles.textTertiary }}>
            {i18n('Drag items to reorder')}
          </div>
          
          <div style={{ marginBottom: '16px' }}>
            {items.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: themeStyles.textTertiary }}>
                {i18n('No child nodes or cards')}
              </div>
            ) : (
              items.map((item, index) => (
                <div
                  key={`${item.type}-${item.id}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  style={{
                    padding: '12px',
                    marginBottom: '8px',
                    backgroundColor: dragOverIndex === index ? themeStyles.bgDragOver : draggedItem?.index === index ? themeStyles.bgDragged : themeStyles.bgPrimary,
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    borderRadius: '4px',
                    cursor: 'move',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    opacity: draggedItem?.index === index ? 0.5 : 1,
                    transition: 'background-color 0.2s',
                  }}
                >
                  <div style={{ fontSize: '18px', color: themeStyles.textTertiary }}>⋮⋮</div>
                  <div style={{ 
                    padding: '2px 8px', 
                    borderRadius: '3px', 
                    fontSize: '12px',
                    backgroundColor: item.type === 'node' ? themeStyles.accent : themeStyles.success,
                    color: themeStyles.textOnPrimary,
                    fontWeight: '500',
                  }}>
                    {item.type === 'node' ? 'Node' : 'Card'}
                  </div>
                  <div style={{ flex: 1, fontSize: '14px', color: themeStyles.textPrimary }}>
                    {item.name}
                  </div>
                </div>
              ))
            )}
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              onClick={onClose}
              style={{
                padding: '6px 16px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '4px',
                backgroundColor: themeStyles.bgButton,
                color: themeStyles.textPrimary,
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              {i18n('Cancel')}
            </button>
            <button
              onClick={handleSave}
              style={{
                padding: '6px 16px',
                border: `1px solid ${themeStyles.success}`,
                borderRadius: '4px',
                backgroundColor: themeStyles.success,
                color: themeStyles.textOnPrimary,
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: '500',
              }}
            >
              {i18n('Save')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Assign order to nodes/cards that lack it; returns migrated base and needsSave
function migrateOrderFields(base: BaseDoc): { base: BaseDoc; needsSave: boolean; cardUpdates: Array<{ cardId: string; nodeId: string; order: number }> } {
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

function getDescendantNodeIds(nodeId: string, edges: BaseEdge[]): string[] {
  const children = edges.filter((e) => e.source === nodeId).map((e) => e.target);
  let desc: string[] = [];
  for (const c of children) {
    desc.push(c);
    desc = desc.concat(getDescendantNodeIds(c, edges));
  }
  return desc;
}

function getAggregatedFilesForNode(
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

type SavedEditorLayout = {
  explorerMode: 'tree' | 'pending' | 'branches' | 'git';
  rightPanelOpen: boolean;
  aiBottomOpen: boolean;
  explorerPanelWidth: number;
  problemsPanelWidth: number;
  aiPanelHeight: number;
};

function readSavedBaseEditorUiPrefs(editorAiHidden: boolean): SavedEditorLayout {
  const raw =
    (typeof window !== 'undefined' && (window as any).UiContext?.baseEditorUiPrefs) || null;
  const modes = new Set(['tree', 'pending', 'branches', 'git']);

  let explorerMode: SavedEditorLayout['explorerMode'] = 'tree';
  if (raw && typeof raw.explorerMode === 'string') {
    const rawMode = raw.explorerMode === 'training' ? 'tree' : raw.explorerMode;
    if (modes.has(rawMode)) explorerMode = rawMode as SavedEditorLayout['explorerMode'];
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
    rightPanelOpen,
    aiBottomOpen,
    explorerPanelWidth,
    problemsPanelWidth,
    aiPanelHeight,
  };
}

type DevelopEditorContextWire = {
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

function normDevelopBranch(b: string | undefined): string {
  return typeof b === 'string' && b.trim() ? b.trim() : 'main';
}

function resolveDevelopQueueRowStats(
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

function developQueueGoalCaption(cur: number, goal: number, unsetLabel: string): string {
  if (goal > 0) return `${cur}/${goal}`;
  return `${cur}/${unsetLabel}`;
}

function BaseEditorDevelopQueueList({
  items,
  currentIndex,
  devCtx,
  themeStyles,
  theme,
  busyIndex,
  onGo,
}: {
  items: Array<{ baseDocId: number; branch: string }>;
  currentIndex: number;
  devCtx: DevelopEditorContextWire;
  themeStyles: any;
  theme: 'light' | 'dark';
  busyIndex: number | null;
  onGo: (baseDocId: number, branch: string, idx: number) => void;
}) {
  const unset = i18n('Develop goal unset');
  const track = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px', minHeight: 0 }}>
      <div style={{ fontSize: 11, color: themeStyles.textSecondary, marginBottom: 10, lineHeight: 1.4 }}>
        {i18n('Develop queue sidebar hint')}
      </div>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item, idx) => {
          const st = resolveDevelopQueueRowStats(devCtx, item.baseDocId, item.branch);
          const isCurrent = idx === currentIndex;
          const busy = busyIndex !== null;
          const cap = (cur: number, goal: number) => developQueueGoalCaption(cur, goal, unset);
          return (
            <li key={`${item.baseDocId}-${item.branch}-${idx}`}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onGo(item.baseDocId, item.branch, idx)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 10px',
                  borderRadius: 8,
                  border: `1px solid ${isCurrent ? themeStyles.accent : themeStyles.borderSecondary}`,
                  background: isCurrent
                    ? (theme === 'dark' ? 'rgba(56, 189, 248, 0.12)' : 'rgba(14, 165, 233, 0.08)')
                    : themeStyles.bgSecondary,
                  color: themeStyles.textPrimary,
                  cursor: busy ? 'wait' : 'pointer',
                  opacity: busy && busyIndex !== idx ? 0.65 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 12, flex: 1, minWidth: 0 }}>
                    <span style={{ color: themeStyles.textTertiary, fontWeight: 600, marginRight: 6 }}>{idx + 1}.</span>
                    {st.baseTitle}
                    <span style={{ color: themeStyles.textSecondary, fontWeight: 500 }}>{` · ${normDevelopBranch(item.branch)}`}</span>
                  </span>
                  {isCurrent ? (
                    <span style={{ fontSize: 10, fontWeight: 700, color: themeStyles.accent, flexShrink: 0 }}>{i18n('Develop queue current')}</span>
                  ) : null}
                </div>
                <div style={{ fontSize: 10, color: themeStyles.textSecondary, lineHeight: 1.5, marginBottom: 6 }}>
                  <span style={{ color: themeStyles.statNode }}>{i18n('Develop today nodes')} {cap(st.todayNodes, st.dailyNodeGoal)}</span>
                  <span style={{ margin: '0 5px', color: themeStyles.textTertiary }}>|</span>
                  <span style={{ color: themeStyles.statCard }}>{i18n('Develop today cards')} {cap(st.todayCards, st.dailyCardGoal)}</span>
                  <span style={{ margin: '0 5px', color: themeStyles.textTertiary }}>|</span>
                  <span style={{ color: themeStyles.statProblem }}>{i18n('Develop today problems')} {cap(st.todayProblems, st.dailyProblemGoal)}</span>
                </div>
                <div style={{ height: 3, borderRadius: 2, background: track, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(() => {
                        const parts: number[] = [];
                        if (st.dailyNodeGoal > 0) {
                          parts.push(Math.min(100, (st.todayNodes / st.dailyNodeGoal) * 100));
                        }
                        if (st.dailyCardGoal > 0) {
                          parts.push(Math.min(100, (st.todayCards / st.dailyCardGoal) * 100));
                        }
                        if (st.dailyProblemGoal > 0) {
                          parts.push(Math.min(100, (st.todayProblems / st.dailyProblemGoal) * 100));
                        }
                        if (!parts.length) return 0;
                        return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
                      })()}%`,
                      height: '100%',
                      background: themeStyles.accent,
                      borderRadius: 1,
                      transition: 'width 0.2s ease',
                    }}
                  />
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function BaseEditorMode({ docId, initialData, basePath = 'base' }: { docId: string | undefined; initialData: BaseDoc; basePath?: string }) {
  
  const getTheme = useCallback(() => {
    try {
      if ((window as any).Ejunz?.utils?.getTheme) {
        return (window as any).Ejunz.utils.getTheme();
      }
      if ((window as any).UserContext?.theme) {
        return (window as any).UserContext.theme === 'dark' ? 'dark' : 'light';
      }
    } catch (e) {
      console.warn('Failed to get theme:', e);
    }
    return 'light';
  }, []);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => getTheme());
  const [contributionData, setContributionData] = useState<{
    todayContribution: { nodes: number; cards: number; problems: number; nodeChars?: number; cardChars?: number; problemChars?: number };
    todayContributionAllDomains: { nodes: number; cards: number; problems: number; nodeChars?: number; cardChars?: number; problemChars?: number };
    contributions: Array<{ date: string; type: 'node' | 'card' | 'problem'; count: number }>;
    contributionDetails: Record<string, Array<{
      domainId: string; domainName: string; nodes: number; cards: number; problems: number;
      nodeStats: { created: number; modified: number; deleted: number };
      cardStats: { created: number; modified: number; deleted: number };
      problemStats: { created: number; modified: number; deleted: number };
    }>>;
  }>(() => {
    const ctx = (window as any).UiContext;
    const defaultChars = { nodeChars: 0, cardChars: 0, problemChars: 0 };
    return {
      todayContribution: { ...defaultChars, ...ctx?.todayContribution, nodes: ctx?.todayContribution?.nodes ?? 0, cards: ctx?.todayContribution?.cards ?? 0, problems: ctx?.todayContribution?.problems ?? 0 },
      todayContributionAllDomains: { ...defaultChars, ...ctx?.todayContributionAllDomains, nodes: ctx?.todayContributionAllDomains?.nodes ?? 0, cards: ctx?.todayContributionAllDomains?.cards ?? 0, problems: ctx?.todayContributionAllDomains?.problems ?? 0 },
      contributions: ctx?.contributions || [],
      contributionDetails: ctx?.contributionDetails || {},
    };
  });
  const [developEditorContext, setDevelopEditorContext] = useState<DevelopEditorContextWire | null>(
    () => ((window as any).UiContext?.developEditorContext as DevelopEditorContextWire) ?? null,
  );
  const [developSwitchModalOpen, setDevelopSwitchModalOpen] = useState(false);
  const [developSettleBusy, setDevelopSettleBusy] = useState(false);
  const [developSessionEditTotals, setDevelopSessionEditTotals] = useState(() => {
    const t = (typeof window !== 'undefined' && (window as any).UiContext?.developSessionEditTotals) || null;
    if (t && typeof t === 'object') {
      return {
        nodes: Number((t as any).nodes) || 0,
        cards: Number((t as any).cards) || 0,
        problems: Number((t as any).problems) || 0,
      };
    }
    return { nodes: 0, cards: 0, problems: 0 };
  });

  const pathnameForDevelopUi = typeof window !== 'undefined' ? window.location.pathname : '';
  const developSessionParamFromUrl =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('session') : null;
  const onDevelopEditorPath = /\/develop\/editor(\/|$)/.test(pathnameForDevelopUi);
  const onBaseBranchEditorPath = /\/base\/[^/]+\/branch\/[^/]+\/editor(?:\/|$)/.test(pathnameForDevelopUi);
  const showDevelopSessionStripUi =
    Boolean(developSessionParamFromUrl) && (onDevelopEditorPath || onBaseBranchEditorPath);
  const editorDevelopSessionKindFromUi =
    typeof window !== 'undefined'
      ? String(((window as any).UiContext?.editorDevelopSessionKind) || '')
      : '';
  const developSessionStartedAtIsoFromUi =
    typeof window !== 'undefined'
      ? String(((window as any).UiContext?.developSessionStartedAtIso) || '')
      : '';

  const [developSessionClock, setDevelopSessionClock] = useState(0);
  useEffect(() => {
    if (!showDevelopSessionStripUi) return undefined;
    if (!developSessionStartedAtIsoFromUi) return undefined;
    const id = window.setInterval(() => setDevelopSessionClock((c) => c + 1), 10000);
    return () => window.clearInterval(id);
  }, [showDevelopSessionStripUi, developSessionStartedAtIsoFromUi]);

  /** Develop-pool editor: ensure `?session=` points at an `appRoute: develop` row for batch-save audit records. */
  useEffect(() => {
    if (basePath !== 'base') return;
    if (!developEditorContext) return;
    const docIdNum = docId ? Number(docId) : NaN;
    if (!Number.isFinite(docIdNum) || docIdNum <= 0) return;
    if (new URLSearchParams(window.location.search).get('session')) return;

    let cancelled = false;
    const domainId = (window as any).UiContext?.domainId || 'system';
    const branch = (window as any).UiContext?.currentBranch || 'main';
    request
      .post(`/d/${domainId}/session/develop/start`, { baseDocId: docIdNum, branch })
      .then((res: { sessionId?: string }) => {
        if (cancelled || !res?.sessionId) return;
        if (new URLSearchParams(window.location.search).get('session')) return;
        const next = new URLSearchParams(window.location.search);
        next.set('session', res.sessionId);
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}?${next.toString()}`,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [developEditorContext, basePath, docId]);

  const [developRunQueueState, setDevelopRunQueueState] = useState<{
    items: Array<{ baseDocId: number; branch: string }>;
    currentIndex: number;
  } | null>(null);

  const [developQueueNavBusy, setDevelopQueueNavBusy] = useState<number | null>(null);
  const [editorRightPanelTab, setEditorRightPanelTab] = useState<'problems' | 'develop_queue'>('problems');

  const navigateDevelopQueueItem = useCallback(async (baseDocId: number, branch: string, queueIndex: number) => {
    const d = (window as any).UiContext?.domainId || 'system';
    setDevelopQueueNavBusy(queueIndex);
    try {
      const res: any = await request.post(`/d/${d}/session/develop/start`, { baseDocId, branch });
      const sessionId = res?.sessionId ?? res?.body?.sessionId;
      if (typeof sessionId === 'string' && sessionId.trim()) {
        window.location.href = `/d/${d}/develop/editor?session=${encodeURIComponent(sessionId.trim())}`;
        return;
      }
      Notification.error(i18n('Develop start failed'));
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? i18n('Develop start failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setDevelopQueueNavBusy(null);
    }
  }, []);

  /** Strip legacy `developRun` from the query string; queue state lives in sessionStorage only. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (!sp.has('developRun')) return;
    sp.delete('developRun');
    const qs = sp.toString();
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + (qs ? `?${qs}` : ''),
    );
  }, []);

  useEffect(() => {
    if (!developRunQueueState?.items.length) {
      setEditorRightPanelTab('problems');
    }
  }, [developRunQueueState]);

  const showDevelopQueueInPanels = !!(developEditorContext && developRunQueueState && developRunQueueState.items.length > 0);

  const contributionWsRef = useRef<any>(null);
  const saveHandlerRef = useRef<() => void>(() => {});
  const editorAiHidden = false;
  const savedEditorLayout = readSavedBaseEditorUiPrefs(editorAiHidden);

  const [explorerMode, setExplorerMode] = useState<'tree' | 'pending' | 'branches' | 'git'>(
    () => savedEditorLayout.explorerMode,
  );
  const [gitRemoteStatus, setGitRemoteStatus] = useState<any>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [gitRepoDraft, setGitRepoDraft] = useState(() => String((window as any).UiContext?.githubRepo || ''));
  const [gitTokenDraft, setGitTokenDraft] = useState('');
  const [githubPATConfigured, setGithubPATConfigured] = useState(
    () => !!(window as any).UiContext?.userGithubTokenConfigured,
  );
  const [gitActionBusy, setGitActionBusy] = useState<'pull' | 'push' | 'commit' | null>(null);
  const [gitCommitNote, setGitCommitNote] = useState('');

  useEffect(() => {
    const checkTheme = () => {
      const newTheme = getTheme();
      if (newTheme !== theme) {
        setTheme(newTheme);
      }
    };

    checkTheme();
    const interval = setInterval(checkTheme, 500);
    return () => clearInterval(interval);
  }, [theme, getTheme]);

  useEffect(() => {
    const socketUrl = (window as any).UiContext?.socketUrl;
    const wsPrefix = (window as any).UiContext?.ws_prefix || '';
    const domainId = (window as any).UiContext?.domainId || 'system';
    if (!socketUrl) return;

    let closed = false;
    const apiPath = basePath === 'base/skill'
      ? `/d/${domainId}/base/skill/data`
      : `/d/${domainId}/base/data`;
    const editorApiQs: Record<string, string> = {};
    if (docId) editorApiQs.docId = docId;
    const editorBranch = (window as any).UiContext?.currentBranch;
    if (editorBranch) editorApiQs.branch = editorBranch;

    const connect = async () => {
      try {
        const { default: WebSocket } = await import('../components/socket');
        const wsUrl = wsPrefix + socketUrl;
        const sock = new WebSocket(wsUrl, false, true);
        contributionWsRef.current = sock;

        sock.onmessage = (_: any, data: string) => {
          if (closed) return;
          try {
            const msg = JSON.parse(data);
            if (msg.type === 'init' || msg.type === 'update') {
              if (msg.type === 'update' && msg.sourceBranch && editorBranch && msg.sourceBranch !== editorBranch) return;
              if (msg.gitStatus != null) {
                setGitRemoteStatus(msg.gitStatus);
              }
              if (msg.todayContribution != null) {
                setContributionData(prev => ({
                  ...prev,
                  todayContribution: msg.todayContribution || prev.todayContribution,
                  todayContributionAllDomains: msg.todayContributionAllDomains || prev.todayContributionAllDomains,
                  contributions: Array.isArray(msg.contributions) ? msg.contributions : prev.contributions,
                  contributionDetails: msg.contributionDetails && typeof msg.contributionDetails === 'object'
                    ? msg.contributionDetails
                    : prev.contributionDetails,
                }));
              }
              if (Object.prototype.hasOwnProperty.call(msg, 'developEditorContext')) {
                setDevelopEditorContext(msg.developEditorContext ?? null);
              }
              request.get(apiPath, editorApiQs).then((newData: any) => {
                if (closed || !newData || (!newData.nodes && !newData.edges)) return;
                const nextNodes = newData.nodes ?? [];
                const nextEdges = newData.edges ?? [];
                const nextNodeCardsMap = newData.nodeCardsMap ?? {};
                setBase(prev => {
                  const prevNodes = prev?.nodes || [];
                  const prevEdges = prev?.edges || [];
                  const tempNodes = prevNodes.filter(n => n.id && String(n.id).startsWith('temp-node-'));
                  const tempNodeIdSet = new Set(tempNodes.map(n => String(n.id)));
                  const tempEdges = prevEdges.filter(e =>
                    (e.id && String(e.id).startsWith('temp-edge-')) ||
                    (e.source && tempNodeIdSet.has(String(e.source))) ||
                    (e.target && tempNodeIdSet.has(String(e.target)))
                  );
                  return {
                    ...prev,
                    ...newData,
                    nodes: [...nextNodes, ...tempNodes],
                    edges: [...nextEdges, ...tempEdges],
                  };
                });
                if ((window as any).UiContext) {
                  (window as any).UiContext.nodeCardsMap = nextNodeCardsMap;
                }
                setNodeCardsMapVersion(v => v + 1);
              }).catch(() => {});
            }
            if (msg.type === 'git_status' && msg.gitStatus != null) {
              const b = (window as any).UiContext?.currentBranch || 'main';
              if (!msg.branch || msg.branch === b) {
                setGitRemoteStatus(msg.gitStatus);
              }
            }
          } catch (e) {
            // ignore parse error
          }
        };

        sock.onclose = () => {
          contributionWsRef.current = null;
        };
      } catch (e) {
        console.warn('Contribution WS connect failed:', e);
      }
    };

    connect();
    return () => {
      closed = true;
      if (contributionWsRef.current) {
        contributionWsRef.current.close();
        contributionWsRef.current = null;
      }
    };
  }, [basePath, docId]);

  const themeStyles = useMemo(() => {
    const isDark = theme === 'dark';
    return {
      bgPrimary: isDark ? '#121212' : '#fff',
      bgSecondary: isDark ? '#323334' : '#f6f8fa',
      bgTertiary: isDark ? '#424242' : '#fafbfc',
      bgHover: isDark ? '#424242' : '#f3f4f6',
      bgSelected: isDark ? '#0366d6' : '#0366d6',
      bgDragOver: isDark ? '#1e3a5f' : '#e3f2fd',
      bgDragged: isDark ? '#2a2a2a' : '#f0f0f0',
      bgButton: isDark ? '#323334' : '#fff',
      bgButtonActive: isDark ? '#0366d6' : '#0366d6',
      bgButtonHover: isDark ? '#424242' : '#f3f4f6',
      
      
      textPrimary: isDark ? '#eee' : '#24292e',
      textSecondary: isDark ? '#bdbdbd' : '#586069',
      textTertiary: isDark ? '#999' : '#6a737d',
      textOnPrimary: isDark ? '#fff' : '#fff',
      
      borderPrimary: isDark ? '#424242' : '#e1e4e8',
      borderSecondary: isDark ? '#555' : '#d1d5da',
      borderFocus: isDark ? '#0366d6' : '#0366d6',
      
      accent: isDark ? '#55b6e2' : '#0366d6',
      success: isDark ? '#4caf50' : '#28a745',
      warning: isDark ? '#ff9800' : '#ff9800',
      error: isDark ? '#f44336' : '#f44336',
      statNode: isDark ? '#64b5f6' : '#2196F3',
      statCard: isDark ? '#81c784' : '#4CAF50',
      statProblem: isDark ? '#ffb74d' : '#FF9800',
    };
  }, [theme]);

  const aiTerminalStyles = useMemo(() => {
    const isDark = theme === 'dark';
    const mono =
      'ui-monospace, Monaco, Menlo, "Ubuntu Mono", Consolas, "Courier New", monospace';
    if (isDark) {
      return {
        mono,
        shellBg: '#1e1e1e',
        tabBarBg: '#252526',
        tabBorder: '#3c3c3c',
        tabActiveBg: '#1e1e1e',
        tabActiveTop: '#007acc',
        text: '#cccccc',
        textDim: '#858585',
        promptUser: '#6a9955',
        /** Input-line prompt: user@host — magenta user, white @:, green host (caret matches host). */
        promptShellUser: '#E91E63',
        promptShellHost: '#4CAF50',
        promptShellSep: '#ffffff',
        promptShellPath: '#9CDCFE',
        promptAi: '#4ec9b0',
        operationBg: '#2d2d30',
        operationBorder: '#3c3c3c',
        operationText: '#4fc1ff',
        resizeDefault: '#3c3c3c',
        resizeActive: '#007acc',
      };
    }
    return {
      mono,
      shellBg: '#ffffff',
      tabBarBg: '#f3f3f3',
      tabBorder: '#e8e8e8',
      tabActiveBg: '#ffffff',
      tabActiveTop: '#007acc',
      text: '#333333',
      textDim: '#767676',
      promptUser: '#098658',
      promptShellUser: '#C2185B',
      promptShellHost: '#2E7D32',
      promptShellSep: '#24292e',
      promptShellPath: '#0277bd',
      promptAi: '#0451a5',
      operationBg: '#f0f6fc',
      operationBorder: '#c8c8c8',
      operationText: '#0071bc',
      resizeDefault: '#cecece',
      resizeActive: '#007acc',
    };
  }, [theme]);

  /** Shell-style prompt parts for the bottom AI input (user@domain:). */
  const aiTerminalInputPromptParts = useMemo(() => {
    const uname = String((window as any).UserContext?.uname || '').trim() || 'user';
    const dom = String((window as any).UiContext?.domainId || '').trim() || 'system';
    return { uname, domain: dom, full: `${uname}@${dom}:` };
  }, []);

  const migrationResult = useMemo(() => migrateOrderFields(initialData), [initialData]);
  const [base, setBase] = useState<BaseDoc>(() => migrationResult.base);

  useEffect(() => {
    if (typeof window === 'undefined' || !developEditorContext || basePath !== 'base') {
      setDevelopRunQueueState(null);
      return;
    }
    const domainId = (window as any).UiContext?.domainId || 'system';
    const branch = String(
      base.currentBranch || (window as any).UiContext?.currentBranch || 'main',
    ).trim() || 'main';
    const docNum = docId ? Number(docId) : NaN;
    let norm: Array<{ baseDocId: number; branch: string }> = [];
    try {
      const raw = sessionStorage.getItem(`developRunQueue:${domainId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          norm = parsed
            .filter((x: any) => x && Number.isFinite(Number(x.baseDocId)))
            .map((x: any) => ({
              baseDocId: Number(x.baseDocId),
              branch: String(x.branch || 'main').trim() || 'main',
            }));
        }
      }
    } catch {
      norm = [];
    }
    if (norm.length === 0) {
      if (Number.isFinite(docNum) && docNum > 0) {
        setDevelopRunQueueState({ items: [{ baseDocId: docNum, branch }], currentIndex: 0 });
      } else {
        setDevelopRunQueueState(null);
      }
      return;
    }
    const idx = Number.isFinite(docNum)
      ? norm.findIndex((s) => s.baseDocId === docNum && s.branch === branch)
      : -1;
    setDevelopRunQueueState({ items: norm, currentIndex: idx });
  }, [docId, developEditorContext, basePath, base.currentBranch]);

  useEffect(() => {
    if (migrationResult.needsSave) {
      const saveMigration = async () => {
        try {
          const migrationNodes = migrationResult.base.nodes.filter(n => !String((n as any).id ?? (n as any)._id ?? '').startsWith('temp-node-'));
          const migrationEdges = migrationResult.base.edges.filter(e =>
            !String((e as any).source ?? '').startsWith('temp-node-') &&
            !String((e as any).target ?? '').startsWith('temp-node-') &&
            !String((e as any).id ?? (e as any)._id ?? '').startsWith('temp-edge-')
          );
          
          await request.post(getBaseUrl('/save'), {
            ...(docId ? { docId } : {}),
            branch: (window as any).UiContext?.currentBranch || 'main',
            nodes: migrationNodes,
            edges: migrationEdges,
            operationDescription: '自动迁移：为节点和卡片添加order字段',
          });
          
          if (migrationResult.cardUpdates.length > 0) {
            const domainId = (window as any).UiContext?.domainId || 'system';
            const updatePromises = migrationResult.cardUpdates.map(update =>
              request.post(getBaseUrl(`/card/${update.cardId}`), {
                ...(docId ? { docId } : {}),
                operation: 'update',
                nodeId: update.nodeId,
                order: update.order,
              })
            );
            await Promise.all(updatePromises);
          }
          
          console.log('Order migration done');
        } catch (error: any) {
          console.error('Order migration failed:', error);
        }
      };
      
      saveMigration();
    }
  }, [migrationResult.needsSave, migrationResult.base.nodes, migrationResult.base.edges, migrationResult.cardUpdates, docId]);
  
  useEffect(() => {
    pendingCreatesRef.current.clear();
    setPendingCreatesCount(0);
    setPendingChanges(new Map());
    setPendingRenames(new Map());
    setPendingDeletes(new Map());
    setPendingDragChanges(new Set());
  }, [docId]);
  
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const selectedFileRef = useRef<FileItem | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState<boolean>(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const getNodeChildrenRef = useRef<((nodeId: string, visited?: Set<string>) => { nodes: string[]; cards: string[] }) | null>(null);
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  const [pendingRenames, setPendingRenames] = useState<Map<string, PendingRename>>(new Map());
  const pendingCreatesRef = useRef<Map<string, PendingCreate>>(new Map());
  const [pendingCreatesCount, setPendingCreatesCount] = useState<number>(0);
  const [pendingDeletes, setPendingDeletes] = useState<Map<string, PendingDelete>>(new Map());
  const originalContentsRef = useRef<Map<string, string>>(new Map());
  const [draggedFile, setDraggedFile] = useState<FileItem | null>(null);
  const [dragOverFile, setDragOverFile] = useState<FileItem | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'into'>('after');
  const [editingFile, setEditingFile] = useState<FileItem | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [pendingDragChanges, setPendingDragChanges] = useState<Set<string>>(new Set());
  const [nodeCardsMapVersion, setNodeCardsMapVersion] = useState(0);

  const refetchEditorData = useCallback(async () => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    const apiPath = basePath === 'base/skill'
      ? `/d/${domainId}/base/skill/data`
      : `/d/${domainId}/base/data`;
    try {
      const qs: Record<string, string> = {};
      if (docId && basePath === 'base') qs.docId = docId;
      const refBranch = (window as any).UiContext?.currentBranch;
      if (refBranch) qs.branch = refBranch;
      const newData: any = await request.get(apiPath, qs);
      if (newData?.nodes != null || newData?.edges != null) {
        setBase(prev => {
          const prevNodes = prev?.nodes || [];
          const prevEdges = prev?.edges || [];
          const serverNodes = newData.nodes ?? prevNodes;
          const serverEdges = newData.edges ?? prevEdges;
          const tempNodes = prevNodes.filter(n => n.id && String(n.id).startsWith('temp-node-'));
          const tempNodeIdSet = new Set(tempNodes.map(n => String(n.id)));
          const tempEdges = prevEdges.filter(e =>
            (e.id && String(e.id).startsWith('temp-edge-')) ||
            (e.source && tempNodeIdSet.has(String(e.source))) ||
            (e.target && tempNodeIdSet.has(String(e.target)))
          );
          return {
            ...prev,
            ...newData,
            nodes: [...serverNodes, ...tempNodes],
            edges: [...serverEdges, ...tempEdges],
          };
        });
      }
      if ((window as any).UiContext && newData?.nodeCardsMap != null) {
        (window as any).UiContext.nodeCardsMap = newData.nodeCardsMap;
      }
      setNodeCardsMapVersion(v => v + 1);
    } catch (e) {
      console.error('[BaseEditor] refetchEditorData failed:', e);
    }
  }, [basePath, docId]);

  const handleCardFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList?.length || !docId) {
      if (fileList && fileList.length === 0) {
        Notification.warn(i18n('No file selected.'));
      }
      e.target.value = '';
      return;
    }
    const files = Array.from(fileList);
    const domainId = (window as any).UiContext?.domainId || 'system';
    const branch = (window as any).UiContext?.currentBranch || 'main';

    if (pendingNodeUploadRef.current) {
      const { nodeId } = pendingNodeUploadRef.current;
      let url: string;
      url = `/d/${domainId}/base/${docId}/node/${nodeId}/files?branch=${encodeURIComponent(branch)}`;
      try {
        await uploadFiles(url, files, {});
        await refetchEditorData();
      } catch (_err) {
        // Notification already shown by uploadFiles
      }
      pendingNodeUploadRef.current = null;
    } else if (pendingCardUploadRef.current) {
      const pending = pendingCardUploadRef.current;
      let url: string;
      url = `/d/${domainId}/base/${docId}/card/${pending.cardId}/files`;
      try {
        await uploadFiles(url, files, {});
        await refetchEditorData();
      } catch (_err) {
        // Notification already shown by uploadFiles
      }
      pendingCardUploadRef.current = null;
    }
    e.target.value = '';
  }, [basePath, docId, refetchEditorData]);

  const handleFilePreviewClick = useCallback(async (e: React.MouseEvent<HTMLAnchorElement>, link: string, filename: string, size: number) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const { previewFileByUrl } = await import('vj/components/preview/preview.page');
    await previewFileByUrl(link, filename, size);
  }, []);

  const dragLeaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const dragOverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastDragOverFileRef = useRef<FileItem | null>(null);
  const lastDropPositionRef = useRef<'before' | 'after' | 'into'>('after');
  const longPressTimerRef = useRef<number | null>(null);
  const longPressFileRef = useRef<FileItem | null>(null);
  const longPressPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const mobileExplorerCloseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const touchDragFileRef = useRef<FileItem | null>(null);
  const touchDragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const touchDragOverFileRef = useRef<FileItem | null>(null);
  const touchDropPositionRef = useRef<'before' | 'after' | 'into'>('after');
  const touchDragListenersRef = useRef<{
    move: (e: TouchEvent) => void;
    end: (e: TouchEvent) => void;
    cancel: (e: TouchEvent) => void;
  } | null>(null);
  const fileTreeRef = useRef<FileItem[]>([]);
  const baseEdgesRef = useRef(base.edges);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileItem } | null>(null);
  const [editorLearnBusy, setEditorLearnBusy] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [newSiblingCardSubmenuOpen, setNewSiblingCardSubmenuOpen] = useState(false);
  const [newSiblingNodeSubmenuOpen, setNewSiblingNodeSubmenuOpen] = useState(false);
  const [newSiblingCardForNodeSubmenuOpen, setNewSiblingCardForNodeSubmenuOpen] = useState(false);
  const [newSiblingNodeForCardSubmenuOpen, setNewSiblingNodeForCardSubmenuOpen] = useState(false);
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const el = contextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const padding = 8;
    let { x, y } = contextMenu;
    if (rect.bottom > window.innerHeight - padding) {
      y = window.innerHeight - rect.height - padding;
    }
    if (rect.right > window.innerWidth - padding) {
      x = window.innerWidth - rect.width - padding;
    }
    if (y < padding) y = padding;
    if (x < padding) x = padding;
    if (x !== contextMenu.x || y !== contextMenu.y) {
      setContextMenu(prev => prev ? { ...prev, x, y } : null);
    }
  }, [contextMenu?.x, contextMenu?.y, contextMenu?.file?.id]);

  useEffect(() => {
    if (!contextMenu || contextMenu.file.type !== 'card') {
      setNewSiblingCardSubmenuOpen(false);
      setNewSiblingNodeForCardSubmenuOpen(false);
    }
    if (!contextMenu || contextMenu.file.type !== 'node') {
      setNewSiblingNodeSubmenuOpen(false);
      setNewSiblingCardForNodeSubmenuOpen(false);
    }
  }, [contextMenu]);

  const [emptyAreaContextMenu, setEmptyAreaContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [clipboard, setClipboard] = useState<{ type: 'copy' | 'cut'; items: FileItem[] } | null>(null);
  const [sortWindow, setSortWindow] = useState<{ nodeId: string } | null>(null);
  const [migrateToNewBaseModal, setMigrateToNewBaseModal] = useState<{ nodeId: string } | null>(null);
  const [migrateNewBaseTitle, setMigrateNewBaseTitle] = useState('');
  const [migrateNewBaseBid, setMigrateNewBaseBid] = useState('');
  const [migrateToNewBaseSubmitting, setMigrateToNewBaseSubmitting] = useState(false);
  const [importWindow, setImportWindow] = useState<{ nodeId: string } | null>(null);
  const [cardFaceWindow, setCardFaceWindow] = useState<{ file: FileItem } | null>(null);
  const [cardFileListModal, setCardFileListModal] = useState<{ cardId: string; nodeId: string; cardTitle: string } | null>(null);
  const [nodeFileListModal, setNodeFileListModal] = useState<{ nodeId: string; nodeTitle: string } | null>(null);
  const [nodeFileListSortBy, setNodeFileListSortBy] = useState<'name' | 'size' | 'time' | 'source'>('name');
  const [nodeFileListSortOrder, setNodeFileListSortOrder] = useState<'asc' | 'desc'>('asc');
  const [fileListRowMenu, setFileListRowMenu] = useState<{ x: number; y: number; downloadUrl: string; deleteUrl: string; filename: string } | null>(null);
  const [nodeFileListEditMode, setNodeFileListEditMode] = useState(false);
  const [selectedFileListRowKeys, setSelectedFileListRowKeys] = useState<Set<string>>(new Set());
  const cardFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCardUploadRef = useRef<{ cardId: string; nodeId: string } | null>(null);
  const pendingNodeUploadRef = useRef<{ nodeId: string } | null>(null);
  const [cardFaceEditContent, setCardFaceEditContent] = useState('');
  const [pendingCardFaceChanges, setPendingCardFaceChanges] = useState<Record<string, string>>({});
  const cardFaceEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const cardFaceEditorInstanceRef = useRef<any>(null);
  const [importText, setImportText] = useState('');
  const [rightPanelOpen, setRightPanelOpen] = useState(() => savedEditorLayout.rightPanelOpen);
  const [aiBottomOpen, setAiBottomOpen] = useState(() => savedEditorLayout.aiBottomOpen);
  const [aiPanelHeight, setAiPanelHeight] = useState(() => savedEditorLayout.aiPanelHeight);
  const [aiPanelMaxHeight, setAiPanelMaxHeight] = useState(640);
  useEffect(() => {
    if (editorAiHidden) {
      setAiBottomOpen(false);
    }
  }, [editorAiHidden]);
  const [chatMessages, setChatMessages] = useState<Array<{
    role: 'user' | 'assistant' | 'operation';
    content: string;
    references?: Array<{ type: 'node' | 'card'; id: string; name: string; path: string[] }>;
    operations?: any[];
    isExpanded?: boolean;
    /** While the model streams a ```json … ``` block: friendly op list, raw JSON hidden. */
    streamOps?: { lines: string[]; receiving: boolean; charCount: number } | null;
  }>>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [chatInputReferences, setChatInputReferences] = useState<Array<{ type: 'node' | 'card'; id: string; name: string; path: string[]; startIndex: number; endIndex: number }>>([]);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesContainerRef = useRef<HTMLDivElement>(null);
  
  const scrollToBottomIfNeeded = useCallback(() => {
    if (!chatMessagesContainerRef.current || !chatMessagesEndRef.current) {
      return;
    }
    
    const container = chatMessagesContainerRef.current;
    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    
    if (isNearBottom) {
      requestAnimationFrame(() => {
        if (chatMessagesContainerRef.current) {
          chatMessagesContainerRef.current.scrollTop = chatMessagesContainerRef.current.scrollHeight;
        }
      });
    }
  }, []);
  
  const [problemsPanelWidth, setProblemsPanelWidth] = useState<number>(
    () => savedEditorLayout.problemsPanelWidth,
  );
  const EXPLORER_PANEL_MIN = 180;
  const EXPLORER_PANEL_MAX = 640;
  const [explorerPanelWidth, setExplorerPanelWidth] = useState<number>(
    () => savedEditorLayout.explorerPanelWidth,
  );
  const [isResizingExplorer, setIsResizingExplorer] = useState<boolean>(false);
  const explorerResizeStartXRef = useRef<number>(0);
  const explorerResizeStartWidthRef = useRef<number>(savedEditorLayout.explorerPanelWidth);
  const RIGHT_SIDE_RAIL_PX = 44;
  const [isResizingProblemsPanel, setIsResizingProblemsPanel] = useState<boolean>(false);
  const problemsResizeStartXRef = useRef<number>(0);
  const problemsResizeStartWidthRef = useRef<number>(savedEditorLayout.problemsPanelWidth);
  const [isResizingAiPanel, setIsResizingAiPanel] = useState<boolean>(false);
  const aiResizeStartYRef = useRef<number>(0);
  const aiResizeStartHeightRef = useRef<number>(savedEditorLayout.aiPanelHeight);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const aiPanelMaxHeightRef = useRef<number>(640);
  const AI_TERMINAL_MIN_H = 120;
  const EDITOR_MAIN_MIN_H = 160;
  const executeAIOperationsRef = useRef<ExecuteAiOpsFn | null>(null);
  const chatWebSocketRef = useRef<any>(null);
  const [domainTools, setDomainTools] = useState<any[]>([]);
  const [domainToolsLoading, setDomainToolsLoading] = useState<boolean>(false);
  const [files] = useState<Array<{ _id: string; name: string; size: number; etag?: string; lastModified?: Date | string }>>(initialData.files || []);
  const [pendingProblemCardIds, setPendingProblemCardIds] = useState<Set<string>>(new Set());
  const [pendingNewProblemCardIds, setPendingNewProblemCardIds] = useState<Set<string>>(new Set());
  const [pendingEditedProblemIds, setPendingEditedProblemIds] = useState<Map<string, Set<string>>>(new Map());
  const [newProblemIds, setNewProblemIds] = useState<Set<string>>(new Set());
  const [editedProblemIds, setEditedProblemIds] = useState<Set<string>>(new Set());
  const originalProblemsRef = useRef<Map<string, Map<string, Problem>>>(new Map());
  const [originalProblemsVersion, setOriginalProblemsVersion] = useState(0);

  /** 仅有「整卡题目需保存」但未落在题目新建/题目更改里时（典型：删除已有题目），用于待提交面板单独列出。 */
  const problemPendingOtherCardIds = useMemo(() => {
    return Array.from(pendingProblemCardIds).filter((cid) => {
      if (pendingNewProblemCardIds.has(cid)) return false;
      const ed = pendingEditedProblemIds.get(cid);
      if (ed && ed.size > 0) return false;
      return true;
    });
  }, [pendingProblemCardIds, pendingNewProblemCardIds, pendingEditedProblemIds]);

  const MOBILE_BREAKPOINT = 768;
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT);
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!isMobile) return;
    const leftEl = document.getElementById('header-mobile-extra-left');
    if (!leftEl) return;
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '8px';
    leftEl.appendChild(wrapper);
    ReactDOM.render(
      <>
        <button type="button" onClick={() => setMobileExplorerOpen(true)} aria-label="Explorer">
          ☰ Explorer
        </button>
        <button
          type="button"
          className={rightPanelOpen ? 'header-mobile-extra-btn is-active' : 'header-mobile-extra-btn'}
          onClick={() => {
            setRightPanelOpen((prev) => !prev);
          }}
          aria-label={i18n('Question')}
        >
          {i18n('Question')}
        </button>
      </>,
      wrapper,
    );
    return () => {
      ReactDOM.unmountComponentAtNode(wrapper);
      wrapper.remove();
    };
  }, [isMobile, rightPanelOpen]);

  useEffect(() => {
    if (!isMobile) return;
    const rightEl = document.getElementById('header-mobile-extra');
    if (!rightEl) return;
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '8px';
    rightEl.appendChild(wrapper);
    const pendingCount = pendingChanges.size + pendingDragChanges.size + pendingRenames.size + pendingCreatesCount + pendingDeletes.size + Object.keys(pendingCardFaceChanges).length + pendingProblemCardIds.size + pendingNewProblemCardIds.size + pendingEditedProblemIds.size;
    const hasPending = pendingCount > 0;
    ReactDOM.render(
      <>
        <button
          type="button"
          className="header-mobile-extra-btn"
          onClick={() => saveHandlerRef.current?.()}
          disabled={isCommitting || !hasPending}
          style={{
            opacity: isCommitting || !hasPending ? 0.6 : 1,
            cursor: isCommitting || !hasPending ? 'not-allowed' : 'pointer',
            background: hasPending ? 'var(--color-success, #28a745)' : undefined,
            color: hasPending ? '#fff' : undefined,
          }}
          aria-label={i18n('Save changes')}
        >
          {isCommitting ? i18n('Saving...') : `${i18n('Save changes')} (${pendingCount})`}
        </button>
        {!editorAiHidden && (
          <button
            type="button"
            className={aiBottomOpen ? 'header-mobile-extra-btn is-active' : 'header-mobile-extra-btn'}
            onClick={() => {
              setAiBottomOpen((prev) => !prev);
            }}
            aria-label="AI"
          >
            AI
          </button>
        )}
      </>,
      wrapper,
    );
    return () => {
      ReactDOM.unmountComponentAtNode(wrapper);
      wrapper.remove();
    };
  }, [isMobile, aiBottomOpen, editorAiHidden, isCommitting, pendingChanges.size, pendingDragChanges.size, pendingRenames.size, pendingCreatesCount, pendingDeletes.size, pendingCardFaceChanges, pendingProblemCardIds.size, pendingNewProblemCardIds.size, pendingEditedProblemIds.size]);

  
  const getSelectedCard = useCallback((): Card | null => {
    if (!selectedFile || selectedFile.type !== 'card') return null;
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = nodeCardsMap[selectedFile.nodeId || ''] || [];
    const card = nodeCards.find((c: Card) => sameCardDocId(c.docId, selectedFile.cardId));
    return card || null;
  }, [selectedFile]);

  
  useEffect(() => {
    if (!selectedFile || selectedFile.type !== 'card') return;
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = nodeCardsMap[selectedFile.nodeId || ''] || [];
    const card = nodeCards.find((c: Card) => sameCardDocId(c.docId, selectedFile.cardId));
    if (!card) return;
    const cardIdStr = String(selectedFile.cardId || '');
    const originalProblems = new Map<string, Problem>();
    (card.problems || []).forEach((p) => {
      originalProblems.set(p.pid, { ...p });
    });
    originalProblemsRef.current.set(cardIdStr, originalProblems);
  }, [selectedFile?.id, selectedFile?.type, selectedFile?.nodeId, selectedFile?.cardId]);
  

  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const initialExpanded = new Set<string>();
    const fromContext = (window as any).UiContext?.baseExpandState;
    if (Array.isArray(fromContext) && fromContext.length > 0 && initialData?.nodes?.length) {
      fromContext.forEach((id: string) => {
        if (initialData!.nodes!.some((n: BaseNode) => n.id === id)) initialExpanded.add(id);
      });
    } else if (initialData?.nodes) {
      initialData.nodes.forEach(node => {
        if (node.expanded !== false) {
          initialExpanded.add(node.id);
        }
      });
    }
    const focusNode = String((window as any).UiContext?.editorFocusNodeId || '').trim();
    const edges0 = initialData?.edges || [];
    if (focusNode && initialData?.nodes?.some((n: BaseNode) => n.id === focusNode)) {
      initialExpanded.add(focusNode);
      collectOutlineAncestors(focusNode, initialData!.nodes!, edges0).forEach((id) => initialExpanded.add(id));
    }
    return initialExpanded;
  });
  
  
  const expandSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const developNavPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const expandedNodesRef = useRef<Set<string>>(expandedNodes);
  
  const baseRef = useRef<BaseDoc>(base);
  
  const explorerScrollRef = useRef<HTMLDivElement>(null);
  const hasExpandedForCardIdRef = useRef<string | null>(null);
  const hasExpandedForUrlNodeIdRef = useRef<string | null>(null);
  
  
  useEffect(() => {
    expandedNodesRef.current = expandedNodes;
  }, [expandedNodes]);
  
  useEffect(() => {
    baseRef.current = base;
  }, [base]);
  
  
  useEffect(() => {
    return () => {
      if (expandSaveTimerRef.current) {
        clearTimeout(expandSaveTimerRef.current);
        expandSaveTimerRef.current = null;
      }
    };
  }, []);

  
  const getBaseUrl = useCallback((path: string, docId?: string): string => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    return `/d/${domainId}/${basePath}${path}`;
  }, [basePath]);

  useEffect(() => {
    if (typeof window === 'undefined' || basePath !== 'base' || !docId) return undefined;
    const path = window.location.pathname;
    const onDevEd = /\/develop\/editor(?:\/|$)/.test(path);
    const onBaseBrEd = /\/base\/[^/]+\/branch\/[^/]+\/editor(?:\/|$)/.test(path);
    if (!onDevEd && !onBaseBrEd) return undefined;
    const sessionHex = new URLSearchParams(window.location.search).get('session')?.trim() || '';
    if (!sessionHex) return undefined;
    const baseDocIdNum = Number(docId);
    if (!Number.isFinite(baseDocIdNum) || baseDocIdNum <= 0) return undefined;
    const branch = (window as any).UiContext?.currentBranch || 'main';
    if (developNavPersistTimerRef.current) clearTimeout(developNavPersistTimerRef.current);
    developNavPersistTimerRef.current = setTimeout(async () => {
      developNavPersistTimerRef.current = null;
      try {
        await request.post(getBaseUrl('/save'), {
          docId: baseDocIdNum,
          branch,
          sidecarOnly: true,
          developSessionId: sessionHex,
          developEditorLocation: `${window.location.pathname}${window.location.search || ''}`,
        });
      } catch (_e) {
        /* best-effort */
      }
    }, 450);
    return () => {
      if (developNavPersistTimerRef.current) {
        clearTimeout(developNavPersistTimerRef.current);
        developNavPersistTimerRef.current = null;
      }
    };
  }, [basePath, docId, selectedFile?.id, getBaseUrl]);

  const fetchGitRemoteStatus = useCallback(async () => {
    if (basePath !== 'base' || !docId) return;
    const branch = (window as any).UiContext?.currentBranch || 'main';
    setGitStatusLoading(true);
    try {
      const res: any = await request.get(getBaseUrl('/git/status'), {
        docId: String(docId),
        branch,
      });
      setGitRemoteStatus(res?.gitStatus ?? null);
    } catch (_e) {
      setGitRemoteStatus(null);
    } finally {
      setGitStatusLoading(false);
    }
  }, [basePath, docId, getBaseUrl]);

  useEffect(() => {
    if (explorerMode !== 'git' || basePath !== 'base' || !docId) return;
    request.get(getBaseUrl('/github/config'), { docId: String(docId) }).then((r: any) => {
      if (r?.githubRepo != null) setGitRepoDraft(String(r.githubRepo));
    }).catch(() => {});
    fetchGitRemoteStatus();
    const t = setInterval(fetchGitRemoteStatus, 15000);
    return () => clearInterval(t);
  }, [explorerMode, basePath, docId, getBaseUrl, fetchGitRemoteStatus]);

  const editorRootNodeId = (window as any).UiContext?.editorRootNodeId || '';
  const currentBranch = (window as any).UiContext?.currentBranch || 'main';

  const editorUiDomainId = useCallback((): string => {
    const rawDomainId = (window as any).UiContext?.domainId;
    return typeof rawDomainId === 'object'
      ? (rawDomainId?._id ? String(rawDomainId._id) : 'system')
      : (rawDomainId ? String(rawDomainId) : 'system');
  }, []);

  const startSingleCardLearnFromEditor = useCallback(async (cardIdRaw: string | undefined) => {
    const cardId = String(cardIdRaw || '').trim();
    if (!cardId || editorLearnBusy) return;
    if (!/^[a-f0-9]{24}$/i.test(cardId)) {
      Notification.error(i18n('Outline learn invalid card'));
      return;
    }
    const domainId = editorUiDomainId();
    setEditorLearnBusy(true);
    try {
      const res: any = await request.post(`/d/${domainId}/learn/lesson/start`, {
        mode: 'card',
        cardId,
      });
      const redir = res?.redirect ?? res?.body?.redirect ?? res?.data?.redirect;
      const url = redir || `/d/${domainId}/learn/lesson?cardId=${encodeURIComponent(cardId)}`;
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        opened.opener = null;
      } else {
        Notification.error(i18n('Outline editor popup blocked'));
      }
    } catch (e: any) {
      const msg = e?.message ?? i18n('Outline learn start failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setEditorLearnBusy(false);
    }
  }, [editorLearnBusy, editorUiDomainId]);

  const startSingleNodeLearnFromEditor = useCallback(async (nodeIdRaw: string | undefined) => {
    const nid = String(nodeIdRaw || '').trim();
    if (!nid || editorLearnBusy) return;
    if (nid.startsWith('temp-node-')) return;
    const baseDocNum = Number((base as any).docId ?? docId);
    if (!Number.isFinite(baseDocNum) || baseDocNum <= 0) {
      Notification.error(i18n('Outline editor start invalid base'));
      return;
    }
    const branch = (window as any).UiContext?.currentBranch || base.currentBranch || 'main';
    const domainId = editorUiDomainId();
    setEditorLearnBusy(true);
    try {
      const res: any = await request.post(`/d/${domainId}/learn/lesson/start`, {
        mode: 'node',
        nodeId: nid,
        baseDocId: baseDocNum,
        branch,
      });
      const redir = res?.redirect ?? res?.body?.redirect ?? res?.data?.redirect;
      const url = redir || `/d/${domainId}/learn/lesson`;
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        opened.opener = null;
      } else {
        Notification.error(i18n('Outline editor popup blocked'));
      }
    } catch (e: any) {
      const msg = e?.message ?? i18n('Outline learn start failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setEditorLearnBusy(false);
    }
  }, [editorLearnBusy, editorUiDomainId, base, docId]);
  
  const fileTree = useMemo(() => {
    const items: FileItem[] = [];
    const nodeMap = new Map<string, { node: BaseNode; children: string[] }>();
    const rootNodes: string[] = [];

    
    base.nodes.forEach((node) => {
      nodeMap.set(node.id, { node, children: [] });
    });

    base.edges.forEach((edge) => {
      const parent = nodeMap.get(edge.source);
      if (parent) {
        parent.children.push(edge.target);
      }
    });
    
    
    nodeMap.forEach((nodeData) => {
      nodeData.children.sort((a, b) => {
        const nodeA = base.nodes.find(n => n.id === a);
        const nodeB = base.nodes.find(n => n.id === b);
        const orderA = nodeA?.order || 0;
        const orderB = nodeB?.order || 0;
        return orderA - orderB;
      });
    });

    base.nodes.forEach((node: any) => {
      const hasParent = base.edges.some((edge) => edge.target === node.id);
      if (!hasParent) rootNodes.push(node.id);
    });

    if (editorRootNodeId && nodeMap.has(editorRootNodeId)) {
      rootNodes.length = 0;
      rootNodes.push(editorRootNodeId);
    }

    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    
    
    const deletedNodeIds = new Set(
      Array.from(pendingDeletes.values())
        .filter(d => d.type === 'node')
        .map(d => d.id)
    );
    const deletedCardIds = new Set(
      Array.from(pendingDeletes.values())
        .filter(d => d.type === 'card')
        .map(d => d.id)
    );

    
    const checkAncestorMoved = (nodeId: string): boolean => {
      
      if (pendingDragChanges.has(`node-${nodeId}`)) return true;
      
      
      const parentEdge = base.edges.find(e => e.target === nodeId);
      if (parentEdge) {
        
        return checkAncestorMoved(parentEdge.source);
      }
      
      return false;
    };

    
    const checkClipboard = (file: { type: 'node' | 'card'; id: string; nodeId?: string; cardId?: string }): 'copy' | 'cut' | undefined => {
      if (!clipboard) return undefined;
      
      const found = clipboard.items.find(item => {
        if (file.type === 'node') {
          return item.type === 'node' && item.nodeId === file.nodeId;
        } else if (file.type === 'card') {
          return item.type === 'card' && item.cardId === file.cardId;
        }
        return false;
      });
      
      return found ? clipboard.type : undefined;
    };

    
    const checkPendingChanges = (file: { type: 'node' | 'card'; id: string; nodeId?: string; cardId?: string; parentId?: string }): boolean => {
      
      if (pendingChanges.has(file.id)) return true;
      
      
      if (pendingRenames.has(file.id)) return true;
      
      
      if (file.type === 'card' && file.cardId && pendingProblemCardIds.has(String(file.cardId))) return true;
      
      
      
      
      const fid = String((file as any).id ?? '');
      const fcid = String((file as any).cardId ?? '');
      if (fid.startsWith('temp-') || 
          (file.type === 'card' && fcid && fcid.startsWith('temp-')) ||
          (file.type === 'card' && fid.startsWith('card-temp-')) ||
          Array.from(pendingCreatesRef.current.values()).some(c => {
            
            if (file.type === 'node' && c.type === 'node' && c.tempId === fid) return true;
            
            if (file.type === 'card' && c.type === 'card' && fid === `card-${c.tempId}`) return true;
            return false;
          })) return true;
      
      
      if (file.type === 'node' && file.nodeId) {
        if (pendingDragChanges.has(`node-${file.nodeId}`)) return true;
        
        if (checkAncestorMoved(file.nodeId)) return true;
      } else if (file.type === 'card') {
        
        if (file.cardId && pendingDragChanges.has(file.cardId)) return true;
        
        if (file.nodeId && checkAncestorMoved(file.nodeId)) return true;
      }
      
      return false;
    };

    
    const buildTree = (nodeId: string, level: number, parentId?: string) => {
      
      if (deletedNodeIds.has(nodeId)) return;
      
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return;

      const { node } = nodeData;
      const isExpanded = expandedNodes.has(nodeId);
      
      
      const nodeFileItem: FileItem = {
        type: 'node',
        id: nodeId,
        name: node.text || i18n('Unnamed Node'),
        nodeId: nodeId,
        parentId,
        level,
      };
      nodeFileItem.hasPendingChanges = checkPendingChanges(nodeFileItem);
      nodeFileItem.clipboardType = checkClipboard(nodeFileItem);
      items.push(nodeFileItem);

      
      if (isExpanded) {
        
        const nodeCards = (nodeCardsMap[nodeId] || [])
          .filter((card: Card) => {
            
            return !card.nodeId || card.nodeId === nodeId;
          })
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
        
        const childNodes = nodeData.children
          .map(childId => {
            const childNode = base.nodes.find(n => n.id === childId);
            return childNode ? { id: childId, node: childNode, order: childNode.order || 0 } : null;
          })
          .filter(Boolean)
          .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: BaseNode; order: number }>;
        
        
        const existingCardIds = new Set((nodeCardsMap[nodeId] || []).map((c: Card) => c.docId));
        const existingNodeIds = new Set(base.nodes.map(n => n.id));
        
        
        const pendingCards = Array.from(pendingCreatesRef.current.values())
          .filter(c => c.type === 'card' && c.nodeId === nodeId && !existingCardIds.has(c.tempId))
          .map(create => {
            
            const tempCard = (nodeCardsMap[nodeId] || []).find((c: Card) => c.docId === create.tempId);
            const maxCardOrder = nodeCards.length > 0 ? Math.max(...nodeCards.map((c: Card) => c.order || 0)) : 0;
            const maxNodeOrder = childNodes.length > 0 ? Math.max(...childNodes.map(n => n.order || 0)) : 0;
            const maxOrder = Math.max(maxCardOrder, maxNodeOrder);
            return {
              type: 'card' as const,
              id: create.tempId,
              order: tempCard?.order || maxOrder + 1,
              data: tempCard || { docId: create.tempId, title: create.title || i18n('New card'), nodeId, order: maxOrder + 1 },
              isPending: true,
            };
          });
        
        
        const pendingNodes = Array.from(pendingCreatesRef.current.values())
          .filter(c => c.type === 'node' && c.nodeId === nodeId && !existingNodeIds.has(c.tempId))
          .map(create => {
            
            const tempNode = base.nodes.find(n => n.id === create.tempId);
            const maxCardOrder = nodeCards.length > 0 ? Math.max(...nodeCards.map((c: Card) => c.order || 0)) : 0;
            const maxNodeOrder = childNodes.length > 0 ? Math.max(...childNodes.map(n => n.order || 0)) : 0;
            const maxOrder = Math.max(maxCardOrder, maxNodeOrder);
            return {
              type: 'node' as const,
              id: create.tempId,
              order: tempNode?.order || maxOrder + 1,
              data: tempNode || { id: create.tempId, text: create.text || i18n('New node'), order: maxOrder + 1 },
              isPending: true,
            };
          });
        
        
        const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any; isPending?: boolean }> = [
          ...childNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: n.node, isPending: false })),
          ...nodeCards.map(c => ({ type: 'card' as const, id: c.docId, order: c.order || 0, data: c, isPending: false })),
          ...pendingCards,
          ...pendingNodes,
        ];
        
        
        allChildren.sort((a, b) => (a.order || 0) - (b.order || 0));
        
        
        allChildren.forEach(item => {
          if (item.type === 'card') {
            const card = item.data as Card;
            
            if (deletedCardIds.has(card.docId)) return;
            
            // Look up rename by both possible keys (card from nodeCards uses id `card-${docId}`, from pending may use docId)
            const renameRecord = pendingRenames.get(`card-${card.docId}`) ?? pendingRenames.get(card.docId);
            const displayName = renameRecord ? renameRecord.newName : (card.title || i18n('Unnamed Card'));
            const cardFileItem: FileItem = {
              type: 'card',
              id: item.isPending ? card.docId : `card-${card.docId}`,
              name: displayName,
              nodeId: card.nodeId || nodeId,
              cardId: card.docId,
              parentId: card.nodeId || nodeId,
              level: level + 1,
            };
            cardFileItem.hasPendingChanges = item.isPending || checkPendingChanges(cardFileItem);
            cardFileItem.clipboardType = checkClipboard(cardFileItem);
            items.push(cardFileItem);
          } else {
            buildTree(item.id, level + 1, nodeId);
          }
        });
      }
    };

    rootNodes.forEach((rootId) => {
      buildTree(rootId, 0);
    });
    
    
    
    const existingNodeIds = new Set(base.nodes.map(n => n.id));
    Array.from(pendingCreatesRef.current.values())
      .filter(c => c.type === 'node' && !c.nodeId && !existingNodeIds.has(c.tempId))
      .forEach(create => {
        const createFileItem: FileItem = {
          type: 'node',
          id: create.tempId,
          name: create.text || i18n('New node'),
          nodeId: create.tempId,
          level: 0,
        };
        createFileItem.hasPendingChanges = true;
        items.push(createFileItem);
      });

    return items;
  }, [base.nodes, base.edges, nodeCardsMapVersion, expandedNodes, pendingChanges, pendingRenames, pendingDragChanges, pendingDeletes, clipboard, editorRootNodeId]);

  useEffect(() => {
    fileTreeRef.current = fileTree;
    baseEdgesRef.current = base.edges;
  }, [fileTree, base.edges]);

  const triggerExpandAutoSave = useCallback(() => {
    
    if (expandSaveTimerRef.current) {
      clearTimeout(expandSaveTimerRef.current);
      expandSaveTimerRef.current = null;
    }

    expandSaveTimerRef.current = setTimeout(async () => {
      try {
        const currentExpandedNodes = expandedNodesRef.current;
        const currentBase = baseRef.current;
        const baseDocId = docId || (currentBase as any)?.docId;
        if (!baseDocId) {
          expandSaveTimerRef.current = null;
          return;
        }
        await request.post(getBaseUrl('/expand-state'), {
          docId: baseDocId,
          expandedNodeIds: Array.from(currentExpandedNodes),
        });
        expandSaveTimerRef.current = null;
      } catch (error: any) {
        console.error('保存展开状态失败:', error);
        expandSaveTimerRef.current = null;
      }
    }, 1500);
  }, [docId, getBaseUrl]);

  
  const toggleNodeExpanded = useCallback((nodeId: string) => {
    let newExpandedState: boolean;
    
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      const isExpanded = newSet.has(nodeId);
      newExpandedState = !isExpanded;
      
      if (isExpanded) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      
      
      expandedNodesRef.current = newSet;
      
      
      setBase(prev => {
        const updated = {
          ...prev,
          nodes: prev.nodes.map(n =>
            n.id === nodeId
              ? { ...n, expanded: newExpandedState }
              : n
          ),
        };
        
        baseRef.current = updated;
        return updated;
      });
      
      return newSet;
    });
    
    
    triggerExpandAutoSave();
  }, [triggerExpandAutoSave]);

  
  const handleSelectFile = useCallback(async (file: FileItem, skipUrlUpdate = false) => {
    
    if (isMultiSelectMode) {
      
      setSelectedItems(prev => {
        const next = new Set(prev);
        const isSelected = next.has(file.id);
        
        if (isSelected) {
          
          next.delete(file.id);
          
          
          if (file.type === 'node' && getNodeChildrenRef.current) {
            const children = getNodeChildrenRef.current(file.nodeId || '');
            children.nodes.forEach(nodeId => {
              const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
              if (nodeFile) next.delete(nodeFile.id);
            });
            children.cards.forEach(cardId => {
              const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
              if (cardFile) next.delete(cardFile.id);
            });
          }
        } else {
          
          next.add(file.id);
          
          
          if (file.type === 'node' && getNodeChildrenRef.current) {
            const children = getNodeChildrenRef.current(file.nodeId || '');
            children.nodes.forEach(nodeId => {
              const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
              if (nodeFile) next.add(nodeFile.id);
            });
            children.cards.forEach(cardId => {
              const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
              if (cardFile) next.add(cardFile.id);
            });
          }
        }
        
        return next;
      });
      return;
    }
    
    if (selectedItems.size > 0) setSelectedItems(new Set());
    
    
    if (file.type === 'node') {
      setSelectedFile(file);
      selectedFileRef.current = file;
      if (!skipUrlUpdate && file.nodeId) {
        const urlParams = new URLSearchParams(window.location.search);
        urlParams.set('nodeId', file.nodeId);
        urlParams.delete('cardId');
        const newUrl = window.location.pathname + '?' + urlParams.toString();
        window.history.pushState({ nodeId: file.nodeId }, '', newUrl);
      }
      return;
    }
    
    
    // Only persist editor content to pendingChanges when the previous selection was a card. When a node was selected we return early without loading node text, so the editor still shows a card's content; saving that as the node's change would incorrectly mark the parent node as modified.
    let pendingChangeToSave: { file: FileItem; content: string; originalContent: string } | null = null;
    if (selectedFile && selectedFile.type === 'card' && editorInstance) {
      try {
        const norm = normalizeCardContentForCompare;
        const currentContent = editorInstance.value() ?? fileContent;
        const nodeCards = (window as any).UiContext?.nodeCardsMap?.[selectedFile.nodeId || ''] || [];
        const cardRow = nodeCards.find((c: Card) => String(c.docId) === String(selectedFile.cardId));
        const mapContent = cardRow ? (cardRow.content ?? '') : null;
        const refOriginal =
          originalContentsRef.current.get(selectedFile.id)
          ?? originalContentsRef.current.get(`card-${selectedFile.cardId}`)
          ?? originalContentsRef.current.get(String(selectedFile.cardId))
          ?? '';
        const dirtyVsMap = mapContent !== null && norm(currentContent) !== norm(mapContent);
        const dirtyVsRefFallback = mapContent === null && norm(currentContent) !== norm(refOriginal);
        if (dirtyVsMap || dirtyVsRefFallback) {
          const originalContent = mapContent !== null ? mapContent : refOriginal;
          pendingChangeToSave = { file: selectedFile, content: currentContent, originalContent };
        }
      } catch (error) {
      }
    }
    
    setSelectedFile(file);
    selectedFileRef.current = file;
    
    
    if (!skipUrlUpdate && file.type === 'card' && file.cardId) {
      const urlParams = new URLSearchParams(window.location.search);
      urlParams.set('cardId', String(file.cardId));
      urlParams.delete('nodeId');
      const newUrl = window.location.pathname + '?' + urlParams.toString();
      window.history.pushState({ cardId: file.cardId }, '', newUrl);
    }
    
    
    const pendingChange = pendingChanges.get(file.id);
    let content = '';
    
    if (pendingChange) {
      
      content = pendingChange.content;
    } else {
      
      if (file.type === 'card') {
        
        const nodeCards = (window as any).UiContext?.nodeCardsMap?.[file.nodeId || ''] || [];
        const card = nodeCards.find((c: Card) => c.docId === file.cardId);
        content = card?.content || '';
        /** Always sync baseline to the source we display (avoids false "pending" after save when ref was stale). */
        originalContentsRef.current.set(file.id, content);
        if (file.cardId) {
          const cid = String(file.cardId);
          originalContentsRef.current.set(`card-${cid}`, content);
          originalContentsRef.current.set(cid, content);
        }
      }
    }
    
    if (pendingChangeToSave) {
      setPendingChanges((prev) => {
        const newMap = new Map(prev);
        newMap.set(pendingChangeToSave!.file.id, {
          file: pendingChangeToSave!.file,
          content: pendingChangeToSave!.content,
          originalContent: pendingChangeToSave!.originalContent,
        });
        return newMap;
      });
    }
    startTransition(() => {
      setFileContent(content);
    });
  }, [base.nodes, selectedFile, editorInstance, fileContent, pendingChanges, isMultiSelectMode, fileTree, selectedItems]);

  
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    const nodeId = urlParams.get('nodeId');
    const cardIdStr = cardId ? String(cardId) : '';
    const nodeIdStr = nodeId ? String(nodeId) : '';
    if (cardIdStr && fileTree.length > 0) {
      const cardFile = fileTree.find(f => f.type === 'card' && String(f.cardId) === cardIdStr);
      if (cardFile) {
        const needSelect = !selectedFile || selectedFile.type !== 'card' || String(selectedFile.cardId) !== cardIdStr;
        if (needSelect) {
          handleSelectFile(cardFile, true);
          return;
        }
        return;
      }
    }
    if (nodeIdStr && fileTree.length > 0) {
      const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeIdStr);
      if (nodeFile && (!selectedFile || selectedFile.type !== 'node' || selectedFile.nodeId !== nodeIdStr)) {
        handleSelectFile(nodeFile, true);
      }
    }
  }, [fileTree, selectedFile, handleSelectFile]);

  
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const urlParams = new URLSearchParams(window.location.search);
      const cardId = urlParams.get('cardId');
      const nodeId = urlParams.get('nodeId');
      const cardIdStr = cardId ? String(cardId) : '';
      const nodeIdStr = nodeId ? String(nodeId) : '';
      if (cardIdStr && fileTree.length > 0) {
        const cardFile = fileTree.find(f => f.type === 'card' && String(f.cardId) === cardIdStr);
        if (cardFile && (!selectedFile || selectedFile.type !== 'card' || String(selectedFile.cardId) !== cardIdStr)) {
          handleSelectFile(cardFile, true);
        }
        return;
      }
      if (nodeIdStr && fileTree.length > 0) {
        const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeIdStr);
        if (nodeFile && (!selectedFile || selectedFile.type !== 'node' || selectedFile.nodeId !== nodeIdStr)) {
          handleSelectFile(nodeFile, true);
        }
        const b = baseRef.current;
        if (b?.nodes?.length && b.nodes.some((n) => n.id === nodeIdStr)) {
          const anc = collectOutlineAncestors(nodeIdStr, b.nodes, b.edges || []);
          setExpandedNodes((prev) => {
            const next = new Set(prev);
            next.add(nodeIdStr);
            anc.forEach((id) => next.add(id));
            return next;
          });
        }
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [fileTree, selectedFile, handleSelectFile]);


  
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    if (!cardId || base.nodes.length === 0) return;
    if (hasExpandedForCardIdRef.current === cardId) return;
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    let nodeId: string | null = null;
    for (const nid of Object.keys(nodeCardsMap)) {
      const cards = (nodeCardsMap[nid] || []) as Array<{ docId?: string }>;
      if (cards.some((c) => c.docId === cardId)) {
        nodeId = nid;
        break;
      }
    }
    if (!nodeId) return;
    const collectAncestors = (id: string): string[] => {
      const edge = base.edges.find((e) => e.target === id);
      if (!edge) return [];
      return [edge.source, ...collectAncestors(edge.source)];
    };
    const toExpand = [nodeId, ...collectAncestors(nodeId)];
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      toExpand.forEach((id) => next.add(id));
      return next;
    });
    hasExpandedForCardIdRef.current = cardId;
  }, [base.nodes.length, base.edges]);

  useEffect(() => {
    if (typeof window === 'undefined' || base.nodes.length === 0) return;
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('cardId')) return;
    const fromUrl = urlParams.get('nodeId')?.trim() || '';
    if (!fromUrl) return;
    if (!base.nodes.some((n) => n.id === fromUrl)) return;
    if (hasExpandedForUrlNodeIdRef.current === fromUrl) return;
    const anc = collectOutlineAncestors(fromUrl, base.nodes, base.edges || []);
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      next.add(fromUrl);
      anc.forEach((id) => next.add(id));
      return next;
    });
    hasExpandedForUrlNodeIdRef.current = fromUrl;
  }, [base.nodes, base.edges]);

  
  useEffect(() => {
    if (!selectedFile || explorerMode !== 'tree') return;
    const id = selectedFile.id;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = explorerScrollRef.current;
        if (!container) return;
        const el = container.querySelector(`[data-file-id="${id}"]`);
        if (el) (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedFile?.id, explorerMode]);

  /** Append an empty single-choice row; edit in place, then save with the rest of pending changes. */

  const handleAddBlankProblem = useCallback(() => {
    if (!selectedFile || selectedFile.type !== 'card') {
      Notification.error(i18n('Please select a card on the left first'));
      return;
    }

    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeId = selectedFile.nodeId || '';
    const nodeCards: Card[] = nodeCardsMap[nodeId] || [];
    const card = nodeCards.find((c: Card) => sameCardDocId(c.docId, selectedFile.cardId));

    if (!card) {
      Notification.error(i18n('Card data not found, cannot generate problem'));
      return;
    }

    const newProblem: ProblemSingle = {
      pid: `p_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      type: 'single',
      stem: '',
      options: ['', '', '', ''],
      answer: 0,
    };
    const updatedProblems = [...(card.problems || []), newProblem];

    if (nodeCardsMap[nodeId]) {
      const cardIndex = nodeCards.findIndex((c: Card) => sameCardDocId(c.docId, selectedFile.cardId));
      if (cardIndex >= 0) {
        nodeCards[cardIndex] = {
          ...nodeCards[cardIndex],
          problems: updatedProblems,
        };
        (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
        setNodeCardsMapVersion(prev => prev + 1);

        const cardIdStr = String(selectedFile.cardId || '');
        setPendingProblemCardIds(prev => {
          const next = new Set(prev);
          next.add(cardIdStr);
          return next;
        });
        setPendingNewProblemCardIds(prev => {
          const next = new Set(prev);
          next.add(cardIdStr);
          return next;
        });
        setNewProblemIds((prev) => new Set(prev).add(newProblem.pid));
      }
    }
  }, [selectedFile, setNodeCardsMapVersion, setPendingProblemCardIds, setPendingNewProblemCardIds, setNewProblemIds]);


  const handleSaveAll = useCallback(async () => {
    if (isCommitting) {
      return;
    }

    setIsCommitting(true);

    
    let allChanges = new Map(pendingChanges);
    if (selectedFile && selectedFile.type === 'card' && editorInstance) {
      try {
        const norm = normalizeCardContentForCompare;
        const currentContent = editorInstance.value() ?? fileContent;
        const nodeCards = (window as any).UiContext?.nodeCardsMap?.[selectedFile.nodeId || ''] || [];
        const cardRow = nodeCards.find((c: Card) => String(c.docId) === String(selectedFile.cardId));
        const mapContent = cardRow ? (cardRow.content ?? '') : null;
        const refOriginal =
          originalContentsRef.current.get(selectedFile.id)
          ?? originalContentsRef.current.get(`card-${selectedFile.cardId}`)
          ?? originalContentsRef.current.get(String(selectedFile.cardId))
          ?? '';
        const dirtyVsMap = mapContent !== null && norm(currentContent) !== norm(mapContent);
        const dirtyVsRefFallback = mapContent === null && norm(currentContent) !== norm(refOriginal);
        if (dirtyVsMap || dirtyVsRefFallback) {
          const originalContent = mapContent !== null ? mapContent : refOriginal;
          allChanges.set(selectedFile.id, {
            file: selectedFile,
            content: currentContent,
            originalContent,
          });
        }
      } catch (error) {
      }
    }

    const hasContentChanges = allChanges.size > 0;
    const hasDragChanges = pendingDragChanges.size > 0;
    const hasRenameChanges = pendingRenames.size > 0;
    const hasCreateChanges = pendingCreatesRef.current.size > 0;
    const hasDeleteChanges = pendingDeletes.size > 0;
    const hasProblemChanges = pendingProblemCardIds.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0;

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      
      const batchSaveData: any = {
        ...(docId ? { docId } : {}),
        branch: (window as any).UiContext?.currentBranch || 'main',
        nodeCreates: [],
        nodeUpdates: [],
        nodeDeletes: [],
        cardCreates: [],
        cardUpdates: [],
        cardDeletes: [],
        edgeCreates: [],
        edgeDeletes: [],
      };
      const developSid = new URLSearchParams(window.location.search).get('session');
      if (developSid && basePath === 'base') {
        batchSaveData.developSessionId = developSid;
        batchSaveData.developEditorLocation = `${window.location.pathname}${window.location.search || ''}`;
      }

      const baseDocIdNumForSave = docId ? Number(docId) : NaN;
      const saveBranch = batchSaveData.branch;
      const editorUiPrefsPayload =
        Number.isFinite(baseDocIdNumForSave) && baseDocIdNumForSave > 0
          ? {
              explorerMode,
              rightPanelOpen,
              aiBottomOpen: editorAiHidden ? false : aiBottomOpen,
              explorerPanelWidth,
              problemsPanelWidth,
              aiPanelHeight,
            }
          : null;

      if (editorUiPrefsPayload) batchSaveData.editorUiPrefs = editorUiPrefsPayload;

      const nodeIdMap = new Map<string, string>();
      const cardIdMap = new Map<string, string>();
      let createCountBeforeSave = 0;
      
      
      if (hasCreateChanges) {
        const creates = Array.from(pendingCreatesRef.current.entries()).map(([tempId, create]) => ({ tempId, ...create })).filter(c => 
          c.tempId && (c.tempId.startsWith('temp-node-') || c.tempId.startsWith('temp-card-'))
        );
        createCountBeforeSave = creates.length;
        
        
        const nodeCreates = creates.filter(c => c.type === 'node');
        const nodeIdSet = new Set<string>();
        
        for (const create of nodeCreates) {
          if (nodeIdSet.has(create.tempId)) {
            continue;
          }
          nodeIdSet.add(create.tempId);
          
          const renameRecord = pendingRenames.get(create.tempId);
          const nodeText = renameRecord ? renameRecord.newName : (create.text || i18n('New node'));
          const existingNode = base.nodes.find(n => n.id === create.tempId);
          const nodeOrder = existingNode?.order;
          batchSaveData.nodeCreates.push({
            tempId: create.tempId,
            text: nodeText,
            parentId: create.nodeId,
            x: (create as any).x,
            y: (create as any).y,
            ...(nodeOrder !== undefined && nodeOrder !== null && { order: nodeOrder }),
          });
        }
        
        
        const cardCreates = creates.filter(c => c.type === 'card');
        const cardIdSet = new Set<string>();
        
        for (const create of cardCreates) {
          if (cardIdSet.has(create.tempId)) {
            continue;
          }
          cardIdSet.add(create.tempId);
          
          const createNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
          let createNodeId = create.nodeId;
          
          if (!createNodeId) {
            continue;
          }
          
          
          
          let createNodeCards: Card[] = createNodeCardsMap[createNodeId] || [];
          if (createNodeCards.length === 0 && create.nodeId && create.nodeId.startsWith('temp-node-')) {
            createNodeCards = createNodeCardsMap[create.nodeId] || [];
          }
          const tempCard = createNodeCards.find((c: Card) => c.docId === create.tempId);

          
          const contentChange = allChanges.get(`card-${create.tempId}`);
          const finalContent = contentChange?.content ?? tempCard?.content ?? '';
          
          const cardRenameKey = `card-${create.tempId}`;
          const renameRecord = pendingRenames.get(cardRenameKey);
          const finalTitle = renameRecord ? renameRecord.newName : (create.title || tempCard?.title || i18n('New card'));
          const finalProblems = tempCard?.problems;

          const childNodeIds = base.edges.filter((e: BaseEdge) => e.source === createNodeId).map((e: BaseEdge) => e.target);
          const childNodesForOrder = childNodeIds.map((id: string) => base.nodes.find((n: BaseNode) => n.id === id)).filter(Boolean) as BaseNode[];
          const maxCardOrder = createNodeCards.length > 0 ? Math.max(...createNodeCards.map((c: Card) => c.order || 0)) : 0;
          const maxNodeOrder = childNodesForOrder.length > 0 ? Math.max(...childNodesForOrder.map((n: BaseNode) => n.order || 0)) : 0;
          const finalOrder = tempCard?.order ?? Math.max(maxCardOrder, maxNodeOrder) + 1;

          batchSaveData.cardCreates.push({
            tempId: create.tempId,
            nodeId: createNodeId,
            title: finalTitle,
            content: finalContent,
            problems: finalProblems,
            order: finalOrder,
          });
        }
      }
      
      
      if (hasContentChanges) {
        
        
        const tempNodeKeysToRemove: string[] = [];
        for (const [key, change] of allChanges.entries()) {
          if (change.file.type === 'node') {
            const isTempNode = (key && key.startsWith('temp-node-')) ||
                              (change.file.id && change.file.id.startsWith('temp-node-')) ||
                              (change.file.nodeId && change.file.nodeId.startsWith('temp-node-'));
            if (isTempNode) {
              tempNodeKeysToRemove.push(key);
            }
          }
        }
        
        tempNodeKeysToRemove.forEach(key => {
          allChanges.delete(key);
        });
        
        const changes = Array.from(allChanges.values());
        
        for (const change of changes) {
          if (change.file.type === 'node') {
            const isTempNode = (change.file.id && change.file.id.startsWith('temp-node-')) ||
                              (change.file.nodeId && change.file.nodeId.startsWith('temp-node-'));
            if (isTempNode) {
              continue;
            }
            
            const nodeIdToUpdate = change.file.nodeId || change.file.id;
            if (!nodeIdToUpdate || nodeIdToUpdate.startsWith('temp-node-')) {
              continue;
            }
            
            batchSaveData.nodeUpdates.push({ nodeId: nodeIdToUpdate, text: change.content });
          } else if (change.file.type === 'card') {
            const cardNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
            const cardNodeId = change.file.nodeId || '';
            const cardNodeCards: Card[] = cardNodeCardsMap[cardNodeId] || [];
            const cardIndex = cardNodeCards.findIndex((c: Card) => sameCardDocId(c.docId, change.file.cardId));
            const card = cardIndex >= 0 ? cardNodeCards[cardIndex] : null;
            
            const problems = card?.problems;

            
            if (!change.file.cardId || String(change.file.cardId).startsWith('temp-card-')) {
              continue;
            }

            
            batchSaveData.cardUpdates.push({
              cardId: change.file.cardId,
              nodeId: change.file.nodeId || '',
              content: change.content,
              title: card?.title,
              problems,
            });
          }
        }
      }

      
      if (hasProblemChanges) {
        
        const nodeCardsMapForProblems = (window as any).UiContext?.nodeCardsMap || {};
        
        const contentChangedCardIds = new Set<string>();
        for (const change of allChanges.values()) {
          if (change.file.type === 'card' && change.file.cardId) {
            contentChangedCardIds.add(String(change.file.cardId));
          }
        }

        
        const problemUpdates: Array<{ cardId: string; nodeId: string; problems: Problem[] }> = [];
        
        for (const problemCardId of Array.from(pendingProblemCardIds)) {
          
          if (String(problemCardId).startsWith('temp-card-')) continue;
          
          if (contentChangedCardIds.has(String(problemCardId))) continue;

          
          let foundNodeId: string | null = null;
          let foundCard: Card | null = null;
          for (const nodeId in nodeCardsMapForProblems) {
            const cards: Card[] = nodeCardsMapForProblems[nodeId] || [];
            const card = cards.find((c) => sameCardDocId(c.docId, problemCardId));
            if (card) {
              foundNodeId = nodeId;
              foundCard = card;
              break;
            }
          }

          if (!foundNodeId || !foundCard) {
            continue;
          }

          
          const problemsToSave = foundCard.problems || [];
          
          problemUpdates.push({
            cardId: problemCardId,
            nodeId: foundNodeId,
            problems: problemsToSave,
          });
        }
        
        
        for (const { cardId, nodeId, problems } of problemUpdates) {
          const existingUpdate = batchSaveData.cardUpdates.find((u: any) => sameCardDocId(u.cardId, cardId));
          if (existingUpdate) {
            existingUpdate.problems = problems;
          } else {
            batchSaveData.cardUpdates.push({
              cardId,
              nodeId,
              problems,
            });
          }
        }
        
      }
      
      
      if (hasDragChanges) {
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        
        
        const nodeOrderUpdates = new Set<string>();
        const cardIdsToUpdateOrder = new Set<string>();
        const nodeEdgeUpdates = new Map<string, { newEdge: BaseEdge | null; oldEdges: BaseEdge[] }>();
        
        
        for (const cardId of pendingDragChanges) {
          if (cardId.startsWith('node-')) {
            
            const nodeId = cardId.replace('node-', '');
            nodeOrderUpdates.add(nodeId);
            
            
            const newEdges = base.edges.filter(e => e.target === nodeId);
            const newEdge = newEdges.length > 0 ? newEdges[0] : null;
            
            
            const oldEdges = base.edges.filter(
              (e: BaseEdge) => e.target === nodeId
            );
            
            nodeEdgeUpdates.set(nodeId, { newEdge, oldEdges });
          } else {
            
            cardIdsToUpdateOrder.add(cardId);
          }
        }
        
        
        let currentBase: BaseDoc | null = null;
        if (nodeEdgeUpdates.size > 0) {
          try {
            const fetchQs: Record<string, string> = {};
            if (docId) fetchQs.docId = docId;
            const fb = (window as any).UiContext?.currentBranch;
            if (fb) fetchQs.branch = fb;
            currentBase = await request.get(
              basePath === 'base/skill'
                ? `/d/${domainId}/base/skill/data`
                : `/d/${domainId}/base/data`,
              fetchQs,
            );
          } catch (error: any) {
          }
        }
        
        
        for (const [nodeId, { newEdge, oldEdges: localOldEdges }] of nodeEdgeUpdates) {
          if (!newEdge) continue;
          
          try {
            
            const edgesToCheck = currentBase?.edges || localOldEdges;
            const oldEdges = edgesToCheck.filter(
              (e: BaseEdge) => e.target === nodeId
            );
            
            
            const edgeExists = oldEdges.some(
              (e: BaseEdge) => e.source === newEdge.source && e.target === newEdge.target
            );
            
            
            for (const oldEdge of oldEdges) {
              
              const isNewEdge = oldEdge.source === newEdge.source && oldEdge.target === newEdge.target;
              if (!isNewEdge && oldEdge.id) {
                
                if (oldEdge.id.startsWith('temp-') || oldEdge.id.startsWith('edge-')) {
                  continue;
                }
                
                
                if (!batchSaveData.edgeDeletes.includes(oldEdge.id)) {
                  batchSaveData.edgeDeletes.push(oldEdge.id);
                }
              }
            }
            
            
            if (!edgeExists) {
              batchSaveData.edgeCreates.push({
                source: newEdge.source,
                target: newEdge.target,
                label: (newEdge as any).label,
              });
            }
          } catch (error: any) {
            // If update fails, try to create edge directly
            batchSaveData.edgeCreates.push({
              source: newEdge.source,
              target: newEdge.target,
              label: (newEdge as any).label,
            });
          }
        }
        
        
        for (const nodeId of nodeOrderUpdates) {
          const node = base.nodes.find(n => n.id === nodeId);
          if (node && !node.id.startsWith('temp-node-')) {
            const existingUpdate = batchSaveData.nodeUpdates.find((u: any) => u.nodeId === nodeId);
            if (existingUpdate) {
              existingUpdate.order = node.order !== undefined ? node.order : 0;
            } else {
              batchSaveData.nodeUpdates.push({ 
                nodeId, 
                order: node.order !== undefined ? node.order : 0,
              });
            }
          }
        }
        
        
        for (const nodeId in nodeCardsMap) {
          const cards = nodeCardsMap[nodeId] || [];
          for (const card of cards) {
            
            if (String(card.docId).startsWith('temp-card-')) continue;
            
            if (cardIdsToUpdateOrder.has(card.docId) && card.order !== undefined && card.order !== null) {
              const existingUpdate = batchSaveData.cardUpdates.find((u: any) => sameCardDocId(u.cardId, card.docId));
              if (existingUpdate) {
                existingUpdate.order = card.order;
              } else {
                batchSaveData.cardUpdates.push({
                  cardId: card.docId,
                  nodeId: nodeId,
                  order: card.order,
                });
              }
            }
          }
        }
        
      }
      
      
      if (hasRenameChanges) {
        
        
        
        const renames = Array.from(pendingRenames.values());
        
        
        const updatedRenames = renames.map(rename => {
          if (rename.file.type === 'node') {
            const nodeId = rename.file.nodeId || rename.file.id;
            
            if (nodeId && nodeId.startsWith('temp-node-') && nodeIdMap.has(nodeId)) {
              const realNodeId = nodeIdMap.get(nodeId)!;
              return {
                ...rename,
                file: {
                  ...rename.file,
                  id: realNodeId,
                  nodeId: realNodeId,
                },
              };
            }
          }
          return rename;
        });
        
        
        for (const rename of updatedRenames) {
          if (rename.file.type === 'node') {
            
            const nodeId = rename.file.nodeId || rename.file.id;
            if (!nodeId || nodeId.startsWith('temp-node-')) {
              continue;
            }
            
            
            const existingUpdate = batchSaveData.nodeUpdates.find((u: any) => u.nodeId === nodeId);
            if (existingUpdate) {
              existingUpdate.text = rename.newName;
            } else {
              batchSaveData.nodeUpdates.push({ nodeId, text: rename.newName });
            }
          } else if (rename.file.type === 'card') {
            
            if (!rename.file.cardId || String(rename.file.cardId).startsWith('temp-card-')) {
              continue;
            }
            
            
            const existingUpdate = batchSaveData.cardUpdates.find((u: any) => u.cardId === rename.file.cardId);
            if (existingUpdate) {
              existingUpdate.title = rename.newName;
            } else {
              batchSaveData.cardUpdates.push({ 
                cardId: rename.file.cardId, 
                nodeId: rename.file.nodeId || '',
                title: rename.newName,
              });
            }
          }
        }
        
      }

      const hasDeleteChanges = pendingDeletes.size > 0;
      
      
      if (hasDeleteChanges) {
        
        const deletes = Array.from(pendingDeletes.values());
        
        
        const cardDeletes = deletes.filter(d => d.type === 'card');
        const nodeDeletes = deletes.filter(d => d.type === 'node');
        
        
        const realCardDeletes = cardDeletes.filter(del => 
          del.id && !String(del.id).startsWith('temp-card-')
        );
        
        
        realCardDeletes.forEach(del => {
          batchSaveData.cardDeletes.push(del.id);
        });
        
        
        const realNodeDeletes = nodeDeletes
          .filter(del => del.id && !String(del.id).startsWith('temp-node-'))
          .filter(del => {
            const id = String(del.id || '');
            if (!id) return false;
            return true;
          });
        
        if (realNodeDeletes.length > 0) {
          
          const nodeIdsToDelete = new Set(realNodeDeletes.map(del => del.id));
          
          
          const edgesToDelete = base.edges.filter(
            (e: BaseEdge) => nodeIdsToDelete.has(e.source) || nodeIdsToDelete.has(e.target)
          );
          
          
          edgesToDelete.forEach(edge => {
            if (edge.id && !edge.id.startsWith('temp-edge-')) {
              batchSaveData.edgeDeletes.push(edge.id);
            }
          });
          
          
          realNodeDeletes.forEach(del => {
            batchSaveData.nodeDeletes.push(del.id);
          });
        }

      }

      
      for (const [cardId, cardFace] of Object.entries(pendingCardFaceChanges)) {
        if (String(cardId).startsWith('temp-card-')) continue;
        const existing = batchSaveData.cardUpdates.find((u: any) => u.cardId === cardId);
        if (existing) {
          existing.cardFace = cardFace;
        } else {
          const nodeCardsMapForFace = (window as any).UiContext?.nodeCardsMap || {};
          let nodeId = '';
          let title = '';
          for (const nid of Object.keys(nodeCardsMapForFace)) {
            const card = (nodeCardsMapForFace[nid] || []).find((c: Card) => c.docId === cardId);
            if (card) { nodeId = nid; title = card.title; break; }
          }
          if (nodeId) batchSaveData.cardUpdates.push({ cardId, nodeId, title, cardFace });
        }
      }

      const hasAnyChanges = 
        batchSaveData.nodeCreates.length > 0 ||
        batchSaveData.nodeUpdates.length > 0 ||
        batchSaveData.nodeDeletes.length > 0 ||
        batchSaveData.cardCreates.length > 0 ||
        batchSaveData.cardUpdates.length > 0 ||
        batchSaveData.cardDeletes.length > 0 ||
        batchSaveData.edgeCreates.length > 0 ||
        batchSaveData.edgeDeletes.length > 0;
      
      if (hasAnyChanges) {
        
        try {
          const response = await request.post(getBaseUrl('/batch-save'), batchSaveData);
          
          if (response.success) {
            const det = (response as any).developSessionEditTotals;
            if (det && typeof det === 'object') {
              setDevelopSessionEditTotals({
                nodes: Number(det.nodes) || 0,
                cards: Number(det.cards) || 0,
                problems: Number(det.problems) || 0,
              });
            }
            if (response.nodeIdMap) {
              Object.entries(response.nodeIdMap).forEach(([tempId, realId]) => {
                nodeIdMap.set(tempId, realId as string);
              });
            }
            
            if (response.cardIdMap) {
              Object.entries(response.cardIdMap).forEach(([tempId, realId]) => {
                cardIdMap.set(tempId, realId as string);
              });
            }
            
            
            if (response.nodeIdMap && Object.keys(response.nodeIdMap).length > 0) {
              setBase(prev => ({
                ...prev,
                nodes: prev.nodes.map(n => {
                  const realId = nodeIdMap.get(n.id);
                  return realId ? { ...n, id: realId } : n;
                }).filter(n => !n.id.startsWith('temp-node-')),
                edges: prev.edges.map(e => {
                  const realSource = nodeIdMap.get(e.source) || e.source;
                  const realTarget = nodeIdMap.get(e.target) || e.target;
                  return { ...e, source: realSource, target: realTarget };
                }).filter(e => 
                  !e.source.startsWith('temp-node-') && 
                  !e.target.startsWith('temp-node-') &&
                  !e.id.startsWith('temp-edge-')
                ),
              }));
              setExpandedNodes(prev => {
                const next = new Set(prev);
                nodeIdMap.forEach((realId, tempId) => {
                  next.delete(tempId);
                  next.add(realId);
                });
                expandedNodesRef.current = next;
                return next;
              });
            }
            
            
            if (cardIdMap.size > 0 || nodeIdMap.size > 0) {
              const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
              const updatedNodeCardsMap: any = {};
              
              for (const [nodeId, cards] of Object.entries(nodeCardsMap)) {
                const realNodeId = nodeIdMap.get(nodeId) || nodeId;
                if (realNodeId && !realNodeId.startsWith('temp-node-')) {
                  const updatedCards = (cards as Card[])
                    .map((card: Card) => {
                      const realCardId = cardIdMap.get(String(card.docId)) || card.docId;
                      return { ...card, docId: realCardId, nodeId: realNodeId };
                    })
                    .filter((card: Card) => !String(card.docId).startsWith('temp-card-'));
                  
                  if (updatedCards.length > 0) {
                    updatedNodeCardsMap[realNodeId] = updatedCards;
                  }
                }
              }
              
              (window as any).UiContext.nodeCardsMap = updatedNodeCardsMap;
            }
            
            
            for (const cardUpdate of batchSaveData.cardUpdates) {
              const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
              const cards = nodeCardsMap[cardUpdate.nodeId] || [];
              const cardIndex = cards.findIndex((c: Card) => String(c.docId) === String(cardUpdate.cardId));
              if (cardIndex >= 0) {
                const next = { ...cards[cardIndex] };
                if (cardUpdate.content !== undefined) next.content = cardUpdate.content;
                if (cardUpdate.title !== undefined) next.title = cardUpdate.title;
                if (cardUpdate.problems !== undefined) next.problems = cardUpdate.problems;
                if (cardUpdate.order !== undefined) next.order = cardUpdate.order;
                cards[cardIndex] = next;
              }
            }
            
            
            for (const cardCreate of batchSaveData.cardCreates) {
              const realCardId = cardIdMap.get(cardCreate.tempId);
              const realNodeId = nodeIdMap.get(cardCreate.nodeId) || cardCreate.nodeId;
              
              if (realCardId && realNodeId && !realNodeId.startsWith('temp-node-')) {
                const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                if (!nodeCardsMap[realNodeId]) {
                  nodeCardsMap[realNodeId] = [];
                }
                const existingIndex = nodeCardsMap[realNodeId].findIndex((c: Card) => c.docId === realCardId);
                const existingCard = existingIndex >= 0 ? nodeCardsMap[realNodeId][existingIndex] : null;
                const maxOrder = nodeCardsMap[realNodeId].length > 0 ? Math.max(...nodeCardsMap[realNodeId].map((c: Card) => c.order ?? 0)) : 0;
                const cardOrder = existingCard?.order != null ? existingCard.order : maxOrder + 1;
                const newCard: Card = {
                  docId: realCardId,
                  nodeId: realNodeId,
                  title: cardCreate.title,
                  content: cardCreate.content,
                  problems: cardCreate.problems,
                  order: cardOrder,
                } as Card;
                if (existingIndex >= 0) {
                  nodeCardsMap[realNodeId][existingIndex] = { ...existingCard, ...newCard, order: cardOrder };
                } else {
                  nodeCardsMap[realNodeId].push(newCard);
                }
                nodeCardsMap[realNodeId].sort((a: Card, b: Card) => (a.order ?? 0) - (b.order ?? 0));
              }
            }
            
            (window as any).UiContext.nodeCardsMap = { ...(window as any).UiContext?.nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);

            if (cardIdMap.size > 0) {
              const q = new URLSearchParams(window.location.search);
              const qCard = q.get('cardId');
              if (qCard && cardIdMap.has(qCard)) {
                q.set('cardId', cardIdMap.get(qCard)!);
                window.history.replaceState(window.history.state, '', `${window.location.pathname}?${q.toString()}`);
              }
              const sel = selectedFileRef.current;
              if (
                sel &&
                sel.type === 'card' &&
                sel.cardId &&
                cardIdMap.has(String(sel.cardId))
              ) {
                const realCardId = cardIdMap.get(String(sel.cardId))!;
                const realNodeId =
                  (sel.nodeId && nodeIdMap.has(String(sel.nodeId))
                    ? nodeIdMap.get(String(sel.nodeId))!
                    : sel.nodeId) || '';
                const maps = (window as any).UiContext?.nodeCardsMap || {};
                const cardRow =
                  realNodeId && maps[realNodeId]
                    ? (maps[realNodeId] as Card[]).find((c: Card) => String(c.docId) === String(realCardId))
                    : null;
                const newId = `card-${realCardId}`;
                const updated: FileItem = {
                  ...sel,
                  id: newId,
                  cardId: realCardId,
                  nodeId: realNodeId || sel.nodeId,
                  parentId: realNodeId || sel.parentId,
                  name: cardRow?.title ?? sel.name,
                };
                selectedFileRef.current = updated;
                setSelectedFile(updated);
                for (const key of [sel.id, `card-${sel.cardId}`, String(sel.cardId)]) {
                  if (originalContentsRef.current.has(key)) {
                    const v = originalContentsRef.current.get(key)!;
                    originalContentsRef.current.delete(key);
                    originalContentsRef.current.set(newId, v);
                  }
                }
              }
            }

            for (const nodeCreate of batchSaveData.nodeCreates) {
              pendingCreatesRef.current.delete(nodeCreate.tempId);
            }
            for (const cardCreate of batchSaveData.cardCreates) {
              pendingCreatesRef.current.delete(cardCreate.tempId);
            }
            setPendingCreatesCount(pendingCreatesRef.current.size);
            
            if (response.errors && response.errors.length > 0) {
              Notification.warn(i18n('Save completed, but {0} error(s) occurred', response.errors.length));
            }
          } else {
            const r = response as { url?: string; errors?: string[] };
            if (typeof r.url === 'string' && r.url && /\/login(\?|#|$)/i.test(r.url)) {
              throw Object.assign(new Error("You're not logged in."), { rawMessage: "You're not logged in." });
            }
            throw new Error(r.errors?.join(', ') || i18n('Batch save failed'));
          }
        } catch (error: any) {
          throw error;
        }
      }

      
      
      
      let actualRenameCount = 0;
      if (hasRenameChanges && nodeIdMap.size > 0) {
        
        const renames = Array.from(pendingRenames.values());
        actualRenameCount = renames.filter(rename => {
          if (rename.file.type === 'node') {
            const nodeId = rename.file.nodeId || rename.file.id;
            
            if (nodeId && nodeId.startsWith('temp-node-') && nodeIdMap.has(nodeId)) {
              return false;
            }
          }
          return true;
        }).length;
      } else {
        actualRenameCount = hasRenameChanges ? pendingRenames.size : 0;
      }
      
      
      setPendingChanges(new Map());
      setPendingDragChanges(new Set());
      setPendingRenames(new Map());
      pendingCreatesRef.current.clear();
      setPendingCreatesCount(0);
      setPendingDeletes(new Map());
      setPendingCardFaceChanges(prev => {
        const next = { ...prev };
        batchSaveData.cardUpdates.forEach((u: any) => delete next[u.cardId]);
        return next;
      });
      const savedProblemCardIds = new Set<string>(pendingProblemCardIds);
      
      setPendingProblemCardIds(new Set());
      setPendingNewProblemCardIds(new Set());
      setPendingEditedProblemIds(new Map());
      const savedCardIds = new Set<string>();
      if (hasProblemChanges) {
        setNewProblemIds(new Set());
        setEditedProblemIds(new Set());
        
        for (const change of allChanges.values()) {
          if (change.file.type === 'card' && change.file.cardId) {
            savedCardIds.add(String(change.file.cardId));
          }
        }
      }
      
      
      const problemChangesCount = pendingNewProblemCardIds.size + pendingEditedProblemIds.size;
      
      const totalChanges = (hasContentChanges ? allChanges.size : 0) 
        + (hasDragChanges ? pendingDragChanges.size : 0) 
        + actualRenameCount
        + createCountBeforeSave
        + (hasDeleteChanges ? pendingDeletes.size : 0)
        + problemChangesCount;

      Notification.success(`保存成功，共 ${totalChanges} 项更改`);

      try {
        if (
          !hasAnyChanges &&
          Number.isFinite(baseDocIdNumForSave) &&
          baseDocIdNumForSave > 0 &&
          (editorUiPrefsPayload || developSid)
        ) {
          await request.post(getBaseUrl('/save'), {
            docId: baseDocIdNumForSave,
            branch: saveBranch,
            sidecarOnly: true,
            ...(developSid
              ? {
                  developSessionId: developSid,
                  developEditorLocation: `${window.location.pathname}${window.location.search || ''}`,
                }
              : {}),
            ...(editorUiPrefsPayload ? { editorUiPrefs: editorUiPrefsPayload } : {}),
          });
        }
      } catch (_persistUi: any) {
        if (_persistUi?.params?.[0] === 'DEVELOP_SESSION_CLOSED') {
          Notification.warn(i18n('Develop session closed reload hint'));
          window.location.reload();
          return;
        }
        /* layout / develop nav persistence is best-effort */
      }
      
      if (hasCreateChanges || hasAnyChanges) {
        try {
          const postSaveQs: Record<string, string> = {};
          if (docId) postSaveQs.docId = docId;
          const psb = (window as any).UiContext?.currentBranch;
          if (psb) postSaveQs.branch = psb;
          const response = await request.get(
            basePath === 'base/skill'
              ? `/d/${domainId}/base/skill/data`
              : `/d/${domainId}/base/data`,
            postSaveQs,
          );
          setBase(response);
          if ((window as any).UiContext && response?.nodeCardsMap != null) {
            (window as any).UiContext.nodeCardsMap = response.nodeCardsMap;
          }
        } catch (error) {
        }
        
        for (const cardId of Array.from(savedProblemCardIds)) {
          if (!String(cardId).startsWith('temp-card-')) {
            savedCardIds.add(String(cardId));
          }
        }
        
        const mapAfterSave = (window as any).UiContext?.nodeCardsMap || {};
        for (const cardId of savedCardIds) {
          const cid = String(cardId);
          if (cid.startsWith('temp-card-')) continue;
          let foundCard: Card | null = null;
          for (const nodeId of Object.keys(mapAfterSave)) {
            const cards: Card[] = mapAfterSave[nodeId] || [];
            const card = cards.find((c: Card) => sameCardDocId(c.docId, cid));
            if (card) {
              foundCard = card;
              break;
            }
          }
          if (foundCard) {
            const originalProblems = new Map<string, Problem>();
            (foundCard.problems || []).forEach((p) => {
              originalProblems.set(p.pid, { ...p });
            });
            originalProblemsRef.current.set(cid, originalProblems);
          }
        }
        
        
        setNodeCardsMapVersion(prev => prev + 1);
        setOriginalProblemsVersion(prev => prev + 1);
      } else if (hasProblemChanges && savedProblemCardIds.size > 0) {
        const mapAfterSave = (window as any).UiContext?.nodeCardsMap || {};
        for (const rawId of savedProblemCardIds) {
          const cid = String(rawId);
          if (cid.startsWith('temp-card-')) continue;
          let foundCard: Card | null = null;
          for (const nodeId of Object.keys(mapAfterSave)) {
            const cards: Card[] = mapAfterSave[nodeId] || [];
            const card = cards.find((c: Card) => sameCardDocId(c.docId, cid));
            if (card) {
              foundCard = card;
              break;
            }
          }
          if (foundCard) {
            const originalProblems = new Map<string, Problem>();
            (foundCard.problems || []).forEach((p) => {
              originalProblems.set(p.pid, { ...p });
            });
            originalProblemsRef.current.set(cid, originalProblems);
          }
        }
        setOriginalProblemsVersion((prev) => prev + 1);
      }
      
      if (hasContentChanges) {
        const changes = Array.from(allChanges.values());
        changes.forEach(change => {
          if (change.file.type !== 'card' || !change.file.cardId) {
            originalContentsRef.current.set(change.file.id, change.content);
            return;
          }
          let primaryId = change.file.id;
          if (cardIdMap.has(String(change.file.cardId))) {
            primaryId = `card-${cardIdMap.get(String(change.file.cardId))!}`;
          }
          const cid = cardIdMap.has(String(change.file.cardId))
            ? String(cardIdMap.get(String(change.file.cardId)))
            : String(change.file.cardId);
          originalContentsRef.current.set(primaryId, change.content);
          originalContentsRef.current.set(`card-${cid}`, change.content);
          originalContentsRef.current.set(cid, change.content);
        });
      }
    } catch (error: any) {
      if (error?.params?.[0] === 'DEVELOP_SESSION_CLOSED') {
        Notification.warn(i18n('Develop session closed reload hint'));
        window.location.reload();
        return;
      }
      const msg = (error?.message || '').toLowerCase();
      const rawMsg = String(error?.rawMessage || '');
      const rawLower = rawMsg.toLowerCase();
      const isNotLoggedIn =
        msg.includes('not logged in')
        || rawLower.includes("you're not logged in")
        || rawLower.includes('privilegeerror')
        || msg.includes('privilegeerror')
        || msg.includes('您没有登录')
        || msg.includes('没有登录')
        || msg.includes('未登录');
      if (isNotLoggedIn) {
        Notification.warn(i18n('Save failed not logged in'));
        return;
      }
      Notification.error(i18n('Save failed') + ': ' + (error?.message || i18n('Unknown error')));
    } finally {
      setIsCommitting(false);
    }
  }, [pendingChanges, pendingDragChanges, pendingRenames, pendingDeletes, pendingCardFaceChanges, pendingProblemCardIds, pendingNewProblemCardIds, pendingEditedProblemIds, selectedFile, editorInstance, fileContent, docId, getBaseUrl, base.nodes, base.edges, setNodeCardsMapVersion, setNewProblemIds, setEditedProblemIds, setOriginalProblemsVersion, explorerMode, rightPanelOpen, aiBottomOpen, explorerPanelWidth, problemsPanelWidth, aiPanelHeight, editorAiHidden, developEditorContext, basePath]);

  useEffect(() => {
    saveHandlerRef.current = handleSaveAll;
  }, [handleSaveAll]);

  
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveHandlerRef.current?.();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  
  const handleRename = useCallback((file: FileItem, newName: string) => {
    if (!newName.trim()) {
      Notification.error(i18n('Name cannot be empty'));
      return;
    }

    const trimmedName = newName.trim();
    
    if (trimmedName === file.name) {
      setPendingRenames(prev => {
        const next = new Map(prev);
        next.delete(file.id);
        if (file.type === 'card' && file.cardId) {
          const altKey = file.id.startsWith('card-') ? file.cardId : `card-${file.cardId}`;
          if (altKey !== file.id) next.delete(altKey);
        }
        return next;
      });
      setEditingFile(null);
      return;
    }
    
    
    if (file.type === 'node') {
      setBase(prev => ({
        ...prev,
        nodes: prev.nodes.map(n => 
          n.id === file.nodeId 
            ? { ...n, text: trimmedName }
            : n
        ),
      }));
    } else if (file.type === 'card') {
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      if (nodeCardsMap[file.nodeId || '']) {
        const cards = nodeCardsMap[file.nodeId || ''];
        const cardIndex = cards.findIndex((c: Card) => c.docId === file.cardId);
        if (cardIndex >= 0) {
          cards[cardIndex] = { ...cards[cardIndex], title: trimmedName };
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
        }
      }
    }
    
    setPendingRenames(prev => {
      const next = new Map(prev);
      const record = { file, newName: trimmedName, originalName: file.name };
      next.set(file.id, record);
      if (file.type === 'card' && file.cardId) {
        const altKey = file.id.startsWith('card-') ? file.cardId : `card-${file.cardId}`;
        if (altKey !== file.id) next.set(altKey, record);
      }
      return next;
    });
    
    setEditingFile(null);
  }, []);

  const handleStartRename = useCallback((file: FileItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingFile(file);
    setEditingName(file.name);
  }, []);

  
  const handleCancelRename = useCallback(() => {
    setEditingFile(null);
    setEditingName('');
  }, []);

  
  const handleConfirmRename = useCallback(async () => {
    if (editingFile) {
      await handleRename(editingFile, editingName);
    }
  }, [editingFile, editingName, handleRename]);

  
  const handleNewCard = useCallback((nodeId: string) => {
    
    if (pendingDeletes.has(nodeId)) {
      Notification.error(i18n('Cannot create: node is in delete list'));
      setContextMenu(null);
      return;
    }
    
    
    const nodeExists = base.nodes.some(n => n.id === nodeId);
    if (!nodeExists && !nodeId.startsWith('temp-node-')) {
      Notification.error(i18n('Cannot create: node does not exist'));
      setContextMenu(null);
      return;
    }
    
    const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newCard: PendingCreate = {
      type: 'card',
      nodeId,
      title: i18n('New card'),
      tempId,
    };
    
    pendingCreatesRef.current.set(tempId, newCard);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    if (!nodeCardsMap[nodeId]) {
      nodeCardsMap[nodeId] = [];
    }
    // Compute children from base.edges/base.nodes (same as buildTree) so the new card's order is max(orders)+1 across all siblings (nodes + cards), ensuring it appears at the bottom.
    const childNodeIds = base.edges.filter(e => e.source === nodeId).map(e => e.target);
    const childNodes = childNodeIds.map(id => base.nodes.find(n => n.id === id)).filter(Boolean) as BaseNode[];
    const cardsForNode = (nodeCardsMap[nodeId] || []).filter((c: Card) => !c.nodeId || c.nodeId === nodeId);
    const allOrders: number[] = [
      ...cardsForNode.map((c: Card) => c.order ?? 0),
      ...childNodes.map(n => n.order ?? 0),
    ];
    const maxOrder = allOrders.length > 0 ? Math.max(...allOrders) : 0;
    const newOrder = maxOrder + 1;
    
    const tempCard: Card = {
      docId: tempId,
      cid: 0,
      nodeId,
      title: i18n('New card'),
      content: '',
      order: newOrder,
      updateAt: new Date().toISOString(),
    } as Card;
    
    nodeCardsMap[nodeId].push(tempCard);
    nodeCardsMap[nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
    setNodeCardsMapVersion(prev => prev + 1);
    
    setContextMenu(null);
  }, [pendingDeletes, base.nodes, base.edges]);

  const handleNewSiblingCardPlacement = useCallback((
    nodeId: string,
    referenceCardId: string,
    placement: 'above' | 'below' | 'bottom',
  ) => {
    if (placement === 'bottom') {
      handleNewCard(nodeId);
      return;
    }
    if (pendingDeletes.has(nodeId)) {
      Notification.error(i18n('Cannot create: node is in delete list'));
      setContextMenu(null);
      return;
    }
    const nodeExists = base.nodes.some(n => n.id === nodeId);
    if (!nodeExists && !nodeId.startsWith('temp-node-')) {
      Notification.error(i18n('Cannot create: node does not exist'));
      setContextMenu(null);
      return;
    }
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const cardsForNode = (nodeCardsMap[nodeId] || []).filter((c: Card) => !c.nodeId || c.nodeId === nodeId);
    const refCard = cardsForNode.find((c: Card) => String(c.docId) === String(referenceCardId));
    if (!refCard) {
      Notification.error(i18n('Card not found'));
      setContextMenu(null);
      return;
    }
    const childNodeIds = base.edges.filter(e => e.source === nodeId).map(e => e.target);
    const childNodes = childNodeIds.map(id => base.nodes.find(n => n.id === id)).filter(Boolean) as BaseNode[];
    type MixRow = { order: number; sortKey: string };
    const mix: MixRow[] = [
      ...cardsForNode.map((c: Card) => ({ order: c.order ?? 0, sortKey: `c:${String(c.docId)}` })),
      ...childNodes.map((n: BaseNode) => ({ order: n.order ?? 0, sortKey: `n:${n.id}` })),
    ];
    mix.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.sortKey.localeCompare(b.sortKey)));
    const refSortKey = `c:${String(refCard.docId)}`;
    const refIdx = mix.findIndex(m => m.sortKey === refSortKey);
    if (refIdx < 0) {
      handleNewCard(nodeId);
      return;
    }
    const refOrder = refCard.order ?? 0;
    let newOrder: number;
    if (placement === 'above') {
      if (refIdx === 0) {
        newOrder = refOrder > 0 ? refOrder - 1 : -1;
      } else {
        const prevOrder = mix[refIdx - 1].order;
        newOrder = prevOrder < refOrder ? (prevOrder + refOrder) / 2 : refOrder - 0.001;
      }
    } else {
      if (refIdx === mix.length - 1) {
        newOrder = Math.max(...mix.map(m => m.order), refOrder) + 1;
      } else {
        const nextOrder = mix[refIdx + 1].order;
        newOrder = nextOrder > refOrder ? (refOrder + nextOrder) / 2 : refOrder + 0.001;
      }
    }
    const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newCard: PendingCreate = {
      type: 'card',
      nodeId,
      title: i18n('New card'),
      tempId,
    };
    pendingCreatesRef.current.set(tempId, newCard);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    if (!nodeCardsMap[nodeId]) {
      nodeCardsMap[nodeId] = [];
    }
    const tempCard: Card = {
      docId: tempId,
      cid: 0,
      nodeId,
      title: i18n('New card'),
      content: '',
      order: newOrder,
      updateAt: new Date().toISOString(),
    } as Card;
    nodeCardsMap[nodeId].push(tempCard);
    nodeCardsMap[nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
    setNodeCardsMapVersion(prev => prev + 1);
    setContextMenu(null);
    setNewSiblingCardSubmenuOpen(false);
  }, [handleNewCard, pendingDeletes, base.nodes, base.edges]);

  const handleNewSiblingCardForNodePlacement = useCallback((
    referenceNodeId: string,
    placement: 'above' | 'below' | 'bottom',
  ) => {
    if (pendingDeletes.has(referenceNodeId)) {
      Notification.error(i18n('Cannot create: node is in delete list'));
      setContextMenu(null);
      return;
    }
    const refNode = base.nodes.find((n) => n.id === referenceNodeId);
    if (!refNode && !referenceNodeId.startsWith('temp-node-')) {
      Notification.error(i18n('Cannot create: node does not exist'));
      setContextMenu(null);
      return;
    }
    const parentId = base.edges.find((e) => e.target === referenceNodeId)?.source;
    if (!parentId) {
      Notification.warn('Root node does not support sibling card');
      setContextMenu(null);
      setNewSiblingCardForNodeSubmenuOpen(false);
      return;
    }
    if (placement === 'bottom') {
      handleNewCard(parentId);
      setNewSiblingCardForNodeSubmenuOpen(false);
      return;
    }
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const cardsForNode = (nodeCardsMap[parentId] || []).filter((c: Card) => !c.nodeId || c.nodeId === parentId);
    const childNodeIds = base.edges.filter((e) => e.source === parentId).map((e) => e.target);
    const childNodes = childNodeIds.map((id) => base.nodes.find((n) => n.id === id)).filter(Boolean) as BaseNode[];
    type MixRow = { order: number; sortKey: string };
    const mix: MixRow[] = [
      ...cardsForNode.map((c: Card) => ({ order: c.order ?? 0, sortKey: `c:${String(c.docId)}` })),
      ...childNodes.map((n: BaseNode) => ({ order: n.order ?? 0, sortKey: `n:${n.id}` })),
    ];
    mix.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.sortKey.localeCompare(b.sortKey)));
    const refSortKey = `n:${referenceNodeId}`;
    const refIdx = mix.findIndex((m) => m.sortKey === refSortKey);
    if (refIdx < 0) {
      handleNewCard(parentId);
      setNewSiblingCardForNodeSubmenuOpen(false);
      return;
    }
    const refOrder = refNode?.order ?? 0;
    let newOrder: number;
    if (placement === 'above') {
      if (refIdx === 0) {
        newOrder = refOrder > 0 ? refOrder - 1 : -1;
      } else {
        const prevOrder = mix[refIdx - 1].order;
        newOrder = prevOrder < refOrder ? (prevOrder + refOrder) / 2 : refOrder - 0.001;
      }
    } else {
      if (refIdx === mix.length - 1) {
        newOrder = Math.max(...mix.map((m) => m.order), refOrder) + 1;
      } else {
        const nextOrder = mix[refIdx + 1].order;
        newOrder = nextOrder > refOrder ? (refOrder + nextOrder) / 2 : refOrder + 0.001;
      }
    }
    const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newCard: PendingCreate = {
      type: 'card',
      nodeId: parentId,
      title: i18n('New card'),
      tempId,
    };
    pendingCreatesRef.current.set(tempId, newCard);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    if (!nodeCardsMap[parentId]) {
      nodeCardsMap[parentId] = [];
    }
    const tempCard: Card = {
      docId: tempId,
      cid: 0,
      nodeId: parentId,
      title: i18n('New card'),
      content: '',
      order: newOrder,
      updateAt: new Date().toISOString(),
    } as Card;
    nodeCardsMap[parentId].push(tempCard);
    nodeCardsMap[parentId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
    setNodeCardsMapVersion((prev) => prev + 1);
    setContextMenu(null);
    setNewSiblingCardForNodeSubmenuOpen(false);
  }, [pendingDeletes, base.nodes, base.edges, handleNewCard]);

  
  const doImportFromText = useCallback((nodeId: string, text: string) => {
    if (pendingDeletes.has(nodeId)) {
      Notification.error(i18n('Cannot import: node is in delete list'));
      return;
    }
    const nodeExists = base.nodes.some(n => n.id === nodeId);
    if (!nodeExists && !nodeId.startsWith('temp-node-')) {
      Notification.error('无法导入：节点不存在');
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      Notification.info(i18n('Please paste or enter content to import'));
      return;
    }
    
    const blocks = trimmed.split(/\n\s*\n\s*---\s*\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (blocks.length === 0) {
      Notification.info(i18n('No valid content (use ## Title and --- to separate cards)'));
      return;
    }
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    if (!nodeCardsMap[nodeId]) nodeCardsMap[nodeId] = [];
    const maxOrder = nodeCardsMap[nodeId].length > 0
      ? Math.max(...nodeCardsMap[nodeId].map((c: Card) => c.order || 0))
      : 0;
    const newChanges = new Map<string, PendingChange>();
    let order = maxOrder;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const firstLineMatch = block.match(/^(#{1,6})\s+(.*?)(?:\n|$)/);
      let title: string;
      let content: string;
      if (firstLineMatch) {
        title = firstLineMatch[2].trim() || '未命名';
        const firstLine = block.split('\n')[0] || '';
        content = block.slice(firstLine.length).replace(/^\n+/, '').trim();
      } else {
        const firstLine = block.split('\n')[0] || '';
        title = firstLine.trim() || i18n('Unnamed');
        content = block.includes('\n') ? block.slice(firstLine.length).replace(/^\n+/, '').trim() : '';
      }
      order += 1;
      const tempId = `temp-card-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`;
      const newCard: PendingCreate = { type: 'card', nodeId, title, tempId };
      pendingCreatesRef.current.set(tempId, newCard);
      const tempCard: Card = {
        docId: tempId,
        cid: 0,
        nodeId,
        title,
        content,
        order,
        updateAt: new Date().toISOString(),
      } as Card;
      nodeCardsMap[nodeId].push(tempCard);
      const fileItem: FileItem = {
        type: 'card',
        id: `card-${tempId}`,
        name: title,
        nodeId,
        cardId: tempId,
        parentId: nodeId,
        level: 0,
      };
      newChanges.set(`card-${tempId}`, { file: fileItem, content, originalContent: '' });
    }
    setPendingCreatesCount(pendingCreatesRef.current.size);
    nodeCardsMap[nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
    setNodeCardsMapVersion(prev => prev + 1);
    setPendingChanges(prev => {
      const next = new Map(prev);
      newChanges.forEach((v, k) => next.set(k, v));
      return next;
    });
    Notification.success(`已导入 ${blocks.length} 个卡片，请保存以生效`);
  }, [pendingDeletes, base.nodes]);

  
  const handleOpenImportWindow = useCallback((nodeId: string) => {
    if (pendingDeletes.has(nodeId)) {
      Notification.error(i18n('Cannot import: node is in delete list'));
      setContextMenu(null);
      return;
    }
    const nodeExists = base.nodes.some(n => n.id === nodeId);
    if (!nodeExists && !nodeId.startsWith('temp-node-')) {
      Notification.error('无法导入：节点不存在');
      setContextMenu(null);
      return;
    }
    setImportWindow({ nodeId });
    setContextMenu(null);
  }, [pendingDeletes, base.nodes]);

  
  useEffect(() => {
    if (!cardFaceWindow) return;
    const timer = setTimeout(() => {
      const textarea = cardFaceEditorRef.current;
      if (!textarea) return;
      const $textarea = $(textarea);
      $textarea.val(cardFaceEditContent);
      $textarea.attr('data-markdown', 'true');
      try {
        const editor = new Editor($textarea, {
          value: cardFaceEditContent,
          onChange: (value: string) => setCardFaceEditContent(value),
        });
        cardFaceEditorInstanceRef.current = editor;
      } catch (e) {
        console.error('Failed to init card face editor:', e);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      if (cardFaceEditorInstanceRef.current) {
        try {
          cardFaceEditorInstanceRef.current.destroy();
        } catch (e) {
          console.warn('Error destroying card face editor:', e);
        }
        cardFaceEditorInstanceRef.current = null;
      }
    };
  }, [cardFaceWindow?.file?.id]);

  
  const handleNewChildNode = useCallback((parentNodeId: string) => {
    const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const childNodes = base.edges
      .filter(e => e.source === parentNodeId)
      .map(e => base.nodes.find(n => n.id === e.target))
      .filter(Boolean) as BaseNode[];
    const nodeCards = (nodeCardsMap[parentNodeId] || [])
      .filter((card: Card) => !card.nodeId || card.nodeId === parentNodeId);
    
    const maxNodeOrder = childNodes.length > 0
      ? Math.max(...childNodes.map(n => n.order || 0))
      : 0;
    const maxCardOrder = nodeCards.length > 0
      ? Math.max(...nodeCards.map((c: Card) => c.order || 0))
      : 0;
    const maxOrder = Math.max(maxNodeOrder, maxCardOrder);
    
    const newChildNode: PendingCreate = {
      type: 'node',
      nodeId: parentNodeId,
      text: i18n('New node'),
      tempId,
    };
    
    pendingCreatesRef.current.set(tempId, newChildNode);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    
    
    const tempNode: BaseNode = {
      id: tempId,
      text: i18n('New node'),
      order: maxOrder + 1,
    };
    
    
    const newEdge: BaseEdge = {
      id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      source: parentNodeId,
      target: tempId,
    };
    
    
    setBase(prev => {
      const updated = {
        ...prev,
        nodes: [...prev.nodes, tempNode].map(n =>
          n.id === parentNodeId
            ? { ...n, expanded: true }
            : n
        ),
        edges: [...prev.edges, newEdge],
      };
      
      baseRef.current = updated;
      return updated;
    });
    
    
    setExpandedNodes(prev => {
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
  }, [triggerExpandAutoSave]);

  const handleNewRootNode = useCallback(() => {
    const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const rootNodes = base.nodes.filter(node => 
      !base.edges.some(edge => edge.target === node.id)
    );
    const maxOrder = rootNodes.length > 0
      ? Math.max(...rootNodes.map(n => n.order || 0))
      : 0;
    
    const newRootNode: PendingCreate = {
      type: 'node',
      nodeId: '', // root has no parent
      text: i18n('New node'),
      tempId,
    };
    
    pendingCreatesRef.current.set(tempId, newRootNode);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    
    
    const tempNode: BaseNode = {
      id: tempId,
      text: i18n('New node'),
      order: maxOrder + 1,
    };
    
    
    setBase(prev => {
      const updated = {
        ...prev,
        nodes: [...prev.nodes, tempNode],
      };
      baseRef.current = updated;
      return updated;
    });
    
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      newSet.add(tempId);
      expandedNodesRef.current = newSet;
      return newSet;
    });
    
    setEmptyAreaContextMenu(null);
  }, [base.nodes, base.edges, handleNewChildNode]);

  const handleNewSiblingNodePlacement = useCallback((
    referenceNodeId: string,
    placement: 'above' | 'below' | 'bottom',
  ) => {
    if (pendingDeletes.has(referenceNodeId)) {
      Notification.error(i18n('Cannot create: node is in delete list'));
      setContextMenu(null);
      return;
    }
    const refExists = base.nodes.some((n) => n.id === referenceNodeId);
    if (!refExists && !referenceNodeId.startsWith('temp-node-')) {
      Notification.error(i18n('Cannot create: node does not exist'));
      setContextMenu(null);
      return;
    }

    const parentEdge = base.edges.find((e) => e.target === referenceNodeId);
    const parentId = parentEdge?.source;

    if (placement === 'bottom') {
      if (parentId) {
        handleNewChildNode(parentId);
      } else {
        handleNewRootNode();
        setContextMenu(null);
        setNewSiblingNodeSubmenuOpen(false);
      }
      return;
    }

    const computeOrderInMix = (
      mix: { order: number; sortKey: string }[],
      refSortKey: string,
      pl: 'above' | 'below',
    ): number | null => {
      const refIdx = mix.findIndex((m) => m.sortKey === refSortKey);
      if (refIdx < 0) return null;
      const refOrder = mix[refIdx].order;
      if (pl === 'above') {
        if (refIdx === 0) {
          return refOrder > 0 ? refOrder - 1 : -1;
        }
        const prevOrder = mix[refIdx - 1].order;
        return prevOrder < refOrder ? (prevOrder + refOrder) / 2 : refOrder - 0.001;
      }
      if (refIdx === mix.length - 1) {
        return Math.max(...mix.map((m) => m.order), refOrder) + 1;
      }
      const nextOrder = mix[refIdx + 1].order;
      return nextOrder > refOrder ? (refOrder + nextOrder) / 2 : refOrder + 0.001;
    };

    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    let newOrder: number;

    if (parentId) {
      const childNodes = base.edges
        .filter((e) => e.source === parentId)
        .map((e) => base.nodes.find((n) => n.id === e.target))
        .filter(Boolean) as BaseNode[];
      const cards = (nodeCardsMap[parentId] || []).filter((c: Card) => !c.nodeId || c.nodeId === parentId);
      const mix: { order: number; sortKey: string }[] = [
        ...cards.map((c: Card) => ({ order: c.order ?? 0, sortKey: `c:${String(c.docId)}` })),
        ...childNodes.map((n: BaseNode) => ({ order: n.order ?? 0, sortKey: `n:${n.id}` })),
      ];
      mix.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.sortKey.localeCompare(b.sortKey)));
      const computed = computeOrderInMix(mix, `n:${referenceNodeId}`, placement);
      if (computed === null) {
        handleNewChildNode(parentId);
        return;
      }
      newOrder = computed;

      const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const newChildNode: PendingCreate = {
        type: 'node',
        nodeId: parentId,
        text: i18n('New node'),
        tempId,
      };
      pendingCreatesRef.current.set(tempId, newChildNode);
      setPendingCreatesCount(pendingCreatesRef.current.size);
      const tempNode: BaseNode = {
        id: tempId,
        text: i18n('New node'),
        order: newOrder,
      };
      const newEdge: BaseEdge = {
        id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        source: parentId,
        target: tempId,
      };
      setBase((prev) => {
        const updated = {
          ...prev,
          nodes: [...prev.nodes, tempNode].map((n) =>
            n.id === parentId ? { ...n, expanded: true } : n,
          ),
          edges: [...prev.edges, newEdge],
        };
        baseRef.current = updated;
        return updated;
      });
      setExpandedNodes((prev) => {
        const newSet = new Set(prev);
        newSet.add(tempId);
        if (!newSet.has(parentId)) {
          newSet.add(parentId);
          expandedNodesRef.current = newSet;
          triggerExpandAutoSave();
        }
        return newSet;
      });
    } else {
      const rootNodes = base.nodes.filter((node) => !base.edges.some((edge) => edge.target === node.id));
      const mix: { order: number; sortKey: string }[] = rootNodes.map((n: BaseNode) => ({
        order: n.order ?? 0,
        sortKey: `n:${n.id}`,
      }));
      mix.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.sortKey.localeCompare(b.sortKey)));
      const computed = computeOrderInMix(mix, `n:${referenceNodeId}`, placement);
      if (computed === null) {
        handleNewRootNode();
        return;
      }
      newOrder = computed;

      const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const newRootNode: PendingCreate = {
        type: 'node',
        nodeId: '',
        text: i18n('New node'),
        tempId,
      };
      pendingCreatesRef.current.set(tempId, newRootNode);
      setPendingCreatesCount(pendingCreatesRef.current.size);
      const tempNode: BaseNode = {
        id: tempId,
        text: i18n('New node'),
        order: newOrder,
      };
      setBase((prev) => {
        const updated = {
          ...prev,
          nodes: [...prev.nodes, tempNode],
        };
        baseRef.current = updated;
        return updated;
      });
      setExpandedNodes((prev) => {
        const newSet = new Set(prev);
        newSet.add(tempId);
        expandedNodesRef.current = newSet;
        return newSet;
      });
    }

    setContextMenu(null);
    setNewSiblingNodeSubmenuOpen(false);
  }, [base.nodes, base.edges, pendingDeletes, handleNewChildNode, handleNewRootNode, triggerExpandAutoSave]);

  const handleNewSiblingNodeForCardPlacement = useCallback((
    parentNodeId: string,
    referenceCardId: string,
    placement: 'above' | 'below' | 'bottom',
  ) => {
    if (pendingDeletes.has(parentNodeId)) {
      Notification.error(i18n('Cannot create: node is in delete list'));
      setContextMenu(null);
      setNewSiblingNodeForCardSubmenuOpen(false);
      return;
    }
    const parentExists = base.nodes.some((n) => n.id === parentNodeId);
    if (!parentExists && !parentNodeId.startsWith('temp-node-')) {
      Notification.error(i18n('Cannot create: node does not exist'));
      setContextMenu(null);
      setNewSiblingNodeForCardSubmenuOpen(false);
      return;
    }
    if (placement === 'bottom') {
      handleNewChildNode(parentNodeId);
      setNewSiblingNodeForCardSubmenuOpen(false);
      return;
    }
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const cardsForNode = (nodeCardsMap[parentNodeId] || []).filter((c: Card) => !c.nodeId || c.nodeId === parentNodeId);
    const refCard = cardsForNode.find((c: Card) => String(c.docId) === String(referenceCardId));
    if (!refCard) {
      handleNewChildNode(parentNodeId);
      setNewSiblingNodeForCardSubmenuOpen(false);
      return;
    }
    const childNodes = base.edges
      .filter((e) => e.source === parentNodeId)
      .map((e) => base.nodes.find((n) => n.id === e.target))
      .filter(Boolean) as BaseNode[];
    type MixRowNfc = { order: number; sortKey: string };
    const mix: MixRowNfc[] = [
      ...cardsForNode.map((c: Card) => ({ order: c.order ?? 0, sortKey: `c:${String(c.docId)}` })),
      ...childNodes.map((n: BaseNode) => ({ order: n.order ?? 0, sortKey: `n:${n.id}` })),
    ];
    mix.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.sortKey.localeCompare(b.sortKey)));
    const refSortKey = `c:${String(refCard.docId)}`;
    const refIdx = mix.findIndex((m) => m.sortKey === refSortKey);
    if (refIdx < 0) {
      handleNewChildNode(parentNodeId);
      setNewSiblingNodeForCardSubmenuOpen(false);
      return;
    }
    const refOrder = refCard.order ?? 0;
    let newOrder: number;
    if (placement === 'above') {
      if (refIdx === 0) {
        newOrder = refOrder > 0 ? refOrder - 1 : -1;
      } else {
        const prevOrder = mix[refIdx - 1].order;
        newOrder = prevOrder < refOrder ? (prevOrder + refOrder) / 2 : refOrder - 0.001;
      }
    } else {
      if (refIdx === mix.length - 1) {
        newOrder = Math.max(...mix.map((m) => m.order), refOrder) + 1;
      } else {
        const nextOrder = mix[refIdx + 1].order;
        newOrder = nextOrder > refOrder ? (refOrder + nextOrder) / 2 : refOrder + 0.001;
      }
    }
    const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newChildNode: PendingCreate = {
      type: 'node',
      nodeId: parentNodeId,
      text: i18n('New node'),
      tempId,
    };
    pendingCreatesRef.current.set(tempId, newChildNode);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    const tempNode: BaseNode = {
      id: tempId,
      text: i18n('New node'),
      order: newOrder,
    };
    const newEdge: BaseEdge = {
      id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      source: parentNodeId,
      target: tempId,
    };
    setBase((prev) => {
      const updated = {
        ...prev,
        nodes: [...prev.nodes, tempNode].map((n) =>
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
    setNewSiblingNodeForCardSubmenuOpen(false);
  }, [pendingDeletes, base.nodes, base.edges, handleNewChildNode, triggerExpandAutoSave]);

  
  const handleNewRootCard = useCallback(() => {
    
    const rootNodes = base.nodes.filter(node => 
      !base.edges.some(edge => edge.target === node.id)
    );
    
    let targetNodeId: string;
    
    if (rootNodes.length === 0) {
      
      const tempNodeId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const newRootNode: PendingCreate = {
        type: 'node',
        nodeId: '', // root has no parent
        text: i18n('New node'),
        tempId: tempNodeId,
      };
      
      pendingCreatesRef.current.set(tempNodeId, newRootNode);
      setPendingCreatesCount(pendingCreatesRef.current.size);
      
      
      const tempNode: BaseNode = {
        id: tempNodeId,
        text: i18n('New node'),
        order: 0,
      };
      
      setBase(prev => {
        const updated = {
          ...prev,
          nodes: [...prev.nodes, tempNode],
        };
        baseRef.current = updated;
        return updated;
      });
      
      setExpandedNodes(prev => {
        const newSet = new Set(prev);
        newSet.add(tempNodeId);
        expandedNodesRef.current = newSet;
        return newSet;
      });
      
      targetNodeId = tempNodeId;
    } else {
      
      targetNodeId = rootNodes[0].id;
    }
    
    
    handleNewCard(targetNodeId);
    setEmptyAreaContextMenu(null);
  }, [base.nodes, base.edges, handleNewCard]);

  const openCountDialog = useCallback(async (title: string): Promise<number | null> => {
    const $body = $(tpl`
      <div class="typo" style="min-width: 260px;">
        <label>
          ${title}
          <input type="number" name="count" class="textbox" style="width: 100%; margin-top: 8px;" min="1" max="100" value="2" />
        </label>
      </div>
    `);
    const dialog = new ActionDialog({ $body, width: '320px' } as any);
    const action = await dialog.open();
    if (action !== 'ok') return null;
    const raw = parseInt($body.find('input[name="count"]').val() as string, 10);
    const n = isNaN(raw) || raw < 1 ? 1 : Math.min(100, raw);
    return n;
  }, []);

  const handleNewMultipleCards = useCallback((nodeId: string) => {
    setContextMenu(null);
    (async () => {
      const n = await openCountDialog(i18n('Number of cards to create'));
      if (n == null) return;
      for (let i = 0; i < n; i++) handleNewCard(nodeId);
      if (n > 1) Notification.success(i18n('Created {0} cards', n));
    })();
  }, [handleNewCard, openCountDialog]);

  const handleNewMultipleChildNodes = useCallback((parentNodeId: string) => {
    setContextMenu(null);
    (async () => {
      const n = await openCountDialog(i18n('Number of child nodes to create'));
      if (n == null) return;
      for (let i = 0; i < n; i++) handleNewChildNode(parentNodeId);
      if (n > 1) Notification.success(i18n('Created {0} child nodes', n));
    })();
  }, [handleNewChildNode, openCountDialog]);

  const handleNewMultipleRootNodes = useCallback(() => {
    setEmptyAreaContextMenu(null);
    (async () => {
      const n = await openCountDialog(i18n('Number of root nodes to create'));
      if (n == null) return;
      for (let i = 0; i < n; i++) handleNewRootNode();
      if (n > 1) Notification.success(i18n('Created {0} root nodes', n));
    })();
  }, [handleNewRootNode, openCountDialog]);

  const handleNewMultipleRootCards = useCallback(() => {
    setEmptyAreaContextMenu(null);
    (async () => {
      const n = await openCountDialog(i18n('Number of cards to create'));
      if (n == null) return;
      for (let i = 0; i < n; i++) handleNewRootCard();
      if (n > 1) Notification.success(i18n('Created {0} cards', n));
    })();
  }, [handleNewRootCard, openCountDialog]);

  
  const handleCopy = useCallback((file?: FileItem) => {
    let itemsToCopy: FileItem[] = [];
    
    
    if (isMultiSelectMode && selectedItems.size > 0 && !file) {
      
      itemsToCopy = fileTree.filter(f => selectedItems.has(f.id));
    } else if (file) {
      
      itemsToCopy = [file];
    } else {
      return;
    }
    
    if (itemsToCopy.length === 0) return;
    
    setClipboard({ type: 'copy', items: itemsToCopy });
    
    
    if (navigator.clipboard && navigator.clipboard.writeText && itemsToCopy.length === 1) {
      const firstItem = itemsToCopy[0];
      const reference = firstItem.type === 'node' 
        ? `ejunz://node/${firstItem.nodeId}`
        : `ejunz://card/${firstItem.cardId}`;
      navigator.clipboard.writeText(reference).catch(() => {
        
      });
    }
    
    setContextMenu(null);
  }, [isMultiSelectMode, selectedItems, fileTree]);

  
  const handleCopyContent = useCallback((file: FileItem) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    let text = '';
    if (file.type === 'card' && file.cardId != null && file.nodeId != null) {
      const pendingChange = pendingChanges.get(file.id);
      if (pendingChange) {
        text = pendingChange.content;
      } else {
        const nodeCards = nodeCardsMap[file.nodeId] || [];
        const card = nodeCards.find((c: Card) => c.docId === file.cardId);
        text = card?.content || '';
      }
    } else if (file.type === 'node' && file.nodeId != null) {
      const deletedNodeIds = new Set(
        Array.from(pendingDeletes.values()).filter(d => d.type === 'node').map(d => d.id)
      );
      const deletedCardIds = new Set(
        Array.from(pendingDeletes.values()).filter(d => d.type === 'card').map(d => d.id)
      );
      const getChildNodeIds = (nodeId: string): string[] => {
        return base.edges
          .filter(e => e.source === nodeId)
          .map(e => base.nodes.find(n => n.id === e.target))
          .filter((n): n is BaseNode => n != null)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map(n => n.id);
      };
      const getNodeName = (nodeId: string): string => {
        const node = base.nodes.find(n => n.id === nodeId);
        return pendingRenames.get(nodeId)?.newName ?? node?.text ?? '';
      };
      const buildNodeContent = (nodeId: string, depth: number): string[] => {
        if (deletedNodeIds.has(nodeId)) return [];
        const parts: string[] = [];
        const cardHeading = '#'.repeat(Math.min(2 + depth, 6));
        const nodeCards = (nodeCardsMap[nodeId] || [])
          .filter((c: Card) => (!c.nodeId || c.nodeId === nodeId) && !deletedCardIds.has(c.docId))
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        for (const card of nodeCards) {
          const cardFileId = `card-${card.docId}`;
          const pendingChange = pendingChanges.get(cardFileId);
          const content = pendingChange ? pendingChange.content : (card.content || '');
          const title = pendingRenames.get(cardFileId)?.newName ?? card.title ?? '';
          const titleLine = title.trim() ? `${cardHeading} ${title.trim()}\n\n` : '';
          const block = titleLine + (content.trim() || '');
          if (block.trim()) parts.push(block.trim());
        }
        const childIds = getChildNodeIds(nodeId);
        for (const childId of childIds) {
          const childName = getNodeName(childId).trim();
          const nodeHeading = '#'.repeat(Math.min(2 + depth, 6));
          const childParts = buildNodeContent(childId, depth + 1);
          if (childParts.length > 0) {
            const nodeTitleLine = childName ? `${nodeHeading} ${childName}\n\n` : '';
            parts.push((nodeTitleLine + childParts.join('\n\n---\n\n')).trim());
          }
        }
        return parts;
      };
      const parts = buildNodeContent(file.nodeId, 0);
      text = parts.join('\n\n---\n\n');
    }
    if (text !== '' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        Notification.success(i18n('Content copied to clipboard'));
      }).catch(() => {
        Notification.error(i18n('Copy failed'));
      });
    } else if (text === '') {
      Notification.info(i18n('No content to copy'));
    } else {
      Notification.error('剪贴板不可用');
    }
    setContextMenu(null);
  }, [pendingChanges, pendingRenames, base, pendingDeletes]);

  
  const handleCut = useCallback((file?: FileItem) => {
    let itemsToCut: FileItem[] = [];
    
    
    if (isMultiSelectMode && selectedItems.size > 0 && !file) {
      
      itemsToCut = fileTree.filter(f => selectedItems.has(f.id));
    } else if (file) {
      
      itemsToCut = [file];
    } else {
      return;
    }
    
    if (itemsToCut.length === 0) return;
    
    setClipboard({ type: 'cut', items: itemsToCut });
    
    
    if (navigator.clipboard && navigator.clipboard.writeText && itemsToCut.length === 1) {
      const firstItem = itemsToCut[0];
      const reference = firstItem.type === 'node' 
        ? `ejunz://node/${firstItem.nodeId}`
        : `ejunz://card/${firstItem.cardId}`;
      navigator.clipboard.writeText(reference).catch(() => {
        
      });
    }
    
    setContextMenu(null);
  }, [isMultiSelectMode, selectedItems, fileTree]);

  
  const cleanupPendingForTempItem = useCallback((file: FileItem) => {
    if (file.type === 'node') {
      const nodeId = file.nodeId || '';
      if (nodeId.startsWith('temp-node-')) {
        
        pendingCreatesRef.current.delete(nodeId);
        setPendingCreatesCount(pendingCreatesRef.current.size);
        
        
        setPendingChanges(prev => {
          const next = new Map(prev);
          next.delete(nodeId);
          return next;
        });
        
        
        setPendingRenames(prev => {
          const next = new Map(prev);
          next.delete(nodeId);
          return next;
        });
        
        
        setPendingDragChanges(prev => {
          const next = new Set(prev);
          next.delete(`node-${nodeId}`);
          return next;
        });
        
        
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const nodeCards = nodeCardsMap[nodeId] || [];
        for (const card of nodeCards) {
          const cardId = card.docId;
          if (cardId && cardId.startsWith('temp-card-')) {
            
            pendingCreatesRef.current.delete(cardId);
            setPendingCreatesCount(pendingCreatesRef.current.size);
            
            
            setPendingChanges(prev => {
              const next = new Map(prev);
              next.delete(`card-${cardId}`);
              return next;
            });
            
            
            setPendingRenames(prev => {
              const next = new Map(prev);
              next.delete(`card-${cardId}`);
              return next;
            });
            
            
            setPendingDragChanges(prev => {
              const next = new Set(prev);
              next.delete(cardId);
              return next;
            });
          }
        }
      }
    } else if (file.type === 'card') {
      const cardId = file.cardId || '';
      if (cardId.startsWith('temp-card-')) {
        
        pendingCreatesRef.current.delete(cardId);
        setPendingCreatesCount(pendingCreatesRef.current.size);
        
        
        setPendingChanges(prev => {
          const next = new Map(prev);
          next.delete(`card-${cardId}`);
          return next;
        });
        
        
        setPendingRenames(prev => {
          const next = new Map(prev);
          next.delete(`card-${cardId}`);
          return next;
        });
        
        
        setPendingDragChanges(prev => {
          const next = new Set(prev);
          next.delete(cardId);
          return next;
        });
      }
    }
  }, []);

  const handleConvertCardToNode = useCallback((file: FileItem) => { if (file.type !== "card" || !file.nodeId || !file.cardId) return; const parentNodeId = file.nodeId; const cardId = file.cardId; const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {}; const cards = nodeCardsMap[parentNodeId] || []; const card = cards.find((c: Card) => String(c.docId) === String(cardId)); if (!card) { Notification.error(i18n("Card not found")); setContextMenu(null); return; } const title = (pendingRenames.get("card-" + cardId)?.newName ?? card.title ?? "").trim() || i18n("Unnamed"); const content = pendingChanges.get("card-" + cardId)?.content ?? card.content ?? ""; const cardOrder = card.order ?? 0; const tempNodeId = "temp-node-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9); const newChildNode: PendingCreate = { type: "node", nodeId: parentNodeId, text: title, tempId: tempNodeId }; pendingCreatesRef.current.set(tempNodeId, newChildNode); setPendingCreatesCount(pendingCreatesRef.current.size); const tempNode: BaseNode = { id: tempNodeId, text: title, order: cardOrder }; const newEdge: BaseEdge = { id: "temp-edge-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9), source: parentNodeId, target: tempNodeId }; setBase(prev => ({ ...prev, nodes: [...prev.nodes, tempNode].map(n => (n.id === parentNodeId ? { ...n, expanded: true } : n)), edges: [...prev.edges, newEdge] })); setExpandedNodes(prev => { const newSet = new Set(prev); newSet.add(tempNodeId); if (!newSet.has(parentNodeId)) { newSet.add(parentNodeId); expandedNodesRef.current = newSet; triggerExpandAutoSave(); } return newSet; }); const tempCardId = "temp-card-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9); const newCardCreate: PendingCreate = { type: "card", nodeId: tempNodeId, title: i18n("Content"), tempId: tempCardId }; pendingCreatesRef.current.set(tempCardId, newCardCreate); setPendingCreatesCount(pendingCreatesRef.current.size); if (!nodeCardsMap[tempNodeId]) nodeCardsMap[tempNodeId] = []; const tempCard: Card = { docId: tempCardId, cid: 0, nodeId: tempNodeId, title: i18n("Content"), content, order: 1, updateAt: new Date().toISOString() } as Card; nodeCardsMap[tempNodeId].push(tempCard); (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap }; setNodeCardsMapVersion(prev => prev + 1); const fileItem: FileItem = { type: "card", id: "card-" + tempCardId, name: tempCard.title, nodeId: tempNodeId, cardId: tempCardId, parentId: tempNodeId, level: 0 }; setPendingChanges(prev => new Map(prev).set("card-" + tempCardId, { file: fileItem, content, originalContent: "" })); if (cardId.startsWith("temp-card-")) cleanupPendingForTempItem(file); else setPendingDeletes(prev => { const next = new Map(prev); next.set(cardId, { type: "card", id: cardId, nodeId: parentNodeId }); return next; }); const cardsArr = nodeCardsMap[parentNodeId] || []; const idx = cardsArr.findIndex((c: Card) => String(c.docId) === String(cardId)); if (idx >= 0) { cardsArr.splice(idx, 1); (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap }; setNodeCardsMapVersion(prev => prev + 1); } setContextMenu(null); }, [base.nodes, base.edges, pendingChanges, pendingRenames, cleanupPendingForTempItem, triggerExpandAutoSave]);

  
  const handlePaste = useCallback((targetNodeId: string) => {
    if (!clipboard || clipboard.items.length === 0) return;

    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    if (!targetNodeId) return;

    
    for (const item of clipboard.items) {
      if (item.type === 'node') {
        const sourceNodeId = item.nodeId || '';
        const sourceNode = base.nodes.find(n => n.id === sourceNodeId);
        
        
        if (!sourceNode) {
          
          if (clipboard.type === 'cut') {
            setClipboard(null);
          }
          continue;
        }
      
      
      if (clipboard.type === 'cut' && sourceNodeId.startsWith('temp-node-')) {
        
        cleanupPendingForTempItem({ type: 'node', id: sourceNodeId, nodeId: sourceNodeId, name: sourceNode.text || '', level: 0 });
      }

      
      const nodesToCopy: BaseNode[] = [];
      const nodeIdMap = new Map<string, string>();
      let nodeCounter = 0;

      
      const collectNodes = (nodeId: string) => {
        const node = base.nodes.find(n => n.id === nodeId);
        if (!node) return;

        
        if (nodeIdMap.has(nodeId)) return;

        nodeCounter++;
        const newId = `temp-node-${Date.now()}-${nodeCounter}-${Math.random().toString(36).substr(2, 9)}`;
        nodeIdMap.set(nodeId, newId);

        const newNode: BaseNode = {
          ...node,
          id: newId,
          text: node.text,
          order: node.order,
        };
        nodesToCopy.push(newNode);

        const childEdges = base.edges.filter(e => e.source === nodeId);
        childEdges.forEach(edge => {
          collectNodes(edge.target);
        });
      };

      collectNodes(sourceNodeId);

      
      const updatedEdges: BaseEdge[] = [];
      
      
      
      base.edges.forEach(edge => {
        const newSource = nodeIdMap.get(edge.source);
        const newTarget = nodeIdMap.get(edge.target);
        
        
        if (newSource && newTarget) {
          updatedEdges.push({
            id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            source: newSource,
            target: newTarget,
          });
        }
      });

      
      const rootNewId = nodeIdMap.get(sourceNodeId);
      if (rootNewId) {
        const edgeExists = updatedEdges.some(e => e.source === targetNodeId && e.target === rootNewId);
        if (!edgeExists) {
          updatedEdges.push({
            id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            source: targetNodeId,
            target: rootNewId,
          });
        }
      }

      
      
      setBase(prev => {
        const existingNodeIds = new Set(prev.nodes.map(n => n.id));
        const newNodes = nodesToCopy.filter(n => !existingNodeIds.has(n.id));
        const existingEdgeKeys = new Set(prev.edges.map(e => `${e.source}-${e.target}`));
        const newEdges = updatedEdges.filter(e => !existingEdgeKeys.has(`${e.source}-${e.target}`));
        return {
          ...prev,
          nodes: [...prev.nodes, ...newNodes],
          edges: [...prev.edges, ...newEdges],
        };
      });

      
      nodesToCopy.forEach(newNode => {
        const oldNodeId = Array.from(nodeIdMap.entries()).find(([_, newId]) => newId === newNode.id)?.[0];
        if (oldNodeId && nodeCardsMap[oldNodeId]) {
          const cards = nodeCardsMap[oldNodeId];
          const newCards = cards.map((card: Card, index: number) => {
            const newCardId = `temp-card-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 9)}`;
            return {
              ...card,
              docId: newCardId,
              nodeId: newNode.id,
            };
          });

          if (!nodeCardsMap[newNode.id]) {
            nodeCardsMap[newNode.id] = [];
          }
          nodeCardsMap[newNode.id].push(...newCards);
          
          
          newCards.forEach(newCard => {
            if (!pendingCreatesRef.current.has(newCard.docId)) {
              pendingCreatesRef.current.set(newCard.docId, {
                type: 'card',
                nodeId: newNode.id,
                title: newCard.title || i18n('New card'),
                tempId: newCard.docId,
              });
              setPendingCreatesCount(pendingCreatesRef.current.size);
            }
          });
        }
      });
      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };

      
      if (clipboard.type === 'cut') {
        
        
        if (sourceNodeId.startsWith('temp-node-')) {
          
          
          nodeIdMap.forEach((newId, oldId) => {
            
            const oldCards = nodeCardsMap[oldId] || [];
            oldCards.forEach((card: Card) => {
              if (card.docId && card.docId.startsWith('temp-card-')) {
                cleanupPendingForTempItem({ 
                  type: 'card', 
                  id: `card-${card.docId}`, 
                  cardId: card.docId, 
                  nodeId: oldId, 
                  name: card.title || '', 
                  level: 0 
                });
              }
            });
            
            if (nodeCardsMap[oldId]) {
              delete nodeCardsMap[oldId];
            }
          });
          
          setBase(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => !nodeIdMap.has(n.id)),
            edges: prev.edges.filter(e => !nodeIdMap.has(e.source) && !nodeIdMap.has(e.target)),
          }));
          
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
        } else {
          
          setPendingDeletes(prev => {
            const next = new Map(prev);
            next.set(sourceNodeId, {
              type: 'node',
              id: sourceNodeId,
            });
            return next;
          });

          setBase(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => !nodeIdMap.has(n.id)),
            edges: prev.edges.filter(e => !nodeIdMap.has(e.source) && !nodeIdMap.has(e.target)),
          }));
        }
      }

      
      
      
      nodesToCopy.forEach(newNode => {
        const oldNodeId = Array.from(nodeIdMap.entries()).find(([_, newId]) => newId === newNode.id)?.[0];
        if (oldNodeId) {
          
          if (!pendingCreatesRef.current.has(newNode.id)) {
            
            let parentNodeId: string = targetNodeId;
            const originalParentEdge = base.edges.find(e => e.target === oldNodeId);
            if (originalParentEdge) {
              const newParentId = nodeIdMap.get(originalParentEdge.source);
              parentNodeId = newParentId || targetNodeId;
            } else {
              parentNodeId = targetNodeId;
            }

            pendingCreatesRef.current.set(newNode.id, {
              type: 'node',
              nodeId: parentNodeId,
              text: newNode.text || i18n('New node'),
              tempId: newNode.id,
            });
            setPendingCreatesCount(pendingCreatesRef.current.size);
          }
        }
      });

      setNodeCardsMapVersion(prev => prev + 1);
      setExpandedNodes(prev => {
        const newSet = new Set(prev);
        if (!newSet.has(targetNodeId)) {
          newSet.add(targetNodeId);
          
          expandedNodesRef.current = newSet;
          
          setBase(prev => {
            const updated = {
              ...prev,
              nodes: prev.nodes.map(n =>
                n.id === targetNodeId
                  ? { ...n, expanded: true }
                  : n
              ),
            };
            
            baseRef.current = updated;
            return updated;
          });
          
          triggerExpandAutoSave();
        }
        return newSet;
      });

      } else if (item.type === 'card') {
        const sourceCardId = item.cardId || '';
        const sourceNodeId = item.nodeId || '';

        
        const sourceCards = nodeCardsMap[sourceNodeId] || [];
        const sourceCard = sourceCards.find((c: Card) => c.docId === sourceCardId);
        
        
        if (!sourceCard) {
          
          if (clipboard.type === 'cut') {
            setClipboard(null);
          }
          continue;
        }
      
      
      if (clipboard.type === 'cut' && sourceCardId.startsWith('temp-card-')) {
        
        cleanupPendingForTempItem({ 
          type: 'card', 
          id: `card-${sourceCardId}`, 
          cardId: sourceCardId, 
          nodeId: sourceNodeId, 
          name: sourceCard.title || '', 
          level: 0 
        });
      }

      const newCardId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const targetChildNodes = base.edges
        .filter((e: BaseEdge) => e.source === targetNodeId)
        .map((e: BaseEdge) => base.nodes.find((n: BaseNode) => n.id === e.target))
        .filter(Boolean) as BaseNode[];
      const maxCardOrder = nodeCardsMap[targetNodeId]?.length > 0
        ? Math.max(...nodeCardsMap[targetNodeId].map((c: Card) => c.order || 0))
        : 0;
      const maxNodeOrder = targetChildNodes.length > 0
        ? Math.max(...targetChildNodes.map((n: BaseNode) => n.order || 0))
        : 0;
      const maxOrder = Math.max(maxCardOrder, maxNodeOrder);

      const newCard: Card = {
        ...sourceCard,
        docId: newCardId,
        nodeId: targetNodeId,
        order: maxOrder + 1,
      };

      
      if (!nodeCardsMap[targetNodeId]) {
        nodeCardsMap[targetNodeId] = [];
      }
      
      const existingIndex = nodeCardsMap[targetNodeId].findIndex((c: Card) => c.docId === newCardId);
      if (existingIndex === -1) {
        nodeCardsMap[targetNodeId].push(newCard);
        nodeCardsMap[targetNodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
      }

      
      if (clipboard.type === 'cut') {
        const sourceCards = nodeCardsMap[sourceNodeId] || [];
        const cardIndex = sourceCards.findIndex((c: Card) => c.docId === sourceCardId);
        if (cardIndex >= 0) {
          sourceCards.splice(cardIndex, 1);
          nodeCardsMap[sourceNodeId] = sourceCards;
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);

          
          
          if (!sourceCardId.startsWith('temp-card-')) {
            
            setPendingDeletes(prev => {
              const next = new Map(prev);
              next.set(sourceCardId, {
                type: 'card',
                id: sourceCardId,
                nodeId: sourceNodeId,
              });
              return next;
            });
          }
        }
      }

      
      
      if (!pendingCreatesRef.current.has(newCardId)) {
        pendingCreatesRef.current.set(newCardId, {
          type: 'card',
          nodeId: targetNodeId,
          title: newCard.title || i18n('New card'),
          tempId: newCardId,
        });
        setPendingCreatesCount(pendingCreatesRef.current.size);
      }

        setNodeCardsMapVersion(prev => prev + 1);
      }
    }

    
    if (clipboard.type === 'cut') {
      setClipboard(null);
    }

    setContextMenu(null);
  }, [clipboard, base, setBase, cleanupPendingForTempItem, triggerExpandAutoSave]);

  
  useEffect(() => {
    const handleResizeMove = (e: MouseEvent) => {
      if (!isResizingProblemsPanel) return;
      const deltaX = problemsResizeStartXRef.current - e.clientX;
      const newWidth = Math.max(200, Math.min(800, problemsResizeStartWidthRef.current + deltaX));
      setProblemsPanelWidth(newWidth);
    };

    const handleResizeEnd = () => {
      setIsResizingProblemsPanel(false);
    };

    if (isResizingProblemsPanel) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingProblemsPanel]);

  useLayoutEffect(() => {
    const el = editorContainerRef.current;
    if (!el) return;
    const updateMax = () => {
      const h = el.getBoundingClientRect().height;
      const max = Math.max(AI_TERMINAL_MIN_H, Math.floor(h - EDITOR_MAIN_MIN_H));
      aiPanelMaxHeightRef.current = max;
      setAiPanelMaxHeight(max);
      setAiPanelHeight((prev) => (prev > max ? max : prev));
    };
    updateMax();
    const ro = new ResizeObserver(updateMax);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const handleAiResizeMove = (e: PointerEvent) => {
      if (!isResizingAiPanel) return;
      const deltaY = aiResizeStartYRef.current - e.clientY;
      const cap = aiPanelMaxHeightRef.current;
      const next = Math.max(AI_TERMINAL_MIN_H, Math.min(cap, aiResizeStartHeightRef.current + deltaY));
      setAiPanelHeight(next);
    };

    const handleAiResizeEnd = () => {
      setIsResizingAiPanel(false);
    };

    if (isResizingAiPanel) {
      document.addEventListener('pointermove', handleAiResizeMove);
      document.addEventListener('pointerup', handleAiResizeEnd);
      document.addEventListener('pointercancel', handleAiResizeEnd);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.body.style.touchAction = 'none';
    }

    return () => {
      document.removeEventListener('pointermove', handleAiResizeMove);
      document.removeEventListener('pointerup', handleAiResizeEnd);
      document.removeEventListener('pointercancel', handleAiResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.touchAction = '';
    };
  }, [isResizingAiPanel]);

  useEffect(() => {
    const handleExplorerResizeMove = (e: MouseEvent) => {
      if (!isResizingExplorer) return;
      const deltaX = e.clientX - explorerResizeStartXRef.current;
      const next = Math.max(
        EXPLORER_PANEL_MIN,
        Math.min(EXPLORER_PANEL_MAX, explorerResizeStartWidthRef.current + deltaX),
      );
      setExplorerPanelWidth(next);
    };

    const handleExplorerResizeEnd = () => {
      setIsResizingExplorer(false);
    };

    if (isResizingExplorer) {
      document.addEventListener('mousemove', handleExplorerResizeMove);
      document.addEventListener('mouseup', handleExplorerResizeEnd);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleExplorerResizeMove);
      document.removeEventListener('mouseup', handleExplorerResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingExplorer]);

  
  useEffect(() => {
    scrollToBottomIfNeeded();
  }, [chatMessages, scrollToBottomIfNeeded]);

  
  const getNodePath = useCallback((nodeId: string): string[] => {
    const path: string[] = [];
    const nodeMap = new Map<string, string>(); // parentId -> nodeId
    
    
    base.edges.forEach((edge) => {
      nodeMap.set(edge.target, edge.source);
    });
    
    
    let currentNodeId: string | undefined = nodeId;
    while (currentNodeId) {
      const node = base.nodes.find(n => n.id === currentNodeId);
      if (node) {
        path.unshift(node.text || i18n('Unnamed Node'));
      }
      currentNodeId = nodeMap.get(currentNodeId);
    }
    
    return path;
  }, [base]);

  const sanitizeShellPathSeg = useCallback(
    (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled',
    [],
  );

  /** Filesystem-style path for terminal + AI: folders = nodes (trailing /), files = cards (.md). */
  const editorShellPath = useMemo(() => {
    if (!selectedFile) return '~';
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    if (selectedFile.type === 'node' && selectedFile.nodeId) {
      const segs = getNodePath(selectedFile.nodeId).map((t) => sanitizeShellPathSeg(t));
      return segs.length ? `/${segs.join('/')}/` : '/';
    }
    if (selectedFile.type === 'card' && selectedFile.nodeId) {
      const segs = getNodePath(selectedFile.nodeId).map((t) => sanitizeShellPathSeg(t));
      const prefix = segs.length ? `/${segs.join('/')}/` : '/';
      const nodeCards = nodeCardsMap[selectedFile.nodeId] || [];
      const card = nodeCards.find((c: Card) => c.docId === selectedFile.cardId);
      const title = sanitizeShellPathSeg(card?.title ?? selectedFile.name ?? 'untitled');
      return `${prefix}${title}.md`;
    }
    return '~';
  }, [selectedFile, getNodePath, sanitizeShellPathSeg, nodeCardsMapVersion]);


  
  const handleAIChatPaste = useCallback(async (e: React.ClipboardEvent<HTMLInputElement>) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const inputEl = e.currentTarget;
    const selectionStart = inputEl.selectionStart ?? 0;
    const selectionEnd = inputEl.selectionEnd ?? 0;
    const currentText = chatInput;

    let reference: { type: 'node' | 'card'; id: string; name: string; path: string[] } | null = null;
    let shouldPreventDefault = false;

    
    if (clipboard && clipboard.type === 'copy' && clipboard.items.length > 0) {
      
      const firstItem = clipboard.items[0];
      if (firstItem.type === 'node') {
        const nodeId = firstItem.nodeId || '';
        const node = base.nodes.find(n => n.id === nodeId);
        if (node) {
          const path = getNodePath(nodeId);
          reference = {
            type: 'node',
            id: nodeId,
            name: node.text || i18n('Unnamed Node'),
            path,
          };
          shouldPreventDefault = true;
        }
      } else if (firstItem.type === 'card') {
        const cardId = firstItem.cardId || '';
        const nodeId = firstItem.nodeId || '';
        const cards = nodeCardsMap[nodeId] || [];
        const card = cards.find((c: Card) => c.docId === cardId);
        if (card) {
          const nodePath = getNodePath(nodeId);
          const cardPath = [...nodePath, card.title || i18n('Unnamed Card')];
          reference = {
            type: 'card',
            id: cardId,
            name: card.title || i18n('Unnamed Card'),
            path: cardPath,
          };
          shouldPreventDefault = true;
        }
      }
    }

    
    if (!reference) {
      try {
        const clipboardText = e.clipboardData.getData('text');
        if (clipboardText) {
          
          const nodeMatch = clipboardText.match(/^ejunz:\/\/node\/(.+)$/);
          const cardMatch = clipboardText.match(/^ejunz:\/\/card\/(.+)$/);
          
          if (nodeMatch) {
            const nodeId = nodeMatch[1];
            const node = base.nodes.find(n => n.id === nodeId);
            if (node) {
              const path = getNodePath(nodeId);
              reference = {
                type: 'node',
                id: nodeId,
                name: node.text || i18n('Unnamed Node'),
                path,
              };
              shouldPreventDefault = true;
            }
          } else if (cardMatch) {
            const cardId = cardMatch[1];
            
            for (const nodeId in nodeCardsMap) {
              const cards = nodeCardsMap[nodeId] || [];
              const card = cards.find((c: Card) => c.docId === cardId);
              if (card) {
                const nodePath = getNodePath(nodeId);
                const cardPath = [...nodePath, card.title || i18n('Unnamed Card')];
                reference = {
                  type: 'card',
                  id: cardId,
                  name: card.title || i18n('Unnamed Card'),
                  path: cardPath,
                };
                shouldPreventDefault = true;
                break;
              }
            }
          }
        }
      } catch (err) {
        
        console.warn('Failed to read clipboard:', err);
      }
    }

    if (reference && shouldPreventDefault) {
      e.preventDefault();
      
      const placeholder = `@${reference.name}`;
      const newText = 
        currentText.slice(0, selectionStart) + 
        placeholder + 
        currentText.slice(selectionEnd);
      
      
      setChatInputReferences(prev => {
        const newRefs = prev.map(ref => {
          
          if (ref.startIndex >= selectionStart) {
            return {
              ...ref,
              startIndex: ref.startIndex + placeholder.length,
              endIndex: ref.endIndex + placeholder.length,
            };
          }
          return ref;
        });
        
        
        newRefs.push({
          type: reference!.type,
          id: reference!.id,
          name: reference!.name,
          path: reference!.path,
          startIndex: selectionStart,
          endIndex: selectionStart + placeholder.length,
        });
        
        
        return newRefs.sort((a, b) => a.startIndex - b.startIndex);
      });
      
      setChatInput(newText);
      
      
      if (clipboard && clipboard.type === 'copy') {
        setClipboard(null);
      }
      
      
      setTimeout(() => {
        const newCursorPos = selectionStart + placeholder.length;
        inputEl.setSelectionRange(newCursorPos, newCursorPos);
        inputEl.focus();
      }, 0);
    }
  }, [clipboard, chatInput, base, getNodePath, setClipboard]);

  
  const convertBaseToText = useCallback((): string => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeMap = new Map<string, { node: BaseNode; children: string[] }>();
    const rootNodes: string[] = [];

    
    base.nodes.forEach((node) => {
      nodeMap.set(node.id, { node, children: [] });
    });

    
    base.edges.forEach((edge) => {
      const parent = nodeMap.get(edge.source);
      if (parent) {
        parent.children.push(edge.target);
      }
    });

    
    base.nodes.forEach((node) => {
      const hasParent = base.edges.some((edge) => edge.target === node.id);
      if (!hasParent) {
        rootNodes.push(node.id);
      }
    });

    
    const buildNodeText = (nodeId: string, indent: number = 0): string => {
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return '';

      const { node, children } = nodeData;
      const indentStr = '  '.repeat(indent);
      const path = getNodePath(nodeId);
      const pathStr = path.join(' > ');
      let result = `${indentStr}- ${node.text || i18n('Unnamed Node')} (ID: ${node.id}, path: ${pathStr})\n`;

      
      const cards = nodeCardsMap[nodeId] || [];
      if (cards.length > 0) {
        cards.forEach((card: Card) => {
          const cardPath = [...path, card.title || i18n('Unnamed Card')].join(' > ');
          result += `${indentStr}  📄 ${card.title || i18n('Unnamed Card')} (ID: ${card.docId}, path: ${cardPath})\n`;
          if (card.content) {
            const contentPreview = card.content.length > 100 
              ? card.content.substring(0, 100) + '...' 
              : card.content;
            result += `${indentStr}    content: ${contentPreview}\n`;
          }
        });
      }

      
      children.forEach((childId) => {
        result += buildNodeText(childId, indent + 1);
      });

      return result;
    };

    let text = 'Current outline structure:\n\n';
    rootNodes.forEach((rootId) => {
      text += buildNodeText(rootId, 0);
    });

    return text;
  }, [base, getNodePath]);

  
  const expandReferences = useCallback((message: string): string => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    let expandedMessage = message;
    
    
    const referencePattern = /@([^\s@]+)/g;
    const matches = Array.from(message.matchAll(referencePattern));
    
    
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const refName = match[1];
      const startIndex = match.index!;
      const endIndex = startIndex + match[0].length;
      
      
      const matchedNode = base.nodes.find(n => n.text === refName);
      if (matchedNode) {
        const path = getNodePath(matchedNode.id);
        const pathStr = path.join(' > ');
        const expandedRef = `@${refName} (node ID: ${matchedNode.id}, full path: ${pathStr})`;
        expandedMessage = expandedMessage.slice(0, startIndex) + expandedRef + expandedMessage.slice(endIndex);
        continue;
      }
      
      
      for (const nodeId in nodeCardsMap) {
        const cards = nodeCardsMap[nodeId] || [];
        const matchedCard = cards.find((c: Card) => c.title === refName);
        if (matchedCard) {
          const nodePath = getNodePath(nodeId);
          const cardPath = [...nodePath, matchedCard.title || i18n('Unnamed Card')].join(' > ');
          
          const fullContent = matchedCard.content || i18n('(No content)');
          const expandedRef = `@${refName} (card ID: ${matchedCard.docId}, full path: ${cardPath}, full content: ${fullContent})`;
          expandedMessage = expandedMessage.slice(0, startIndex) + expandedRef + expandedMessage.slice(endIndex);
          break;
        }
      }
    }
    
    return expandedMessage;
  }, [base, getNodePath]);

  
  const handleAIChatSend = useCallback(async () => {
    if (!chatInput.trim() || isChatLoading) return;

    const userMessage = chatInput.trim();
    
    const references = chatInputReferences.map(ref => ({
      type: ref.type,
      id: ref.id,
      name: ref.name,
      path: ref.path,
    }));
    
    
    const expandedMessage = expandReferences(userMessage);
    setChatInput('');
    setChatInputReferences([]);
    setIsChatLoading(true);

    
    const historyBeforeNewMessage = chatMessages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .map(msg => {
        
        let content = msg.content;
        
        if (!content && msg.role === 'assistant') {
          content = 'Done';
        }
        return {
          role: msg.role,
          content: content,
        };
      });
    
    console.log('AI chat history (before this turn):', historyBeforeNewMessage);
    
    
    let assistantMessageIndex: number;
    setChatMessages(prev => {
      const newMessages: Array<{ 
        role: 'user' | 'assistant' | 'operation'; 
        content: string; 
        references?: Array<{ type: 'node' | 'card'; id: string; name: string; path: string[] }>;
        operations?: any[];
        isExpanded?: boolean;
      }> = [
        ...prev, 
        { 
          role: 'user' as const, 
          content: userMessage,
          references: references.length > 0 ? references : undefined,
        }
      ];
      assistantMessageIndex = newMessages.length;
      newMessages.push({ role: 'assistant' as const, content: '' });
      return newMessages;
    });

    
    scrollToBottomIfNeeded();

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      const history = historyBeforeNewMessage;

      
      const baseText = convertBaseToText();
      
      
      const finalUserMessage = expandedMessage;

      
      let currentCardContext = '';
      const currentCard = getSelectedCard();
      if (currentCard && selectedFile && selectedFile.type === 'card') {
        const nodePath = getNodePath(selectedFile.nodeId || '');
        const cardPath = [...nodePath, currentCard.title || i18n('Unnamed Card')].join(' > ');
        const problems = currentCard.problems || [];
        
        
        let problemsText = '';
        if (problems.length > 0) {
          problemsText = '\n- Existing problems on this card:\n';
          problems.forEach((p: Problem, index: number) => {
            const k = problemKind(p);
            if (k === 'flip') {
              const f = p as ProblemFlip;
              problemsText += `\n  Problem ${index + 1} (ID: ${p.pid}): flip card\n`;
              problemsText += `  - faceA: ${f.faceA}\n  - faceB: ${f.faceB}\n`;
              if (f.analysis) problemsText += `  - analysis: ${f.analysis}\n`;
              return;
            }
            if (k === 'true_false') {
              const tf = p as ProblemTrueFalse;
              problemsText += `\n  Problem ${index + 1} (ID: ${p.pid}): true/false\n`;
              problemsText += `  - stem: ${tf.stem}\n  - correct answer: ${tf.answer === 1 ? 'true (1)' : 'false (0)'}\n`;
              if (tf.analysis) problemsText += `  - analysis: ${tf.analysis}\n`;
              return;
            }
            if (k === 'multi') {
              const pm = p as ProblemMulti;
              const set = new Set(pm.answer || []);
              const optionsText = pm.options.map((opt, oi) =>
                `  ${String.fromCharCode(65 + oi)}. ${opt}${set.has(oi) ? ' (correct)' : ''}`
              ).join('\n');
              problemsText += `\n  Problem ${index + 1} (ID: ${p.pid}): multiple choice\n`;
              problemsText += `  - stem: ${pm.stem}\n  - options:\n${optionsText}\n`;
              problemsText += `  - answer index array: ${JSON.stringify([...(pm.answer || [])].sort((a, b) => a - b))}\n`;
              if (pm.analysis) problemsText += `  - analysis: ${pm.analysis}\n`;
              return;
            }
            const ps = p as ProblemSingle;
            const optionsText = ps.options.map((opt, oi) =>
              `  ${String.fromCharCode(65 + oi)}. ${opt}${oi === ps.answer ? ' (correct)' : ''}`
            ).join('\n');
            problemsText += `\n  Problem ${index + 1} (ID: ${p.pid}): single choice\n`;
            problemsText += `  - stem: ${ps.stem}\n`;
            problemsText += `  - options:\n${optionsText}\n`;
            if (ps.analysis) {
              problemsText += `  - analysis: ${ps.analysis}\n`;
            }
          });
        } else {
          problemsText = '\n- Existing problems on this card: none';
        }
        
        currentCardContext = `
[Currently open card]
- Title: ${currentCard.title || i18n('Unnamed Card')}
- Card ID: ${currentCard.docId}
- Path: ${cardPath}
- Content: ${currentCard.content || i18n('(No content)')}
- Problem count: ${problems.length}${problemsText}

`;
      }

      
      const systemPrompt = `You are a knowledge-base assistant. You help users edit their outline (nodes) and cards.

[Core responsibilities]
1. **create_node**: create a new node under a parent when asked
2. **create_card**: create a card under a node
3. **move_node**: move a node to a new parent
4. **rename**: rename a node or card
5. **update_card_content**: change card body/markdown when the user asks to edit, polish, format, or improve *content* (not the title)
6. **delete**: delete a node or card when asked
7. **create_problem**: add practice problems for the **currently open card** when asked. Use \`problemKind\`: \`single\` (default, one correct option index in \`answer\`), \`multi\` (\`answer\` is an array of correct option indices), \`true_false\` (\`stem\` + \`answer\` 0 = false, 1 = true), \`flip\` (\`faceA\` / \`faceB\`, no \`options\`)

[Outline structure]
${baseText}
${currentCardContext}

[Editor selection path]
The user's current selection in the left tree (like Git export: nodes are folders with trailing /; cards are .md under that folder):
${editorShellPath}

[Response format for mutations]
Reply with a JSON code block only for executable operations, using this shape:
\`\`\`json
{
  "operations": [
    {
      "type": "create_node",
      "parentId": "node_xxx",
      "text": "New node title"
    },
    {
      "type": "create_card",
      "nodeId": "node_xxx",
      "title": "Card title",
      "content": "Optional markdown body"
    },
    {
      "type": "move_node",
      "nodeId": "node_xxx",
      "targetParentId": "node_yyy"
    },
    {
      "type": "move_card",
      "cardId": "card_xxx",
      "targetNodeId": "node_yyy"
    },
    {
      "type": "rename_node",
      "nodeId": "node_xxx",
      "newText": "New node title"
    },
    {
      "type": "rename_card",
      "cardId": "card_xxx",
      "newTitle": "New card title"
    },
    {
      "type": "update_card_content",
      "cardId": "card_xxx",
      "newContent": "New markdown content"
    },
    {
      "type": "delete_node",
      "nodeId": "node_xxx"
    },
    {
      "type": "delete_card",
      "cardId": "card_xxx"
    },
    {
      "type": "create_problem",
      "cardId": "card_xxx",
      "problemKind": "single",
      "stem": "Question stem",
      "options": ["A", "B", "C", "D"],
      "answer": 0,
      "analysis": "Optional explanation"
    },
    {
      "type": "create_problem",
      "cardId": "card_xxx",
      "problemKind": "multi",
      "stem": "Question stem",
      "options": ["A","B","C","D"],
      "answer": [0, 2],
      "analysis": "Optional"
    },
    {
      "type": "create_problem",
      "cardId": "card_xxx",
      "problemKind": "true_false",
      "stem": "IPv6 addresses are 128 bits long.",
      "answer": 1,
      "analysis": "Optional"
    },
    {
      "type": "create_problem",
      "cardId": "card_xxx",
      "problemKind": "flip",
      "faceA": "Front prompt or summary",
      "faceB": "Back answer or detail",
      "analysis": "Optional"
    }
  ]
}
\`\`\`

[Rules]
1. When you need to perform edits, output **only** a \`\`\`json ... \`\`\` block with \`operations\` (no extra prose around it).
2. If the user is only asking a question and no mutation is needed, answer in plain text and **do not** output JSON.
3. For "fix/improve/format/polish **content**" requests, use \`update_card_content\` on the card body, **not** \`rename_card\`.
4. Use \`rename_card\` / \`rename_node\` only when the user clearly wants to change a **title/name**.
5. **move_node**: read the outline above; match the user's folder/node by **name and full path**, then use the real **node ID** as \`targetParentId\`. Node IDs look like \`node_...\`; they are **not** card IDs (cards use long hex-like ids). "Move folder" means move a **node**. If you cannot resolve a target, reply with an error in plain text instead of guessing IDs.
6. **move_card**: to move a **card**, use \`move_card\` (card id + \`targetNodeId\`). Never use \`move_node\` for a card. If the user @-mentions a card, use \`move_card\` with that card's id.
7. **create_problem**: omit \`problemKind\` or set \`single\` for classic single-choice; \`multi\` requires \`answer\` as an array; \`true_false\` requires \`stem\` and \`answer\` 0/1; \`flip\` requires \`faceA\` and \`faceB\` and must **not** include \`options\`.
8. **Valid JSON**: never put raw line breaks or unescaped \`"\` inside a string value; use standard JSON escaping (backslash + quote, backslash + n for newline).
9. **Streaming**: emit each \`operations[]\` entry as a **fully closed** \`{ ... }\` object (balanced braces) **before** starting the next. The editor applies each finished object immediately—trailing incomplete objects wait until complete.
`;

      
      if (chatWebSocketRef.current) {
        chatWebSocketRef.current.close();
        chatWebSocketRef.current = null;
      }

      
      const { default: WebSocket } = await import('../components/socket');
      const wsPrefix = (window as any).UiContext?.wsPrefix || '';
      const wsUrl = `/d/${domainId}/ai/chat-ws`;
      const sock = new WebSocket(wsPrefix + wsUrl, false, true);
      chatWebSocketRef.current = sock;

      let accumulatedContent = '';
      let streamFinished = false;
      let streamedAiOpsExecuted = 0;
      let streamExecChain: Promise<unknown> = Promise.resolve();

      sock.onmessage = (_, data: string) => {
        try {
          const msg = JSON.parse(data);
          
          if (msg.type === 'content') {
            accumulatedContent += msg.content;

            const split = splitAiAssistantStream(accumulatedContent);
            let displayContent = split.visibleProse;
            if (!split.inFence) {
              const stripClosed = accumulatedContent.replace(/```\s*json\s*\r?\n[\s\S]*?\r?\n```/gi, '').trim();
              displayContent = stripClosed;
            }
            const rawTypes = split.inFence ? extractAiOperationTypesPartial(split.fenceBody) : [];
            const opLines = rawTypes.map((x) => friendlyAiOperationLabel(x));

            setChatMessages(prev => {
              const newMessages = [...prev];
              if (newMessages[assistantMessageIndex]) {
                newMessages[assistantMessageIndex] = {
                  role: 'assistant',
                  content:
                    displayContent
                    || (split.inFence ? '' : 'Thinking…'),
                  streamOps: split.inFence
                    ? {
                        lines: opLines,
                        receiving: true,
                        charCount: split.fenceBody.length,
                      }
                    : null,
                };
              }
              return newMessages;
            });

            if (split.inFence && executeAIOperationsRef.current) {
              const parsedSoFar = extractParsedOperationsFromPartialFence(split.fenceBody);
              const fn = executeAIOperationsRef.current;
              while (streamedAiOpsExecuted < parsedSoFar.length) {
                const op = parsedSoFar[streamedAiOpsExecuted];
                streamedAiOpsExecuted += 1;
                streamExecChain = streamExecChain.then(() => fn([op], { quiet: true }));
              }
            }

            scrollToBottomIfNeeded();
          } else if (msg.type === 'done') {
            streamFinished = true;
            const finalContent = msg.content || accumulatedContent;
            
            
            const jsonMatch = finalContent.match(/```\s*json\s*\r?\n([\s\S]*?)\r?\n```/i);
            let textContent = finalContent.replace(/```\s*json\s*\r?\n[\s\S]*?\r?\n```/gi, '').trim();

            setChatMessages(prev => {
              const newMessages = [...prev];
              if (newMessages[assistantMessageIndex]) {
                newMessages[assistantMessageIndex] = {
                  role: 'assistant',
                  content: textContent || 'Done',
                  streamOps: null,
                };
              }
              return newMessages;
            });
            
            
            scrollToBottomIfNeeded();

            let opsChainFinishesLoading = false;
            if (jsonMatch) {
                try {
                  const parseOperationPayload = (raw: string) => {
                    let text = String(raw || '').trim();
                    text = text
                      .replace(/[“”]/g, '"')
                      .replace(/[‘’]/g, '\'')
                      .replace(/^\uFEFF/, '')
                      .replace(/,\s*([}\]])/g, '$1');
                    const firstBrace = text.indexOf('{');
                    const firstBracket = text.indexOf('[');
                    const start = firstBrace === -1 ? firstBracket : (firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket));
                    if (start > 0) text = text.slice(start).trim();
                    try {
                      return JSON.parse(text);
                    } catch (e1) {
                      try {
                        return JSON.parse(jsonrepair(text));
                      } catch {
                        throw e1;
                      }
                    }
                  };

                  const operations = parseOperationPayload(jsonMatch[1]);
                  if (operations.operations && Array.isArray(operations.operations)) {
                    const allOps = operations.operations as any[];
                    console.log('AI operations payload:', allOps);

                    setChatMessages(prev => {
                      const newMessages = [...prev];
                      newMessages.push({
                        role: 'operation',
                        content: `Applying ${allOps.length} operation(s)`,
                        operations: allOps,
                        isExpanded: false,
                      });
                      return newMessages;
                    });

                    if (executeAIOperationsRef.current) {
                      opsChainFinishesLoading = true;
                      const fn = executeAIOperationsRef.current;
                      streamExecChain = streamExecChain.then(async () => {
                        const rem = allOps.slice(streamedAiOpsExecuted);
                        if (!rem.length) {
                          return { success: true, errors: [] as string[] };
                        }
                        const result = await fn(rem, { quiet: true });
                        if (result.success) {
                          streamedAiOpsExecuted = allOps.length;
                        }
                        return result;
                      });
                      streamExecChain
                        .then((result: any) => {
                          if (!result?.success) {
                            const errorText = (result?.errors || []).join('\n');
                            setChatMessages(prev => {
                              const newMessages = [...prev];
                              newMessages.push({
                                role: 'assistant',
                                content: `Operations failed:\n${errorText}\n\nFix the issues above (check node vs card IDs) and try again.`,
                              });
                              return newMessages;
                            });
                            scrollToBottomIfNeeded();
                            return;
                          }
                          if (allOps.length) {
                            Notification.success('AI operations applied');
                          }
                        })
                        .catch((err) => {
                          console.error('Failed to execute operations:', err);
                          const errorMsg = 'Failed to run operations: ' + (err.message || 'unknown error');
                          Notification.error(errorMsg);
                          setChatMessages(prev => {
                            const newMessages = [...prev];
                            newMessages.push({
                              role: 'assistant',
                              content: `Operations failed: ${errorMsg}\n\nPlease try again.`,
                            });
                            return newMessages;
                          });
                        })
                        .finally(() => {
                          if (chatWebSocketRef.current) {
                            chatWebSocketRef.current.close();
                            chatWebSocketRef.current = null;
                          }
                          setIsChatLoading(false);
                        });
                    } else {
                      setTimeout(async () => {
                        if (executeAIOperationsRef.current) {
                          const result = await executeAIOperationsRef.current(allOps);
                          if (result.success) {
                            Notification.success('AI operations applied');
                          } else {
                            const errorText = result.errors.join('\n');
                            setChatMessages(prev => {
                              const newMessages = [...prev];
                              newMessages.push({
                                role: 'assistant',
                                content: `Operations failed:\n${errorText}\n\nPlease fix and try again.`,
                              });
                              return newMessages;
                            });
                          }
                        }
                      }, 100);
                    }
                  }
                } catch (e) {
                  console.error('Failed to parse AI operations:', e);
                  const rawPreview = (jsonMatch[1] || '').slice(0, 240).replace(/\s+/g, ' ');
                  Notification.error(`Failed to parse AI operations: ${(e as any).message || 'unknown error'}. Raw snippet: ${rawPreview}`);
                }
              }

            if (!opsChainFinishesLoading) {
              if (chatWebSocketRef.current) {
                chatWebSocketRef.current.close();
                chatWebSocketRef.current = null;
              }
              setIsChatLoading(false);
            }
          } else if (msg.type === 'error') {
            streamFinished = true;
            setChatMessages(prev => {
              const newMessages = [...prev];
              if (newMessages[assistantMessageIndex]) {
                newMessages[assistantMessageIndex] = {
                  role: 'assistant',
                  content: `Error: ${msg.error || 'unknown error'}`,
                };
              }
              return newMessages;
            });
            Notification.error('AI chat failed: ' + (msg.error || 'unknown error'));
            setIsChatLoading(false);
            
            
            if (chatWebSocketRef.current) {
              chatWebSocketRef.current.close();
              chatWebSocketRef.current = null;
            }
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      sock.onclose = () => {
        chatWebSocketRef.current = null;
        if (!streamFinished) {
          setIsChatLoading(false);
        }
      };

      sock.onopen = () => {
        
        sock.send(JSON.stringify({
          message: `${systemPrompt}\n\nUser request:\n${finalUserMessage}`,
          history,
        }));
      };
    } catch (error: any) {
      setChatMessages(prev => {
        const newMessages = [...prev];
        if (newMessages[assistantMessageIndex]) {
          newMessages[assistantMessageIndex] = {
            role: 'assistant',
            content: `Error: ${error.message || 'unknown error'}`,
          };
        }
        return newMessages;
      });
      Notification.error('AI chat failed: ' + (error.message || 'unknown error'));
    } finally {
      setIsChatLoading(false);
    }
  }, [
    chatInput,
    isChatLoading,
    chatMessages,
    convertBaseToText,
    expandReferences,
    editorShellPath,
    getSelectedCard,
    selectedFile,
    getNodePath,
  ]);

  
  const executeAIOperations = useCallback<ExecuteAiOpsFn>(async (
    operations,
    execOpts,
  ) => {
    const quiet = Boolean(execOpts?.quiet);
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const errors: string[] = [];
    
    for (const op of operations) {
      try {
        if (op.type === 'create_node') {
          const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const newChildNode: PendingCreate = {
            type: 'node',
            nodeId: op.parentId || '',
            text: op.text || i18n('New node'),
            tempId,
          };
          
          pendingCreatesRef.current.set(tempId, newChildNode);
          setPendingCreatesCount(pendingCreatesRef.current.size);
          
          const tempNode: BaseNode = {
            id: tempId,
            text: op.text || i18n('New node'),
          };
          
          setBase(prev => ({
            ...prev,
            nodes: [...prev.nodes, tempNode],
            edges: op.parentId ? [...prev.edges, {
              id: `temp-edge-${Date.now()}`,
              source: op.parentId,
              target: tempId,
            }] : prev.edges,
          }));
          
          if (op.parentId) {
            setExpandedNodes(prev => {
              const newSet = new Set(prev);
              newSet.add(tempId);
              if (!newSet.has(op.parentId)) {
                newSet.add(op.parentId);
                expandedNodesRef.current = newSet;
                setBase(prev => {
                  const updated = {
                    ...prev,
                    nodes: prev.nodes.map(n =>
                      n.id === op.parentId
                        ? { ...n, expanded: true }
                        : n
                    ),
                  };
                  
                  baseRef.current = updated;
                  return updated;
                });
                triggerExpandAutoSave();
              }
              return newSet;
            });
          } else {
            setExpandedNodes(prev => {
              const newSet = new Set(prev);
              newSet.add(tempId);
              expandedNodesRef.current = newSet;
              return newSet;
            });
          }
        } else if (op.type === 'create_card') {
          const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const newCard: PendingCreate = {
            type: 'card',
            nodeId: op.nodeId,
            title: op.title || i18n('New card'),
            tempId,
          };
          
          pendingCreatesRef.current.set(tempId, newCard);
          setPendingCreatesCount(pendingCreatesRef.current.size);
          
          if (!nodeCardsMap[op.nodeId]) {
            nodeCardsMap[op.nodeId] = [];
          }
          const maxOrder = nodeCardsMap[op.nodeId].length > 0 
            ? Math.max(...nodeCardsMap[op.nodeId].map((c: Card) => c.order || 0))
            : 0;
          
          const tempCard: Card = {
            docId: tempId,
            cid: 0,
            nodeId: op.nodeId,
            title: op.title || i18n('New card'),
            content: op.content || '',
            order: maxOrder + 1,
            updateAt: new Date().toISOString(),
          } as Card;
          
          nodeCardsMap[op.nodeId].push(tempCard);
          nodeCardsMap[op.nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
          setExpandedNodes(prev => new Set(prev).add(op.nodeId));
        } else if (op.type === 'move_node') {
          let nodeId = op.nodeId;
          const targetParentId = op.targetParentId;
          
          console.log('执行 move_node 操作:', { nodeId, targetParentId });
          console.log('所有可用节点:', base.nodes.map(n => ({ id: n.id, text: n.text })));
          
          
          let node = base.nodes.find(n => n.id === nodeId);
          
          
          if (!node) {
            const nodeByName = base.nodes.find(n => n.text === nodeId);
            if (nodeByName) {
              console.warn(`警告：nodeId "${nodeId}" 是节点名称，不是节点ID。应该使用节点ID "${nodeByName.id}"`);
              const errorMsg = `错误：nodeId "${nodeId}" 是节点名称，不是节点ID。请使用节点ID "${nodeByName.id}"`;
              Notification.error(errorMsg);
              errors.push(errorMsg);
              continue;
            }
          }
          
          
          if (!node) {
            console.log('nodeId 不是节点ID，可能是卡片ID:', nodeId);
            
            for (const nId in nodeCardsMap) {
              const cards = nodeCardsMap[nId] || [];
              const card = cards.find((c: Card) => c.docId === nodeId);
              if (card) {
                console.log('找到卡片，但使用了 move_node 操作，应该使用 move_card');
                const errorMsg = `检测到 ${nodeId} 是卡片ID，不是节点ID。移动卡片请使用 move_card 操作，而不是 move_node。`;
                Notification.error(errorMsg);
                errors.push(errorMsg);
                continue;
              }
            }
            console.error('节点不存在:', nodeId);
            console.log('所有节点ID:', base.nodes.map(n => ({ id: n.id, text: n.text })));
            const errorMsg = `节点 ${nodeId} 不存在。请检查节点ID是否正确。`;
            Notification.error(errorMsg);
            errors.push(errorMsg);
            continue;
          }
          
          
          if (targetParentId) {
            const targetNode = base.nodes.find(n => n.id === targetParentId);
            
            
            if (!targetNode) {
              const targetNodeByName = base.nodes.find(n => n.text === targetParentId);
              if (targetNodeByName) {
                console.warn(`警告：targetParentId "${targetParentId}" 是节点名称，不是节点ID。应该使用节点ID "${targetNodeByName.id}"`);
                const errorMsg = `错误：targetParentId "${targetParentId}" 是节点名称，不是节点ID。请使用节点ID "${targetNodeByName.id}"`;
                Notification.error(errorMsg);
                errors.push(errorMsg);
                continue;
              }
              
              console.error('目标节点不存在:', targetParentId);
              console.log('所有节点ID:', base.nodes.map(n => ({ id: n.id, text: n.text })));
              const errorMsg = `目标节点 ${targetParentId} 不存在。请检查节点ID是否正确。`;
              Notification.error(errorMsg);
              errors.push(errorMsg);
              continue;
            }
            console.log('目标节点:', { id: targetNode.id, text: targetNode.text });
          } else {
            console.log('移动到根节点');
          }
          
          
          const isDescendant = (ancestorId: string, nodeId: string): boolean => {
            const children = base.edges
              .filter(e => e.source === ancestorId)
              .map(e => e.target);
            if (children.includes(nodeId)) return true;
            return children.some(childId => isDescendant(childId, nodeId));
          };
          
          if (targetParentId && isDescendant(nodeId, targetParentId)) {
            const errorMsg = '不能将节点移动到自己的子节点下';
            Notification.error(errorMsg);
            errors.push(errorMsg);
            continue;
          }
          
          
          const oldEdges = base.edges.filter(e => e.target === nodeId);
          const newEdges = base.edges.filter(e => !oldEdges.includes(e));
          
          
          if (targetParentId) {
            
            const existingEdge = newEdges.find(e => e.source === targetParentId && e.target === nodeId);
            if (!existingEdge) {
              newEdges.push({
                id: `edge-${targetParentId}-${nodeId}-${Date.now()}`,
                source: targetParentId,
                target: nodeId,
              });
            }
          }
          
          setBase(prev => ({
            ...prev,
            edges: newEdges,
          }));
          
          setPendingDragChanges(prev => new Set(prev).add(`node-${nodeId}`));
          
          
          if (targetParentId) {
            setExpandedNodes(prev => {
              const newSet = new Set(prev);
              if (!newSet.has(targetParentId)) {
                newSet.add(targetParentId);
                
                expandedNodesRef.current = newSet;
                
                setBase(prev => {
                  const updated = {
                    ...prev,
                    nodes: prev.nodes.map(n =>
                      n.id === targetParentId
                        ? { ...n, expanded: true }
                        : n
                    ),
                  };
                  
                  baseRef.current = updated;
                  return updated;
                });
                
                triggerExpandAutoSave();
              }
              return newSet;
            });
          }
          
          if (!quiet) {
            Notification.success(`节点已移动到 ${targetParentId ? '目标节点下' : '根节点'}`);
          }
        } else if (op.type === 'move_card') {
          const cardId = op.cardId;
          const targetNodeId = op.targetNodeId;
          
          console.log('执行 move_card 操作:', { cardId, targetNodeId });
          
          
          const targetNode = base.nodes.find(n => n.id === targetNodeId);
          if (!targetNode) {
            console.error('目标节点不存在:', targetNodeId);
            console.log('所有节点ID:', base.nodes.map(n => ({ id: n.id, text: n.text })));
            Notification.error(`目标节点 ${targetNodeId} 不存在。请检查节点ID是否正确。`);
            continue;
          }
          
          
          let foundCard: Card | null = null;
          let sourceNodeId: string | null = null;
          
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              sourceNodeId = nodeId;
              break;
            }
          }
          
          if (!foundCard || !sourceNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          
          if (sourceNodeId === targetNodeId) {
            Notification.error('卡片已经在目标节点下');
            continue;
          }
          
          
          const sourceCards = nodeCardsMap[sourceNodeId] || [];
          const cardIndex = sourceCards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            sourceCards.splice(cardIndex, 1);
            nodeCardsMap[sourceNodeId] = sourceCards;
          }
          
          
          if (!nodeCardsMap[targetNodeId]) {
            nodeCardsMap[targetNodeId] = [];
          }
          
          
          const maxOrder = nodeCardsMap[targetNodeId].length > 0
            ? Math.max(...nodeCardsMap[targetNodeId].map((c: Card) => c.order || 0))
            : 0;
          
          
          const updatedCard: Card = {
            ...foundCard,
            nodeId: targetNodeId,
            order: maxOrder + 1,
          };
          
          nodeCardsMap[targetNodeId].push(updatedCard);
          nodeCardsMap[targetNodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
          
          
          setPendingDragChanges(prev => new Set(prev).add(cardId));
          
          
          setExpandedNodes(prev => {
            const newSet = new Set(prev);
            if (!newSet.has(targetNodeId)) {
              newSet.add(targetNodeId);
              
              expandedNodesRef.current = newSet;
              
              setBase(prev => {
                const updated = {
                  ...prev,
                  nodes: prev.nodes.map(n =>
                    n.id === targetNodeId
                      ? { ...n, expanded: true }
                      : n
                  ),
                };
                
                baseRef.current = updated;
                return updated;
              });
              
              triggerExpandAutoSave();
            }
            return newSet;
          });
          
          if (!quiet) {
            Notification.success(`卡片已移动到节点 ${targetNode.text} 下`);
          }
        } else if (op.type === 'rename_node') {
          const nodeId = op.nodeId;
          const newText = op.newText;
          
          const node = base.nodes.find(n => n.id === nodeId);
          if (!node) {
            Notification.error(`节点 ${nodeId} 不存在`);
            continue;
          }
          
          
          setBase(prev => ({
            ...prev,
            nodes: prev.nodes.map(n => 
              n.id === nodeId ? { ...n, text: newText } : n
            ),
          }));
          
          
          const fileItem: FileItem = {
            type: 'node',
            id: nodeId,
            name: node.text || i18n('Unnamed Node'),
            nodeId: nodeId,
            level: 0,
          };
          
          setPendingRenames(prev => {
            const next = new Map(prev);
            next.set(nodeId, {
              file: fileItem,
              newName: newText,
              originalName: node.text || i18n('Unnamed Node'),
            });
            return next;
          });
        } else if (op.type === 'rename_card') {
          const cardId = op.cardId;
          const newTitle = op.newTitle;
          
          
          let foundCard: Card | null = null;
          let foundNodeId: string | null = null;
          
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              foundNodeId = nodeId;
              break;
            }
          }
          
          if (!foundCard || !foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          
          const cards = nodeCardsMap[foundNodeId];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards[cardIndex] = { ...cards[cardIndex], title: newTitle };
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
          }
          
          
          const fileItem: FileItem = {
            type: 'card',
            id: `card-${cardId}`,
            name: foundCard.title || i18n('Unnamed Card'),
            nodeId: foundNodeId,
            cardId: cardId,
            level: 0,
          };
          
          setPendingRenames(prev => {
            const next = new Map(prev);
            next.set(`card-${cardId}`, {
              file: fileItem,
              newName: newTitle,
              originalName: foundCard!.title || i18n('Unnamed Card'),
            });
            return next;
          });
        } else if (op.type === 'update_card_content') {
          const cardId = op.cardId;
          const newContent = op.newContent;
          
          
          let foundCard: Card | null = null;
          let foundNodeId: string | null = null;
          
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              foundNodeId = nodeId;
              break;
            }
          }
          
          if (!foundCard || !foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          
          const cards = nodeCardsMap[foundNodeId];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards[cardIndex] = { ...cards[cardIndex], content: newContent };
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
          }
          
          
          const fileItem: FileItem = {
            type: 'card',
            id: `card-${cardId}`,
            name: foundCard.title || i18n('Unnamed Card'),
            nodeId: foundNodeId,
            cardId: cardId,
            level: 0,
          };
          
          
          setPendingChanges(prev => {
            const next = new Map(prev);
            next.set(`card-${cardId}`, {
              file: fileItem,
              content: newContent,
              originalContent: foundCard!.content || '',
            });
            
            return new Map(next);
          });
          
          
          const currentSelected = selectedFileRef.current;
          if (currentSelected && currentSelected.type === 'card' && currentSelected.cardId === cardId) {
            // Guard: do not write to editor if selection changed during the delay (e.g. user switched to a node or another card), otherwise card content could be saved as node text.
            setTimeout(() => {
              const latestSelected = selectedFileRef.current;
              if (!latestSelected || latestSelected.type !== 'card' || latestSelected.cardId !== cardId) return;
              
              // Only update fileContent when still editing the same card.
              setFileContent(newContent);
              
              if (editorRef.current) {
                editorRef.current.value = newContent;
                
                const event = new Event('input', { bubbles: true });
                editorRef.current.dispatchEvent(event);
              }
              
              if (editorInstance) {
                try {
                  editorInstance.value(newContent);
                } catch (e) {
                  // ignore
                }
              }
              
              const $textarea = $(`#editor-wrapper-${latestSelected.id} textarea`);
              if ($textarea.length > 0) {
                $textarea.val(newContent);
                
                if ($textarea.attr('data-markdown') === 'true') {
                  $textarea.trigger('change');
                }
              }
            }, 100);
          }
        } else if (op.type === 'delete_node') {
          const nodeId = op.nodeId;
          const node = base.nodes.find(n => n.id === nodeId);
          if (!node) {
            Notification.error(`节点 ${nodeId} 不存在`);
            continue;
          }
          
          
          const hasCards = nodeCardsMap[nodeId]?.length > 0;
          const hasChildren = base.edges.some(e => e.source === nodeId);
          
          if (hasCards || hasChildren) {
            Notification.error(i18n('Cannot delete: node has children or cards'));
            continue;
          }
          
          setPendingDeletes(prev => {
            const next = new Map(prev);
            next.set(nodeId, {
              type: 'node',
              id: nodeId,
            });
            return next;
          });
          
          setBase(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => n.id !== nodeId),
            edges: prev.edges.filter(e => e.source !== nodeId && e.target !== nodeId),
          }));
        } else if (op.type === 'delete_card') {
          const cardId = op.cardId;
          
          
          let foundNodeId: string | null = null;
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundNodeId = nodeId;
              break;
            }
          }
          
          if (!foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          setPendingDeletes(prev => {
            const next = new Map(prev);
            next.set(cardId, {
              type: 'card',
              id: cardId,
              nodeId: foundNodeId!,
            });
            return next;
          });
          
          const cards = nodeCardsMap[foundNodeId!];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards.splice(cardIndex, 1);
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
          }
        } else if (op.type === 'create_problem') {
          const cardId = op.cardId;
          const analysis = op.analysis;

          if (!cardId) {
            Notification.error(i18n('cardId is required'));
            errors.push('create_problem 操作缺少 cardId');
            continue;
          }

          let foundCard: Card | null = null;
          let foundNodeId: string | null = null;

          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => sameCardDocId(c.docId, cardId));
            if (card) {
              foundCard = card;
              foundNodeId = nodeId;
              break;
            }
          }

          if (!foundCard || !foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            errors.push(`卡片 ${cardId} 不存在`);
            continue;
          }

          const rawKind = String(op.problemKind || op.kind || '').toLowerCase().trim();
          const kind: ProblemKind =
            rawKind === 'multi' || rawKind === 'true_false' || rawKind === 'flip' ? rawKind : 'single';

          const pid = `p_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
          const analysisStr = typeof analysis === 'string' && analysis.trim() ? analysis.trim() : undefined;
          let newProblem: Problem;

          if (kind === 'flip') {
            const faceA = String(op.faceA ?? op.stem ?? '').trim();
            const faceB = String(op.faceB ?? '').trim();
            if (!faceA || !faceB) {
              Notification.error('翻转题需要 faceA 与 faceB');
              errors.push('create_problem flip：缺少 faceA 或 faceB');
              continue;
            }
            newProblem = migrateRawProblem({
              pid,
              type: 'flip',
              faceA,
              faceB,
              ...(analysisStr ? { analysis: analysisStr } : {}),
            });
          } else if (kind === 'true_false') {
            const stem = String(op.stem ?? '').trim();
            if (!stem) {
              Notification.error('题干是必需的');
              errors.push('create_problem true_false：缺少 stem');
              continue;
            }
            const a = op.answer;
            let av: 0 | 1 = 0;
            if (a === true || a === 1 || a === '1' || String(a).toLowerCase() === 'true' || String(a) === '正确' || String(a) === '真') {
              av = 1;
            } else if (a === false || a === 0 || a === '0' || String(a).toLowerCase() === 'false' || String(a) === '错误' || String(a) === '假') {
              av = 0;
            } else if (typeof a === 'number' && Number.isFinite(a)) {
              av = a >= 1 ? 1 : 0;
            } else if (typeof a === 'string' && /^\d+$/.test(a.trim())) {
              av = parseInt(a.trim(), 10) >= 1 ? 1 : 0;
            }
            newProblem = migrateRawProblem({
              pid,
              type: 'true_false',
              stem,
              answer: av,
              ...(analysisStr ? { analysis: analysisStr } : {}),
            });
          } else if (kind === 'multi') {
            const stem = String(op.stem ?? '').trim();
            const options = Array.isArray(op.options) ? op.options.map((x: unknown) => String(x ?? '')) : [];
            if (!stem) {
              Notification.error('题干是必需的');
              errors.push('create_problem multi：缺少 stem');
              continue;
            }
            if (options.length < 2) {
              Notification.error('至少需要两个选项');
              errors.push('create_problem multi：选项数量不足');
              continue;
            }
            const ar = op.answer ?? op.answers;
            const coercedAnswers = Array.isArray(ar)
              ? ar
                  .map((x: unknown) => {
                    if (typeof x === 'number' && Number.isFinite(x)) return Math.trunc(x);
                    if (typeof x === 'string' && /^\d+$/.test(x.trim())) return parseInt(x.trim(), 10);
                    return NaN;
                  })
                  .filter((x: number) => Number.isFinite(x))
              : ar;
            newProblem = migrateRawProblem({
              pid,
              type: 'multi',
              stem,
              options,
              answer: coercedAnswers,
              ...(typeof op.optionSlots === 'number' && Number.isFinite(op.optionSlots) ? { optionSlots: op.optionSlots } : {}),
              ...(analysisStr ? { analysis: analysisStr } : {}),
            });
            if (isMultiProblem(newProblem)) {
              const n = newProblem.options.length;
              const ans = normalizeMultiAnswers(newProblem.answer).filter((i) => i >= 0 && i < n);
              if (!ans.length) {
                Notification.error('多选题至少指定一个有效答案下标');
                errors.push('create_problem multi：answer 无效');
                continue;
              }
              newProblem = { ...newProblem, answer: ans };
            }
          } else {
            const stem = String(op.stem ?? '').trim();
            const options = Array.isArray(op.options) ? op.options.map((x: unknown) => String(x ?? '')) : [];
            const answerRaw = op.answer;
            let answerNum = NaN;
            if (typeof answerRaw === 'number' && Number.isFinite(answerRaw)) {
              answerNum = Math.trunc(answerRaw);
            } else if (typeof answerRaw === 'string' && /^\d+$/.test(answerRaw.trim())) {
              answerNum = parseInt(answerRaw.trim(), 10);
            }
            if (!stem) {
              Notification.error('题干是必需的');
              errors.push('create_problem 操作缺少 stem');
              continue;
            }
            if (options.length < 2) {
              Notification.error('至少需要两个选项');
              errors.push('create_problem 操作的选项数量不足');
              continue;
            }
            if (!Number.isFinite(answerNum) || answerNum < 0 || answerNum >= options.length) {
              Notification.error(i18n('Answer index invalid'));
              errors.push('create_problem 操作的答案索引无效');
              continue;
            }
            newProblem = migrateRawProblem({
              pid,
              stem,
              options,
              answer: answerNum,
              ...(analysisStr ? { analysis: analysisStr } : {}),
            });
          }

          const existingProblems: Problem[] = foundCard.problems || [];
          const updatedProblems = [...existingProblems, newProblem];

          const cards = nodeCardsMap[foundNodeId];
          const cardIndex = cards.findIndex((c: Card) => sameCardDocId(c.docId, cardId));
          if (cardIndex >= 0) {
            cards[cardIndex] = {
              ...cards[cardIndex],
              problems: updatedProblems,
            };
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);

            const cardIdStr = String(cardId);
            if (cardIdStr) {
              setPendingProblemCardIds(prev => {
                const next = new Set(prev);
                next.add(cardIdStr);
                return next;
              });

              setPendingNewProblemCardIds(prev => {
                const next = new Set(prev);
                next.add(cardIdStr);
                return next;
              });
            }

            setNewProblemIds((prev) => new Set(prev).add(newProblem.pid));
          }

          if (!quiet) {
            Notification.success('题目已通过Agent生成并保存');
          }
        }
      } catch (error: any) {
        console.error(`Failed to execute operation ${op.type}:`, error);
        const errorMsg = `执行操作失败: ${op.type} - ${error.message || '未知错误'}`;
        Notification.error(errorMsg);
        errors.push(errorMsg);
      }
    }
    
    return { success: errors.length === 0, errors };
  }, [base, setBase, selectedFile, editorInstance, setFileContent, triggerExpandAutoSave, setNodeCardsMapVersion, setPendingProblemCardIds, setPendingNewProblemCardIds]);

  
  useEffect(() => {
    executeAIOperationsRef.current = executeAIOperations;
  }, [executeAIOperations]);

  
  const getNodeChildren = useCallback((nodeId: string, visited: Set<string> = new Set()): { nodes: string[]; cards: string[] } => {
    if (visited.has(nodeId)) {
      return { nodes: [], cards: [] };
    }
    visited.add(nodeId);
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const cards: string[] = (nodeCardsMap[nodeId] || []).map((c: Card) => c.docId || '').filter(Boolean);
    const childNodes: string[] = base.edges
      .filter(e => e.source === nodeId)
      .map(e => e.target)
      .filter(Boolean);
    
    
    const allNodes: string[] = [...childNodes];
    const allCards: string[] = [...cards];
    
    for (const childNodeId of childNodes) {
      const childData = getNodeChildren(childNodeId, visited);
      allNodes.push(...childData.nodes);
      allCards.push(...childData.cards);
    }
    
    return { nodes: allNodes, cards: allCards };
  }, [base.edges]);
  
  
  useEffect(() => {
    getNodeChildrenRef.current = getNodeChildren;
  }, [getNodeChildren]);

  
  const handleExportToPDF = useCallback(async (nodeId: string) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const node = base.nodes.find(n => n.id === nodeId);
    if (!node) {
      Notification.error(i18n('Node does not exist'));
      return;
    }

    
    const dialog = new Dialog({
      $body: `
        <div style="padding: 20px;">
          <div style="text-align: center; margin-bottom: 15px; font-size: 16px; font-weight: 500; color: #333;">
            正在导出PDF
          </div>
          <div id="pdf-export-status" style="text-align: center; margin-bottom: 10px; color: #666; font-size: 13px;">
            准备中...
          </div>
          <div class="bp5-progress-bar bp5-intent-primary bp5-no-stripes" style="margin-bottom: 10px;">
            <div id="pdf-export-progress" class="bp5-progress-meter" style="width: 0%; transition: width 0.3s ease;"></div>
          </div>
          <div id="pdf-export-current" style="text-align: center; color: #999; font-size: 12px; margin-top: 8px;">
          </div>
        </div>
      `,
    });

    const $status = dialog.$dom.find('#pdf-export-status');
    const $progress = dialog.$dom.find('#pdf-export-progress');
    const $current = dialog.$dom.find('#pdf-export-current');

    try {
      dialog.open();
      setContextMenu(null);

      
      $status.text(i18n('Loading PDF library...'));
      $progress.css('width', '10%');
      
      const [{ jsPDF }, html2canvasModule] = await Promise.all([
        import('jspdf'),
        import('html2canvas'),
      ]);
      
      $status.text(i18n('Collecting data...'));
      $progress.css('width', '20%');
      
      
      interface ExportItem {
        type: 'node' | 'card';
        id: string;
        title: string;
        content: string;
        level: number;
        order: number;
        parentOrder?: string;
      }

      const collectItems = (parentNodeId: string, level: number = 0, parentOrder: string = ''): ExportItem[] => {
        const items: ExportItem[] = [];
        
        
        const childNodes = base.edges
          .filter(e => e.source === parentNodeId)
          .map(e => {
            const childNode = base.nodes.find(n => n.id === e.target);
            return childNode ? { id: childNode.id, node: childNode, order: childNode.order || 0 } : null;
          })
          .filter(Boolean)
          .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: BaseNode; order: number }>;
        
        
        const cards = (nodeCardsMap[parentNodeId] || [])
          .filter((card: Card) => !card.nodeId || card.nodeId === parentNodeId)
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
        
        const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any }> = [
          ...childNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: n.node })),
          ...cards.map(c => ({ type: 'card' as const, id: c.docId, order: c.order || 0, data: c })),
        ];
        
        allChildren.sort((a, b) => (a.order || 0) - (b.order || 0));
        
        
        let itemIndex = 1;
        for (const child of allChildren) {
          const currentOrder = parentOrder ? `${parentOrder}.${itemIndex}` : `${itemIndex}`;
          
          if (child.type === 'node') {
            items.push({
              type: 'node',
              id: child.id,
              title: child.data.text || i18n('Unnamed Node'),
              content: '',
              level,
              order: child.order,
              parentOrder: currentOrder,
            });
            
            
            const childItems = collectItems(child.id, level + 1, currentOrder);
            items.push(...childItems);
          } else {
            
            let cardContent = child.data.content || '';
            const cardFileId = `card-${child.id}`;
            const pendingChange = pendingChanges.get(cardFileId);
            if (pendingChange) {
              cardContent = pendingChange.content;
            }
            
            items.push({
              type: 'card',
              id: child.id,
              title: child.data.title || i18n('Unnamed Card'),
              content: cardContent,
              level,
              order: child.order,
              parentOrder: currentOrder,
            });
          }
          
          itemIndex++;
        }
        
        return items;
      };

      const allItems = collectItems(nodeId, 0, '');
      const totalItems = allItems.length;
      
      $status.text(`共找到 ${totalItems} 个项目，开始生成PDF...`);
      $progress.css('width', '30%');
      
      
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 20;
      const contentWidth = pageWidth - 2 * margin;
      let yPos = margin;
      const lineHeight = 7;
      const titleHeight = 10;
      const sectionSpacing = 5;

      
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      const rootTitle = String(node.text || i18n('Unnamed Node')).trim();
      if (rootTitle && !isNaN(margin) && !isNaN(yPos)) {
        pdf.text(rootTitle, margin, yPos);
        yPos += titleHeight + sectionSpacing;
      }

      
      const tocItems: Array<{ order: string; title: string; page: number }> = [];
      let contentYPos = margin;

      
      pdf.addPage();

      let processedCount = 0;
      for (const item of allItems) {
        processedCount++;
        const progressPercent = 30 + Math.round((processedCount / totalItems) * 50); // 30-80%
        $progress.css('width', `${progressPercent}%`);
        $status.text(`正在处理: ${item.parentOrder} ${item.title}`);
        $current.text(`${processedCount} / ${totalItems}`);
        
        const currentPageNumber = (pdf.internal as any).getNumberOfPages();
        tocItems.push({
          order: item.parentOrder || '',
          title: item.title,
          page: currentPageNumber,
        });

        
        if (contentYPos > pageHeight - margin - 20) {
          pdf.addPage();
          contentYPos = margin;
        }

        
        pdf.setFontSize(12 + (3 - item.level) * 2);
        pdf.setFont('helvetica', 'bold');
        const titleText = `${item.parentOrder || ''} ${item.title || '未命名'}`.trim();
        if (titleText) {
          const titleLines = pdf.splitTextToSize(titleText, contentWidth);
          
          if (isNaN(contentYPos) || contentYPos < margin) {
            contentYPos = margin;
          }
          
          if (Array.isArray(titleLines)) {
            titleLines.forEach((line: string) => {
              if (contentYPos + lineHeight > pageHeight - margin) {
                pdf.addPage();
                contentYPos = margin;
              }
              const lineText = String(line || '').trim();
              if (lineText && !isNaN(margin) && !isNaN(contentYPos)) {
                pdf.text(lineText, margin, contentYPos);
                contentYPos += lineHeight + 2;
              }
            });
          } else {
            const singleLine = String(titleLines || '').trim();
            if (singleLine && !isNaN(margin) && !isNaN(contentYPos)) {
              pdf.text(singleLine, margin, contentYPos);
              contentYPos += lineHeight + 2;
            }
          }
        }

        
        if (item.type === 'card' && item.content) {
          try {
            $status.text(`正在渲染: ${item.title}`);
            
            const htmlContent = await fetch('/markdown', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                text: item.content,
                inline: false,
              }),
            }).then(res => res.text());
            
            if (htmlContent) {
              
              
              const tempDiv = document.createElement('div');
              tempDiv.style.width = `${contentWidth}mm`;
              tempDiv.style.padding = '10px';
              tempDiv.style.fontSize = '12px';
              tempDiv.style.lineHeight = '1.6';
              tempDiv.style.fontFamily = 'Arial, "Microsoft YaHei", "SimSun", sans-serif';
              tempDiv.style.color = '#000';
              tempDiv.style.backgroundColor = '#fff';
              tempDiv.style.position = 'absolute';
              tempDiv.style.left = '-9999px';
              tempDiv.style.top = '0';
              tempDiv.innerHTML = htmlContent;
              document.body.appendChild(tempDiv);
              
              
              await new Promise<void>((resolve) => {
                const images = tempDiv.querySelectorAll('img');
                if (images.length === 0) {
                  resolve();
                  return;
                }
                let loadedCount = 0;
                const totalImages = images.length;
                images.forEach((img) => {
                  if (img.complete) {
                    loadedCount++;
                    if (loadedCount === totalImages) resolve();
                  } else {
                    img.onload = () => {
                      loadedCount++;
                      if (loadedCount === totalImages) resolve();
                    };
                    img.onerror = () => {
                      loadedCount++;
                      if (loadedCount === totalImages) resolve();
                    };
                  }
                });
                setTimeout(() => resolve(), 5000);
              });
              
              
              const canvas = await html2canvasModule.default(tempDiv, {
                scale: 2,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false,
                width: contentWidth * 3.779527559,
              });
              
              
              document.body.removeChild(tempDiv);
              
              
              const imgWidth = contentWidth;
              const imgHeight = (canvas.height / canvas.width) * imgWidth;
              
              
              const maxHeightPerPage = pageHeight - 2 * margin;
              if (imgHeight > maxHeightPerPage) {
                
                const parts = Math.ceil(imgHeight / maxHeightPerPage);
                const partHeight = imgHeight / parts;
                
                for (let i = 0; i < parts; i++) {
                  
                  if (contentYPos > pageHeight - margin - 10) {
                    pdf.addPage();
                    contentYPos = margin;
                  }
                  
                  
                  const partCanvas = document.createElement('canvas');
                  partCanvas.width = canvas.width;
                  partCanvas.height = Math.ceil(canvas.height / parts);
                  const ctx = partCanvas.getContext('2d');
                  if (ctx) {
                    const sourceY = i * (canvas.height / parts);
                    const sourceHeight = canvas.height / parts;
                    
                    ctx.drawImage(
                      canvas,
                      0,
                      sourceY,
                      canvas.width,
                      sourceHeight,
                      0,
                      0,
                      canvas.width,
                      sourceHeight
                    );
                    
                    const partImgData = partCanvas.toDataURL('image/png');
                    pdf.addImage(partImgData, 'PNG', margin, contentYPos, imgWidth, partHeight);
                    contentYPos += partHeight;
                  }
                }
              } else {
                
                if (contentYPos + imgHeight > pageHeight - margin) {
                  pdf.addPage();
                  contentYPos = margin;
                }
                
                
                const imgData = canvas.toDataURL('image/png');
                pdf.addImage(imgData, 'PNG', margin, contentYPos, imgWidth, imgHeight);
                contentYPos += imgHeight;
              }
              
              contentYPos += sectionSpacing;
            }
          } catch (error) {
            console.error('渲染Markdown失败:', error);
            
            pdf.setFontSize(10);
            pdf.setFont('helvetica', 'normal');
            
            
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = item.content;
            const textContent = tempDiv.textContent || tempDiv.innerText || item.content;
            const contentLines = pdf.splitTextToSize(textContent.substring(0, 1000), contentWidth);
            
            for (const line of contentLines) {
              if (contentYPos + lineHeight > pageHeight - margin) {
                pdf.addPage();
                contentYPos = margin;
              }
              const lineText = String(line || '').trim();
              if (lineText && !isNaN(margin) && !isNaN(contentYPos)) {
                pdf.text(lineText, margin, contentYPos);
                contentYPos += lineHeight;
              }
            }
            
            contentYPos += sectionSpacing;
          }
        }

        contentYPos += sectionSpacing;
      }

      $status.text('正在生成目录...');
      $progress.css('width', '85%');
      
      
      pdf.insertPage(1);
      let tocYPos = margin;

      
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      const tocRootTitle = String(node.text || i18n('Unnamed Node')).trim();
      if (tocRootTitle && !isNaN(margin) && !isNaN(tocYPos)) {
        pdf.text(tocRootTitle, margin, tocYPos);
        tocYPos += titleHeight + sectionSpacing;
      }

      
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      if (!isNaN(margin) && !isNaN(tocYPos)) {
        pdf.text('目录', margin, tocYPos);
        tocYPos += lineHeight + 2;
      }

      
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      for (const tocItem of tocItems) {
        if (tocYPos + lineHeight > pageHeight - margin) {
          pdf.addPage();
          tocYPos = margin;
        }
        
        const tocText = `${tocItem.order || ''} ${tocItem.title || '未命名'} ................ ${tocItem.page || 1}`;
        const tocTextStr = String(tocText).trim();
        if (tocTextStr && !isNaN(margin) && !isNaN(tocYPos)) {
          pdf.text(tocTextStr, margin, tocYPos);
          tocYPos += lineHeight;
        }
      }

      $status.text(i18n('Saving PDF...'));
      $progress.css('width', '95%');
      
      
      const fileName = `${node.text || i18n('Unnamed Node')}_${new Date().toISOString().split('T')[0]}.pdf`;
      pdf.save(fileName);
      
      $status.text(i18n('Export complete'));
      $progress.css('width', '100%');
      $current.text('');
      
      Notification.success(i18n('PDF export successful'));
      
      
      setTimeout(() => {
        dialog.close();
      }, 1000);
    } catch (error: any) {
      console.error('导出PDF失败:', error);
      $status.text(`${i18n('Export failed')}: ${error?.message || i18n('Unknown error')}`);
      $progress.css('width', '100%');
      $progress.css('background-color', '#dc3545');
      Notification.error(`导出PDF失败: ${error?.message || '未知错误'}`);
      
      
      setTimeout(() => {
        dialog.close();
      }, 3000);
    }
  }, [base.nodes, base.edges, pendingChanges]);

  
  const handleToggleSelect = useCallback((file: FileItem) => {
    if (!isMultiSelectMode) return;
    
    setSelectedItems(prev => {
      const next = new Set(prev);
      const isSelected = next.has(file.id);
      
      if (isSelected) {
        
        next.delete(file.id);
        
        
        if (file.type === 'node' && getNodeChildrenRef.current) {
          const children = getNodeChildrenRef.current(file.nodeId || '');
          children.nodes.forEach(nodeId => {
            
            const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
            if (nodeFile) next.delete(nodeFile.id);
          });
          children.cards.forEach(cardId => {
            
            const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
            if (cardFile) next.delete(cardFile.id);
          });
        }
      } else {
        
        next.add(file.id);
        
        
        if (file.type === 'node' && getNodeChildrenRef.current) {
          const children = getNodeChildrenRef.current(file.nodeId || '');
          children.nodes.forEach(nodeId => {
            const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
            if (nodeFile) next.add(nodeFile.id);
          });
          children.cards.forEach(cardId => {
            const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
            if (cardFile) next.add(cardFile.id);
          });
        }
      }
      
      return next;
    });
  }, [isMultiSelectMode, fileTree]);

  
  const handleBatchDelete = useCallback(() => {
    if (selectedItems.size === 0) {
      Notification.info(i18n('Please select items to delete first'));
      return;
    }
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const itemsToDelete: FileItem[] = [];
    const allNodeIdsToDelete = new Set<string>();
    const allCardIdsToDelete = new Set<string>();
    
    
    for (const fileId of selectedItems) {
      const file = fileTree.find(f => f.id === fileId);
      if (file) {
        itemsToDelete.push(file);
        
        
        if (file.type === 'node' && getNodeChildrenRef.current) {
          const nodeId = file.nodeId || '';
          const children = getNodeChildrenRef.current(nodeId);
          children.nodes.forEach(childNodeId => {
            allNodeIdsToDelete.add(childNodeId);
            
            const childFile = fileTree.find(f => f.type === 'node' && f.nodeId === childNodeId);
            if (childFile && !itemsToDelete.find(f => f.id === childFile.id)) {
              itemsToDelete.push(childFile);
            }
          });
          children.cards.forEach(cardId => {
            allCardIdsToDelete.add(cardId);
            
            const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
            if (cardFile && !itemsToDelete.find(f => f.id === cardFile.id)) {
              itemsToDelete.push(cardFile);
            }
          });
        }
        
        
        if (file.type === 'node') {
          allNodeIdsToDelete.add(file.nodeId || '');
        } else if (file.type === 'card') {
          allCardIdsToDelete.add(file.cardId || '');
        }
      }
    }
    
    
    const tempNodeIds: string[] = [];
    const tempCardIds: string[] = [];
    
    for (const file of itemsToDelete) {
      if (file.type === 'node') {
        const nodeId = file.nodeId || '';
        if (nodeId.startsWith('temp-node-')) {
          cleanupPendingForTempItem(file);
          tempNodeIds.push(nodeId);
        }
      } else if (file.type === 'card') {
        const cardId = file.cardId || '';
        if (cardId.startsWith('temp-card-')) {
          cleanupPendingForTempItem(file);
          tempCardIds.push(cardId);
        }
      }
    }
    
    
    setPendingDeletes(prev => {
      const next = new Map(prev);
      
      
      for (const nodeId of allNodeIdsToDelete) {
        if (!tempNodeIds.includes(nodeId)) {
          next.set(nodeId, {
            type: 'node',
            id: nodeId,
          });
        }
      }
      
      
      for (const cardId of allCardIdsToDelete) {
        if (!tempCardIds.includes(cardId)) {
          
          const cardFile = itemsToDelete.find(f => f.type === 'card' && f.cardId === cardId);
          const cardNodeId = cardFile?.nodeId || 
            base.nodes.find(n => {
              const cards = nodeCardsMap[n.id] || [];
              return cards.some((c: Card) => c.docId === cardId);
            })?.id;
          
          next.set(cardId, {
            type: 'card',
            id: cardId,
            nodeId: cardNodeId,
          });
        }
      }
      
      return next;
    });
    
    
    const nodeIdsArray = Array.from(allNodeIdsToDelete);
    if (nodeIdsArray.length > 0) {
      setBase(prev => ({
        ...prev,
        nodes: prev.nodes.filter(n => !nodeIdsArray.includes(n.id)),
        edges: prev.edges.filter(e => 
          !nodeIdsArray.includes(e.source) && !nodeIdsArray.includes(e.target)
        ),
      }));
    }
    
    
    const cardIdsArray = Array.from(allCardIdsToDelete);
    for (const cardId of cardIdsArray) {
      
      for (const nodeIdKey in nodeCardsMap) {
        const cards = nodeCardsMap[nodeIdKey];
        const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
        if (cardIndex >= 0) {
          cards.splice(cardIndex, 1);
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
          break;
        }
      }
    }
    
    
    setSelectedItems(new Set());
    const totalItemsToDelete = allNodeIdsToDelete.size + allCardIdsToDelete.size;
    Notification.success(`已标记 ${totalItemsToDelete} 个项目待删除（包括 ${allNodeIdsToDelete.size} 个节点和 ${allCardIdsToDelete.size} 个卡片），请保存以确认删除`);
  }, [selectedItems, fileTree, cleanupPendingForTempItem]);

  
  const handleDelete = useCallback((file: FileItem) => {
    if (file.type === 'node') {
      
      const nodeId = file.nodeId || file.id || '';
      
      if (!nodeId) {
        Notification.error(i18n('Cannot delete: invalid node ID'));
        setContextMenu(null);
        return;
      }
      
      
      if (pendingDeletes.has(nodeId)) {
        Notification.info(i18n('Node already in delete list'));
        setContextMenu(null);
        return;
      }
      
      
      const isTempNode = nodeId.startsWith('temp-node-');
      
      if (isTempNode) {
        cleanupPendingForTempItem(file);
        
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        if (nodeCardsMap[nodeId]) {
          delete nodeCardsMap[nodeId];
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(v => v + 1);
        }
        setBase(prev => ({
          ...prev,
          nodes: prev.nodes.filter(n => n.id !== nodeId),
          edges: prev.edges.filter(e => e.source !== nodeId && e.target !== nodeId),
        }));
        
      } else {
        
        const children = getNodeChildrenRef.current ? getNodeChildrenRef.current(nodeId) : { nodes: [], cards: [] };
        
        
        setPendingDeletes(prev => {
          const next = new Map(prev);
          
          
          for (const childNodeId of children.nodes) {
            if (!next.has(childNodeId)) {
              next.set(childNodeId, {
                type: 'node',
                id: childNodeId,
              });
            }
          }
          
          
          for (const cardId of children.cards) {
            if (!next.has(cardId)) {
              
              const cardNodeId = base.nodes.find(n => {
                const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                const cards = nodeCardsMap[n.id] || [];
                return cards.some((c: Card) => c.docId === cardId);
              })?.id;
              
              next.set(cardId, {
                type: 'card',
                id: cardId,
                nodeId: cardNodeId,
              });
            }
          }
          
          
          next.set(nodeId, {
            type: 'node',
            id: nodeId,
          });
          
          return next;
        });
        
        
        const allNodeIdsToDelete = [nodeId, ...children.nodes];
        setBase(prev => ({
          ...prev,
          nodes: prev.nodes.filter(n => !allNodeIdsToDelete.includes(n.id)),
          edges: prev.edges.filter(e => 
            !allNodeIdsToDelete.includes(e.source) && !allNodeIdsToDelete.includes(e.target)
          ),
        }));
        
        
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        for (const cardId of children.cards) {
          
          for (const nodeIdKey in nodeCardsMap) {
            const cards = nodeCardsMap[nodeIdKey];
            const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
            if (cardIndex >= 0) {
              cards.splice(cardIndex, 1);
              (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
              setNodeCardsMapVersion(prev => prev + 1);
              break;
            }
          }
        }
      }
    } else if (file.type === 'card') {
      const cardId = file.cardId || '';
      
      
      if (cardId.startsWith('temp-card-')) {
        cleanupPendingForTempItem(file);
        
      } else {
        
      setPendingDeletes(prev => {
        const next = new Map(prev);
          next.set(cardId, {
          type: 'card',
            id: cardId,
          nodeId: file.nodeId,
        });
        return next;
      });
      }
      
      
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      if (nodeCardsMap[file.nodeId || '']) {
        const cards = nodeCardsMap[file.nodeId || ''];
        const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
        if (cardIndex >= 0) {
          cards.splice(cardIndex, 1);
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
        }
      }
    }
    
    setContextMenu(null);
  }, [base.edges, base.nodes, pendingDeletes, cleanupPendingForTempItem]);

  const getDropPositionForTouch = useCallback((
    dragged: FileItem,
    target: FileItem,
    clientY: number,
    targetRect: DOMRect,
    edges: typeof base.edges
  ): 'before' | 'after' | 'into' => {
    const midY = targetRect.top + targetRect.height / 2;
    if (dragged.type === 'card') {
      if (target.type === 'node') return 'into';
      if (target.type === 'card') return clientY < midY ? 'before' : 'after';
    }
    if (dragged.type === 'node' && target.type === 'node') {
      const draggedNodeId = dragged.nodeId || '';
      const targetNodeId = target.nodeId || '';
      const draggedParentEdge = edges.find(e => e.target === draggedNodeId);
      const targetParentEdge = edges.find(e => e.target === targetNodeId);
      const draggedParentId = draggedParentEdge?.source;
      const targetParentId = targetParentEdge?.source;
      if (draggedParentId && targetParentId && draggedParentId === targetParentId && draggedNodeId !== targetNodeId) {
        return clientY < midY ? 'before' : 'after';
      }
      return 'into';
    }
    return 'after';
  }, []);

  
  const handleDragStart = useCallback((e: React.DragEvent, file: FileItem) => {
    setDraggedFile(file);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', file.id);
  }, []);

  
  const handleDragEnd = useCallback(() => {
    
    if (dragLeaveTimeoutRef.current) {
      clearTimeout(dragLeaveTimeoutRef.current);
      dragLeaveTimeoutRef.current = null;
    }
    if (dragOverTimeoutRef.current) {
      clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }
    
    setDraggedFile(null);
    setDragOverFile(null);
    setDropPosition('after');
    lastDragOverFileRef.current = null;
    lastDropPositionRef.current = 'after';
  }, []);

  
  const handleDragOver = useCallback((e: React.DragEvent, file: FileItem) => {
    e.preventDefault();
    e.stopPropagation();
    
    
    if (dragLeaveTimeoutRef.current) {
      clearTimeout(dragLeaveTimeoutRef.current);
      dragLeaveTimeoutRef.current = null;
    }
    
    if (!draggedFile || draggedFile.id === file.id) {
      
      if (lastDragOverFileRef.current?.id === file.id) {
        return;
      }
      
      if (dragOverTimeoutRef.current) {
        clearTimeout(dragOverTimeoutRef.current);
      }
      dragOverTimeoutRef.current = setTimeout(() => {
        if (lastDragOverFileRef.current?.id !== file.id) {
          setDragOverFile(null);
          lastDragOverFileRef.current = null;
        }
      }, 100);
      return;
    }
    
    
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseY = e.clientY;
    const newDropPosition = getDropPositionForTouch(draggedFile, file, mouseY, rect, base.edges);
    if (lastDragOverFileRef.current?.id === file.id) {
      if (lastDropPositionRef.current !== newDropPosition) {
        setDropPosition(newDropPosition);
        lastDropPositionRef.current = newDropPosition;
      }
      return;
    }
    
    
    if (dragOverTimeoutRef.current) {
      clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }
    
    
    setDragOverFile(file);
    setDropPosition(newDropPosition);
    lastDragOverFileRef.current = file;
    lastDropPositionRef.current = newDropPosition;
  }, [draggedFile, base.edges, getDropPositionForTouch]);

  
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    
    if (dragLeaveTimeoutRef.current) {
      clearTimeout(dragLeaveTimeoutRef.current);
    }
    
    
    dragLeaveTimeoutRef.current = setTimeout(() => {
      setDragOverFile(null);
      dragLeaveTimeoutRef.current = null;
    }, 50);
  }, []);

  
  const handleDrop = useCallback((e: React.DragEvent, targetFile: FileItem, positionOverride?: 'before' | 'after' | 'into') => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!draggedFile || draggedFile.id === targetFile.id) {
      setDragOverFile(null);
      return;
    }

    const effectivePosition = positionOverride ?? dropPosition;

    try {
      
      if (draggedFile.type === 'card' && targetFile.type === 'node') {
        
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const targetNodeCards = nodeCardsMap[targetFile.nodeId] || [];
        const maxOrder = targetNodeCards.length > 0 
          ? Math.max(...targetNodeCards.map((c: Card) => c.order || 0))
          : 0;
        const newOrder = maxOrder + 1;
        
        
        if (nodeCardsMap[draggedFile.nodeId || '']) {
          const cards = nodeCardsMap[draggedFile.nodeId || ''];
          const cardIndex = cards.findIndex((c: Card) => c.docId === draggedFile.cardId);
          if (cardIndex >= 0) {
            const [card] = cards.splice(cardIndex, 1);
            
            card.nodeId = targetFile.nodeId || '';
            card.order = newOrder;
            
            
            if (!nodeCardsMap[targetFile.nodeId]) {
              nodeCardsMap[targetFile.nodeId] = [];
            }
            nodeCardsMap[targetFile.nodeId].push(card);
            
            nodeCardsMap[targetFile.nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            
            
            setPendingDragChanges(prev => new Set(prev).add(draggedFile.cardId || ''));
          }
        }
      } else if (draggedFile.type === 'card' && targetFile.type === 'card') {
        
        const targetNodeId = targetFile.nodeId;
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const targetNodeCards = nodeCardsMap[targetNodeId] || [];
        const targetCard = targetNodeCards.find((c: Card) => c.docId === targetFile.cardId);
        const targetOrder = targetCard?.order || 0;
        
        
        if (draggedFile.nodeId === targetNodeId) {
          
          const allCards = [...targetNodeCards].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          const draggedCardIndex = allCards.findIndex((c: Card) => c.docId === draggedFile.cardId);
          const targetCardIndex = allCards.findIndex((c: Card) => c.docId === targetFile.cardId);
          
          if (draggedCardIndex >= 0 && targetCardIndex >= 0 && draggedCardIndex !== targetCardIndex) {
            
            const [draggedCard] = allCards.splice(draggedCardIndex, 1);
            
            let newIndex: number;
            if (effectivePosition === 'before') {
              newIndex = targetCardIndex;
            } else {
              // after
              newIndex = draggedCardIndex < targetCardIndex ? targetCardIndex : targetCardIndex + 1;
            }
            allCards.splice(newIndex, 0, draggedCard);
            
            
            allCards.forEach((card, index) => {
              card.order = index + 1;
            });
            
            
            nodeCardsMap[targetNodeId] = allCards;
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            
            
            setPendingDragChanges(prev => new Set(prev).add(draggedFile.cardId || ''));
            
            
            setNodeCardsMapVersion(prev => prev + 1);
          }
        } else {
          
          const draggedCard = nodeCardsMap[draggedFile.nodeId || '']?.find((c: Card) => c.docId === draggedFile.cardId);
          if (!draggedCard) {
            setDragOverFile(null);
            return;
          }
          
          let newOrder: number;
          if (effectivePosition === 'before') {
            
            newOrder = targetOrder;
            
            targetNodeCards.forEach((card: Card) => {
              if (card.order && card.order >= targetOrder) {
                card.order = (card.order || 0) + 1;
              }
            });
          } else {
            
            newOrder = targetOrder + 1;
            
            targetNodeCards.forEach((card: Card) => {
              if (card.order && card.order > targetOrder) {
                card.order = (card.order || 0) + 1;
              }
            });
          }
          
          
          if (nodeCardsMap[draggedFile.nodeId || '']) {
            const cards = nodeCardsMap[draggedFile.nodeId || ''];
            const cardIndex = cards.findIndex((c: Card) => c.docId === draggedFile.cardId);
            if (cardIndex >= 0) {
              cards.splice(cardIndex, 1);
            }
          }
          
          
          if (!nodeCardsMap[targetNodeId]) {
            nodeCardsMap[targetNodeId] = [];
          }
          draggedCard.nodeId = targetNodeId;
          draggedCard.order = newOrder;
          nodeCardsMap[targetNodeId].push(draggedCard);
          
          nodeCardsMap[targetNodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          
          
          setPendingDragChanges(prev => new Set(prev).add(draggedFile.cardId || ''));
          
          
          setNodeCardsMapVersion(prev => prev + 1);
        }
      } else if (draggedFile.type === 'node' && targetFile.type === 'node') {
        const draggedNodeId = draggedFile.nodeId || '';
        const targetNodeId = targetFile.nodeId || '';
        
        
        const draggedParentEdge = base.edges.find(e => e.target === draggedNodeId);
        const targetParentEdge = base.edges.find(e => e.target === targetNodeId);
        const draggedParentId = draggedParentEdge?.source;
        const targetParentId = targetParentEdge?.source;
        
        
        const isSameParent = draggedParentId && targetParentId && draggedParentId === targetParentId;
        
        if (isSameParent && effectivePosition !== 'into') {
          
          
          const siblingNodes = base.edges
            .filter(e => e.source === draggedParentId)
            .map(e => {
              const node = base.nodes.find(n => n.id === e.target);
              return node ? { id: node.id, node, order: node.order || 0 } : null;
            })
            .filter(Boolean)
            .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: BaseNode; order: number }>;
          
          const draggedNodeIndex = siblingNodes.findIndex(n => n.id === draggedNodeId);
          const targetNodeIndex = siblingNodes.findIndex(n => n.id === targetNodeId);
          
          if (draggedNodeIndex >= 0 && targetNodeIndex >= 0 && draggedNodeIndex !== targetNodeIndex) {
            
            const [draggedNodeData] = siblingNodes.splice(draggedNodeIndex, 1);
            
            
            let newIndex: number;
            if (effectivePosition === 'before') {
              newIndex = targetNodeIndex;
            } else {
              // after
              newIndex = draggedNodeIndex < targetNodeIndex ? targetNodeIndex : targetNodeIndex + 1;
            }
            siblingNodes.splice(newIndex, 0, draggedNodeData);
            
            
            siblingNodes.forEach((nodeData, index) => {
              nodeData.node.order = index + 1;
            });
            
            
            setBase(prev => ({
              ...prev,
              nodes: prev.nodes.map(n => {
                const updatedNode = siblingNodes.find(sn => sn.id === n.id);
                return updatedNode ? { ...n, order: updatedNode.node.order } : n;
              }),
            }));
            
            
            setPendingDragChanges(prev => {
              const newSet = new Set(prev);
              newSet.add(`node-${draggedNodeId}`);
              return newSet;
            });
            
            
            setNodeCardsMapVersion(prev => prev + 1);
          }
        } else {
          
          
          const isDescendant = (ancestorId: string, nodeId: string): boolean => {
            
            const children = base.edges
              .filter(e => e.source === ancestorId)
              .map(e => e.target);
            
            
            if (children.includes(nodeId)) {
              return true;
            }
            
            
            return children.some(childId => isDescendant(childId, nodeId));
          };
          
          
          if (isDescendant(draggedNodeId, targetNodeId)) {
            Notification.error(i18n('Cannot move node into its own descendant'));
            setDragOverFile(null);
            return;
          }
          
          
          const existingEdge = base.edges.find(
            e => e.source === targetNodeId && e.target === draggedNodeId
          );
          
          if (!existingEdge) {
            
            const getAllDescendants = (nodeId: string): string[] => {
              const directChildren = base.edges
                .filter(e => e.source === nodeId)
                .map(e => e.target);
              
              const allDescendants = [...directChildren];
              for (const childId of directChildren) {
                allDescendants.push(...getAllDescendants(childId));
              }
              return allDescendants;
            };
            
            const draggedNodeDescendants = getAllDescendants(draggedNodeId);
            
            
            const targetChildren = base.edges.filter(e => e.source === targetNodeId);
            const targetChildNodes = targetChildren.map(e => {
              const node = base.nodes.find(n => n.id === e.target);
              return node ? { id: node.id, order: node.order || 0 } : null;
            }).filter(Boolean) as Array<{ id: string; order: number }>;
            const maxOrder = targetChildNodes.length > 0 
              ? Math.max(...targetChildNodes.map(n => n.order))
              : 0;
            const newOrder = maxOrder + 1;
            
            
            const oldEdges = base.edges.filter(
              e => e.target === draggedNodeId
            );
            
            
            const newEdges = base.edges.filter(
              e => !oldEdges.includes(e)
            );
            
            
            const newEdge: BaseEdge = {
              id: `edge-${targetNodeId}-${draggedNodeId}-${Date.now()}`,
              source: targetNodeId,
              target: draggedNodeId,
            };
            
            newEdges.push(newEdge);
            
            
            const draggedNode = base.nodes.find(n => n.id === draggedNodeId);
            
            
            setBase(prev => ({
              ...prev,
              edges: newEdges,
              nodes: prev.nodes.map(n => 
                n.id === draggedNodeId ? { ...n, order: newOrder } : n
              ),
            }));
            
            
            setPendingDragChanges(prev => {
              const newSet = new Set(prev);
              newSet.add(`node-${draggedNodeId}`);
              
              
              return newSet;
            });
            
            
            setNodeCardsMapVersion(prev => prev + 1);
          }
        }
      }
      
      
      setBase(prev => ({ ...prev }));
      
      
      
      
      
      
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
      
      setDragOverFile(null);
      setDropPosition('after');
    } catch (error: any) {
      console.error('移动失败:', error);
      setDragOverFile(null);
      setDropPosition('after');
    }
  }, [draggedFile, dropPosition, base.edges, base.nodes]);

  
  const selectedFileIdRef = useRef<string | null>(null);
  const isInitializingRef = useRef(false);
  
  
  useEffect(() => {
    if (!editorRef.current || !selectedFile) {
      return;
    }

    
    if (selectedFileIdRef.current === selectedFile.id && editorInstance) {
      return;
    }
    
    selectedFileIdRef.current = selectedFile.id;
    isInitializingRef.current = true;

    
    if (editorInstance) {
      try {
        editorInstance.destroy();
      } catch (error) {
        console.warn('Error destroying editor:', error);
      }
      setEditorInstance(null);
    }

    let currentEditor: any = null;

    
    let retryCount = 0;
    const maxRetries = 10;
    
    const initEditor = () => {
      
      if (!editorRef.current) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Editor element not found after retries');
        isInitializingRef.current = false;
        return;
      }

      const textareaElement = editorRef.current;
      const parentElement = textareaElement.parentElement;
      
      if (!parentElement) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Editor element has no parent after retries');
        isInitializingRef.current = false;
        return;
      }

      
      if (!document.body.contains(textareaElement)) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Editor element not in document after retries');
        isInitializingRef.current = false;
        return;
      }

      const $textarea = $(textareaElement);
      
      
      if (selectedFile.type === 'card') {
        $textarea.attr('data-markdown', 'true');
      } else {
        $textarea.removeAttr('data-markdown');
      }

      
      $textarea.val(fileContent);
      
      
      if (!textareaElement.parentElement) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Textarea has no parent element after retries');
        isInitializingRef.current = false;
        return;
      }
      
      try {
        currentEditor = new Editor($textarea, {
          value: fileContent,
          language: selectedFile.type === 'card' ? undefined : 'plain',
          onChange: (value: string) => {
            
            if (isInitializingRef.current) {
              return;
            }
            setFileContent(value);
            
            
            const currentSelectedFile = selectedFileRef.current;
            if (currentSelectedFile) {
              const originalContent = originalContentsRef.current.get(currentSelectedFile.id) || '';
              
              
              if (value !== originalContent) {
                setPendingChanges(prev => {
                  const newMap = new Map(prev);
                  newMap.set(currentSelectedFile.id, {
                    file: currentSelectedFile,
                    content: value,
                    originalContent: originalContent,
                  });
                  return newMap;
                });
              } else {
                
                setPendingChanges(prev => {
                  const newMap = new Map(prev);
                  if (newMap.has(currentSelectedFile.id)) {
                    newMap.delete(currentSelectedFile.id);
                  }
                  return newMap;
                });
              }
            }
          },
        });

        
        
        setTimeout(() => {
          setEditorInstance(currentEditor);
          isInitializingRef.current = false;
        }, 100);
      } catch (error) {
        console.error('Failed to initialize editor:', error);
        isInitializingRef.current = false;
      }
    };

    
    const timer = setTimeout(() => {
      requestAnimationFrame(initEditor);
    }, 200);

    return () => {
      clearTimeout(timer);
      if (currentEditor) {
        try {
          currentEditor.destroy();
        } catch (error) {
          console.warn('Error destroying editor in cleanup:', error);
        }
      }
      isInitializingRef.current = false;
    };
  }, [selectedFile?.id]);
  
  
  useEffect(() => {
    if (!editorInstance || !selectedFile || isInitializingRef.current) {
      return;
    }
    
    
    if (selectedFileIdRef.current === selectedFile.id) {
      try {
        const currentValue = editorInstance.value();
        if (currentValue !== fileContent) {
          editorInstance.value(fileContent);
        }
      } catch (e) {
        
        console.warn('Failed to update editor content:', e);
      }
    }
  }, [fileContent, editorInstance, selectedFile]);

  useEffect(() => {
    if (basePath !== 'base/skill') return;
    const domainId = (window as any).UiContext?.domainId;
    if (!domainId) return;
    setDomainToolsLoading(true);
    request.get(`/d/${domainId}/tool/api/list`)
      .then((data: any) => {
        setDomainTools(data?.tools ?? []);
      })
      .catch(() => {
        setDomainTools([]);
      })
      .finally(() => {
        setDomainToolsLoading(false);
      });
  }, [basePath]);

  
  useEffect(() => {
    return () => {
      
    };
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      flex: 1,
      minHeight: 0,
      alignItems: 'stretch',
      overflow: 'hidden',
      height: isMobile ? '100dvh' : '100%',
      width: '100%',
      backgroundColor: themeStyles.bgPrimary,
    }}>
      <input
        ref={cardFileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleCardFileInputChange}
      />
      {isMobile && mobileExplorerOpen && (
        <div
          role="presentation"
          style={{ position: 'fixed', inset: 0, zIndex: 1001, backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => setMobileExplorerOpen(false)}
          aria-hidden
        />
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexShrink: 0,
          alignItems: 'stretch',
          alignSelf: 'stretch',
          ...(isMobile
            ? {
                position: 'fixed' as const,
                left: 0,
                top: 0,
                bottom: 0,
                width: '280px',
                maxWidth: '85vw',
                zIndex: 1002,
                transform: mobileExplorerOpen ? 'translateX(0)' : 'translateX(-100%)',
                transition: 'transform 0.2s ease',
                boxShadow: mobileExplorerOpen ? '4px 0 16px rgba(0,0,0,0.15)' : 'none',
                paddingTop: 'env(safe-area-inset-top, 0px)',
              }
            : {
                minHeight: 0,
                maxHeight: '100%',
                height: '100%',
                overflow: 'hidden',
              }),
        } as React.CSSProperties}
      >
      <div style={{
        position: 'relative',
        width: isMobile ? '100%' : explorerPanelWidth,
        minWidth: 0,
        minHeight: 0,
        flexShrink: 0,
        alignSelf: 'stretch',
        height: isMobile ? undefined : '100%',
        maxHeight: isMobile ? undefined : '100%',
        borderRight: `1px solid ${themeStyles.borderPrimary}`,
        backgroundColor: themeStyles.bgSecondary,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        overflow: 'hidden',
      } as React.CSSProperties}
      >
        <div style={{
          width: isMobile ? '48px' : '44px',
          padding: isMobile ? '10px 6px' : '8px 5px',
          borderRight: `1px solid ${themeStyles.borderPrimary}`,
          backgroundColor: themeStyles.bgPrimary,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: '6px',
          flexShrink: 0,
          alignSelf: 'stretch',
          overflowY: 'auto',
          overflowX: 'hidden',
          WebkitOverflowScrolling: 'touch',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', flexWrap: 'nowrap' }}>
            {isMobile && (
              <button
                type="button"
                onClick={() => setMobileExplorerOpen(false)}
                style={{
                  width: '34px',
                  height: '34px',
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  borderRadius: '4px',
                  background: themeStyles.bgButton,
                  color: themeStyles.textSecondary,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
                title="Close"
              >
                X
              </button>
            )}
            <button
              onClick={() => {
                if (explorerMode !== 'tree') {
                  setExplorerMode('tree');
                  setIsMultiSelectMode(true);
                  return;
                }
                setIsMultiSelectMode(!isMultiSelectMode);
                if (isMultiSelectMode) {
                  setSelectedItems(new Set());
                }
              }}
              style={{
                width: '34px',
                height: '34px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '3px',
                backgroundColor: isMultiSelectMode ? themeStyles.bgButtonActive : themeStyles.bgButton,
                color: isMultiSelectMode ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                cursor: 'pointer',
                flexShrink: 0,
              }}
              title={isMultiSelectMode ? i18n('Exit multi-select') : i18n('Multi-select')}
            >
              {isMultiSelectMode ? '✓' : '☐'}
            </button>
            <button
              onClick={() => setExplorerMode('tree')}
              style={{
                width: '34px',
                height: '34px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '3px',
                backgroundColor: explorerMode === 'tree' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                color: explorerMode === 'tree' ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                cursor: 'pointer',
                flexShrink: 0,
              }}
              title="树形视图"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2.5 4.5h4l1 1h6v6h-11z" />
                <path d="M2.5 5.5v-1h4l1 1" />
              </svg>
            </button>
            <button
              onClick={() => setExplorerMode('pending')}
              style={{
                width: '34px',
                height: '34px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '3px',
                backgroundColor: explorerMode === 'pending' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                color: explorerMode === 'pending' ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                cursor: 'pointer',
                flexShrink: 0,
              }}
              title="查看待提交的更改"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 2.5h8v11H4z" />
                <path d="M6 6h4M6 8.5h4M6 11h3" />
              </svg>
            </button>
            <button
              onClick={() => setExplorerMode('branches')}
              style={{
                width: '34px',
                height: '34px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '3px',
                backgroundColor: explorerMode === 'branches' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                color: explorerMode === 'branches' ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                cursor: 'pointer',
                flexShrink: 0,
              }}
              title="查看分支并跳转"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="4" cy="3.5" r="1.5" />
                <circle cx="4" cy="12.5" r="1.5" />
                <circle cx="12" cy="8" r="1.5" />
                <path d="M5.5 4.3L10.5 7.2M5.5 11.7l5-2.9" />
              </svg>
            </button>
            {basePath === 'base' && docId ? (
              <button
                type="button"
                onClick={() => setExplorerMode('git')}
                style={{
                  width: '34px',
                  height: '34px',
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  borderRadius: '3px',
                  backgroundColor: explorerMode === 'git' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                  color: explorerMode === 'git' ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
                title="GitHub 同步"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
        <div
          ref={explorerScrollRef}
          style={{
            padding: '8px 0',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {explorerMode === 'tree' ? (
            fileTree.map((file, index) => {
            const isSelected = isMultiSelectMode
              ? selectedItems.has(file.id)
              : (selectedFile?.id === file.id);
            const selectedIndex = selectedFile != null ? fileTree.findIndex(f => f.id === selectedFile.id) : -1;
            const isHighlighted = !isMultiSelectMode && selectedFile != null && selectedFile.id === file.id && selectedIndex === index;
            const isDragOver = dragOverFile?.id === file.id;
            const isDragged = draggedFile?.id === file.id;
            const isEditing = editingFile?.id === file.id;
            const isExpanded = file.type === 'node' && expandedNodes.has(file.nodeId || '');
            
            return (
              <div
                key={`${file.parentId ?? 'root'}-${file.level}-${file.id}-${index}`}
                data-file-item
                data-file-id={file.id}
                draggable={true}
                onDragStart={(e) => handleDragStart(e, file)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOver(e, file)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => {
                  handleDrop(e, file);
                  
                  if (dragLeaveTimeoutRef.current) {
                    clearTimeout(dragLeaveTimeoutRef.current);
                    dragLeaveTimeoutRef.current = null;
                  }
                  if (dragOverTimeoutRef.current) {
                    clearTimeout(dragOverTimeoutRef.current);
                    dragOverTimeoutRef.current = null;
                  }
                  setDragOverFile(null);
                  setDropPosition('after');
                  lastDragOverFileRef.current = null;
                  lastDropPositionRef.current = 'after';
                }}
                onClick={(e) => {
                  if (isEditing) return;
                  if (file.type === 'node') {
                    const target = e.target as HTMLElement;
                    if (target.style.cursor === 'pointer' && (target.textContent === '▼' || target.textContent === '▶')) {
                      return;
                    }
                  }
                  handleSelectFile(file);
                  if (isMobile) {
                    if (mobileExplorerCloseTimeoutRef.current) {
                      clearTimeout(mobileExplorerCloseTimeoutRef.current);
                      mobileExplorerCloseTimeoutRef.current = null;
                    }
                    mobileExplorerCloseTimeoutRef.current = setTimeout(() => {
                      setMobileExplorerOpen(false);
                      mobileExplorerCloseTimeoutRef.current = null;
                    }, 400);
                  }
                }}
                onDoubleClick={(e) => {
                  if (isMobile) {
                    if (mobileExplorerCloseTimeoutRef.current) {
                      clearTimeout(mobileExplorerCloseTimeoutRef.current);
                      mobileExplorerCloseTimeoutRef.current = null;
                    }
                    return;
                  }
                  handleStartRename(file, e);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, file });
                }}
                onTouchStart={(e) => {
                  if (!isMobile || isEditing) return;
                  const touch = e.touches[0];
                  touchDragStartPosRef.current = { x: touch.clientX, y: touch.clientY };
                  longPressFileRef.current = file;
                  longPressPosRef.current = { x: touch.clientX, y: touch.clientY };
                  longPressTimerRef.current = window.setTimeout(() => {
                    setContextMenu({ x: longPressPosRef.current.x, y: longPressPosRef.current.y, file: longPressFileRef.current! });
                    longPressTimerRef.current = null;
                  }, 500);
                }}
                onTouchEnd={() => {
                  if (longPressTimerRef.current) {
                    clearTimeout(longPressTimerRef.current);
                    longPressTimerRef.current = null;
                  }
                }}
                onTouchMove={(e) => {
                  if (!isMobile) return;
                  if (longPressTimerRef.current) {
                    const touch = e.touches[0];
                    const start = touchDragStartPosRef.current;
                    const dx = touch.clientX - start.x;
                    const dy = touch.clientY - start.y;
                    if (Math.sqrt(dx * dx + dy * dy) > 10) {
                      clearTimeout(longPressTimerRef.current);
                      longPressTimerRef.current = null;
                    }
                  }
                  
                  if (isMobile) return;
                  if (touchDragFileRef.current) return;
                  const touch = e.touches[0];
                  const start = touchDragStartPosRef.current;
                  const dx = touch.clientX - start.x;
                  const dy = touch.clientY - start.y;
                  if (Math.sqrt(dx * dx + dy * dy) <= 10) return;
                  touchDragFileRef.current = file;
                  setDraggedFile(file);
                  const onDocTouchMove = (ev: TouchEvent) => {
                    if (ev.touches.length === 0) return;
                    const t = ev.touches[0];
                    ev.preventDefault();
                    const el = document.elementFromPoint(t.clientX, t.clientY);
                    const itemEl = el?.closest?.('[data-file-item]') as HTMLElement | null;
                    const fileId = itemEl?.getAttribute?.('data-file-id');
                    const tree = fileTreeRef.current;
                    const targetFile = fileId && tree ? tree.find(f => f.id === fileId) : null;
                    const dragged = touchDragFileRef.current;
                    if (!dragged || !targetFile || targetFile.id === dragged.id) {
                      if (targetFile?.id !== dragged?.id) {
                        setDragOverFile(null);
                        touchDragOverFileRef.current = null;
                      }
                      return;
                    }
                    const rect = itemEl.getBoundingClientRect();
                    const edges = baseEdgesRef.current;
                    const pos = getDropPositionForTouch(dragged, targetFile, t.clientY, rect, edges);
                    setDragOverFile(targetFile);
                    setDropPosition(pos);
                    touchDragOverFileRef.current = targetFile;
                    touchDropPositionRef.current = pos;
                  };
                  const removeListeners = () => {
                    if (!touchDragListenersRef.current) return;
                    document.removeEventListener('touchmove', touchDragListenersRef.current.move);
                    document.removeEventListener('touchend', touchDragListenersRef.current.end);
                    document.removeEventListener('touchcancel', touchDragListenersRef.current.cancel);
                    touchDragListenersRef.current = null;
                  };
                  const onDocTouchEnd = () => {
                    removeListeners();
                    const over = touchDragOverFileRef.current;
                    const dragged = touchDragFileRef.current;
                    if (over && dragged && over.id !== dragged.id) {
                      handleDrop(
                        { preventDefault: () => {}, stopPropagation: () => {} } as React.DragEvent,
                        over,
                        touchDropPositionRef.current
                      );
                    }
                    handleDragEnd();
                    touchDragFileRef.current = null;
                    touchDragOverFileRef.current = null;
                  };
                  const onDocTouchCancel = () => {
                    removeListeners();
                    handleDragEnd();
                    touchDragFileRef.current = null;
                    touchDragOverFileRef.current = null;
                  };
                  document.addEventListener('touchmove', onDocTouchMove, { passive: false });
                  document.addEventListener('touchend', onDocTouchEnd, { passive: true });
                  document.addEventListener('touchcancel', onDocTouchCancel, { passive: true });
                  touchDragListenersRef.current = { move: onDocTouchMove, end: onDocTouchEnd, cancel: onDocTouchCancel };
                }}
                style={{
                  padding: `4px ${8 + file.level * 16}px`,
                  cursor: isEditing ? 'text' : 'pointer',
                  fontSize: '13px',
                  color: isHighlighted ? themeStyles.textOnPrimary : themeStyles.textPrimary,
                  backgroundColor: isHighlighted
                    ? themeStyles.bgSelected
                    : isDragOver
                      ? themeStyles.bgDragOver
                      : isDragged
                        ? themeStyles.bgDragged
                        : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  opacity: isDragged ? 0.5 : 1,
                  border: isDragOver 
                    ? dropPosition === 'into'
                      ? `2px dashed ${themeStyles.accent}` 
                      : `2px solid ${themeStyles.accent}`
                    : file.clipboardType === 'cut'
                      ? `2px dashed ${themeStyles.error}`
                      : file.clipboardType === 'copy'
                        ? `2px dashed ${themeStyles.success}`
                        : file.hasPendingChanges
                          ? `1px dashed ${themeStyles.warning}`
                          : '2px solid transparent',
                  borderTop: isDragOver && dropPosition === 'before' 
                    ? `3px solid ${themeStyles.accent}` 
                    : undefined,
                  borderBottom: isDragOver && dropPosition === 'after' 
                    ? `3px solid ${themeStyles.accent}` 
                    : undefined,
                }}
                onMouseEnter={(e) => {
                  if (!isHighlighted && !isDragOver && !isDragged) {
                    e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isHighlighted && !isDragOver && !isDragged) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
              {isMultiSelectMode && (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => handleToggleSelect(file)}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginRight: '6px',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                />
              )}
              {file.type === 'node' ? (
                <>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleNodeExpanded(file.nodeId || '');
                    }}
                    style={{
                      width: '16px',
                      height: '16px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      flexShrink: 0,
                      fontSize: '10px',
                      color: themeStyles.textTertiary,
                      userSelect: 'none',
                      marginRight: '2px',
                    }}
                    title={isExpanded ? i18n('Collapse') : i18n('Expand')}
                  >
                    {isExpanded ? '▼' : '▶'}
                  </span>
                  <span style={{ 
                    fontSize: '16px', 
                    flexShrink: 0,
                    width: '16px',
                    height: '16px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    {isExpanded ? '📁' : '📂'}
                  </span>
                </>
              ) : (
                <span style={{ 
                  fontSize: '14px', 
                  flexShrink: 0,
                  width: '16px',
                  height: '16px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginLeft: '18px',
                }}>
                  📄
                </span>
              )}
              {isEditing ? (
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={async () => {
                    
                    if (editingFile && editingName.trim() && editingName !== editingFile.name) {
                      await handleConfirmRename();
                    } else {
                      handleCancelRename();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                      handleCancelRename();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                  style={{
                    flex: 1,
                    padding: '2px 4px',
                    fontSize: '13px',
                    border: `1px solid ${themeStyles.borderFocus}`,
                    borderRadius: '3px',
                    outline: 'none',
                    backgroundColor: themeStyles.bgPrimary,
                    color: themeStyles.textPrimary,
                  }}
                />
              ) : (
                <span style={{ 
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}>
                  {file.name}
                  {file.clipboardType === 'cut' && (
                    <span style={{ 
                      fontSize: '10px', 
                      color: '#f44336',
                      fontWeight: 'bold',
                    }} title="已剪切">
                      ✂
                    </span>
                  )}
                  {file.clipboardType === 'copy' && (
                    <span style={{ 
                      fontSize: '10px', 
                      color: '#4caf50',
                      fontWeight: 'bold',
                    }} title={i18n('Copied')}>
                      📋
                    </span>
                  )}
                </span>
              )}
              {isMobile && !isEditing && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const rect = (e.target as HTMLElement).getBoundingClientRect();
                    setContextMenu({ x: rect.left, y: rect.bottom + 4, file });
                  }}
                  style={{
                    flexShrink: 0,
                    width: '36px',
                    minHeight: '36px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: 'none',
                    background: 'transparent',
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                    fontSize: '18px',
                    marginLeft: '4px',
                  }}
                  aria-label="操作"
                >
                  ⋯
                </button>
              )}
            </div>
            );
          })
          ) : explorerMode === 'branches' ? (
            <div style={{ padding: '8px' }}>
              <div style={{
                fontSize: '12px',
                fontWeight: '600',
                color: themeStyles.textSecondary,
                marginBottom: '8px',
                padding: '0 8px',
              }}>
                当前分支：{base.currentBranch || 'main'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {(base.branches && base.branches.length > 0 ? base.branches : ['main']).map((branchName) => {
                  const isCurrent = branchName === (base.currentBranch || 'main');
                  const docSeg = String(docId || base.docId || base.bid || '').trim();
                  const targetHref = docSeg
                    ? getBaseUrl(`/${docSeg}/outline/branch/${encodeURIComponent(branchName)}`)
                    : '#';
                  return (
                    <a
                      key={branchName}
                      href={isCurrent ? undefined : targetHref}
                      onClick={isCurrent ? (e) => e.preventDefault() : undefined}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 10px',
                        borderRadius: '4px',
                        textDecoration: 'none',
                        border: `1px solid ${themeStyles.borderSecondary}`,
                        backgroundColor: isCurrent ? themeStyles.bgSelected : themeStyles.bgButton,
                        color: isCurrent ? themeStyles.textOnPrimary : themeStyles.textPrimary,
                        fontSize: '12px',
                        cursor: isCurrent ? 'default' : 'pointer',
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {branchName}
                      </span>
                      <span style={{ fontSize: '11px', opacity: 0.85 }}>
                        {isCurrent ? '当前' : '前往'}
                      </span>
                    </a>
                  );
                })}
              </div>
            </div>
          ) : explorerMode === 'git' && basePath === 'base' && docId ? (
            <div style={{ padding: '8px', fontSize: '12px', color: themeStyles.textPrimary }}>
              <div style={{ fontWeight: 600, color: themeStyles.textSecondary, marginBottom: '8px', padding: '0 8px' }}>
                GitHub · 分支 {currentBranch || 'main'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 8px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ color: themeStyles.textSecondary, fontSize: '11px' }}>仓库 URL（HTTPS 或 git@…）</span>
                  <input
                    value={gitRepoDraft}
                    onChange={(e) => setGitRepoDraft(e.target.value)}
                    placeholder="https://github.com/org/repo"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '6px 8px',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: '4px',
                      background: themeStyles.bgPrimary,
                      color: themeStyles.textPrimary,
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await request.post(getBaseUrl('/github/config'), { docId, githubRepo: gitRepoDraft.trim() });
                      if ((window as any).UiContext) (window as any).UiContext.githubRepo = gitRepoDraft.trim();
                      Notification.success('已保存仓库配置');
                      fetchGitRemoteStatus();
                    } catch (err: any) {
                      Notification.error(err?.message || '保存失败');
                    }
                  }}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    border: `1px solid ${themeStyles.borderSecondary}`,
                    background: themeStyles.bgButton,
                    color: themeStyles.textPrimary,
                    cursor: 'pointer',
                  }}
                >
                  保存仓库地址
                </button>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ color: themeStyles.textSecondary, fontSize: '11px' }}>
                    个人访问令牌（PAT）{githubPATConfigured ? ' · 已配置' : ' · 未配置'}
                  </span>
                  <input
                    type="password"
                    value={gitTokenDraft}
                    onChange={(e) => setGitTokenDraft(e.target.value)}
                    placeholder="ghp_…"
                    autoComplete="off"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '6px 8px',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: '4px',
                      background: themeStyles.bgPrimary,
                      color: themeStyles.textPrimary,
                    }}
                  />
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  <button
                    type="button"
                    onClick={async () => {
                      const domainId = (window as any).UiContext?.domainId || 'system';
                      try {
                        await request.post(`/d/${domainId}/user/github-token`, { githubToken: gitTokenDraft.trim() });
                        setGithubPATConfigured(!!gitTokenDraft.trim());
                        setGitTokenDraft('');
                        Notification.success('已保存令牌');
                        fetchGitRemoteStatus();
                      } catch (err: any) {
                        Notification.error(err?.message || '保存失败');
                      }
                    }}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '4px',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      background: themeStyles.bgButton,
                      color: themeStyles.textPrimary,
                      cursor: 'pointer',
                    }}
                  >
                    保存令牌
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const domainId = (window as any).UiContext?.domainId || 'system';
                      try {
                        await request.post(`/d/${domainId}/user/github-token`, { githubToken: '' });
                        setGithubPATConfigured(false);
                        setGitTokenDraft('');
                        Notification.success('已清除令牌');
                        fetchGitRemoteStatus();
                      } catch (err: any) {
                        Notification.error(err?.message || '清除失败');
                      }
                    }}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '4px',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      background: themeStyles.bgSecondary,
                      color: themeStyles.textSecondary,
                      cursor: 'pointer',
                    }}
                  >
                    清除令牌
                  </button>
                </div>
                <div
                  style={{
                    marginTop: '4px',
                    padding: '8px',
                    borderRadius: '4px',
                    border: `1px solid ${themeStyles.borderSecondary}`,
                    background: themeStyles.bgSecondary,
                    fontSize: '11px',
                  }}
                >
                  {gitStatusLoading && !gitRemoteStatus ? (
                    <span style={{ color: themeStyles.textSecondary }}>正在获取远程状态…</span>
                  ) : gitRemoteStatus ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {(gitRemoteStatus.lastCommitShort || gitRemoteStatus.lastCommit) ? (
                        <span style={{ wordBreak: 'break-all' }}>
                          当前分支最新提交：
                          {gitRemoteStatus.lastCommitShort || String(gitRemoteStatus.lastCommit).slice(0, 8)}
                          {gitRemoteStatus.lastCommitMessageShort || gitRemoteStatus.lastCommitMessage
                            ? ` — ${gitRemoteStatus.lastCommitMessageShort || gitRemoteStatus.lastCommitMessage}`
                            : ''}
                        </span>
                      ) : null}
                      <span>相对 origin：领先 {gitRemoteStatus.ahead ?? 0} · 落后 {gitRemoteStatus.behind ?? 0}</span>
                      <span>
                        工作区相对最新提交：{gitRemoteStatus.uncommittedChanges ? '有未提交变更' : '干净'}
                        {gitRemoteStatus.hasRemoteBranch === false ? ' · 远程无此分支' : ''}
                      </span>
                    </div>
                  ) : (
                    <span style={{ color: themeStyles.textSecondary }}>配置仓库与令牌后可查看与远程的差异</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ color: themeStyles.textSecondary, fontSize: '11px' }}>本地 Git（先保存知识库内容再提交）</span>
                  <input
                    value={gitCommitNote}
                    onChange={(e) => setGitCommitNote(e.target.value)}
                    placeholder="提交说明（可选）"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '6px 8px',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: '4px',
                      background: themeStyles.bgPrimary,
                      color: themeStyles.textPrimary,
                      fontSize: '12px',
                    }}
                  />
                  <button
                    type="button"
                    disabled={!!gitActionBusy}
                    onClick={async () => {
                      setGitActionBusy('commit');
                      try {
                        await request.post(
                          getBaseUrl(`/branch/${encodeURIComponent(currentBranch || 'main')}/commit`),
                          { docId, note: gitCommitNote.trim() },
                        );
                        Notification.success('已提交到本地 Git 仓库');
                        setGitCommitNote('');
                        fetchGitRemoteStatus();
                      } catch (err: any) {
                        Notification.error(err?.message || '本地提交失败');
                      } finally {
                        setGitActionBusy(null);
                      }
                    }}
                    style={{
                      padding: '6px 12px',
                      borderRadius: '4px',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      background: themeStyles.bgSecondary,
                      color: themeStyles.textPrimary,
                      cursor: gitActionBusy ? 'not-allowed' : 'pointer',
                      opacity: gitActionBusy ? 0.6 : 1,
                      alignSelf: 'flex-start',
                    }}
                  >
                    {gitActionBusy === 'commit' ? '提交中…' : '提交到本地仓库'}
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  <button
                    type="button"
                    disabled={!!gitActionBusy}
                    onClick={async () => {
                      setGitActionBusy('pull');
                      try {
                        await request.post(
                          getBaseUrl(`/branch/${encodeURIComponent(currentBranch || 'main')}/github/pull`),
                          { docId },
                        );
                        Notification.success('Pull 完成');
                        await refetchEditorData();
                        fetchGitRemoteStatus();
                      } catch (err: any) {
                        Notification.error(err?.message || 'Pull 失败');
                      } finally {
                        setGitActionBusy(null);
                      }
                    }}
                    style={{
                      padding: '6px 12px',
                      borderRadius: '4px',
                      border: 'none',
                      background: themeStyles.bgButtonActive,
                      color: themeStyles.textOnPrimary,
                      cursor: gitActionBusy ? 'not-allowed' : 'pointer',
                      opacity: gitActionBusy ? 0.6 : 1,
                    }}
                  >
                    {gitActionBusy === 'pull' ? 'Pull…' : 'Pull'}
                  </button>
                  <button
                    type="button"
                    disabled={!!gitActionBusy}
                    onClick={async () => {
                      setGitActionBusy('push');
                      try {
                        await request.post(
                          getBaseUrl(`/branch/${encodeURIComponent(currentBranch || 'main')}/github/push`),
                          { docId },
                        );
                        Notification.success('Push 完成');
                        fetchGitRemoteStatus();
                      } catch (err: any) {
                        Notification.error(err?.message || 'Push 失败');
                      } finally {
                        setGitActionBusy(null);
                      }
                    }}
                    style={{
                      padding: '6px 12px',
                      borderRadius: '4px',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      background: themeStyles.bgButton,
                      color: themeStyles.textPrimary,
                      cursor: gitActionBusy ? 'not-allowed' : 'pointer',
                      opacity: gitActionBusy ? 0.6 : 1,
                    }}
                  >
                    {gitActionBusy === 'push' ? 'Push…' : 'Push'}
                  </button>
                  <button
                    type="button"
                    onClick={() => fetchGitRemoteStatus()}
                    style={{
                      padding: '6px 12px',
                      borderRadius: '4px',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      background: themeStyles.bgSecondary,
                      color: themeStyles.textSecondary,
                      cursor: 'pointer',
                    }}
                  >
                    刷新状态
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: '8px' }}>
              <div style={{
                fontSize: '12px',
                fontWeight: '600',
                color: themeStyles.textSecondary,
                marginBottom: '12px',
                padding: '0 8px',
              }}>
                待提交的更改
              </div>
              <div style={{
                fontSize: '11px',
                color: themeStyles.textSecondary,
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                padding: '0 8px',
              }}>
                {/* Content changes */}
                {pendingChanges.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>内容更改 ({pendingChanges.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingChanges.values()).slice(0, 5).map((change, idx) => (
                        <div key={idx} style={{ marginBottom: '2px' }}>
                          • {change.file.name}
                        </div>
                      ))}
                      {pendingChanges.size > 5 && (
                        <div style={{ color: themeStyles.textTertiary, fontStyle: 'italic' }}>... 还有 {pendingChanges.size - 5} 个</div>
          )}
        </div>
      </div>
                )}
                
                {/* Drag changes */}
                {pendingDragChanges.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>拖动更改 ({pendingDragChanges.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingDragChanges).slice(0, 5).map((item, idx) => {
                        const file = fileTree.find(f => 
                          (f.type === 'node' && f.nodeId === item.replace('node-', '')) ||
                          (f.type === 'card' && f.cardId === item)
                        );
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {file ? file.name : item}
                          </div>
                        );
                      })}
                      {pendingDragChanges.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingDragChanges.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* */}
                {pendingRenames.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>重命名 ({pendingRenames.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingRenames.values()).slice(0, 5).map((rename, idx) => (
                        <div key={idx} style={{ marginBottom: '2px' }}>
                          • {rename.file.name} → {rename.newName}
                        </div>
                      ))}
                      {pendingRenames.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingRenames.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Card face changes */}
                {Object.keys(pendingCardFaceChanges).length > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>卡面更改 ({Object.keys(pendingCardFaceChanges).length})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Object.keys(pendingCardFaceChanges).slice(0, 5).map((cardId) => {
                        const file = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
                        return (
                          <div key={cardId} style={{ marginBottom: '2px' }}>
                            • {file ? file.name : cardId}
                          </div>
                        );
                      })}
                      {Object.keys(pendingCardFaceChanges).length > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {Object.keys(pendingCardFaceChanges).length - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* New items */}
                {pendingCreatesCount > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>新建 ({pendingCreatesCount})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingCreatesRef.current.values()).slice(0, 5).map((create, idx) => (
                        <div key={idx} style={{ marginBottom: '2px' }}>
                          • {create.type === 'card' ? i18n('Card') : i18n('Node')}: {create.title || create.text || i18n('Unnamed')}
                        </div>
                      ))}
                      {pendingCreatesCount > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingCreatesCount - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Deletions */}
                {pendingDeletes.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>删除 ({pendingDeletes.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingDeletes.values()).slice(0, 5).map((del, idx) => {
                        const file = fileTree.find(f => 
                          (del.type === 'node' && f.type === 'node' && f.nodeId === del.id) ||
                          (del.type === 'card' && f.type === 'card' && f.cardId === del.id)
                        );
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {file ? file.name : `${del.type === 'card' ? i18n('Card') : i18n('Node')} (${del.id.substring(0, 8)}...)`}
                          </div>
                        );
                      })}
                      {pendingDeletes.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingDeletes.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Problem creates */}
                {pendingNewProblemCardIds.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>题目新建 ({pendingNewProblemCardIds.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingNewProblemCardIds).slice(0, 5).map((cardId, idx) => {
                        
                        const file = fileTree.find(f => 
                          f.type === 'card' && sameCardDocId(f.cardId, cardId)
                        );
                        
                        let cardName = file ? file.name : '';
                        if (!cardName) {
                          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                          for (const nodeId in nodeCardsMap) {
                            const cards = nodeCardsMap[nodeId] || [];
                            const card = cards.find((c: Card) => sameCardDocId(c.docId, cardId));
                            if (card) {
                              cardName = card.title || i18n('Unnamed Card');
                              break;
                            }
                          }
                        }
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {cardName || `卡片 (${cardId.substring(0, 8)}...)`}
                          </div>
                        );
                      })}
                      {pendingNewProblemCardIds.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingNewProblemCardIds.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Problem edits */}
                {pendingEditedProblemIds.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>题目更改 ({pendingEditedProblemIds.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingEditedProblemIds.entries()).slice(0, 5).map(([cardId, problemIds], idx) => {
                        
                        const file = fileTree.find(f => 
                          f.type === 'card' && sameCardDocId(f.cardId, cardId)
                        );
                        
                        let cardName = file ? file.name : '';
                        if (!cardName) {
                          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                          for (const nodeId in nodeCardsMap) {
                            const cards = nodeCardsMap[nodeId] || [];
                            const card = cards.find((c: Card) => sameCardDocId(c.docId, cardId));
                            if (card) {
                              cardName = card.title || i18n('Unnamed Card');
                              break;
                            }
                          }
                        }
                        const problemCount = problemIds.size;
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {cardName || `卡片 (${cardId.substring(0, 8)}...)`} ({problemCount} 个题目)
                          </div>
                        );
                      })}
                      {pendingEditedProblemIds.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingEditedProblemIds.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}

                {problemPendingOtherCardIds.length > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>
                      题目删除或其它待保存 ({problemPendingOtherCardIds.length})
                    </div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {problemPendingOtherCardIds.slice(0, 5).map((cardId, idx) => {
                        const file = fileTree.find((f) => f.type === 'card' && sameCardDocId(f.cardId, cardId));
                        let cardName = file ? file.name : '';
                        if (!cardName) {
                          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                          for (const nodeId in nodeCardsMap) {
                            const cards = nodeCardsMap[nodeId] || [];
                            const card = cards.find((c: Card) => sameCardDocId(c.docId, cardId));
                            if (card) {
                              cardName = card.title || i18n('Unnamed Card');
                              break;
                            }
                          }
                        }
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {cardName || `卡片 (${String(cardId).substring(0, 8)}...)`}
                          </div>
                        );
                      })}
                      {problemPendingOtherCardIds.length > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>
                          ... 还有 {problemPendingOtherCardIds.length - 5} 个
                        </div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* No pending changes */}
                {pendingChanges.size === 0 && 
                 pendingDragChanges.size === 0 && 
                 pendingRenames.size === 0 && 
                 Object.keys(pendingCardFaceChanges).length === 0 &&
                 pendingCreatesCount === 0 && 
                 pendingDeletes.size === 0 &&
                 pendingProblemCardIds.size === 0 &&
                 pendingNewProblemCardIds.size === 0 &&
                 pendingEditedProblemIds.size === 0 && (
                  <div style={{ 
                    color: themeStyles.textTertiary, 
                    fontStyle: 'italic',
                    textAlign: 'center',
                    padding: '8px 0',
                  }}>
                    暂无待提交的更改
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {!isMobile && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            explorerResizeStartXRef.current = e.clientX;
            explorerResizeStartWidthRef.current = explorerPanelWidth;
            setIsResizingExplorer(true);
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧边栏宽度"
          title="拖拽调整侧边栏宽度"
          style={{
            width: '4px',
            flexShrink: 0,
            alignSelf: 'stretch',
            background: isResizingExplorer ? themeStyles.accent : themeStyles.borderPrimary,
            cursor: 'col-resize',
            position: 'relative',
            transition: isResizingExplorer ? 'none' : 'background 0.2s ease',
          }}
          onMouseEnter={(e) => {
            if (!isResizingExplorer) {
              e.currentTarget.style.background = themeStyles.textSecondary;
            }
          }}
          onMouseLeave={(e) => {
            if (!isResizingExplorer) {
              e.currentTarget.style.background = themeStyles.borderPrimary;
            }
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '-2px',
              top: 0,
              width: '8px',
              height: '100%',
              cursor: 'col-resize',
            }}
            aria-hidden
          />
        </div>
      )}
      </div>


      {/* Card file list modal */}
      {cardFileListModal && docId && (() => {
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const cards = nodeCardsMap[cardFileListModal.nodeId] || [];
        const card = cards.find((c: Card) => String(c.docId) === cardFileListModal!.cardId);
        const files = card?.files || [];
        const downloadUrl = (filename: string) => getBaseUrl(`/${docId}/card/${cardFileListModal.cardId}/file/${encodeURIComponent(filename)}`, docId);
        const previewUrl = (filename: string) => {
          const u = downloadUrl(filename);
          return u + (u.includes('?') ? '&noDisposition=1' : '?noDisposition=1');
        };
        const filesListUrl = getBaseUrl(`/${docId}/card/${cardFileListModal.cardId}/files`, docId);
        return (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 1001,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0,0,0,0.4)',
            }}
            onClick={() => setCardFileListModal(null)}
          >
            <div
              style={{
                backgroundColor: themeStyles.bgPrimary,
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '8px',
                boxShadow: theme === 'dark' ? '0 4px 20px rgba(0,0,0,0.5)' : '0 4px 20px rgba(0,0,0,0.2)',
                minWidth: 320,
                maxWidth: 480,
                maxHeight: '70vh',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ padding: '12px 16px', borderBottom: `1px solid ${themeStyles.borderSecondary}`, fontWeight: 600, color: themeStyles.textPrimary }}>
                {cardFileListModal.cardTitle || 'Card'} — {i18n('Files')}
              </div>
              <div style={{ padding: '12px', overflow: 'auto', flex: 1 }}>
                {files.length === 0 ? (
                  <div style={{ color: themeStyles.textSecondary, fontSize: 13 }}>{i18n('No files. Use right-click → Upload file.')}</div>
                ) : (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {files.map((f) => (
                      <li
                        key={f.name}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 0',
                          borderBottom: `1px solid ${themeStyles.borderSecondary}`,
                          gap: 8,
                          minWidth: 0,
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFileListRowMenu({
                            x: e.clientX,
                            y: e.clientY,
                            downloadUrl: downloadUrl(f.name),
                            deleteUrl: filesListUrl,
                            filename: f.name,
                          });
                        }}
                      >
                        <a
                          href={previewUrl(f.name)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={f.name}
                          style={{ color: themeStyles.textPrimary, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                          onClick={(ev) => handleFilePreviewClick(ev, previewUrl(f.name), f.name, f.size || 0)}
                        >
                          {f.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div style={{ padding: '8px 16px', borderTop: `1px solid ${themeStyles.borderSecondary}`, textAlign: 'right' }}>
                <button
                  type="button"
                  style={{
                    padding: '6px 12px',
                    fontSize: 13,
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    borderRadius: 4,
                    background: themeStyles.bgButton,
                    color: themeStyles.textPrimary,
                    cursor: 'pointer',
                  }}
                  onClick={() => setCardFileListModal(null)}
                >
                  {i18n('Close')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Node file list modal */}
      {nodeFileListModal && docId && (() => {
        const branch = (window as any).UiContext?.currentBranch || 'main';
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const aggregatedFiles = getAggregatedFilesForNode(nodeFileListModal.nodeId, base, nodeCardsMap);
        const sourceSortKey = (row: AggregatedFileItem) =>
          row.sourceType === 'self' ? '0' : row.sourceType === 'node' ? `1${row.sourceNodeText || row.sourceNodeId}` : `2${row.sourceCardTitle || row.sourceCardId || ''}`;
        const timeMs = (row: AggregatedFileItem) => {
          const v = row.lastModified;
          if (!v) return 0;
          return (typeof v === 'string' ? new Date(v) : v).getTime();
        };
        const sortedFiles = [...aggregatedFiles].sort((a, b) => {
          const ord = nodeFileListSortOrder === 'asc' ? 1 : -1;
          if (nodeFileListSortBy === 'name') return ord * (a.name.localeCompare(b.name, undefined, { numeric: true }));
          if (nodeFileListSortBy === 'size') return ord * (a.size - b.size);
          if (nodeFileListSortBy === 'time') return ord * (timeMs(a) - timeMs(b));
          return ord * sourceSortKey(a).localeCompare(sourceSortKey(b));
        });
        const nodeFileDownloadUrl = (nid: string, filename: string) => getBaseUrl(`/${docId}/node/${nid}/file/${encodeURIComponent(filename)}?branch=${encodeURIComponent(branch)}`, docId);
        const cardFileDownloadUrl = (cardId: string, filename: string) => getBaseUrl(`/${docId}/card/${cardId}/file/${encodeURIComponent(filename)}`, docId);
        const downloadUrlFor = (row: AggregatedFileItem) => row.sourceType === 'card' && row.sourceCardId ? cardFileDownloadUrl(row.sourceCardId, row.name) : nodeFileDownloadUrl(row.sourceNodeId, row.name);
        const previewUrlFor = (row: AggregatedFileItem) => {
          const u = downloadUrlFor(row);
          return u + (u.includes('?') ? '&noDisposition=1' : '?noDisposition=1');
        };
        const filesListUrl = getBaseUrl(`/${docId}/node/${nodeFileListModal.nodeId}/files?branch=${encodeURIComponent(branch)}`, docId);
        return (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 1001,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0,0,0,0.4)',
            }}
            onClick={() => setNodeFileListModal(null)}
          >
            <div
              style={{
                backgroundColor: themeStyles.bgPrimary,
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '8px',
                boxShadow: theme === 'dark' ? '0 4px 20px rgba(0,0,0,0.5)' : '0 4px 20px rgba(0,0,0,0.2)',
                minWidth: 320,
                maxWidth: 520,
                maxHeight: '70vh',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ padding: '12px 16px', borderBottom: `1px solid ${themeStyles.borderSecondary}`, fontWeight: 600, color: themeStyles.textPrimary }}>
                {nodeFileListModal.nodeTitle || 'Node'} — {i18n('Files')}
              </div>
              <div style={{ padding: '12px', overflow: 'auto', flex: 1 }}>
                {sortedFiles.length === 0 ? (
                  <div style={{ color: themeStyles.textSecondary, fontSize: 13 }}>{i18n('No files. Use right-click → Upload file.')}</div>
                ) : (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {sortedFiles.map((row, idx) => (
                      <li
                        key={`${row.sourceType}-${row.sourceNodeId}-${row.sourceCardId || ''}-${row.name}-${idx}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 0',
                          borderBottom: `1px solid ${themeStyles.borderSecondary}`,
                          gap: 8,
                          flexWrap: 'nowrap',
                          minWidth: 0,
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          const deleteUrl = row.sourceType === 'self'
                            ? filesListUrl
                            : row.sourceType === 'card' && row.sourceCardId
                              ? getBaseUrl(`/${docId}/card/${row.sourceCardId}/files`, docId)
                              : getBaseUrl(`/${docId}/node/${row.sourceNodeId}/files?branch=${encodeURIComponent(branch)}`, docId);
                          setFileListRowMenu({
                            x: e.clientX,
                            y: e.clientY,
                            downloadUrl: downloadUrlFor(row),
                            deleteUrl,
                            filename: row.name,
                          });
                        }}
                      >
                        <a
                          href={previewUrlFor(row)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={row.name}
                          style={{ color: themeStyles.textPrimary, fontSize: 13, flex: '1 1 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, cursor: 'pointer' }}
                          onClick={(ev) => handleFilePreviewClick(ev, previewUrlFor(row), row.name, row.size)}
                        >
                          {row.name}
                        </a>
                        <span style={{ fontSize: 12, color: themeStyles.textSecondary, flex: '0 1 45%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {row.sourceType === 'self' ? i18n('This node') : row.sourceType === 'node' ? (
                            <button type="button" title={`${i18n('Node')}: ${row.sourceNodeText || row.sourceNodeId}`} style={{ background: 'none', border: 'none', padding: 0, color: themeStyles.accent, cursor: 'pointer', textDecoration: 'underline', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => { const t = fileTree.find((f) => f.type === 'node' && f.nodeId === row.sourceNodeId); if (t) { setNodeFileListModal(null); handleSelectFile(t); } }}>{i18n('Node')}: {row.sourceNodeText || row.sourceNodeId}</button>
                          ) : (
                            <button type="button" title={`${i18n('Card')}: ${row.sourceCardTitle || row.sourceCardId}`} style={{ background: 'none', border: 'none', padding: 0, color: themeStyles.accent, cursor: 'pointer', textDecoration: 'underline', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => { const t = fileTree.find((f) => f.type === 'card' && f.cardId === row.sourceCardId); if (t) { setNodeFileListModal(null); handleSelectFile(t); } }}>{i18n('Card')}: {row.sourceCardTitle || row.sourceCardId}</button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div style={{ padding: '8px 16px', borderTop: `1px solid ${themeStyles.borderSecondary}`, textAlign: 'right' }}>
                <button
                  type="button"
                  style={{
                    padding: '6px 12px',
                    fontSize: 13,
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    borderRadius: 4,
                    background: themeStyles.bgButton,
                    color: themeStyles.textPrimary,
                    cursor: 'pointer',
                  }}
                  onClick={() => setNodeFileListModal(null)}
                >
                  {i18n('Close')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            backgroundColor: themeStyles.bgPrimary,
            border: `1px solid ${themeStyles.borderSecondary}`,
            borderRadius: '4px',
            boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
            zIndex: 1100,
            minWidth: '180px',
            padding: '4px 0',
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {contextMenu.file.type === 'node' ? (
            <>
              {/* Paste (when clipboard has content) */}
              {clipboard && (
                <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handlePaste(contextMenu.file.nodeId || '')}
                  >
                    粘贴{clipboard.items.length > 1 ? ` (${clipboard.items.length})` : ''}
                  </div>
                  <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
                </>
              )}
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  setIsMultiSelectMode(!isMultiSelectMode);
                  setSelectedItems(new Set());
                  setContextMenu(null);
                }}
              >
                {isMultiSelectMode ? '退出多选' : '多选模式'}
              </div>
              {/* Multi-select: copy, cut, delete (batch delete hidden in collect: may remove nodes) */}
              {isMultiSelectMode && selectedItems.size > 0 && (
                <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handleCopy()}
                  >
                    复制选中项 ({selectedItems.size})
                  </div>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handleCut()}
                  >
                    剪切选中项 ({selectedItems.size})
                  </div>
                  {(
                  <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.error,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => {
                      handleBatchDelete();
                      setContextMenu(null);
                    }}
                  >
                    删除选中项 ({selectedItems.size})
                  </div>
                  <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
                  </>
                  )}
                </>
              )}
              {basePath !== 'base/skill' && docId && contextMenu.file.nodeId && !String(contextMenu.file.nodeId).startsWith('temp-node-') && (
                <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: editorLearnBusy ? 'wait' : 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                      opacity: editorLearnBusy ? 0.65 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!editorLearnBusy) e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => {
                      void startSingleNodeLearnFromEditor(contextMenu.file.nodeId);
                      setContextMenu(null);
                    }}
                  >
                    {i18n('Outline learn single node')}
                  </div>
                  <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
                </>
              )}
              {(
              <>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleNewCard(contextMenu.file.nodeId || '')}
              >
                新建 Card
              </div>
              </>
              )}
              {(
              <>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleNewChildNode(contextMenu.file.nodeId || '')}
              >
                新建子 Node
              </div>
              <div
                style={{ position: 'relative' }}
                onMouseEnter={() => setNewSiblingNodeSubmenuOpen(true)}
                onMouseLeave={() => setNewSiblingNodeSubmenuOpen(false)}
              >
                <div
                  style={{
                    padding: '6px 16px',
                    cursor: 'default',
                    fontSize: '13px',
                    color: themeStyles.textPrimary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <span>新建兄弟 Node</span>
                  <span style={{ opacity: 0.65, fontSize: '12px', flexShrink: 0 }}>›</span>
                </div>
                {newSiblingNodeSubmenuOpen && contextMenu.file.nodeId && (
                  <div
                    style={{
                      position: 'absolute',
                      left: '100%',
                      top: 0,
                      marginLeft: '2px',
                      minWidth: '140px',
                      backgroundColor: themeStyles.bgPrimary,
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: '4px',
                      boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
                      zIndex: 1200,
                      padding: '4px 0',
                    }}
                    onMouseEnter={() => setNewSiblingNodeSubmenuOpen(true)}
                    onMouseLeave={() => setNewSiblingNodeSubmenuOpen(false)}
                  >
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingNodePlacement(contextMenu.file.nodeId || '', 'above');
                      }}
                    >
                      向上插入
                    </div>
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingNodePlacement(contextMenu.file.nodeId || '', 'below');
                      }}
                    >
                      向下插入
                    </div>
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingNodePlacement(contextMenu.file.nodeId || '', 'bottom');
                      }}
                    >
                      底部插入
                    </div>
                  </div>
                )}
              </div>
              </>
              )}
              {(
              <>
              <div
                style={{ position: 'relative' }}
                onMouseEnter={() => setNewSiblingCardForNodeSubmenuOpen(true)}
                onMouseLeave={() => setNewSiblingCardForNodeSubmenuOpen(false)}
              >
                <div
                  style={{
                    padding: '6px 16px',
                    cursor: 'default',
                    fontSize: '13px',
                    color: themeStyles.textPrimary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <span>新建兄弟 Card</span>
                  <span style={{ opacity: 0.65, fontSize: '12px', flexShrink: 0 }}>›</span>
                </div>
                {newSiblingCardForNodeSubmenuOpen && contextMenu.file.nodeId && (
                  <div
                    style={{
                      position: 'absolute',
                      left: '100%',
                      top: 0,
                      marginLeft: '2px',
                      minWidth: '140px',
                      backgroundColor: themeStyles.bgPrimary,
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: '4px',
                      boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
                      zIndex: 1200,
                      padding: '4px 0',
                    }}
                    onMouseEnter={() => setNewSiblingCardForNodeSubmenuOpen(true)}
                    onMouseLeave={() => setNewSiblingCardForNodeSubmenuOpen(false)}
                  >
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingCardForNodePlacement(contextMenu.file.nodeId || '', 'above');
                      }}
                    >
                      向上插入
                    </div>
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingCardForNodePlacement(contextMenu.file.nodeId || '', 'below');
                      }}
                    >
                      向下插入
                    </div>
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingCardForNodePlacement(contextMenu.file.nodeId || '', 'bottom');
                      }}
                    >
                      底部插入
                    </div>
                  </div>
                )}
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleNewMultipleCards(contextMenu.file.nodeId || '')}
              >
                新建多个 Card
              </div>
              </>
              )}
              {(
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleNewMultipleChildNodes(contextMenu.file.nodeId || '')}
              >
                新建多个子 Node
              </div>
              )}
              {(
              <>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleOpenImportWindow(contextMenu.file.nodeId || '')}
              >
                导入
              </div>
              {basePath !== 'base/skill' && docId && contextMenu.file.nodeId && !String(contextMenu.file.nodeId).startsWith('temp-node-') && (
                <div
                  style={{
                    padding: '6px 16px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: themeStyles.textPrimary,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  onClick={() => {
                    setMigrateNewBaseTitle('');
                    setMigrateNewBaseBid('');
                    setMigrateToNewBaseModal({ nodeId: contextMenu.file.nodeId || '' });
                    setContextMenu(null);
                  }}
                >
                  Migrate to new base
                </div>
              )}
              <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
              </>
              )}
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  setSortWindow({ nodeId: contextMenu.file.nodeId || '' });
                  setContextMenu(null);
                }}
              >
                排序
              </div>
              {(
              <>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  handleExportToPDF(contextMenu.file.nodeId || '');
                }}
              >
                导出为PDF
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  if (!docId || !contextMenu.file.nodeId) return;
                  pendingNodeUploadRef.current = { nodeId: contextMenu.file.nodeId };
                  setContextMenu(null);
                  cardFileInputRef.current?.click();
                }}
              >
                {i18n('Upload file')}
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  const nodeId = contextMenu.file.nodeId || '';
                  const node = base.nodes.find((n: BaseNode) => n.id === nodeId);
                  setNodeFileListModal({ nodeId, nodeTitle: node?.text || '' });
                  setContextMenu(null);
                }}
              >
                {/* Skill mode: right sidebar, click tool to copy params */}
      {basePath === 'base/skill' && (
        <div style={{
          width: '280px',
          flexShrink: 0,
          height: '100%',
          minHeight: 0,
          alignSelf: 'stretch',
          borderLeft: `1px solid ${themeStyles.borderPrimary}`,
          backgroundColor: themeStyles.bgSecondary,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${themeStyles.borderPrimary}`,
            fontSize: '12px',
            fontWeight: '600',
            color: themeStyles.textSecondary,
            backgroundColor: themeStyles.bgPrimary,
          }}>
            工具
          </div>
          <div style={{ padding: '8px 12px', fontSize: '11px', color: themeStyles.textTertiary, borderBottom: `1px solid ${themeStyles.borderPrimary}` }}>
            点击工具可复制「工具名 + 参数」到剪贴板
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
            {domainToolsLoading ? (
              <div style={{ padding: '12px 16px', fontSize: '12px', color: themeStyles.textSecondary }}>加载中...</div>
            ) : domainTools.length === 0 ? (
              <div style={{ padding: '12px 16px', fontSize: '12px', color: themeStyles.textSecondary }}>当前域下暂无工具。</div>
            ) : (
              domainTools.map((tool: any) => {
                const toolKey = tool.toolKey || tool.name || '';
                const label = tool.name || tool.toolKey || '';
                const serverLabel = tool.edgeName || '';
                const schema = tool.inputSchema;
                const params: Array<{ name: string; desc?: string; defaultVal?: string }> = [];
                if (schema?.properties && typeof schema.properties === 'object') {
                  Object.entries(schema.properties).forEach(([k, v]: [string, any]) => {
                    params.push({
                      name: k,
                      desc: v?.description,
                      defaultVal: v?.default != null ? String(v.default) : undefined,
                    });
                  });
                }
                const buildCopyPayload = () => {
                  const args: Record<string, string> = {};
                  params.forEach((p) => {
                    args[p.name] = p.defaultVal ?? '';
                  });
                  return JSON.stringify({ tool: toolKey, arguments: args }, null, 2);
                };
                const copyPayload = toolKey ? (params.length > 0 ? buildCopyPayload() : JSON.stringify({ tool: toolKey, arguments: {} }, null, 2)) : '';
                return (
                  <div
                    key={tool.tid != null ? `edge-${tool.tid}-${tool.edgeToken}` : `system-${tool.toolKey}`}
                    title={copyPayload ? '点击复制工具参数' : ''}
                    onClick={() => {
                      if (!copyPayload) return;
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(copyPayload).then(() => {
                          Notification.success('已复制到剪贴板');
                        }).catch(() => {
                          Notification.error(i18n('Copy failed'));
                        });
                      } else {
                        Notification.error('剪贴板不可用');
                      }
                    }}
                    style={{
                      padding: '10px 16px',
                      fontSize: '12px',
                      color: themeStyles.textPrimary,
                      cursor: copyPayload ? 'pointer' : 'default',
                      borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                    }}
                    onMouseEnter={(e) => {
                      if (copyPayload) e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>{label}</div>
                    {serverLabel && (
                      <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginTop: '2px' }}>{serverLabel}</div>
                    )}
                    {params.length > 0 && (
                      <div style={{ marginTop: '6px', fontSize: '11px', color: themeStyles.textSecondary }}>
                        <div style={{ fontWeight: 600, marginBottom: '4px' }}>参数：</div>
                        {params.map((p) => (
                          <div key={p.name} style={{ marginLeft: '4px', marginBottom: '2px' }}>
                            <code style={{ fontSize: '10px' }}>{p.name}</code>
                            {p.desc && <span style={{ marginLeft: '4px' }}>— {p.desc}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}



      {(() => {
                  const node = base.nodes.find((n: BaseNode) => n.id === contextMenu.file.nodeId);
                  const n = node?.files?.length ?? 0;
                  return n > 0 ? i18n('{0} file(s) — Open list', n) : i18n('Open file list');
                })()}
              </div>
              </>
              )}
              <>
              <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  handleStartRename(contextMenu.file, { stopPropagation: () => {} } as React.MouseEvent);
                  setContextMenu(null);
                }}
              >
                重命名
              </div>
              {(
              <div style={{ padding: '6px 16px', cursor: 'pointer', fontSize: '13px', color: themeStyles.textPrimary }} onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = themeStyles.bgHover; }} onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }} onClick={() => handleConvertCardToNode(contextMenu.file)}>转换为 node</div>
              )}
              <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCopy(contextMenu.file)}
              >
                复制
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCopyContent(contextMenu.file)}
              >
                复制内容
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCut(contextMenu.file)}
              >
                剪切
              </div>
              {(
              <>
              <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.error,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleDelete(contextMenu.file)}
              >
                删除 Node
              </div>
              </>
              )}
              </>
            </>
          ) : (
            <>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  setIsMultiSelectMode(!isMultiSelectMode);
                  setSelectedItems(new Set());
                  setContextMenu(null);
                }}
              >
                {isMultiSelectMode ? '退出多选' : '多选模式'}
              </div>
              {/* Multi-select: copy, cut, delete (batch delete hidden in collect: may remove nodes) */}
              {isMultiSelectMode && selectedItems.size > 0 && (
                <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handleCopy()}
                  >
                    复制选中项 ({selectedItems.size})
                  </div>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handleCut()}
                  >
                    剪切选中项 ({selectedItems.size})
                  </div>
                  {(
                  <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.error,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => {
                      handleBatchDelete();
                      setContextMenu(null);
                    }}
                  >
                    删除选中项 ({selectedItems.size})
                  </div>
                  <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
                  </>
                  )}
                </>
              )}
              {basePath !== 'base/skill' && docId && contextMenu.file.cardId && !String(contextMenu.file.cardId).startsWith('temp-card-') && (
                <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: editorLearnBusy ? 'wait' : 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                      opacity: editorLearnBusy ? 0.65 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!editorLearnBusy) e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => {
                      void startSingleCardLearnFromEditor(String(contextMenu.file.cardId));
                      setContextMenu(null);
                    }}
                  >
                    {i18n('Outline learn single card')}
                  </div>
                  <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
                </>
              )}
              <div
                style={{ position: 'relative' }}
                onMouseEnter={() => setNewSiblingCardSubmenuOpen(true)}
                onMouseLeave={() => setNewSiblingCardSubmenuOpen(false)}
              >
                <div
                  style={{
                    padding: '6px 16px',
                    cursor: 'default',
                    fontSize: '13px',
                    color: themeStyles.textPrimary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <span>新建兄弟 Card</span>
                  <span style={{ opacity: 0.65, fontSize: '12px', flexShrink: 0 }}>›</span>
                </div>
                {newSiblingCardSubmenuOpen && contextMenu.file.cardId && (
                  <div
                    style={{
                      position: 'absolute',
                      left: '100%',
                      top: 0,
                      marginLeft: '2px',
                      minWidth: '140px',
                      backgroundColor: themeStyles.bgPrimary,
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: '4px',
                      boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
                      zIndex: 1200,
                      padding: '4px 0',
                    }}
                    onMouseEnter={() => setNewSiblingCardSubmenuOpen(true)}
                    onMouseLeave={() => setNewSiblingCardSubmenuOpen(false)}
                  >
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingCardPlacement(
                          contextMenu.file.nodeId || '',
                          String(contextMenu.file.cardId),
                          'above',
                        );
                      }}
                    >
                      向上插入
                    </div>
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingCardPlacement(
                          contextMenu.file.nodeId || '',
                          String(contextMenu.file.cardId),
                          'below',
                        );
                      }}
                    >
                      向下插入
                    </div>
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingCardPlacement(
                          contextMenu.file.nodeId || '',
                          String(contextMenu.file.cardId),
                          'bottom',
                        );
                      }}
                    >
                      底部插入
                    </div>
                  </div>
                )}
              </div>
              {(
              <>
              <div
                style={{ position: 'relative' }}
                onMouseEnter={() => setNewSiblingNodeForCardSubmenuOpen(true)}
                onMouseLeave={() => setNewSiblingNodeForCardSubmenuOpen(false)}
              >
                <div
                  style={{
                    padding: '6px 16px',
                    cursor: 'default',
                    fontSize: '13px',
                    color: themeStyles.textPrimary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <span>新建兄弟 Node</span>
                  <span style={{ opacity: 0.65, fontSize: '12px', flexShrink: 0 }}>›</span>
                </div>
                {newSiblingNodeForCardSubmenuOpen && contextMenu.file.nodeId && contextMenu.file.cardId && (
                  <div
                    style={{
                      position: 'absolute',
                      left: '100%',
                      top: 0,
                      marginLeft: '2px',
                      minWidth: '140px',
                      backgroundColor: themeStyles.bgPrimary,
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: '4px',
                      boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
                      zIndex: 1200,
                      padding: '4px 0',
                    }}
                    onMouseEnter={() => setNewSiblingNodeForCardSubmenuOpen(true)}
                    onMouseLeave={() => setNewSiblingNodeForCardSubmenuOpen(false)}
                  >
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingNodeForCardPlacement(
                          contextMenu.file.nodeId || '',
                          String(contextMenu.file.cardId),
                          'above',
                        );
                      }}
                    >
                      向上插入
                    </div>
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingNodeForCardPlacement(
                          contextMenu.file.nodeId || '',
                          String(contextMenu.file.cardId),
                          'below',
                        );
                      }}
                    >
                      向下插入
                    </div>
                    <div
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: themeStyles.textPrimary,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewSiblingNodeForCardPlacement(
                          contextMenu.file.nodeId || '',
                          String(contextMenu.file.cardId),
                          'bottom',
                        );
                      }}
                    >
                      底部插入
                    </div>
                  </div>
                )}
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleConvertCardToNode(contextMenu.file)}
              >
                转换为 node
              </div>
              </>
              )}
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  handleStartRename(contextMenu.file, { stopPropagation: () => {} } as React.MouseEvent);
                  setContextMenu(null);
                }}
              >
                重命名
              </div>
              <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCopy(contextMenu.file)}
              >
                复制
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCopyContent(contextMenu.file)}
              >
                复制内容
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  if (!docId || !contextMenu.file.cardId) return;
                  pendingCardUploadRef.current = { cardId: String(contextMenu.file.cardId), nodeId: contextMenu.file.nodeId || '' };
                  setContextMenu(null);
                  cardFileInputRef.current?.click();
                }}
              >
                {i18n('Upload file')}
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  const cardId = contextMenu.file.cardId ? String(contextMenu.file.cardId) : '';
                  const nodeId = contextMenu.file.nodeId || '';
                  const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                  const cards = nodeCardsMap[nodeId] || [];
                  const card = cards.find((c: Card) => String(c.docId) === cardId);
                  setCardFileListModal({ cardId, nodeId, cardTitle: card?.title || '' });
                  setContextMenu(null);
                }}
              >
                {(() => {
                  const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                  const cards = nodeCardsMap[contextMenu.file.nodeId || ''] || [];
                  const card = cards.find((c: Card) => String(c.docId) === contextMenu.file.cardId);
                  const n = card?.files?.length ?? 0;
                  return n > 0 ? i18n('{0} file(s) — Open list', n) : i18n('Open file list');
                })()}
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                  const card = (nodeCardsMap[contextMenu.file.nodeId || ''] || []).find((c: Card) => c.docId === contextMenu.file.cardId);
                  const initial = pendingCardFaceChanges[contextMenu.file.cardId || ''] ?? card?.cardFace ?? '';
                  setCardFaceEditContent(initial);
                  setCardFaceWindow({ file: contextMenu.file });
                  setContextMenu(null);
                }}
              >
                编辑卡面
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCut(contextMenu.file)}
              >
                剪切
              </div>
              <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.error,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleDelete(contextMenu.file)}
              >
                删除 Card
              </div>
            </>
          )}
        </div>
      )}

      {/* Empty area context menu */}
      {emptyAreaContextMenu && (
        <div
          style={{
            position: 'fixed',
            left: emptyAreaContextMenu.x,
            top: emptyAreaContextMenu.y,
            backgroundColor: themeStyles.bgPrimary,
            border: `1px solid ${themeStyles.borderSecondary}`,
            borderRadius: '4px',
            boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
            zIndex: 1100,
            minWidth: '180px',
            padding: '4px 0',
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {(
          <>
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => handleNewRootNode()}
          >
            新建 Node
          </div>
          </>
          )}
          {(
          <>
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => handleNewRootCard()}
          >
            新建 Card
          </div>
          </>
          )}
          {(
          <>
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => handleNewMultipleRootNodes()}
          >
            新建多个 Node
          </div>
          </>
          )}
          {(
          <>
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => handleNewMultipleRootCards()}
          >
            新建多个 Card
          </div>
          </>
          )}
        </div>
      )}

      {/* File list row context menu (Copy link / Download / Delete) */}
      {fileListRowMenu && (
        <div
          style={{
            position: 'fixed',
            left: fileListRowMenu.x,
            top: fileListRowMenu.y,
            backgroundColor: themeStyles.bgPrimary,
            border: `1px solid ${themeStyles.borderSecondary}`,
            borderRadius: '4px',
            boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
            zIndex: 1100,
            minWidth: '140px',
            padding: '4px 0',
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={async () => {
              const path = fileListRowMenu!.downloadUrl.startsWith('http') ? fileListRowMenu!.downloadUrl : fileListRowMenu!.downloadUrl;
              const previewPath = path + (path.includes('?') ? '&noDisposition=1' : '?noDisposition=1');
              const md = `[](${previewPath})`;
              try {
                await navigator.clipboard.writeText(md);
                Notification.success(i18n('Link copied.'));
              } catch (err: any) {
                Notification.error(err?.message || i18n('Copy failed.'));
              }
              setFileListRowMenu(null);
            }}
          >
            {i18n('Copy link')}
          </div>
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => {
              window.open(fileListRowMenu!.downloadUrl, '_blank');
              setFileListRowMenu(null);
            }}
          >
            {i18n('Download')}
          </div>
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={async () => {
              const filename = fileListRowMenu!.filename;
              const $body = $(tpl`
                <div class="typo" style="min-width: 280px;">
                  <label>
                    ${i18n('Rename file')}
                    <input type="text" name="newName" class="textbox" style="width: 100%; margin-top: 8px;" />
                  </label>
                </div>
              `);
              $body.find('input[name="newName"]').val(filename);
              const dialog = new ActionDialog({ $body, width: '360px' } as any);
              const action = await dialog.open();
              if (action !== 'ok') {
                setFileListRowMenu(null);
                return;
              }
              const trimmed = ($body.find('input[name="newName"]').val() as string || '').trim();
              if (!trimmed || trimmed === filename) {
                setFileListRowMenu(null);
                return;
              }
              try {
                await request.post(fileListRowMenu!.deleteUrl, { fileAction: 'rename', oldName: filename, newName: trimmed });
                Notification.success(i18n('Renamed.'));
                await refetchEditorData();
              } catch (err: any) {
                Notification.error(err?.message || i18n('Rename failed.'));
              }
              setFileListRowMenu(null);
            }}
          >
            {i18n('Rename')}
          </div>
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={async () => {
              try {
                await request.post(fileListRowMenu!.deleteUrl, { files: [fileListRowMenu!.filename] });
                Notification.success(i18n('Deleted.'));
                await refetchEditorData();
              } catch (err: any) {
                Notification.error(err?.message || i18n('Delete failed.'));
              }
              setFileListRowMenu(null);
            }}
          >
            {i18n('Delete')}
          </div>
        </div>
      )}

      {/* Click outside to close menu */}
      {(contextMenu || emptyAreaContextMenu || fileListRowMenu) && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1099,
          }}
          onClick={() => {
            setContextMenu(null);
            setEmptyAreaContextMenu(null);
            setFileListRowMenu(null);
          }}
        />
      )}

      {/* Sort window */}
      {sortWindow && (
        <SortWindow
          nodeId={sortWindow.nodeId}
          base={base}
          docId={docId}
          getBaseUrl={getBaseUrl}
          onClose={() => setSortWindow(null)}
          nodeCardsMapVersion={nodeCardsMapVersion}
          themeStyles={themeStyles}
          theme={theme}
          onSave={async (sortedItems) => {
            try {
              const domainId = (window as any).UiContext?.domainId || 'system';
              const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
              
              
              const updatedNodes = base.nodes.map(node => {
                const sortedItem = sortedItems.find(item => item.type === 'node' && item.id === node.id);
                if (sortedItem && node.order !== sortedItem.order) {
                  return { ...node, order: sortedItem.order };
                }
                return node;
              });
              
              
              setBase(prev => ({
                ...prev,
                nodes: updatedNodes,
              }));
              
              
              for (const sortedItem of sortedItems) {
                if (sortedItem.type === 'card') {
                  const card = (nodeCardsMap[sortWindow.nodeId] || []).find((c: Card) => c.docId === sortedItem.id);
                  if (card && card.order !== sortedItem.order) {
                    card.order = sortedItem.order;
                  }
                }
              }
              
              if (nodeCardsMap[sortWindow.nodeId]) {
                nodeCardsMap[sortWindow.nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
                (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
              }
              
              
              setNodeCardsMapVersion(prev => prev + 1);
              
              
              setPendingDragChanges(prev => {
                const newSet = new Set(prev);
                sortedItems.forEach(item => {
                  if (item.type === 'node') {
                    newSet.add(`node-${item.id}`);
                  } else {
                    newSet.add(item.id);
                  }
                });
                return newSet;
              });
              
              Notification.success(i18n('Sort order updated, click Save to persist'));
              setSortWindow(null);
            } catch (error: any) {
              console.error('Failed to save sort order:', error);
              Notification.error(`保存排序失败: ${error?.message || '未知错误'}`);
            }
          }}
        />
      )}

      {/* Import window */}
      {importWindow && (
        <>
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: theme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.3)',
              zIndex: 1100,
            }}
            onClick={() => setImportWindow(null)}
          />
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '90%',
              maxWidth: '560px',
              maxHeight: '80vh',
              backgroundColor: themeStyles.bgPrimary,
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '8px',
              boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.5)' : '0 4px 24px rgba(0,0,0,0.15)',
              zIndex: 1101,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              padding: '16px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              fontSize: '15px',
              fontWeight: 500,
              color: themeStyles.textPrimary,
            }}>
              导入
            </div>
            <div style={{ padding: '16px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <p style={{ margin: '0 0 10px', fontSize: '13px', color: themeStyles.textSecondary }}>
                {i18n('Import hint')}
              </p>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'## 1\n\n内容……\n\n---\n\n## 2\n\n内容……'}
                style={{
                  width: '100%',
                  flex: 1,
                  minHeight: '200px',
                  padding: '12px',
                  fontSize: '13px',
                  fontFamily: 'monospace',
                  color: themeStyles.textPrimary,
                  backgroundColor: themeStyles.bgSecondary,
                  border: `1px solid ${themeStyles.borderPrimary}`,
                  borderRadius: '4px',
                  resize: 'vertical',
                }}
              />
            </div>
            <div style={{
              padding: '12px 16px',
              borderTop: `1px solid ${themeStyles.borderPrimary}`,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
            }}>
              <button
                type="button"
                onClick={() => setImportWindow(null)}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: themeStyles.textSecondary,
                  backgroundColor: themeStyles.bgSecondary,
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                {i18n('Cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  doImportFromText(importWindow.nodeId, importText);
                  setImportWindow(null);
                  setImportText('');
                }}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: '#fff',
                  backgroundColor: themeStyles.accent,
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                确定
              </button>
            </div>
          </div>
        </>
      )}

      {migrateToNewBaseModal && (
        <>
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: theme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.3)',
              zIndex: 1100,
            }}
            onClick={() => !migrateToNewBaseSubmitting && setMigrateToNewBaseModal(null)}
          />
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '90%',
              maxWidth: '420px',
              backgroundColor: themeStyles.bgPrimary,
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '8px',
              boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.5)' : '0 4px 24px rgba(0,0,0,0.15)',
              zIndex: 1101,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              padding: '16px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              fontSize: '15px',
              fontWeight: 500,
              color: themeStyles.textPrimary,
            }}>
              Migrate to new base
            </div>
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ margin: 0, fontSize: '13px', color: themeStyles.textSecondary, lineHeight: 1.5 }}>
                Moves this node and its subtree into a new knowledge base (child nodes, cards, and attached files). Save all pending edits from the toolbar first. Confirming opens the new base in a new tab.
              </p>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: themeStyles.textPrimary }}>
                Title
                <input
                  type="text"
                  value={migrateNewBaseTitle}
                  onChange={(e) => setMigrateNewBaseTitle(e.target.value)}
                  placeholder="New base title"
                  disabled={migrateToNewBaseSubmitting}
                  style={{
                    padding: '8px 10px',
                    fontSize: '13px',
                    color: themeStyles.textPrimary,
                    backgroundColor: themeStyles.bgSecondary,
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    borderRadius: '4px',
                  }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: themeStyles.textPrimary }}>
                BID (optional)
                <input
                  type="text"
                  value={migrateNewBaseBid}
                  onChange={(e) => setMigrateNewBaseBid(e.target.value)}
                  placeholder="e.g. P1001"
                  disabled={migrateToNewBaseSubmitting}
                  style={{
                    padding: '8px 10px',
                    fontSize: '13px',
                    color: themeStyles.textPrimary,
                    backgroundColor: themeStyles.bgSecondary,
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    borderRadius: '4px',
                  }}
                />
              </label>
            </div>
            <div style={{
              padding: '12px 16px',
              borderTop: `1px solid ${themeStyles.borderPrimary}`,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
            }}>
              <button
                type="button"
                disabled={migrateToNewBaseSubmitting}
                onClick={() => setMigrateToNewBaseModal(null)}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: themeStyles.textSecondary,
                  backgroundColor: themeStyles.bgSecondary,
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  borderRadius: '4px',
                  cursor: migrateToNewBaseSubmitting ? 'not-allowed' : 'pointer',
                }}
              >
                {i18n('Cancel')}
              </button>
              <button
                type="button"
                disabled={migrateToNewBaseSubmitting}
                onClick={async () => {
                  const trimmedTitle = migrateNewBaseTitle.trim();
                  if (!trimmedTitle) {
                    Notification.error('Please enter a title');
                    return;
                  }
                  const nid = migrateToNewBaseModal.nodeId;
                  if (!docId || !nid) return;
                  const numericDocId = Number(docId);
                  if (!Number.isFinite(numericDocId) || numericDocId <= 0) {
                    Notification.error('Cannot migrate: invalid document ID');
                    return;
                  }
                  const pendingMigrate =
                    pendingChanges.size +
                    pendingDragChanges.size +
                    pendingRenames.size +
                    pendingCreatesCount +
                    pendingDeletes.size +
                    Object.keys(pendingCardFaceChanges).length +
                    pendingProblemCardIds.size +
                    pendingNewProblemCardIds.size +
                    pendingEditedProblemIds.size;
                  if (pendingMigrate > 0) {
                    Notification.warn('Please save all changes before migrating');
                    return;
                  }
                  setMigrateToNewBaseSubmitting(true);
                  try {
                    const res: any = await request.post(getBaseUrl('/migrate-node-to-new'), {
                      docId: numericDocId,
                      branch: currentBranch,
                      nodeId: nid,
                      title: trimmedTitle,
                      bid: migrateNewBaseBid.trim(),
                    });
                    if (!res?.success) {
                      Notification.error(res?.message || 'Migration failed');
                      return;
                    }
                    Notification.success('New base created; subtree moved');
                    setMigrateToNewBaseModal(null);
                    const openSeg = res.bid ? String(res.bid) : String(res.newDocId);
                    const domainId = (window as any).UiContext?.domainId || 'system';
                    const outlinePath = `/d/${domainId}/base/${openSeg}/outline/branch/${encodeURIComponent(currentBranch)}`;
                    window.open(outlinePath, '_blank');
                    await refetchEditorData();
                    selectedFileRef.current = null;
                    setSelectedFile(null);
                  } catch (err: any) {
                    Notification.error(err?.message || 'Migration failed');
                  } finally {
                    setMigrateToNewBaseSubmitting(false);
                  }
                }}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: '#fff',
                  backgroundColor: themeStyles.accent,
                  border: 'none',
                  borderRadius: '4px',
                  cursor: migrateToNewBaseSubmitting ? 'not-allowed' : 'pointer',
                  opacity: migrateToNewBaseSubmitting ? 0.7 : 1,
                }}
              >
                {migrateToNewBaseSubmitting ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Card face editor */}
      {cardFaceWindow && (
        <>
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: theme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.3)',
              zIndex: 1100,
            }}
            onClick={() => setCardFaceWindow(null)}
          />
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '90%',
              maxWidth: '640px',
              maxHeight: '80vh',
              backgroundColor: themeStyles.bgPrimary,
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '8px',
              boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.5)' : '0 4px 24px rgba(0,0,0,0.15)',
              zIndex: 1101,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              padding: '16px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              fontSize: '15px',
              fontWeight: 500,
              color: themeStyles.textPrimary,
            }}>
              编辑卡面
            </div>
            <div style={{ padding: '16px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <p style={{ margin: '0 0 10px', fontSize: '13px', color: themeStyles.textSecondary }}>
                卡面会在 lesson 中与 Know it / No impression 一起展示，支持 Markdown
              </p>
              <textarea
                ref={cardFaceEditorRef}
                key={cardFaceWindow?.file?.cardId ?? 'card-face-editor'}
                defaultValue={cardFaceEditContent}
                data-markdown="true"
                style={{
                  width: '100%',
                  flex: 1,
                  minHeight: '240px',
                  padding: '12px',
                  fontSize: '13px',
                  fontFamily: 'monospace',
                  color: themeStyles.textPrimary,
                  backgroundColor: themeStyles.bgSecondary,
                  border: `1px solid ${themeStyles.borderPrimary}`,
                  borderRadius: '4px',
                  resize: 'vertical',
                }}
              />
            </div>
            <div style={{
              padding: '12px 16px',
              borderTop: `1px solid ${themeStyles.borderPrimary}`,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
            }}>
              <button
                type="button"
                onClick={() => setCardFaceWindow(null)}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: themeStyles.textSecondary,
                  backgroundColor: themeStyles.bgSecondary,
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                {i18n('Cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const { file } = cardFaceWindow;
                  const cardId = file.cardId || '';
                  setPendingCardFaceChanges(prev => ({ ...prev, [cardId]: (cardFaceEditorInstanceRef.current && typeof cardFaceEditorInstanceRef.current.value === 'function' ? cardFaceEditorInstanceRef.current.value() : cardFaceEditContent) }));
                  const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                  const nodeId = file.nodeId || '';
                  if (nodeCardsMap[nodeId]) {
                    const cards = nodeCardsMap[nodeId];
                    const idx = cards.findIndex((c: Card) => c.docId === cardId);
                    if (idx >= 0) {
                      cards[idx] = { ...cards[idx], cardFace: (cardFaceEditorInstanceRef.current && typeof cardFaceEditorInstanceRef.current.value === 'function' ? cardFaceEditorInstanceRef.current.value() : cardFaceEditContent) };
                      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
                      setNodeCardsMapVersion(prev => prev + 1);
                    }
                  }
                  if (cardFaceEditorInstanceRef.current) {
                    try { cardFaceEditorInstanceRef.current.destroy(); } catch (_) {}
                    cardFaceEditorInstanceRef.current = null;
                  }
                  if (cardFaceEditorInstanceRef.current) {
                    try { cardFaceEditorInstanceRef.current.destroy(); } catch (e) {}
                    cardFaceEditorInstanceRef.current = null;
                  }
                  setCardFaceWindow(null);
                }}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: '#fff',
                  backgroundColor: themeStyles.accent,
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                确定
              </button>
            </div>
          </div>
        </>
      )}

      <div style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        paddingTop: isMobile ? 'env(safe-area-inset-top, 0px)' : 0,
        paddingLeft: isMobile ? 'env(safe-area-inset-left, 0px)' : 0,
        paddingRight: isMobile ? 'env(safe-area-inset-right, 0px)' : 0,
        paddingBottom: isMobile ? 'env(safe-area-inset-bottom, 0px)' : 0,
      }}>
        <div style={{
          padding: isMobile ? '12px 16px' : '8px 16px',
          paddingTop: isMobile ? 'max(12px, env(safe-area-inset-top, 0px))' : '8px',
          borderBottom: `1px solid ${themeStyles.borderPrimary}`,
          backgroundColor: themeStyles.bgPrimary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: isMobile ? '8px' : 0,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: isMobile ? '1 1 100%' : undefined }}>
            <a
              href={getBaseUrl(`/${docId}/branch/${base.currentBranch || 'main'}`)}
              style={{
                padding: isMobile ? '10px 12px' : '4px 8px',
                minHeight: isMobile ? '44px' : undefined,
                fontSize: '12px',
                color: themeStyles.textPrimary,
                textDecoration: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              ← 返回
            </a>
            {selectedFile && (
              <div style={{ fontSize: '13px', color: themeStyles.textPrimary }}>
                {selectedFile.name}
              </div>
            )}
          </div>
          {!isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
            {(pendingChanges.size > 0 || pendingDragChanges.size > 0 || pendingRenames.size > 0 || Object.keys(pendingCardFaceChanges).length > 0 || pendingProblemCardIds.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0) && (
              <span style={{ fontSize: '12px', color: themeStyles.textSecondary }}>
                {pendingChanges.size > 0 && `${pendingChanges.size} 个文件已修改`}
                {pendingChanges.size > 0 && (pendingDragChanges.size > 0 || pendingRenames.size > 0 || Object.keys(pendingCardFaceChanges).length > 0 || pendingProblemCardIds.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0) && '，'}
                {Object.keys(pendingCardFaceChanges).length > 0 && `${Object.keys(pendingCardFaceChanges).length} 个卡面已修改`}
                {Object.keys(pendingCardFaceChanges).length > 0 && (pendingDragChanges.size > 0 || pendingRenames.size > 0 || pendingProblemCardIds.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0) && '，'}
                {pendingDragChanges.size > 0 && `${pendingDragChanges.size} 个拖动操作`}
                {pendingDragChanges.size > 0 && (pendingRenames.size > 0 || pendingProblemCardIds.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0) && '，'}
                {pendingRenames.size > 0 && `${pendingRenames.size} 个重命名`}
                {(pendingRenames.size > 0 || pendingChanges.size > 0 || pendingDragChanges.size > 0) && (pendingProblemCardIds.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0) && '，'}
                {pendingNewProblemCardIds.size > 0 && `${pendingNewProblemCardIds.size} 个题目新建`}
                {pendingNewProblemCardIds.size > 0 && (pendingEditedProblemIds.size > 0 || pendingProblemCardIds.size > 0) && '，'}
                {pendingEditedProblemIds.size > 0 && `${pendingEditedProblemIds.size} 个题目更改`}
              </span>
            )}
            <button
              onClick={() => {
                console.log('[保存按钮] 点击保存，pendingProblemCardIds:', Array.from(pendingProblemCardIds));
                handleSaveAll();
              }}
              disabled={isCommitting || (pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0 && Object.keys(pendingCardFaceChanges).length === 0 && pendingProblemCardIds.size === 0 && pendingNewProblemCardIds.size === 0 && pendingEditedProblemIds.size === 0)}
              style={{
                padding: isMobile ? '10px 12px' : '4px 12px',
                minHeight: isMobile ? '44px' : undefined,
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '3px',
                backgroundColor: (pendingChanges.size > 0 || pendingDragChanges.size > 0 || pendingRenames.size > 0 || pendingCreatesCount > 0 || pendingDeletes.size > 0 || Object.keys(pendingCardFaceChanges).length > 0 || pendingProblemCardIds.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0) ? themeStyles.success : (theme === 'dark' ? '#555' : '#6c757d'),
                color: themeStyles.textOnPrimary,
                cursor: (isCommitting || (pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0 && Object.keys(pendingCardFaceChanges).length === 0 && pendingProblemCardIds.size === 0 && pendingNewProblemCardIds.size === 0 && pendingEditedProblemIds.size === 0)) ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                fontWeight: '500',
                opacity: (isCommitting || (pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0 && Object.keys(pendingCardFaceChanges).length === 0 && pendingProblemCardIds.size === 0 && pendingNewProblemCardIds.size === 0 && pendingEditedProblemIds.size === 0)) ? 0.6 : 1,
              }}
              title={(pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0 && Object.keys(pendingCardFaceChanges).length === 0 && pendingProblemCardIds.size === 0 && pendingNewProblemCardIds.size === 0 && pendingEditedProblemIds.size === 0) ? i18n('No pending changes') : i18n('Save all changes')}
            >
              {isCommitting ? i18n('Saving...') : `${i18n('Save changes')} (${pendingChanges.size + pendingDragChanges.size + pendingRenames.size + pendingCreatesCount + pendingDeletes.size + Object.keys(pendingCardFaceChanges).length + pendingProblemCardIds.size + pendingNewProblemCardIds.size + pendingEditedProblemIds.size})`}
            </button>
          </div>
          )}
        </div>

        {/* */}
        {(() => {
          const todayContribution = contributionData.todayContribution;
          const todayAll = contributionData.todayContributionAllDomains;
          const domainId = (window as any).UiContext?.domainId || (window as any).UiContext?.base?.domainId;
          const uid = (window as any).UserContext?._id;
          const contributionLink = typeof uid === 'number' && domainId
            ? `/d/${domainId}/user/${uid}?tab=contributions`
            : null;
          const chars = (t: typeof todayContribution) => (t.nodeChars ?? 0) + (t.cardChars ?? 0) + (t.problemChars ?? 0);
          const formatNum = (n: number) => n.toLocaleString('en-US');
          const cardStyle: React.CSSProperties = {
            padding: isMobile ? '8px 10px' : '12px 16px',
            borderRadius: isMobile ? '6px' : '10px',
            border: `1px solid ${themeStyles.borderSecondary}`,
            backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
            flex: 1,
            minWidth: 0,
          };
          const Stat = ({ label, value, color }: { label: string; value: string; color: string }) => (
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: isMobile ? '2px' : '4px' }}>
              <span style={{ fontSize: isMobile ? '10px' : '11px', color: themeStyles.textSecondary, fontWeight: 500 }}>{label}</span>
              <span style={{ color, fontWeight: 600, fontSize: isMobile ? '12px' : '14px' }}>{value}</span>
            </span>
          );
          const devCtx = developEditorContext;
          const developGoalCaption = (cur: number, goal: number) => {
            if (goal > 0) return `${cur}/${goal}`;
            return `${cur}/${i18n('Develop goal unset')}`;
          };
          const DevelopGoalBar = ({
            label, cur, goal, barColor,
          }: { label: string; cur: number; goal: number; barColor: string }) => {
            const unset = goal <= 0;
            const caption = developGoalCaption(cur, goal);
            const pct = !unset && goal > 0 ? Math.min(100, Math.round((cur / goal) * 100)) : 0;
            const track = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
            return (
              <div style={{ marginBottom: isMobile ? 4 : 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: themeStyles.textPrimary }}>{label}</span>
                  <span style={{ fontSize: 10, color: themeStyles.textSecondary }}>{caption}</span>
                </div>
                {!unset ? (
                  <div style={{
                    height: 4,
                    borderRadius: 2,
                    background: track,
                    overflow: 'hidden',
                    border: `1px solid ${themeStyles.borderSecondary}`,
                  }}
                  >
                    <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 1, transition: 'width 0.2s ease' }} />
                  </div>
                ) : null}
              </div>
            );
          };
          const formatDevelopElapsed = (ms: number) => {
            let sec = Math.max(0, Math.floor(ms / 1000));
            const h = Math.floor(sec / 3600);
            sec -= h * 3600;
            const m = Math.floor(sec / 60);
            sec -= m * 60;
            if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
            return `${m}:${String(sec).padStart(2, '0')}`;
          };
          const startedAtMs = developSessionStartedAtIsoFromUi
            ? new Date(developSessionStartedAtIsoFromUi).getTime()
            : NaN;
          const developSessionElapsedText = Number.isFinite(startedAtMs)
            ? formatDevelopElapsed(Date.now() - startedAtMs)
            : '';
          void developSessionClock;

          const developPoolCardFullWidth = devCtx ? (
            <div style={{
              ...cardStyle,
              flex: '1 1 100%',
              maxWidth: '100%',
              padding: isMobile ? '6px 8px' : '8px 12px',
              borderRadius: isMobile ? 6 : 8,
            }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '4px 10px',
                marginBottom: 6,
              }}
              >
                <span style={{ fontSize: 11, fontWeight: 600, color: themeStyles.textPrimary }}>
                  {i18n('Develop editor pool progress')}
                </span>
                <span style={{ fontSize: 10, color: themeStyles.textTertiary, whiteSpace: 'nowrap' }}>
                  {devCtx.current.baseTitle}
                  <span style={{ color: themeStyles.textSecondary }}>{` · ${devCtx.current.branch}`}</span>
                  <span style={{ marginLeft: 6 }}>{devCtx.dateUtc}</span>
                </span>
              </div>
              <DevelopGoalBar label={i18n('Develop today nodes')} cur={devCtx.current.todayNodes} goal={devCtx.current.dailyNodeGoal} barColor={themeStyles.statNode} />
              <DevelopGoalBar label={i18n('Develop today cards')} cur={devCtx.current.todayCards} goal={devCtx.current.dailyCardGoal} barColor={themeStyles.statCard} />
              <DevelopGoalBar label={i18n('Develop today problems')} cur={devCtx.current.todayProblems} goal={devCtx.current.dailyProblemGoal} barColor={themeStyles.statProblem} />
              {devCtx.current.goalsMet ? (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 8,
                  marginTop: 4,
                  paddingTop: 6,
                  borderTop: `1px solid ${themeStyles.borderSecondary}`,
                }}
                >
                  <span
                    title={i18n('Develop editor goals complete')}
                    aria-label={i18n('Develop editor goals complete')}
                    style={{
                      color: themeStyles.success,
                      fontSize: 15,
                      fontWeight: 700,
                      lineHeight: 1,
                      cursor: 'default',
                      userSelect: 'none',
                    }}
                  >
                    ✓
                  </span>
                  {devCtx.othersIncomplete.length > 0 ? (
                    <button
                      type="button"
                      title={i18n('Develop editor switch other base')}
                      aria-label={i18n('Develop editor switch other base')}
                      onClick={() => setDevelopSwitchModalOpen(true)}
                      style={{
                        flexShrink: 0,
                        width: 26,
                        height: 26,
                        padding: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 15,
                        lineHeight: 1,
                        borderRadius: 6,
                        border: `1px solid ${themeStyles.borderSecondary}`,
                        background: themeStyles.accent,
                        color: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      →
                    </button>
                  ) : (
                    <span
                      title={i18n('Develop editor all pool goals met')}
                      aria-label={i18n('Develop editor all pool goals met')}
                      style={{ fontSize: 11, color: themeStyles.textTertiary, cursor: 'default', userSelect: 'none' }}
                    >
                      ○
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ) : null;

          const developSessionStrip = showDevelopSessionStripUi && developSessionParamFromUrl ? (
            <div
              style={{
                flexShrink: 0,
                padding: isMobile ? '6px 10px 8px' : '10px 16px 12px',
                borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                backgroundColor: themeStyles.bgSecondary,
                display: 'flex',
                flexDirection: 'column',
                gap: isMobile ? '6px' : '8px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
                <span style={{ fontSize: isMobile ? '12px' : '13px', fontWeight: 600, color: themeStyles.textPrimary }}>
                  {i18n('Develop session contribution')}
                </span>
                <button
                  type="button"
                  title={i18n('Develop editor end session')}
                  aria-label={i18n('Develop editor end session')}
                  disabled={developSettleBusy}
                  onClick={async () => {
                    const sid = developSessionParamFromUrl;
                    if (!sid) return;
                    const d = (window as any).UiContext?.domainId || 'system';
                    setDevelopSettleBusy(true);
                    try {
                      const res: any = await request.post(`/d/${d}/session/develop/settle`, { sessionId: sid });
                      if (res?.redirect) {
                        window.location.href = res.redirect;
                        return;
                      }
                      Notification.error(i18n('Develop settle failed'));
                    } catch (e: any) {
                      Notification.error(e?.message || i18n('Develop settle failed'));
                    } finally {
                      setDevelopSettleBusy(false);
                    }
                  }}
                  style={{
                    flexShrink: 0,
                    padding: isMobile ? '6px 10px' : '4px 12px',
                    fontSize: 11,
                    fontWeight: 600,
                    lineHeight: 1.2,
                    borderRadius: 6,
                    border: `1px solid ${themeStyles.borderSecondary}`,
                    background: themeStyles.bgButton,
                    color: themeStyles.textPrimary,
                    cursor: developSettleBusy ? 'wait' : 'pointer',
                    opacity: developSettleBusy ? 0.75 : 1,
                  }}
                >
                  {developSettleBusy ? '…' : i18n('Develop editor end session')}
                </button>
              </div>
              {developSessionElapsedText ? (
                <div style={{ fontSize: 10, color: themeStyles.textSecondary }}>
                  {i18n('Develop session elapsed label')}
                  {` ${developSessionElapsedText}`}
                </div>
              ) : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: isMobile ? '8px 12px' : '12px 16px', alignItems: 'center' }}>
                <Stat label={i18n('Nodes')} value={formatNum(developSessionEditTotals.nodes)} color={themeStyles.statNode} />
                <Stat label={i18n('Cards')} value={formatNum(developSessionEditTotals.cards)} color={themeStyles.statCard} />
                <Stat label={i18n('Problems')} value={formatNum(developSessionEditTotals.problems)} color={themeStyles.statProblem} />
              </div>
            </div>
          ) : null;

          const showDevelopPoolRow = !!(devCtx && editorDevelopSessionKindFromUi !== 'outline_node');
          const showTodayContributionRow = !showDevelopPoolRow
            && !onDevelopEditorPath
            && !(showDevelopSessionStripUi && editorDevelopSessionKindFromUi === 'outline_node');

          return (
            <>
              {developSessionStrip}
              {showDevelopPoolRow ? (
                <div
                  style={{
                    flexShrink: 0,
                    padding: isMobile ? '4px 8px 6px' : '6px 12px 8px',
                    borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                    backgroundColor: themeStyles.bgSecondary,
                  }}
                >
                  {developPoolCardFullWidth}
                </div>
              ) : (showTodayContributionRow ? (
                <div
                  style={{
                    flexShrink: 0,
                    padding: isMobile ? '6px 10px 8px' : '12px 16px',
                    borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                    backgroundColor: themeStyles.bgSecondary,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: isMobile ? '6px' : '10px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
                    <span style={{ fontSize: isMobile ? '12px' : '13px', fontWeight: 600, color: themeStyles.textPrimary }}>
                      {i18n('Today\'s contribution')}
                    </span>
                    {contributionLink && (
                      <a href={contributionLink} style={{ fontSize: isMobile ? '11px' : '12px', color: themeStyles.accent, textDecoration: 'none' }}>
                        {i18n('View all')} →
                      </a>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: isMobile ? '8px' : '12px', flexWrap: 'wrap' }}>
                    <div style={cardStyle}>
                      <div style={{ fontSize: isMobile ? '10px' : '11px', color: themeStyles.textSecondary, marginBottom: isMobile ? '4px' : '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        {i18n('Total today (all domains)')}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: isMobile ? '8px 12px' : '12px 16px', alignItems: 'center' }}>
                        <Stat label={i18n('Nodes')} value={formatNum(todayAll.nodes)} color={themeStyles.statNode} />
                        <Stat label={i18n('Cards')} value={formatNum(todayAll.cards)} color={themeStyles.statCard} />
                        <Stat label={i18n('Problems')} value={formatNum(todayAll.problems)} color={themeStyles.statProblem} />
                        <Stat label={i18n('Chars')} value={formatNum(chars(todayAll))} color={themeStyles.textSecondary} />
                      </div>
                    </div>
                    <div style={cardStyle}>
                      <div style={{ fontSize: isMobile ? '10px' : '11px', color: themeStyles.textSecondary, marginBottom: isMobile ? '4px' : '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        {i18n('This domain today')}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: isMobile ? '8px 12px' : '12px 16px', alignItems: 'center' }}>
                        <Stat label={i18n('Nodes')} value={formatNum(todayContribution.nodes)} color={themeStyles.statNode} />
                        <Stat label={i18n('Cards')} value={formatNum(todayContribution.cards)} color={themeStyles.statCard} />
                        <Stat label={i18n('Problems')} value={formatNum(todayContribution.problems)} color={themeStyles.statProblem} />
                        <Stat label={i18n('Chars')} value={formatNum(chars(todayContribution))} color={themeStyles.textSecondary} />
                      </div>
                    </div>
                  </div>
                </div>
              ) : null)}
              {developSwitchModalOpen && devCtx && editorDevelopSessionKindFromUi !== 'outline_node' && devCtx.othersIncomplete.length > 0 ? (
                <>
                  <div
                    role="presentation"
                    style={{
                      position: 'fixed',
                      inset: 0,
                      zIndex: 12000,
                      background: 'rgba(0,0,0,0.45)',
                    }}
                    onClick={() => setDevelopSwitchModalOpen(false)}
                  />
                  <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={i18n('Develop editor switch modal title')}
                    style={{
                      position: 'fixed',
                      left: '50%',
                      top: '50%',
                      transform: 'translate(-50%, -50%)',
                      zIndex: 12001,
                      width: 'min(520px, calc(100vw - 24px))',
                      maxHeight: 'min(80vh, 640px)',
                      overflow: 'auto',
                      background: themeStyles.bgPrimary,
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: 12,
                      boxShadow: theme === 'dark' ? '0 12px 40px rgba(0,0,0,0.5)' : '0 8px 32px rgba(0,0,0,0.12)',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ padding: 16, borderBottom: `1px solid ${themeStyles.borderPrimary}` }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: themeStyles.textPrimary }}>{i18n('Develop editor switch modal title')}</div>
                      <div style={{ fontSize: 12, color: themeStyles.textSecondary, marginTop: 6 }}>{i18n('Develop editor switch modal hint')}</div>
                    </div>
                    <div style={{ padding: 12 }}>
                      {devCtx.othersIncomplete.map((row) => (
                        <button
                          key={`${row.baseDocId}-${row.branch}`}
                          type="button"
                          onClick={() => { window.location.href = row.editorUrl; }}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            padding: '8px 10px',
                            marginBottom: 6,
                            borderRadius: 8,
                            border: `1px solid ${themeStyles.borderSecondary}`,
                            background: themeStyles.bgSecondary,
                            color: themeStyles.textPrimary,
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
                            {row.baseTitle}
                            <span style={{ color: themeStyles.textSecondary, fontWeight: 500 }}>{` · ${row.branch}`}</span>
                          </div>
                          <div style={{ fontSize: 10, color: themeStyles.textSecondary, lineHeight: 1.45 }}>
                            <span style={{ color: themeStyles.statNode }}>{i18n('Develop today nodes')} {developGoalCaption(row.todayNodes, row.dailyNodeGoal)}</span>
                            <span style={{ margin: '0 6px', color: themeStyles.textTertiary }}>|</span>
                            <span style={{ color: themeStyles.statCard }}>{i18n('Develop today cards')} {developGoalCaption(row.todayCards, row.dailyCardGoal)}</span>
                            <span style={{ margin: '0 6px', color: themeStyles.textTertiary }}>|</span>
                            <span style={{ color: themeStyles.statProblem }}>{i18n('Develop today problems')} {developGoalCaption(row.todayProblems, row.dailyProblemGoal)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                    <div style={{ padding: 12, borderTop: `1px solid ${themeStyles.borderPrimary}` }}>
                      <button
                        type="button"
                        onClick={() => setDevelopSwitchModalOpen(false)}
                        style={{
                          width: '100%',
                          padding: 10,
                          borderRadius: 8,
                          border: `1px solid ${themeStyles.borderSecondary}`,
                          background: 'transparent',
                          color: themeStyles.textPrimary,
                          cursor: 'pointer',
                        }}
                      >
                        {i18n('Cancel')}
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
            </>
          );
        })()}

        {/* Editor + problems */}
        <div 
          id="editor-container"
          ref={editorContainerRef}
          style={{ flex: 1, minHeight: 0, padding: '0', overflow: 'hidden', position: 'relative', backgroundColor: themeStyles.bgPrimary, display: 'flex', flexDirection: 'column' }}
        >
          {/* Markdown editor */}
          <div style={{ flex: 1, minHeight: 0 }}>
            {selectedFile && selectedFile.type === 'card' ? (
              <div 
                id={`editor-wrapper-${selectedFile.id}`}
                style={{ width: '100%', height: '100%', position: 'relative' }}
              >
                <textarea
                  key={selectedFile.id}
                  ref={editorRef}
                  defaultValue={fileContent}
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    outline: 'none',
                    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, "source-code-pro", monospace',
                    fontSize: '14px',
                    lineHeight: '1.6',
                    resize: 'none',
                    padding: '16px',
                    boxSizing: 'border-box',
                    backgroundColor: themeStyles.bgPrimary,
                    color: themeStyles.textPrimary,
                  }}
                />
              </div>
            ) : selectedFile?.type === 'node' && selectedFile.nodeId && docId ? (
              (() => {
                const branch = (window as any).UiContext?.currentBranch || 'main';
                const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                const node = base.nodes.find((n: BaseNode) => n.id === selectedFile!.nodeId);
                const nodeId = selectedFile!.nodeId!;
                const aggregatedFiles = getAggregatedFilesForNode(nodeId, base, nodeCardsMap);
                const nodeFileDownloadUrl = (nid: string, filename: string) => getBaseUrl(`/${docId}/node/${nid}/file/${encodeURIComponent(filename)}?branch=${encodeURIComponent(branch)}`, docId);
                const cardFileDownloadUrl = (cardId: string, filename: string) => getBaseUrl(`/${docId}/card/${cardId}/file/${encodeURIComponent(filename)}`, docId);
                const downloadUrlFor = (row: AggregatedFileItem) => row.sourceType === 'card' && row.sourceCardId ? cardFileDownloadUrl(row.sourceCardId, row.name) : nodeFileDownloadUrl(row.sourceNodeId, row.name);
                const previewUrlFor = (row: AggregatedFileItem) => {
                  const u = downloadUrlFor(row);
                  return u + (u.includes('?') ? '&noDisposition=1' : '?noDisposition=1');
                };
                const filesListUrl = getBaseUrl(`/${docId}/node/${nodeId}/files?branch=${encodeURIComponent(branch)}`, docId);
                const formatSize = (bytes: number) => {
                  if (bytes < 1024) return `${bytes} B`;
                  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                };
                const formatTime = (v?: Date | string) => {
                  if (!v) return '—';
                  const d = typeof v === 'string' ? new Date(v) : v;
                  return d.toLocaleString();
                };
                const toggleSort = (col: 'name' | 'size' | 'time' | 'source') => {
                  if (nodeFileListSortBy === col) setNodeFileListSortOrder(o => o === 'asc' ? 'desc' : 'asc');
                  else { setNodeFileListSortBy(col); setNodeFileListSortOrder('asc'); }
                };
                const sourceSortKey = (row: AggregatedFileItem) =>
                  row.sourceType === 'self' ? '0' : row.sourceType === 'node' ? `1${row.sourceNodeText || row.sourceNodeId}` : `2${row.sourceCardTitle || row.sourceCardId || ''}`;
                const timeMs = (row: AggregatedFileItem) => {
                  const v = row.lastModified;
                  if (!v) return 0;
                  return (typeof v === 'string' ? new Date(v) : v).getTime();
                };
                const sortedFiles = [...aggregatedFiles].sort((a, b) => {
                  const ord = nodeFileListSortOrder === 'asc' ? 1 : -1;
                  if (nodeFileListSortBy === 'name') return ord * (a.name.localeCompare(b.name, undefined, { numeric: true }));
                  if (nodeFileListSortBy === 'size') return ord * (a.size - b.size);
                  if (nodeFileListSortBy === 'time') return ord * (timeMs(a) - timeMs(b));
                  return ord * sourceSortKey(a).localeCompare(sourceSortKey(b));
                });
                const thStyle = () => ({
                  textAlign: 'left' as const,
                  padding: '8px 12px',
                  color: themeStyles.textSecondary,
                  fontWeight: 600,
                  cursor: 'pointer' as const,
                  userSelect: 'none' as const,
                  whiteSpace: 'nowrap' as const,
                });
                const sortIndicator = (col: 'name' | 'size' | 'time' | 'source') =>
                  nodeFileListSortBy === col ? (nodeFileListSortOrder === 'asc' ? ' ↑' : ' ↓') : '';
                const rowKey = (row: AggregatedFileItem, idx: number) => `${row.sourceType}-${row.sourceNodeId}-${row.sourceCardId || ''}-${row.name}-${idx}`;
                const selectedRows = sortedFiles.filter((row, idx) => selectedFileListRowKeys.has(rowKey(row, idx)));
                const toggleEditMode = () => {
                  setNodeFileListEditMode((v) => !v);
                  setSelectedFileListRowKeys(new Set());
                };
                const toggleRow = (key: string) => {
                  setSelectedFileListRowKeys((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  });
                };
                const toggleSelectAll = () => {
                  if (selectedFileListRowKeys.size >= sortedFiles.length) setSelectedFileListRowKeys(new Set());
                  else setSelectedFileListRowKeys(new Set(sortedFiles.map((row, idx) => rowKey(row, idx))));
                };
                const handleBatchDelete = async () => {
                  try {
                    for (const row of selectedRows) {
                      const deleteUrl = row.sourceType === 'self' ? filesListUrl : row.sourceType === 'card' && row.sourceCardId ? getBaseUrl(`/${docId}/card/${row.sourceCardId}/files`, docId) : getBaseUrl(`/${docId}/node/${row.sourceNodeId}/files?branch=${encodeURIComponent(branch)}`, docId);
                      await request.post(deleteUrl, { files: [row.name] });
                    }
                    Notification.success(i18n('Deleted.'));
                    await refetchEditorData();
                    setSelectedFileListRowKeys(new Set());
                  } catch (err: any) {
                    Notification.error(err?.message || i18n('Delete failed.'));
                  }
                };
                const handleBatchDownload = () => {
                  selectedRows.forEach((row) => window.open(downloadUrlFor(row), '_blank'));
                  setSelectedFileListRowKeys(new Set());
                };
                const handleBatchCopyMdLinks = async () => {
                  const text = selectedRows.map((row) => `[](${previewUrlFor(row)})`).join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    Notification.success(i18n('Link copied.'));
                  } catch (e: any) {
                    Notification.error(e?.message || i18n('Copy failed.'));
                  }
                };
                const toFullUrl = (url: string) => (url.startsWith('http') ? url : `${window.location.origin}${url}`);
                const handleBatchCopyDownloadLinks = async () => {
                  const text = selectedRows.map((row) => toFullUrl(downloadUrlFor(row))).join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    Notification.success(i18n('Link copied.'));
                  } catch (e: any) {
                    Notification.error(e?.message || i18n('Copy failed.'));
                  }
                };
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                    <div style={{
                      padding: '12px 16px',
                      borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexShrink: 0,
                      backgroundColor: themeStyles.bgSecondary,
                      flexWrap: 'wrap',
                      gap: 8,
                    }}>
                      <span style={{ fontWeight: 600, color: themeStyles.textPrimary, fontSize: '14px' }}>
                        {node?.text || selectedFile.nodeId} — {i18n('Files')}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {nodeFileListEditMode && selectedRows.length > 0 && (
                          <>
                            <button type="button" style={{ padding: '6px 10px', fontSize: '12px', border: `1px solid ${themeStyles.borderPrimary}`, borderRadius: '4px', background: themeStyles.bgButton, color: themeStyles.textPrimary, cursor: 'pointer' }} onClick={handleBatchDelete}>{i18n('Delete selected')}</button>
                            <button type="button" style={{ padding: '6px 10px', fontSize: '12px', border: `1px solid ${themeStyles.borderPrimary}`, borderRadius: '4px', background: themeStyles.bgButton, color: themeStyles.textPrimary, cursor: 'pointer' }} onClick={handleBatchDownload}>{i18n('Download selected')}</button>
                            <button type="button" style={{ padding: '6px 10px', fontSize: '12px', border: `1px solid ${themeStyles.borderPrimary}`, borderRadius: '4px', background: themeStyles.bgButton, color: themeStyles.textPrimary, cursor: 'pointer' }} onClick={handleBatchCopyMdLinks}>{i18n('Copy md links')}</button>
                            <button type="button" style={{ padding: '6px 10px', fontSize: '12px', border: `1px solid ${themeStyles.borderPrimary}`, borderRadius: '4px', background: themeStyles.bgButton, color: themeStyles.textPrimary, cursor: 'pointer' }} onClick={handleBatchCopyDownloadLinks}>{i18n('Copy download links')}</button>
                          </>
                        )}
                        <button
                          type="button"
                          style={{
                            padding: '6px 12px',
                            fontSize: '13px',
                            border: `1px solid ${themeStyles.borderPrimary}`,
                            borderRadius: '4px',
                            background: themeStyles.bgButton,
                            color: themeStyles.textPrimary,
                            cursor: 'pointer',
                          }}
                          onClick={() => {
                            pendingNodeUploadRef.current = { nodeId };
                            cardFileInputRef.current?.click();
                          }}
                        >
                          {i18n('Upload')}
                        </button>
                        <button
                          type="button"
                          style={{
                            padding: '6px 12px',
                            fontSize: '13px',
                            border: `1px solid ${themeStyles.borderPrimary}`,
                            borderRadius: '4px',
                            background: nodeFileListEditMode ? themeStyles.bgButtonActive : themeStyles.bgButton,
                            color: themeStyles.textPrimary,
                            cursor: 'pointer',
                          }}
                          onClick={toggleEditMode}
                        >
                          {nodeFileListEditMode ? i18n('Done') : i18n('Edit')}
                        </button>
                      </div>
                    </div>
                    <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
                      {aggregatedFiles.length === 0 ? (
                        <div style={{ color: themeStyles.textSecondary, fontSize: '14px', textAlign: 'center', padding: '24px' }}>
                          {i18n('There are no files currently.')}
                        </div>
                      ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>
                          <thead>
                            <tr style={{ borderBottom: `2px solid ${themeStyles.borderPrimary}` }}>
                              {nodeFileListEditMode && (
                                <th style={{ width: 36, minWidth: 36, padding: '8px 4px', textAlign: 'center', color: themeStyles.textSecondary }}>
                                  <input type="checkbox" checked={sortedFiles.length > 0 && selectedFileListRowKeys.size >= sortedFiles.length} onChange={toggleSelectAll} title={i18n('Select all')} />
                                </th>
                              )}
                              <th style={{ ...thStyle(), width: nodeFileListEditMode ? '40%' : '44%', minWidth: 0 }} onClick={() => toggleSort('name')} title={i18n('Sort')}>{i18n('Filename')}{sortIndicator('name')}</th>
                              <th style={{ ...thStyle(), width: '12%', minWidth: 0 }} onClick={() => toggleSort('size')} title={i18n('Sort')}>{i18n('Size')}{sortIndicator('size')}</th>
                              <th style={{ ...thStyle(), width: '22%', minWidth: 0 }} onClick={() => toggleSort('time')} title={i18n('Sort')}>{i18n('Time')}{sortIndicator('time')}</th>
                              <th style={{ ...thStyle(), width: '22%', minWidth: 0 }} onClick={() => toggleSort('source')} title={i18n('Sort')}>{i18n('Source')}{sortIndicator('source')}</th>
                              {isMobile && <th style={{ width: 44, minWidth: 44, padding: '8px 4px', color: themeStyles.textSecondary }} aria-label={i18n('Actions')} />}
                            </tr>
                          </thead>
                          <tbody>
                            {sortedFiles.map((row, idx) => {
                              const deleteUrl = row.sourceType === 'self'
                                ? filesListUrl
                                : row.sourceType === 'card' && row.sourceCardId
                                  ? getBaseUrl(`/${docId}/card/${row.sourceCardId}/files`, docId)
                                  : getBaseUrl(`/${docId}/node/${row.sourceNodeId}/files?branch=${encodeURIComponent(branch)}`, docId);
                              const key = rowKey(row, idx);
                              return (
                              <tr
                                key={key}
                                style={{ borderBottom: `1px solid ${themeStyles.borderSecondary}` }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setFileListRowMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    downloadUrl: downloadUrlFor(row),
                                    deleteUrl,
                                    filename: row.name,
                                  });
                                }}
                              >
                                {nodeFileListEditMode && (
                                  <td style={{ width: 36, minWidth: 36, padding: '8px 4px', textAlign: 'center', verticalAlign: 'middle' }} onClick={(e) => e.stopPropagation()}>
                                    <input type="checkbox" checked={selectedFileListRowKeys.has(key)} onChange={() => toggleRow(key)} />
                                  </td>
                                )}
                                <td style={{ padding: '8px 12px', overflow: 'hidden', minWidth: 0 }}>
                                  <a
                                    href={previewUrlFor(row)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={row.name}
                                    style={{ color: themeStyles.accent, textDecoration: 'none', cursor: 'pointer', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    onClick={(ev) => handleFilePreviewClick(ev, previewUrlFor(row), row.name, row.size)}
                                  >
                                    {row.name}
                                  </a>
                                </td>
                                {isMobile && (
                                  <td style={{ width: 44, minWidth: 44, padding: '8px 4px', verticalAlign: 'middle', textAlign: 'center' }}>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                        setFileListRowMenu({
                                          x: Math.min(rect.left, window.innerWidth - 160),
                                          y: rect.bottom + 4,
                                          downloadUrl: downloadUrlFor(row),
                                          deleteUrl,
                                          filename: row.name,
                                        });
                                      }}
                                      style={{
                                        width: 36,
                                        height: 36,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        border: 'none',
                                        background: 'transparent',
                                        color: themeStyles.textSecondary,
                                        cursor: 'pointer',
                                        fontSize: '18px',
                                        borderRadius: '4px',
                                      }}
                                      aria-label={i18n('Actions')}
                                    >
                                      ⋯
                                    </button>
                                  </td>
                                )}
                                <td style={{ padding: '8px 12px', color: themeStyles.textSecondary, overflow: 'hidden', minWidth: 0 }}>{formatSize(row.size)}</td>
                                <td style={{ padding: '8px 12px', color: themeStyles.textSecondary, overflow: 'hidden', minWidth: 0 }}>{formatTime(row.lastModified)}</td>
                                <td style={{ padding: '8px 12px', color: themeStyles.textSecondary, fontSize: '12px', overflow: 'hidden', minWidth: 0 }}>
                                  {row.sourceType === 'self' ? (
                                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i18n('This node')}</span>
                                  ) : row.sourceType === 'node' ? (
                                    <button
                                      type="button"
                                      title={`${i18n('Node')}: ${row.sourceNodeText || row.sourceNodeId}`}
                                      style={{ background: 'none', border: 'none', padding: 0, color: themeStyles.accent, cursor: 'pointer', textDecoration: 'underline', fontSize: '12px', display: 'block', width: '100%', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}
                                      onClick={() => {
                                        const target = fileTree.find((f) => f.type === 'node' && f.nodeId === row.sourceNodeId);
                                        if (target) handleSelectFile(target);
                                      }}
                                    >
                                      {i18n('Node')}: {row.sourceNodeText || row.sourceNodeId}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      title={`${i18n('Card')}: ${row.sourceCardTitle || row.sourceCardId}`}
                                      style={{ background: 'none', border: 'none', padding: 0, color: themeStyles.accent, cursor: 'pointer', textDecoration: 'underline', fontSize: '12px', display: 'block', width: '100%', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}
                                      onClick={() => {
                                        const target = fileTree.find((f) => f.type === 'card' && f.cardId === row.sourceCardId);
                                        if (target) handleSelectFile(target);
                                      }}
                                    >
                                      {i18n('Card')}: {row.sourceCardTitle || row.sourceCardId}
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ); })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: themeStyles.textSecondary,
                fontSize: '14px',
              }}>
                请从左侧选择一个卡片
              </div>
            )}
          </div>

          {!editorAiHidden && (
            <>
              {aiBottomOpen && (
                <div
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    setIsResizingAiPanel(true);
                    aiResizeStartYRef.current = e.clientY;
                    aiResizeStartHeightRef.current = aiPanelHeight;
                  }}
                  style={{
                    height: '8px',
                    flexShrink: 0,
                    cursor: 'row-resize',
                    touchAction: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxSizing: 'border-box',
                    borderTop: `1px solid ${aiTerminalStyles.tabBorder}`,
                    background: isResizingAiPanel ? aiTerminalStyles.resizeActive : aiTerminalStyles.tabBarBg,
                  }}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="拖拽调整终端与编辑器高度比例"
                >
                  <div
                    style={{
                      width: '40px',
                      height: '3px',
                      borderRadius: '2px',
                      background: isResizingAiPanel ? aiTerminalStyles.resizeActive : aiTerminalStyles.resizeDefault,
                      opacity: isResizingAiPanel ? 1 : 0.55,
                      pointerEvents: 'none',
                    }}
                  />
                </div>
              )}
              {aiBottomOpen ? (
                <div
                  style={{
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    borderTop: 'none',
                    backgroundColor: aiTerminalStyles.shellBg,
                    overflow: 'hidden',
                    fontFamily: aiTerminalStyles.mono,
                    height: aiPanelHeight,
                    minHeight: AI_TERMINAL_MIN_H,
                    maxHeight: aiPanelMaxHeight,
                  }}
                >
                  <div
                    style={{
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'stretch',
                      justifyContent: 'space-between',
                      minHeight: 28,
                      backgroundColor: aiTerminalStyles.tabBarBg,
                      borderBottom: `1px solid ${aiTerminalStyles.tabBorder}`,
                      fontSize: '12px',
                      color: aiTerminalStyles.textDim,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0 10px',
                        backgroundColor: aiTerminalStyles.tabActiveBg,
                        borderTop: `2px solid ${aiTerminalStyles.tabActiveTop}`,
                        borderRight: `1px solid ${aiTerminalStyles.tabBorder}`,
                        color: aiTerminalStyles.text,
                        fontWeight: 500,
                        marginBottom: -1,
                        paddingBottom: 1,
                      }}
                    >
                      AI
                    </div>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      onClick={() => setAiBottomOpen(false)}
                      style={{
                        background: 'none',
                        border: 'none',
                        borderLeft: `1px solid ${aiTerminalStyles.tabBorder}`,
                        cursor: 'pointer',
                        color: aiTerminalStyles.textDim,
                        fontSize: '14px',
                        lineHeight: 1,
                        padding: '0 10px',
                        fontFamily: 'inherit',
                      }}
                      aria-label="收起面板"
                      title="收起"
                    >
                      ▼
                    </button>
                  </div>
                  <div
                    ref={chatMessagesContainerRef}
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflowY: 'auto',
                      padding: '8px 10px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      backgroundColor: aiTerminalStyles.shellBg,
                      fontSize: '12px',
                      lineHeight: 1.5,
                    }}
                  >
                    {chatMessages.map((msg, index) => {
                      if (msg.role === 'operation') {
                        return (
                          <div key={index} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
                            <div
                              onClick={() => {
                                setChatMessages((prev) => {
                                  const next = [...prev];
                                  next[index] = { ...next[index], isExpanded: !next[index].isExpanded };
                                  return next;
                                });
                              }}
                              style={{
                                padding: '4px 8px',
                                background: aiTerminalStyles.operationBg,
                                border: `1px solid ${aiTerminalStyles.operationBorder}`,
                                color: aiTerminalStyles.operationText,
                                fontSize: '12px',
                                cursor: 'pointer',
                                userSelect: 'none',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                              }}
                            >
                              <span style={{ color: aiTerminalStyles.promptAi }}>[op]</span>
                              <span style={{ flex: 1 }}>{msg.content}</span>
                              <span style={{ color: aiTerminalStyles.textDim, flexShrink: 0 }}>
                                {msg.isExpanded ? '▼' : '▶'}
                              </span>
                            </div>
                            {msg.isExpanded && msg.operations && (
                              <div
                                style={{
                                  marginTop: '4px',
                                  padding: '6px 8px',
                                  background: aiTerminalStyles.tabBarBg,
                                  border: `1px solid ${aiTerminalStyles.tabBorder}`,
                                  fontSize: '11px',
                                  fontFamily: 'inherit',
                                  overflowX: 'auto',
                                  color: aiTerminalStyles.text,
                                }}
                              >
                                <ol style={{ margin: '4px 0 0 18px', padding: 0, lineHeight: 1.45 }}>
                                  {msg.operations.map((op: any, oi: number) => (
                                    <li key={oi}>{summarizeAiOperationOneLine(op)}</li>
                                  ))}
                                </ol>
                              </div>
                            )}
                          </div>
                        );
                      }
                      return (
                        <div
                          key={index}
                          style={{
                            display: 'flex',
                            flexDirection: 'row',
                            alignItems: 'flex-start',
                            gap: '6px',
                            maxWidth: '100%',
                          }}
                        >
                          <span
                            style={{
                              flexShrink: 0,
                              color: msg.role === 'user' ? aiTerminalStyles.promptUser : aiTerminalStyles.promptAi,
                              userSelect: 'none',
                            }}
                          >
                            {msg.role === 'user' ? '$' : '>'}
                          </span>
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              color: aiTerminalStyles.text,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {msg.role === 'user' && msg.references && msg.references.length > 0 && (
                              <div
                                style={{
                                  marginBottom: '4px',
                                  color: aiTerminalStyles.textDim,
                                  fontSize: '11px',
                                }}
                              >
                                {msg.references.map((ref, refIndex) => (
                                  <span key={refIndex}>
                                    {refIndex > 0 ? ' ' : ''}@{ref.name}
                                  </span>
                                ))}
                              </div>
                            )}
                            {msg.content}
                            {msg.role === 'assistant' && msg.streamOps?.receiving && (
                              <div
                                style={{
                                  marginTop: '6px',
                                  padding: '6px 8px',
                                  borderRadius: '4px',
                                  border: `1px solid ${aiTerminalStyles.tabBorder}`,
                                  backgroundColor: aiTerminalStyles.tabBarBg,
                                  fontSize: '11px',
                                  color: aiTerminalStyles.text,
                                }}
                              >
                                <div style={{ color: aiTerminalStyles.operationText, fontWeight: 600, marginBottom: '4px' }}>
                                  Receiving operations…
                                </div>
                                {msg.streamOps.lines.length > 0 ? (
                                  <ol style={{ margin: '0 0 0 18px', padding: 0, color: aiTerminalStyles.text }}>
                                    {msg.streamOps.lines.map((line, li) => (
                                      <li key={`${li}-${line}`}>{line}</li>
                                    ))}
                                  </ol>
                                ) : (
                                  <div style={{ color: aiTerminalStyles.textDim, fontStyle: 'italic' }}>Waiting for operation list…</div>
                                )}
                                <div style={{ marginTop: '4px', fontSize: '10px', color: aiTerminalStyles.textDim }}>
                                  {msg.streamOps.charCount} characters in plan
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {isChatLoading && (
                      <div style={{ color: aiTerminalStyles.textDim, fontSize: '12px' }}>
                        <span style={{ color: aiTerminalStyles.promptAi }}>...</span> Processing
                      </div>
                    )}
                    <div ref={chatMessagesEndRef} />
                  </div>
                  <div
                    style={{
                      padding: '4px 10px 6px 7px',
                      borderTop: `1px solid ${aiTerminalStyles.tabBorder}`,
                      borderLeft: `3px solid ${aiTerminalStyles.tabActiveTop}`,
                      backgroundColor: aiTerminalStyles.shellBg,
                      flexShrink: 0,
                      fontFamily: aiTerminalStyles.mono,
                    }}
                  >
                    {chatInputReferences.length > 0 && (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: '6px',
                          marginBottom: '4px',
                          fontSize: '11px',
                          color: aiTerminalStyles.textDim,
                        }}
                      >
                        <span style={{ userSelect: 'none' }}>#</span>
                        {chatInputReferences.map((ref, index) => (
                          <span key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                            <span style={{ color: aiTerminalStyles.operationText }}>@{ref.name}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const placeholder = '@' + ref.name;
                                const { startIndex, endIndex } = ref;
                                const newText = chatInput.slice(0, startIndex) + chatInput.slice(endIndex);
                                setChatInputReferences((prev) =>
                                  prev
                                    .filter((_, i) => i !== index)
                                    .map((r) => {
                                      if (r.startIndex > startIndex) {
                                        return {
                                          ...r,
                                          startIndex: r.startIndex - placeholder.length,
                                          endIndex: r.endIndex - placeholder.length,
                                        };
                                      }
                                      return r;
                                    }),
                                );
                                setChatInput(newText);
                              }}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: 0,
                                color: aiTerminalStyles.textDim,
                                fontFamily: 'inherit',
                                fontSize: '11px',
                                lineHeight: 1,
                              }}
                              title="移除引用"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'stretch',
                        gap: 3,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: '11px',
                          lineHeight: '15px',
                          userSelect: 'none',
                          opacity: 0.92,
                          minWidth: 0,
                        }}
                        title={editorShellPath}
                      >
                        <span
                          style={{
                            color: aiTerminalStyles.promptShellPath,
                            flexShrink: 0,
                          }}
                        >
                          $
                        </span>
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            color: aiTerminalStyles.promptShellPath,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {editorShellPath}
                        </span>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          minHeight: 22,
                        }}
                      >
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            flexShrink: 0,
                            maxWidth: '52%',
                            fontSize: '12px',
                            lineHeight: '22px',
                            userSelect: 'none',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            fontFamily: aiTerminalStyles.mono,
                          }}
                          title={aiTerminalInputPromptParts.full}
                        >
                          <span style={{ color: aiTerminalStyles.promptShellUser, flexShrink: 0 }}>
                            {aiTerminalInputPromptParts.uname}
                          </span>
                          <span
                            style={{
                              color: aiTerminalStyles.promptShellSep,
                              flexShrink: 0,
                              paddingLeft: 3,
                              paddingRight: 3,
                            }}
                          >
                            @
                          </span>
                          <span
                            style={{
                              color: aiTerminalStyles.promptShellHost,
                              flexShrink: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {aiTerminalInputPromptParts.domain}
                          </span>
                          <span style={{ color: aiTerminalStyles.promptShellSep, flexShrink: 0 }}>:</span>
                        </span>
                        <input
                          type="text"
                          value={chatInput}
                          onChange={(e) => {
                          const newText = e.target.value;
                          const oldText = chatInput;
                          if (newText.length !== oldText.length) {
                            const diff = newText.length - oldText.length;
                            const selectionStart = e.currentTarget.selectionStart ?? 0;
                            setChatInputReferences((prev) =>
                              prev
                                .map((ref) => {
                                  if (selectionStart <= ref.startIndex) {
                                    return {
                                      ...ref,
                                      startIndex: ref.startIndex + diff,
                                      endIndex: ref.endIndex + diff,
                                    };
                                  }
                                  if (selectionStart > ref.startIndex && selectionStart < ref.endIndex) {
                                    return null as any;
                                  }
                                  return ref;
                                })
                                .filter((ref) => ref != null && ref.startIndex >= 0 && ref.endIndex <= newText.length),
                            );
                          }
                          setChatInput(newText);
                          }}
                          onPaste={handleAIChatPaste}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAIChatSend();
                            }
                          }}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={isChatLoading}
                          aria-label="终端输入"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            padding: 0,
                            margin: 0,
                            border: 'none',
                            outline: 'none',
                            boxShadow: 'none',
                            fontSize: '12px',
                            lineHeight: '22px',
                            fontFamily: 'inherit',
                            backgroundColor: 'transparent',
                            color: aiTerminalStyles.text,
                            caretColor: aiTerminalStyles.promptShellHost,
                            WebkitAppearance: 'none' as any,
                            appearance: 'none' as any,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAiBottomOpen(true)}
                  style={{
                    flexShrink: 0,
                    width: '100%',
                    padding: '4px 10px',
                    border: 'none',
                    borderTop: `1px solid ${aiTerminalStyles.tabBorder}`,
                    backgroundColor: aiTerminalStyles.tabBarBg,
                    color: aiTerminalStyles.textDim,
                    fontSize: '12px',
                    cursor: 'pointer',
                    fontWeight: 500,
                    textAlign: 'left',
                    fontFamily: aiTerminalStyles.mono,
                  }}
                >
                  ▲ AI
                </button>
              )}
            </>
          )}

        </div>
      </div>

      {(() => {
        /* problems sidebar only; AI is in editor bottom panel */
        const problemsBody = (
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', minHeight: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '8px' }}>
              <button
                type="button"
                onClick={() => handleAddBlankProblem()}
                title="添加练习题"
                aria-label="添加练习题"
                style={{
                  width: '28px',
                  height: '28px',
                  padding: 0,
                  lineHeight: '26px',
                  fontSize: '18px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: `1px solid ${themeStyles.borderPrimary}`,
                  background: themeStyles.bgSecondary,
                  color: themeStyles.accent,
                  cursor: 'pointer',
                }}
              >
                +
              </button>
            </div>
            {(() => {
              const card = getSelectedCard();
              const problems = card?.problems || [];
              const cardIdStr = String(selectedFile?.cardId || '');
              const _ = originalProblemsVersion;
              const originalProblems = originalProblemsRef.current.get(cardIdStr) || new Map();
              if (!problems.length) {
                return null;
              }
              return (
                <div style={{ marginBottom: '8px' }}>
                  {problems.map((p, index) => {
                    const isNew = newProblemIds.has(p.pid) || !originalProblems.has(p.pid);
                    const originalProblem = originalProblems.get(p.pid);
                    let borderColor = '#e1e4e8';
                    let borderStyle = 'solid';
                    const isEdited = editedProblemIds.has(p.pid)
                      || (originalProblem && JSON.stringify(originalProblem) !== JSON.stringify(p));
                    if (isNew) { borderColor = '#4caf50'; borderStyle = 'dashed'; }
                    else if (isEdited) { borderColor = '#ff9800'; borderStyle = 'dashed'; }
                    return (
                      <EditableProblem
                        key={p.pid}
                        problem={p}
                        index={index}
                        cardId={cardIdStr}
                        borderColor={borderColor}
                        borderStyle={borderStyle}
                        isNew={isNew}
                        isEdited={isEdited}
                        originalProblem={originalProblem}
                        docId={docId}
                        getBaseUrl={getBaseUrl}
                        themeStyles={themeStyles}
                        onUpdate={(updatedProblem) => {
                          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                          const nodeId = selectedFile?.nodeId || '';
                          const nodeCards: Card[] = nodeCardsMap[nodeId] || [];
                          const cardIndex = nodeCards.findIndex((c: Card) => sameCardDocId(c.docId, selectedFile?.cardId));
                          if (cardIndex >= 0) {
                            const existingProblems = nodeCards[cardIndex].problems || [];
                            const problemIndex = existingProblems.findIndex(prob => prob.pid === p.pid);
                            if (problemIndex >= 0) {
                              existingProblems[problemIndex] = updatedProblem;
                              nodeCards[cardIndex] = { ...nodeCards[cardIndex], problems: existingProblems };
                              (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
                              setNodeCardsMapVersion(prev => prev + 1);
                              if (isNew) setNewProblemIds(prev => new Set(prev).add(p.pid));
                              else setEditedProblemIds(prev => new Set(prev).add(p.pid));
                              if (cardIdStr) {
                                setPendingProblemCardIds(prev => { const next = new Set(prev); next.add(cardIdStr); return next; });
                                if (isNew) setPendingNewProblemCardIds(prev => { const next = new Set(prev); next.add(cardIdStr); return next; });
                                else {
                                  setPendingEditedProblemIds(prev => {
                                    const next = new Map(prev);
                                    if (!next.has(cardIdStr)) next.set(cardIdStr, new Set());
                                    next.get(cardIdStr)!.add(p.pid);
                                    return next;
                                  });
                                  setPendingNewProblemCardIds(prev => { const next = new Set(prev); next.delete(cardIdStr); return next; });
                                }
                              }
                            }
                          }
                        }}
                        onDelete={() => {
                          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                          const nodeId = selectedFile?.nodeId || '';
                          const nodeCards: Card[] = nodeCardsMap[nodeId] ? [...nodeCardsMap[nodeId]] : [];
                          const cardIndex = nodeCards.findIndex((c: Card) => sameCardDocId(c.docId, selectedFile?.cardId));
                          if (cardIndex >= 0) {
                            const existingProblems = [...(nodeCards[cardIndex].problems || [])];
                            const problemIndex = existingProblems.findIndex((prob) => prob.pid === p.pid);
                            if (problemIndex >= 0) {
                              existingProblems.splice(problemIndex, 1);
                              nodeCards[cardIndex] = { ...nodeCards[cardIndex], problems: existingProblems };
                              (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap, [nodeId]: nodeCards };
                            }
                          }
                          if (cardIdStr) {
                            setPendingProblemCardIds((prev) => { const next = new Set(prev); next.add(cardIdStr); return next; });
                          }
                          setNewProblemIds((prev) => { const next = new Set(prev); next.delete(p.pid); return next; });
                          setEditedProblemIds((prev) => { const next = new Set(prev); next.delete(p.pid); return next; });
                          setPendingNewProblemCardIds((prev) => { const next = new Set(prev); next.delete(cardIdStr); return next; });
                          setPendingEditedProblemIds((prev) => {
                            const next = new Map(prev);
                            const editedSet = next.get(cardIdStr);
                            if (editedSet) {
                              editedSet.delete(p.pid);
                              if (editedSet.size === 0) next.delete(cardIdStr);
                            }
                            return next;
                          });
                          setNodeCardsMapVersion((prev) => prev + 1);
                          setOriginalProblemsVersion((prev) => prev + 1);
                        }}
                      />
                    );
                  })}
                </div>
              );
            })()}
          </div>
        );

        return (
          <>
            {rightPanelOpen && isMobile && (
              <div
                role="presentation"
                style={{ position: 'fixed', inset: 0, zIndex: 1001, backgroundColor: 'rgba(0,0,0,0.4)' }}
                onClick={() => setRightPanelOpen(false)}
                aria-hidden
              />
            )}
            {!isMobile && rightPanelOpen && (
              <div
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsResizingProblemsPanel(true);
                  problemsResizeStartXRef.current = e.clientX;
                  problemsResizeStartWidthRef.current = problemsPanelWidth;
                }}
                style={{
                  width: '4px',
                  height: '100%',
                  alignSelf: 'stretch',
                  background: isResizingProblemsPanel ? themeStyles.accent : themeStyles.borderPrimary,
                  cursor: 'col-resize',
                  position: 'relative',
                  flexShrink: 0,
                  transition: isResizingProblemsPanel ? 'none' : 'background 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  if (!isResizingProblemsPanel) {
                    e.currentTarget.style.background = themeStyles.textSecondary;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isResizingProblemsPanel) {
                    e.currentTarget.style.background = themeStyles.borderPrimary;
                  }
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: '-2px',
                    top: 0,
                    width: '8px',
                    height: '100%',
                    cursor: 'col-resize',
                  }}
                />
              </div>
            )}

            {rightPanelOpen && (
        <div style={{
          ...(isMobile
            ? {
                position: 'fixed' as const,
                right: RIGHT_SIDE_RAIL_PX,
                top: 0,
                bottom: 0,
                width: `min(400px, calc(100vw - ${RIGHT_SIDE_RAIL_PX}px))`,
                zIndex: 1002,
                boxShadow: '-4px 0 16px rgba(0,0,0,0.15)',
                paddingTop: 'env(safe-area-inset-top, 0px)',
              }
            : {
                width: `${problemsPanelWidth}px`,
                height: '100%',
                minHeight: 0,
                alignSelf: 'stretch',
                flexShrink: 0,
                transition: isResizingProblemsPanel ? 'none' : 'width 0.3s ease',
              }),
          borderLeft: `1px solid ${themeStyles.borderPrimary}`,
          display: 'flex',
          flexDirection: 'column',
          background: themeStyles.bgPrimary,
        }}>
          {isMobile && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 10px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              backgroundColor: themeStyles.bgSecondary,
              flexShrink: 0,
            }}>
              <span style={{ fontWeight: 600, fontSize: '14px', color: themeStyles.textPrimary, flex: 1, minWidth: 0 }}>
                {showDevelopQueueInPanels && developEditorContext && developRunQueueState ? (
                  editorRightPanelTab === 'develop_queue' ? (
                    <>
                      {i18n('Develop queue tab')}
                      {developRunQueueState.currentIndex >= 0
                        ? ` ${developRunQueueState.currentIndex + 1}/${developRunQueueState.items.length}`
                        : ` · ${developRunQueueState.items.length}`}
                    </>
                  ) : (
                    '本卡片的练习题'
                  )
                ) : (
                  '本卡片的练习题'
                )}
              </span>
              <button
                type="button"
                onClick={() => setRightPanelOpen(false)}
                style={{
                  marginLeft: 'auto',
                  background: 'none',
                  border: 'none',
                  fontSize: '20px',
                  cursor: 'pointer',
                  color: themeStyles.textTertiary,
                  lineHeight: 1,
                  padding: '0 4px',
                  flexShrink: 0,
                }}
                aria-label="关闭"
              >
                &times;
              </button>
            </div>
          )}
          {!isMobile && (
            <div style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              background: themeStyles.bgSecondary,
              color: themeStyles.textPrimary,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexShrink: 0,
              gap: 8,
            }}>
              {showDevelopQueueInPanels && developEditorContext && developRunQueueState ? (
                <span style={{ fontWeight: 'bold', minWidth: 0 }}>
                  {editorRightPanelTab === 'develop_queue' ? (
                    <>
                      {i18n('Develop queue tab')}
                      {developRunQueueState.currentIndex >= 0
                        ? ` ${developRunQueueState.currentIndex + 1}/${developRunQueueState.items.length}`
                        : ` · ${developRunQueueState.items.length}`}
                    </>
                  ) : (
                    '本卡片的练习题'
                  )}
                </span>
              ) : (
                <span style={{ fontWeight: 'bold' }}>本卡片的练习题</span>
              )}
              <button
                type="button"
                onClick={() => setRightPanelOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '18px',
                  cursor: 'pointer',
                  color: themeStyles.textTertiary,
                  flexShrink: 0,
                }}
                aria-label="关闭"
              >
                &times;
              </button>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {showDevelopQueueInPanels && developEditorContext && developRunQueueState && editorRightPanelTab === 'develop_queue' ? (
              <BaseEditorDevelopQueueList
                items={developRunQueueState.items}
                currentIndex={developRunQueueState.currentIndex}
                devCtx={developEditorContext}
                themeStyles={themeStyles}
                theme={theme}
                busyIndex={developQueueNavBusy}
                onGo={navigateDevelopQueueItem}
              />
            ) : selectedFile?.type === 'card' ? (
                problemsBody
              ) : (
                <div style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '16px',
                  color: themeStyles.textSecondary,
                  fontSize: '14px',
                  textAlign: 'center',
                }}>
                  请先在左侧树中选择一张卡片
                </div>
              )}
          </div>
        </div>
      )}

            <div style={{
              ...(isMobile
                ? {
                    position: 'fixed' as const,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    zIndex: 1003,
                    paddingTop: 'env(safe-area-inset-top, 0px)',
                    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
                    boxSizing: 'border-box' as const,
                  }
                : {
                    alignSelf: 'stretch',
                  }),
              width: `${RIGHT_SIDE_RAIL_PX}px`,
              flexShrink: 0,
              borderLeft: `1px solid ${themeStyles.borderPrimary}`,
              backgroundColor: themeStyles.bgPrimary,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: '6px',
              padding: '8px 5px',
              overflowY: 'auto',
              overflowX: 'hidden',
              WebkitOverflowScrolling: 'touch',
            }}>
                <button
                  type="button"
                  onClick={() => {
                    if (rightPanelOpen && editorRightPanelTab === 'problems') {
                      setRightPanelOpen(false);
                    } else {
                      setEditorRightPanelTab('problems');
                      setRightPanelOpen(true);
                    }
                  }}
                  style={{
                    width: '34px',
                    height: '34px',
                    border: `1px solid ${themeStyles.borderSecondary}`,
                    borderRadius: '3px',
                    backgroundColor: rightPanelOpen && editorRightPanelTab === 'problems' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                    color: rightPanelOpen && editorRightPanelTab === 'problems' ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                    cursor: 'pointer',
                    flexShrink: 0,
                    fontSize: '11px',
                    fontWeight: 600,
                  }}
                  title="本卡片的练习题"
                  aria-label="题目"
                >
                  题
                </button>
                {showDevelopQueueInPanels && developEditorContext && developRunQueueState ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (rightPanelOpen && editorRightPanelTab === 'develop_queue') {
                        setRightPanelOpen(false);
                      } else {
                        setEditorRightPanelTab('develop_queue');
                        setRightPanelOpen(true);
                      }
                    }}
                    style={{
                      width: '34px',
                      height: '34px',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: '3px',
                      backgroundColor: rightPanelOpen && editorRightPanelTab === 'develop_queue' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                      color: rightPanelOpen && editorRightPanelTab === 'develop_queue' ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                      cursor: 'pointer',
                      flexShrink: 0,
                      fontSize: '11px',
                      fontWeight: 600,
                    }}
                    title={`${i18n('Develop queue tab')}${
                      developRunQueueState.currentIndex >= 0
                        ? ` ${developRunQueueState.currentIndex + 1}/${developRunQueueState.items.length}`
                        : ` · ${developRunQueueState.items.length}`
                    }`}
                    aria-label={i18n('Develop queue tab')}
                  >
                    队
                  </button>
                ) : null}
            </div>
          </>
        );
      })()}
    </div>
  );
}


const getBaseUrl = (path: string, docId: string): string => {
  const domainId = (window as any).UiContext?.domainId || 'system';
  return `/d/${domainId}/base/${docId}${path}`;
};

const page = new NamedPage(['base_editor', 'base_editor_branch', 'base_skill_editor', 'base_skill_editor_branch', 'develop_editor'], async (pageName) => {
  try {
    
    const isSkill = pageName === 'base_skill_editor' || pageName === 'base_skill_editor_branch';
    const containerId = isSkill ? '#skill-editor-mode' : '#base-editor-mode';
    const $container = $(containerId);
    if (!$container.length) {
      return;
    }

    const domainId = (window as any).UiContext?.domainId || 'system';
    const docId = $container.data('doc-id') || $container.attr('data-doc-id') || '';

    
    let initialData: BaseDoc;
    try {
      
      const apiPath = isSkill
        ? `/d/${domainId}/base/skill/data`
        : `/d/${domainId}/base/data`;
      const initQs: Record<string, string> = {};
      if (docId) initQs.docId = docId;
      const initBranch = (window as any).UiContext?.currentBranch;
      if (initBranch) initQs.branch = initBranch;
      const response = await request.get(apiPath, initQs);
      initialData = response;
      
      if (!initialData.docId) {
        initialData.docId = docId || '';
      }
    } catch (error: any) {
      Notification.error(`加载${isSkill ? 'Skills' : '知识库'}失败: ` + (error.message || '未知错误'));
      return;
    }

    const editorBasePath = isSkill ? 'base/skill' : 'base';
    ReactDOM.render(
      <BaseEditorMode docId={initialData.docId || ''} initialData={initialData} basePath={editorBasePath} />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize editor mode:', error);
    Notification.error('初始化编辑器模式失败: ' + (error.message || '未知错误'));
  }
});

export default page;




import Notification from 'vj/components/notification';
import { i18n } from 'vj/utils';
import type { Problem, ProblemKind } from 'ejun/src/interface';
import {
  isMultiProblem,
  matchingColumnsNormalized,
  migrateRawProblem,
  normalizeMultiAnswers,
  SUPER_FLIP_COL_MIN,
  MATCHING_COL_MIN,
  MATCHING_PAIR_MIN,
} from 'ejun/src/model/problem';
import { sameCardDocId, type EditorCard } from '../../editor_workspace/card_problems_panel';
import { supportsRoadmapPracticeProblems } from '../node_kinds';

function ensureNodeCard(
  nodeId: string,
  nodeCardsMap: Record<string, EditorCard[]>,
  label: string,
): EditorCard {
  if (!nodeCardsMap[nodeId]?.length) {
    const tempId = `temp-card-${nodeId}`;
    nodeCardsMap[nodeId] = [{
      docId: tempId,
      cid: 0,
      title: label || i18n('Roadmap new node'),
      content: '',
      order: 0,
      nodeId,
      problems: [],
    }];
  }
  return nodeCardsMap[nodeId][0];
}

function resolveNodeIdFromOp(
  op: Record<string, unknown>,
  nodeCardsMap: Record<string, EditorCard[]>,
  aiCreatedNodeIds: Map<string, string>,
): string | null {
  const rawNodeId = op.nodeId != null ? String(op.nodeId) : '';
  if (rawNodeId) {
    return aiCreatedNodeIds.get(rawNodeId) || rawNodeId;
  }
  const cardId = op.cardId != null ? String(op.cardId) : '';
  if (!cardId) return null;
  for (const nodeId of Object.keys(nodeCardsMap)) {
    const card = (nodeCardsMap[nodeId] || []).find((c) => sameCardDocId(c.docId, cardId));
    if (card) return nodeId;
  }
  return null;
}

export function applyCreateProblemOp(
  op: Record<string, unknown>,
  nodeCardsMap: Record<string, EditorCard[]>,
  aiCreatedNodeIds: Map<string, string>,
  nodeTypeById?: Map<string, string | undefined>,
): { error?: string; cardId?: string; nodeId?: string } {
  const nodeId = resolveNodeIdFromOp(op, nodeCardsMap, aiCreatedNodeIds);
  if (!nodeId) {
    const msg = i18n('Roadmap AI problem missing nodeId');
    Notification.error(msg);
    return { error: msg };
  }

  const nodeType = nodeTypeById?.get(nodeId);
  if (nodeTypeById && !supportsRoadmapPracticeProblems(nodeType)) {
    const msg = i18n('Roadmap practice problems node type forbidden');
    Notification.error(msg);
    return { error: msg };
  }

  const card = ensureNodeCard(nodeId, nodeCardsMap, String(op.nodeLabel || ''));
  const cardIdStr = String(card.docId);
  const existingProblems: Problem[] = card.problems || [];

  const targetPidRaw =
    typeof op.pid === 'string' && op.pid.trim()
      ? op.pid.trim()
      : typeof op.problemPid === 'string' && op.problemPid.trim()
        ? op.problemPid.trim()
        : '';
  let replaceIndex = -1;
  if (targetPidRaw) {
    replaceIndex = existingProblems.findIndex((p) => p.pid === targetPidRaw);
    if (replaceIndex < 0) {
      const msg = i18n('Practice problem pid not on open card');
      Notification.error(msg);
      return { error: msg };
    }
  }

  const rawKind = String(op.problemKind || op.kind || '').toLowerCase().trim();
  const kind: ProblemKind =
    rawKind === 'multi'
    || rawKind === 'true_false'
    || rawKind === 'flip'
    || rawKind === 'fill_blank'
    || rawKind === 'matching'
    || rawKind === 'super_flip'
    || rawKind === 'chain'
    || rawKind === 'ai_eval'
      ? rawKind
      : 'single';

  const pid = replaceIndex >= 0
    ? targetPidRaw
    : `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const analysisStr = typeof op.analysis === 'string' && op.analysis.trim() ? op.analysis.trim() : undefined;
  const aiTitleRaw = typeof op.title === 'string' ? op.title.trim() : '';
  const titleSpread = aiTitleRaw
    ? { title: aiTitleRaw.length > 200 ? `${aiTitleRaw.slice(0, 197)}…` : aiTitleRaw }
    : {};

  let newProblem: Problem;

  if (kind === 'flip') {
    const faceA = String(op.faceA ?? op.stem ?? '').trim();
    const faceB = String(op.faceB ?? '').trim();
    if (!faceA || !faceB) {
      return { error: 'flip: faceA and faceB required' };
    }
    newProblem = migrateRawProblem({
      pid,
      type: 'flip',
      faceA,
      faceB,
      ...(typeof op.hint === 'string' && op.hint.trim() ? { hint: op.hint.trim() } : {}),
      ...titleSpread,
      ...(analysisStr ? { analysis: analysisStr } : {}),
    });
  } else if (kind === 'true_false') {
    const stem = String(op.stem ?? '').trim();
    if (!stem) return { error: 'true_false: stem required' };
    const a = op.answer;
    let av: 0 | 1 = 0;
    if (a === true || a === 1 || a === '1' || String(a).toLowerCase() === 'true') av = 1;
    newProblem = migrateRawProblem({
      pid,
      type: 'true_false',
      stem,
      answer: av,
      ...titleSpread,
      ...(analysisStr ? { analysis: analysisStr } : {}),
    });
  } else if (kind === 'fill_blank') {
    const stem = String(op.stem ?? '').trim();
    if (!stem) return { error: 'fill_blank: stem required' };
    const ar = op.answers ?? op.answer;
    const answersArr = Array.isArray(ar)
      ? ar.map((x: unknown) => String(x ?? '').trim())
      : typeof ar === 'string' ? [ar.trim()] : [''];
    newProblem = migrateRawProblem({
      pid,
      type: 'fill_blank',
      stem,
      answers: answersArr.length ? answersArr : [''],
      ...titleSpread,
      ...(analysisStr ? { analysis: analysisStr } : {}),
    });
  } else if (kind === 'multi') {
    const stem = String(op.stem ?? '').trim();
    const options = Array.isArray(op.options) ? op.options.map((x: unknown) => String(x ?? '')) : [];
    if (!stem || options.length < 2) return { error: 'multi: stem and ≥2 options required' };
    newProblem = migrateRawProblem({
      pid,
      type: 'multi',
      stem,
      options,
      answer: op.answer ?? op.answers,
      ...titleSpread,
      ...(analysisStr ? { analysis: analysisStr } : {}),
    });
    if (isMultiProblem(newProblem)) {
      const n = newProblem.options.length;
      const ans = normalizeMultiAnswers(newProblem.answer).filter((i) => i >= 0 && i < n);
      if (!ans.length) return { error: 'multi: invalid answer' };
      newProblem = { ...newProblem, answer: ans };
    }
  } else if (kind === 'matching') {
    const colRaw = op.columns;
    if (!Array.isArray(colRaw) || colRaw.length < MATCHING_COL_MIN) {
      return { error: 'matching: columns required' };
    }
    newProblem = migrateRawProblem({
      pid,
      type: 'matching',
      ...(typeof op.stem === 'string' && op.stem.trim() ? { stem: op.stem.trim() } : {}),
      columns: colRaw,
      ...titleSpread,
      ...(analysisStr ? { analysis: analysisStr } : {}),
    });
    const ncol = matchingColumnsNormalized(newProblem as any);
    if (ncol.length < MATCHING_COL_MIN || (ncol[0]?.length ?? 0) < MATCHING_PAIR_MIN) {
      return { error: 'matching: invalid columns' };
    }
  } else if (kind === 'super_flip') {
    if (!Array.isArray(op.columns) || op.columns.length < SUPER_FLIP_COL_MIN) {
      return { error: 'super_flip: columns required' };
    }
    newProblem = migrateRawProblem({
      pid,
      type: 'super_flip',
      ...(typeof op.stem === 'string' && op.stem.trim() ? { stem: op.stem.trim() } : {}),
      columns: op.columns,
      ...(Array.isArray(op.headers) ? { headers: op.headers } : {}),
      ...titleSpread,
      ...(analysisStr ? { analysis: analysisStr } : {}),
    });
  } else if (kind === 'chain') {
    const rows = Array.isArray(op.rows) ? op.rows.map((x: any) => ({
      rowType: x.rowType === 'text' ? 'text' as const : 'flip' as const,
      content: String(x.content ?? ''),
    })) : [];
    if (!rows.length) {
      return { error: 'chain: rows array required' };
    }
    newProblem = migrateRawProblem({
      pid,
      type: 'chain',
      rows,
      ...(typeof op.stem === 'string' && op.stem.trim() ? { stem: op.stem.trim() } : {}),
      ...titleSpread,
      ...(analysisStr ? { analysis: analysisStr } : {}),
    });
  } else {
    const stem = String(op.stem ?? '').trim();
    const options = Array.isArray(op.options) ? op.options.map((x: unknown) => String(x ?? '')) : [];
    let answerNum = NaN;
    if (typeof op.answer === 'number' && Number.isFinite(op.answer)) answerNum = Math.trunc(op.answer);
    else if (typeof op.answer === 'string' && /^\d+$/.test(op.answer.trim())) {
      answerNum = parseInt(op.answer.trim(), 10);
    }
    if (!stem || options.length < 2 || !Number.isFinite(answerNum)) {
      return { error: 'single: stem, options, answer required' };
    }
    newProblem = migrateRawProblem({
      pid,
      stem,
      options,
      answer: answerNum,
      ...titleSpread,
      ...(analysisStr ? { analysis: analysisStr } : {}),
    });
  }

  const updatedProblems = replaceIndex >= 0
    ? existingProblems.map((p, i) => (i === replaceIndex ? newProblem : p))
    : [...existingProblems, newProblem];

  const nodeCards = [...(nodeCardsMap[nodeId] || [])];
  const cardIndex = nodeCards.findIndex((c) => sameCardDocId(c.docId, card.docId));
  if (cardIndex < 0) return { error: 'card not found' };
  nodeCards[cardIndex] = { ...nodeCards[cardIndex], problems: updatedProblems };
  nodeCardsMap[nodeId] = nodeCards;
  if ((window as any).UiContext) {
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
  }
  return { cardId: cardIdStr, nodeId };
}

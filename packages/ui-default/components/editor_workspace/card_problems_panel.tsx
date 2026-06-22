import React, { useCallback, useMemo, useRef, useState } from 'react';
import Notification from 'vj/components/notification';
import { i18n } from 'vj/utils';
import type { Problem } from 'ejun/src/interface';
import type { EditorThemeStyles } from './theme';
import { EditableProblem, makeBlankSingleProblem } from './editable_problem';

export interface EditorCard {
  docId: string;
  cid?: number;
  title: string;
  content?: string;
  order?: number;
  nodeId?: string;
  problems?: Problem[];
}

export function sameCardDocId(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function getNodeCardsMap(): Record<string, EditorCard[]> {
  return ((window as any).UiContext?.nodeCardsMap || {}) as Record<string, EditorCard[]>;
}

function setNodeCardsMap(next: Record<string, EditorCard[]>) {
  if ((window as any).UiContext) {
    (window as any).UiContext.nodeCardsMap = next;
  }
}

function problemsCardForNode(
  nodeId: string,
  nodeLabel: string,
  createTempCard: boolean,
): EditorCard | null {
  const map = getNodeCardsMap();
  const cards = [...(map[nodeId] || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (cards.length > 0) return cards[0];
  if (!createTempCard) return null;
  const tempId = `temp-card-${nodeId}`;
  const tempCard: EditorCard = {
    docId: tempId,
    cid: 0,
    title: nodeLabel || i18n('Roadmap new node'),
    content: '',
    order: 0,
    nodeId,
    problems: [],
  };
  setNodeCardsMap({ ...map, [nodeId]: [tempCard] });
  return tempCard;
}

export interface CardProblemsPanelProps {
  nodeId: string | null;
  nodeLabel: string;
  docId: string;
  themeStyles: EditorThemeStyles;
  getEditorUrl: (path: string) => string;
  onProblemsDirty?: (cardId: string) => void;
  reloadEpoch?: number;
}

export function CardProblemsPanel({
  nodeId,
  nodeLabel,
  docId,
  themeStyles,
  getEditorUrl,
  onProblemsDirty,
}: CardProblemsPanelProps) {
  const [, bump] = useState(0);
  const refresh = useCallback(() => bump((v) => v + 1), []);
  const originalProblemsRef = useRef<Map<string, Map<string, Problem>>>(new Map());
  const originalProblemsOrderRef = useRef<Map<string, string[]>>(new Map());
  const [newProblemIds, setNewProblemIds] = useState<Set<string>>(new Set());
  const [editedProblemIds, setEditedProblemIds] = useState<Set<string>>(new Set());
  const [originalProblemsVersion, setOriginalProblemsVersion] = useState(0);

  const card = useMemo(() => {
    if (!nodeId) return null;
    return problemsCardForNode(nodeId, nodeLabel, false);
  }, [nodeId, nodeLabel, originalProblemsVersion]);

  const cardIdStr = card ? String(card.docId) : '';

  const ensureCard = useCallback(() => {
    if (!nodeId) return null;
    const c = problemsCardForNode(nodeId, nodeLabel, true);
    refresh();
    return c;
  }, [nodeId, nodeLabel, refresh]);

  const handleAddBlankProblem = useCallback(() => {
    if (!nodeId) {
      Notification.error(i18n('Please select a node first'));
      return;
    }
    const target = ensureCard();
    if (!target) return;
    const map = getNodeCardsMap();
    const nodeCards = [...(map[nodeId] || [])];
    const cardIndex = nodeCards.findIndex((c) => sameCardDocId(c.docId, target.docId));
    if (cardIndex < 0) return;
    const newProblem = makeBlankSingleProblem();
    const list = [...(nodeCards[cardIndex].problems || []), newProblem];
    nodeCards[cardIndex] = { ...nodeCards[cardIndex], problems: list };
    setNodeCardsMap({ ...map, [nodeId]: nodeCards });
    setNewProblemIds((prev) => new Set(prev).add(newProblem.pid));
    setOriginalProblemsVersion((v) => v + 1);
    onProblemsDirty?.(String(target.docId));
    refresh();
  }, [ensureCard, nodeId, onProblemsDirty, refresh]);

  const reorderProblems = useCallback((from: number, to: number) => {
    if (!nodeId || !card) return;
    const map = getNodeCardsMap();
    const nodeCards = [...(map[nodeId] || [])];
    const cardIndex = nodeCards.findIndex((c) => sameCardDocId(c.docId, card.docId));
    if (cardIndex < 0) return;
    const list = [...(nodeCards[cardIndex].problems || [])];
    if (to < 0 || to >= list.length) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    nodeCards[cardIndex] = { ...nodeCards[cardIndex], problems: list };
    setNodeCardsMap({ ...map, [nodeId]: nodeCards });
    onProblemsDirty?.(String(card.docId));
    refresh();
  }, [card, nodeId, onProblemsDirty, refresh]);

  if (!nodeId) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        color: themeStyles.textSecondary,
        fontSize: '13px',
        textAlign: 'center',
      }}
      >
        {i18n('Please select a node first')}
      </div>
    );
  }

  const problems = card?.problems || [];
  const originalProblems = originalProblemsRef.current.get(cardIdStr) || new Map();
  const baselinePidOrder = originalProblemsOrderRef.current.get(cardIdStr);
  const currentPidOrder = problems.map((pr) => pr.pid);
  const reorderVisualDirty = !!baselinePidOrder
    && baselinePidOrder.length > 0
    && currentPidOrder.length === baselinePidOrder.length
    && baselinePidOrder.some((pid, i) => pid !== currentPidOrder[i]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '8px' }}>
        <button
          type="button"
          onClick={handleAddBlankProblem}
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
      {problems.length > 1 ? (
        <div style={{ fontSize: '10px', color: themeStyles.textSecondary, marginBottom: '6px', lineHeight: 1.35 }}>
          {i18n('Problem reorder hint')}
        </div>
      ) : null}
      {!card ? (
        <div style={{ fontSize: '12px', color: themeStyles.textSecondary, padding: '8px 0' }}>
          {i18n('No problems yet')}
        </div>
      ) : null}
      {problems.map((p, index) => {
        const isNew = newProblemIds.has(p.pid) || !originalProblems.has(p.pid);
        const originalProblem = originalProblems.get(p.pid);
        let borderColor = '#e1e4e8';
        let borderStyle = 'solid';
        const isEdited = editedProblemIds.has(p.pid)
          || (originalProblem && JSON.stringify(originalProblem) !== JSON.stringify(p))
          || reorderVisualDirty;
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
            getBaseUrl={getEditorUrl}
            themeStyles={themeStyles}
            onReorderUp={problems.length > 1 ? () => reorderProblems(index, index - 1) : undefined}
            onReorderDown={problems.length > 1 ? () => reorderProblems(index, index + 1) : undefined}
            reorderDisableUp={index <= 0}
            reorderDisableDown={index >= problems.length - 1}
            onUpdate={(updatedProblem) => {
              if (!nodeId || !card) return;
              const map = getNodeCardsMap();
              const nodeCards = [...(map[nodeId] || [])];
              const cardIndex = nodeCards.findIndex((c) => sameCardDocId(c.docId, card.docId));
              if (cardIndex < 0) return;
              const existingProblems = [...(nodeCards[cardIndex].problems || [])];
              const problemIndex = existingProblems.findIndex((prob) => prob.pid === p.pid);
              if (problemIndex < 0) return;
              existingProblems[problemIndex] = updatedProblem;
              nodeCards[cardIndex] = { ...nodeCards[cardIndex], problems: existingProblems };
              setNodeCardsMap({ ...map, [nodeId]: nodeCards });
              if (isNew) setNewProblemIds((prev) => new Set(prev).add(p.pid));
              else setEditedProblemIds((prev) => new Set(prev).add(p.pid));
              onProblemsDirty?.(cardIdStr);
              refresh();
            }}
            onDelete={() => {
              if (!nodeId || !card) return;
              const map = getNodeCardsMap();
              const nodeCards = [...(map[nodeId] || [])];
              const cardIndex = nodeCards.findIndex((c) => sameCardDocId(c.docId, card.docId));
              if (cardIndex < 0) return;
              const existingProblems = [...(nodeCards[cardIndex].problems || [])];
              const problemIndex = existingProblems.findIndex((prob) => prob.pid === p.pid);
              if (problemIndex >= 0) existingProblems.splice(problemIndex, 1);
              nodeCards[cardIndex] = { ...nodeCards[cardIndex], problems: existingProblems };
              setNodeCardsMap({ ...map, [nodeId]: nodeCards });
              onProblemsDirty?.(cardIdStr);
              setNewProblemIds((prev) => { const next = new Set(prev); next.delete(p.pid); return next; });
              setEditedProblemIds((prev) => { const next = new Set(prev); next.delete(p.pid); return next; });
              setOriginalProblemsVersion((v) => v + 1);
              refresh();
            }}
          />
        );
      })}
    </div>
  );
}

export function collectPendingRoadmapCardUpdates(
  pendingCardIds: Set<string>,
): Array<{ cardId: string; nodeId: string; problems: Problem[]; title?: string; content?: string }> {
  const map = getNodeCardsMap();
  const updates: Array<{ cardId: string; nodeId: string; problems: Problem[]; title?: string; content?: string }> = [];
  for (const cardId of pendingCardIds) {
    if (String(cardId).startsWith('temp-card-')) continue;
    for (const nodeId of Object.keys(map)) {
      const card = (map[nodeId] || []).find((c) => sameCardDocId(c.docId, cardId));
      if (card) {
        updates.push({
          cardId: String(card.docId),
          nodeId,
          problems: card.problems || [],
          title: card.title,
          content: card.content || '',
        });
        break;
      }
    }
  }
  return updates;
}

export function collectPendingRoadmapCardCreates(
  pendingCardIds: Set<string>,
): Array<{ tempId: string; nodeId: string; title: string; content: string; problems: Problem[] }> {
  const map = getNodeCardsMap();
  const creates: Array<{ tempId: string; nodeId: string; title: string; content: string; problems: Problem[] }> = [];
  for (const cardId of pendingCardIds) {
    const id = String(cardId);
    if (!id.startsWith('temp-card-')) continue;
    const nodeId = id.replace(/^temp-card-/, '');
    const card = (map[nodeId] || []).find((c) => sameCardDocId(c.docId, id));
    if (!card) continue;
    creates.push({
      tempId: id,
      nodeId,
      title: card.title || i18n('Roadmap new node'),
      content: card.content || '',
      problems: card.problems || [],
    });
  }
  return creates;
}

export function applyRoadmapCardIdMap(cardIdMap: Record<string, string>) {
  const map = getNodeCardsMap();
  const next: Record<string, EditorCard[]> = {};
  for (const nodeId of Object.keys(map)) {
    next[nodeId] = (map[nodeId] || []).map((card) => {
      const mapped = cardIdMap[String(card.docId)];
      if (!mapped) return card;
      return { ...card, docId: mapped };
    });
  }
  setNodeCardsMap(next);
}

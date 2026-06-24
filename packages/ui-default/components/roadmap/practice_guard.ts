import type { Node } from 'reactflow';
import {
  sameCardDocId,
  type EditorCard,
} from '../editor_workspace/card_problems_panel';
import { supportsRoadmapPracticeProblems } from './node_kinds';

function getNodeCardsMap(): Record<string, EditorCard[]> {
  return ((window as any).UiContext?.nodeCardsMap || {}) as Record<string, EditorCard[]>;
}

export function practiceNodeIdSet(
  nodes: Array<{ id: string; data?: { roadmapNodeType?: string } }>,
): Set<string> {
  const ids = new Set<string>();
  nodes.forEach((node) => {
    if (supportsRoadmapPracticeProblems(node.data?.roadmapNodeType)) {
      ids.add(node.id);
    }
  });
  return ids;
}

export function nodeIdForCardId(
  cardId: string,
  nodeCardsMap: Record<string, EditorCard[]> = getNodeCardsMap(),
): string | null {
  const id = String(cardId);
  for (const nodeId of Object.keys(nodeCardsMap)) {
    const card = (nodeCardsMap[nodeId] || []).find((entry) => sameCardDocId(entry.docId, id));
    if (card) return nodeId;
  }
  return null;
}

export function cardSupportsPracticeProblems(
  cardId: string,
  nodes: Array<{ id: string; data?: { roadmapNodeType?: string } }>,
  nodeCardsMap: Record<string, EditorCard[]> = getNodeCardsMap(),
): boolean {
  const nodeId = nodeIdForCardId(cardId, nodeCardsMap);
  if (!nodeId) return false;
  const node = nodes.find((entry) => entry.id === nodeId);
  return !!node && supportsRoadmapPracticeProblems(node.data?.roadmapNodeType);
}

export function removePendingProblemCardsForNode(
  nodeId: string,
  pendingCardIds: Set<string>,
  nodeCardsMap: Record<string, EditorCard[]> = getNodeCardsMap(),
): Set<string> {
  const next = new Set(pendingCardIds);
  for (const card of nodeCardsMap[nodeId] || []) {
    next.delete(String(card.docId));
  }
  return next;
}

export function nodeSupportsPractice(node: Node | null | undefined): boolean {
  return !!node && supportsRoadmapPracticeProblems(node.data?.roadmapNodeType);
}

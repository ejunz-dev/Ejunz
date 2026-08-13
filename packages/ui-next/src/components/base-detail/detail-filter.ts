import type { BaseDetailCard, BaseDetailNode, BaseDetailProblem } from './types';
import { cardDisplayLabel, nodeDisplayLabel } from './tree';

export interface BaseDetailFilter {
  filterNode: string;
  filterCard: string;
  filterProblem: string;
  filterCardTag: string;
  filterProblemTag: string;
}

export function emptyBaseDetailFilter(): BaseDetailFilter {
  return { filterNode: '', filterCard: '', filterProblem: '', filterCardTag: '', filterProblemTag: '' };
}

const FILTER_KEYS = ['filterNode', 'filterCard', 'filterProblem', 'filterCardTag', 'filterProblemTag'] as const;

export function readBaseDetailFilterFromLocation(): BaseDetailFilter {
  if (typeof window === 'undefined') return emptyBaseDetailFilter();
  const params = new URLSearchParams(window.location.search);
  return {
    filterNode: params.get('filterNode') || '',
    filterCard: params.get('filterCard') || '',
    filterProblem: params.get('filterProblem') || '',
    filterCardTag: params.get('filterCardTag') || '',
    filterProblemTag: params.get('filterProblemTag') || '',
  };
}

export function writeBaseDetailFilterToLocation(filters: BaseDetailFilter): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  for (const key of FILTER_KEYS) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', next);
}

export function isBaseDetailFilterActive(filters: BaseDetailFilter): boolean {
  return FILTER_KEYS.some((key) => !!filters[key].trim());
}

function text(value: unknown): string {
  return String(value || '').replace(/<[^>]+>/g, ' ').toLowerCase();
}

function terms(value: string): string[] {
  return value.split(',').map((term) => term.trim().toLowerCase()).filter(Boolean);
}

function includesAny(values: string[], expected: string): boolean {
  return terms(expected).some((term) => values.includes(term));
}

function problemSearchText(problem: BaseDetailProblem): string {
  const values: unknown[] = [problem.title, problem.stem, problem.content, problem.cardFace, problem.faceA, problem.faceB, problem.hint, problem.analysis];
  for (const key of ['options', 'answers']) {
    const value = problem[key];
    if (Array.isArray(value)) values.push(...value);
  }
  return values.map(text).filter(Boolean).join(' ');
}

export function cardMatchesFilters(card: BaseDetailCard, filters: BaseDetailFilter): boolean {
  const cardQuery = filters.filterCard.trim().toLowerCase();
  if (cardQuery && !`${text(cardDisplayLabel(card))} ${text(card.content)} ${text(card.cardFace)}`.includes(cardQuery)) return false;

  const cardTags = (card.tags || []).map((tag) => tag.toLowerCase());
  if (filters.filterCardTag.trim() && !includesAny(cardTags, filters.filterCardTag)) return false;

  const problemQuery = filters.filterProblem.trim().toLowerCase();
  if (problemQuery && !(card.problems || []).some((problem) => problemSearchText(problem).includes(problemQuery))) return false;

  const problemTags = (card.problems || []).flatMap((problem) => (problem.tags || []).map((tag) => tag.toLowerCase()));
  if (filters.filterProblemTag.trim() && !includesAny(problemTags, filters.filterProblemTag)) return false;

  return true;
}

export function nodeMatchesFilter(node: BaseDetailNode, filters: BaseDetailFilter): boolean {
  const query = filters.filterNode.trim().toLowerCase();
  return !query || text(nodeDisplayLabel(node)).includes(query);
}

export function cardMatchesSearch(card: BaseDetailCard, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const cardText = `${text(cardDisplayLabel(card))} ${text(card.content)} ${text(card.cardFace)} ${(card.tags || []).map(text).join(' ')}`;
  return cardText.includes(normalized) || (card.problems || []).some((problem) => problemSearchText(problem).includes(normalized));
}

export function nodeMatchesSearch(node: BaseDetailNode, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return !normalized || text(nodeDisplayLabel(node)).includes(normalized);
}

export function cardMatchesSelection(card: BaseDetailCard, node: BaseDetailNode, query: string, filters: BaseDetailFilter): boolean {
  const nodeFilterMatches = nodeMatchesFilter(node, filters);
  if (!nodeFilterMatches) return false;
  if (!cardMatchesFilters(card, filters)) return false;
  if (!query.trim()) return true;
  return nodeMatchesSearch(node, query) || cardMatchesSearch(card, query);
}

export function filterTags(cards: BaseDetailCard[], problem = false): string[] {
  const tags = new Set<string>();
  for (const card of cards) {
    if (problem) {
      for (const item of card.problems || []) for (const tag of item.tags || []) tags.add(tag);
    } else {
      for (const tag of card.tags || []) tags.add(tag);
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

export function countBaseDetailMatches(nodes: BaseDetailNode[], nodeCardsMap: Record<string, BaseDetailCard[]>, query: string, filters: BaseDetailFilter): number {
  let count = 0;
  for (const node of nodes) {
    const cards = nodeCardsMap[node.id] || [];
    if ((nodeMatchesFilter(node, filters) && (!isBaseDetailFilterActive(filters) || cards.some((card) => cardMatchesFilters(card, filters))) && (!query.trim() || nodeMatchesSearch(node, query))) || cards.some((card) => cardMatchesSelection(card, node, query, filters))) {
      count += 1;
    }
  }
  return count;
}

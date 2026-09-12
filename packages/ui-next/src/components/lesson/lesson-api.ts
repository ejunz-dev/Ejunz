import { requestJson, updateBaseCard } from '../base-detail/base-detail-api';
import type { LessonAnswerRecord, LessonPassResponse, LessonSnapshot } from './types';

export function readLessonSnapshot(raw: unknown): LessonSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, any>;
  const candidate = value.lesson && typeof value.lesson === 'object' ? value.lesson : value;
  if (!candidate || typeof candidate !== 'object') return null;
  const card = (candidate as Record<string, any>).card;
  if (!card || typeof card !== 'object') return null;
  return candidate as LessonSnapshot;
}

export async function fetchLessonSnapshot(
  domainId: string,
  sessionId?: string,
): Promise<LessonSnapshot | null> {
  const query = new URLSearchParams({ format: 'json' });
  if (sessionId) query.set('session', sessionId);
  const response = await requestJson<LessonPassResponse>(`/learn/lesson?${query.toString()}`, {
    domainId,
    acceptJson: true,
  });
  return readLessonSnapshot(response);
}

export interface PassLessonCardOptions {
  domainId: string;
  sessionId?: string;
  cardId: string;
  answerHistory: LessonAnswerRecord[];
  totalTime: number;
  isTodayMode?: boolean;
  isSingleNodeMode?: boolean;
  nodeId?: string;
  noImpression?: boolean;
}

export async function passLessonCard(options: PassLessonCardOptions): Promise<LessonPassResponse> {
  return requestJson<LessonPassResponse>('/learn/lesson/pass', {
    domainId: options.domainId,
    acceptJson: true,
    body: {
      ...(options.sessionId ? { session: options.sessionId } : {}),
      answerHistory: options.answerHistory,
      totalTime: options.totalTime,
      cardId: options.cardId,
      singleNodeMode: options.isSingleNodeMode || undefined,
      todayMode: options.isTodayMode || undefined,
      nodeId: options.isSingleNodeMode && options.nodeId ? options.nodeId : undefined,
      noImpression: options.noImpression || undefined,
      spaNext: options.isSingleNodeMode || options.isTodayMode ? true : undefined,
    },
  });
}

export async function navigateLessonCard(options: {
  domainId: string;
  sessionId?: string;
  action: 'prev' | 'skip';
  isTodayMode?: boolean;
  isSingleNodeMode?: boolean;
  nodeId?: string;
}): Promise<LessonPassResponse> {
  return requestJson<LessonPassResponse>('/learn/lesson/navigate', {
    domainId: options.domainId,
    acceptJson: true,
    body: {
      ...(options.sessionId ? { session: options.sessionId } : {}),
      lessonCardNav: options.action,
      todayMode: options.isTodayMode || undefined,
      singleNodeMode: options.isSingleNodeMode || undefined,
      nodeId: options.isSingleNodeMode && options.nodeId ? options.nodeId : undefined,
      spaNext: options.isSingleNodeMode || options.isTodayMode ? true : undefined,
    },
  });
}

export async function registerProblemTag(domainId: string, baseDocId: number, tag: string): Promise<string[]> {
  const response = await requestJson<{ problemTags?: string[] }>(
    `/base/${baseDocId}/problem-tag-register`,
    { domainId, acceptJson: true, body: { tag } },
  );
  return Array.isArray(response?.problemTags) ? response.problemTags.map(String) : [];
}

export async function deleteProblemTag(domainId: string, baseDocId: number, tag: string): Promise<string[]> {
  const response = await requestJson<{ problemTags?: string[] }>('/base/problem-tag', {
    domainId,
    acceptJson: true,
    body: { docId: baseDocId, action: 'delete', tag },
  });
  return Array.isArray(response?.problemTags) ? response.problemTags.map(String) : [];
}

export async function saveCardProblems(
  domainId: string,
  cardId: string,
  problems: unknown[],
): Promise<void> {
  await updateBaseCard(domainId, cardId, { problems: problems as never });
}

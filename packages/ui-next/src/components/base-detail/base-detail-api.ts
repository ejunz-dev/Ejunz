import type { BaseDetailCard } from './types';

export function domainApiPath(path: string, domainId = 'system'): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return domainId && domainId !== 'system'
    ? `/d/${encodeURIComponent(domainId)}${normalized}`
    : normalized;
}

async function parseResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { success: response.ok, body: text };
  }
}

function failureMessage(payload: any, status: number): string {
  const error = payload?.error;
  const nested = error && typeof error === 'object' ? error.message : error;
  return String(payload?.message || nested || payload?.body || `HTTP ${status}`);
}

export async function requestJson<T = any>(
  path: string,
  options: { domainId?: string; method?: string; body?: unknown; acceptJson?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.acceptJson) headers.Accept = 'application/json';
  const response = await fetch(domainApiPath(path, options.domainId), {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: Object.keys(headers).length ? headers : undefined,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await parseResponse(response);
  if (!response.ok || payload?.success === false) {
    throw new Error(failureMessage(payload, response.status));
  }
  return payload as T;
}

export interface StartNodeLessonOptions {
  domainId: string;
  nodeId: string;
  baseDocId: number;
  detailFilteredCardIds: string[];
  detailSourceUrl: string;
  detailFilterSummary: string;
}

export async function startNodeLesson(options: StartNodeLessonOptions): Promise<string> {
  const response = await requestJson<{ redirect?: string }>('/learn/lesson/start', {
    domainId: options.domainId,
    acceptJson: true,
    body: {
      mode: 'node',
      nodeId: options.nodeId,
      baseDocId: options.baseDocId,
      learnSource: 'base',
      source: 'base_detail',
      detailFilteredCardIds: options.detailFilteredCardIds,
      detailSourceUrl: options.detailSourceUrl,
      detailFilterSummary: options.detailFilterSummary,
    },
  });
  const redirect = typeof response?.redirect === 'string' ? response.redirect.trim() : '';
  if (!redirect) throw new Error('Learn lesson start missing redirect');
  return redirect;
}

export async function updateBaseCard(
  domainId: string,
  cardId: string,
  patch: Partial<Pick<BaseDetailCard, 'title' | 'content' | 'tags' | 'problems'>>,
): Promise<void> {
  await requestJson(`/base/card/${encodeURIComponent(cardId)}`, {
    domainId,
    body: { ...patch, operation: 'update' },
  });
}

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

export async function requestJson<T = any>(
  path: string,
  options: { domainId?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(domainApiPath(path, options.domainId), {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await parseResponse(response);
  if (!response.ok || payload?.success === false) {
    const message = payload?.message || payload?.error || payload?.body || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return payload as T;
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

export type UiNextResponseMode = 'dev' | 'prod' | 'json';

export interface UiNextLogger {
  info(format: string, ...args: unknown[]): void;
}

function responseBytes(body: unknown): number {
  const text = typeof body === 'string' ? body : JSON.stringify(body) || '';
  return new TextEncoder().encode(text).byteLength;
}

export function logUiNextResponse(
  logger: UiNextLogger,
  mode: UiNextResponseMode,
  url: string,
  page: string,
  body: unknown,
) {
  const label = mode === 'json' ? 'JSON page-data' : `SSR ${mode}`;
  logger.info('%s %s -> %s (%d bytes)', label, url, page, responseBytes(body));
}

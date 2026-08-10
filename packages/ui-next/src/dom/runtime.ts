import { compile } from 'path-to-regexp';
import type { PageData } from '../context/page-data';
import { resolvePage } from './registry';
import type { DomMountContext, DomRenderContext } from './types';

let cleanup: (() => void) | undefined;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createContext(
  page: PageData,
  routeMap: Record<string, string>,
  host = 'localhost',
  navigate: (url: string) => Promise<void> = async () => {},
): DomMountContext {
  const ui = page.args.UiContext || {};
  const domainId = String(ui.domainId || 'system');
  const domains = ui.domain?.host;
  const domainHosts = Array.isArray(domains) ? domains.map(String) : domains ? [String(domains)] : [];

  const buildUrl = (name: string, params: Record<string, string | number> = {}, search: Record<string, string> = {}) => {
    const pattern = routeMap[name];
    if (!pattern) return '#';
    try {
      const path = compile(pattern)(params as Record<string, string>);
      const prefix = domainId !== 'system' && !domainHosts.includes(host) ? `/d/${domainId}` : '';
      const query = new URLSearchParams(search).toString();
      return `${prefix}${path}${query ? `?${query}` : ''}`;
    } catch {
      return '#';
    }
  };

  const link = (url: string, content: string, attrs: Record<string, string> = {}) => {
    const safeAttrs = Object.entries(attrs)
      .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
      .join('');
    const client = url.startsWith('/') && !url.startsWith('//') ? ' data-ej-link="1"' : '';
    return `<a href="${escapeHtml(url)}"${client}${safeAttrs}>${content}</a>`;
  };

  return { page, args: page.args, routeMap, host, escape: escapeHtml, buildUrl, link, navigate };
}

export function renderPage(
  page: PageData,
  routeMap: Record<string, string>,
  host = 'localhost',
): string {
  const definition = resolvePage(page);
  if (!definition) return `<div class="uinp-error">Page not found: ${escapeHtml(page.name)}</div>`;
  return definition.render(createContext(page, routeMap, host));
}

export async function mountPage(
  root: HTMLElement,
  page: PageData,
  routeMap: Record<string, string>,
  options: { initial?: boolean; host?: string; navigate?: (url: string) => Promise<void> } = {},
): Promise<void> {
  cleanup?.();
  cleanup = undefined;
  const definition = resolvePage(page);
  if (!definition) {
    root.innerHTML = `<div class="uinp-error">Page not found: ${escapeHtml(page.name)}</div>`;
    return;
  }
  const context = createContext(page, routeMap, options.host || window.location.host, options.navigate);
  if (!options.initial) root.innerHTML = definition.render(context);
  const mounted = definition.mount?.(root, context);
  cleanup = typeof mounted === 'function' ? mounted : undefined;
}

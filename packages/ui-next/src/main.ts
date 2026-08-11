/// <reference path="./vite-env.d.ts" />

import { endpoints, initialPage, isInjected, pluginsUrl, routeMapStore } from './globals';
import { installPlugins } from './dom/registry';
import { mountPage } from './dom/runtime';
import type { DomPluginDefinition } from './dom/types';

declare global {
  interface Window {
    __ejunzPlugins?: DomPluginDefinition[];
  }
}

async function loadPlugins() {
  let plugins: DomPluginDefinition[] = [];
  if (import.meta.env.DEV) {
    const module = await import('virtual:ejunz-plugins');
    plugins = (module.default || []) as unknown as DomPluginDefinition[];
  } else {
    try {
      await import(/* @vite-ignore */ pluginsUrl || '/plugins.js');
      plugins = window.__ejunzPlugins || [];
    } catch (error) {
      // A page can still render its built-in definition without optional plugins.
      void error;
    }
  }
  installPlugins(plugins);
}

let currentPage = initialPage;
let navigating = false;

async function fetchPage(url: string, init = false): Promise<boolean> {
  if (navigating) return false;
  navigating = true;
  try {
    for (const endpoint of endpoints) {
      try {
        const requestUrl = new URL(url, endpoint).href;
        const response = await fetch(requestUrl, {
          headers: {
            Accept: 'application/json',
            'x-ejunz-inject': [
              'uicontext', 'usercontext', 'pagename',
              ...(init ? ['routemap'] : []),
            ].join(','),
          },
        });
        if (response.redirected) {
          window.location.href = response.url;
          return false;
        }
        if (!response.ok) throw new Error(`Navigation failed: ${response.status}`);
        const body = await response.json();
        if (init && body.routeMap && typeof body.routeMap === 'object') routeMapStore.set(body.routeMap);
        currentPage = {
          name: response.headers.get('x-ejunz-page') || currentPage.name,
          template: response.headers.get('x-ejunz-template') || '',
          args: body,
          url,
        };
        await mountPage(document.getElementById('root')!, currentPage, routeMapStore.getSnapshot(), {
          host: window.location.host,
          navigate,
        });
        return true;
      } catch {
        // Try the next configured endpoint.
      }
    }
    window.location.href = url;
    return false;
  } finally {
    navigating = false;
  }
}

async function navigate(url: string) {
  const target = new URL(url, window.location.href);
  if (target.origin !== window.location.origin) {
    window.location.href = target.href;
    return;
  }
  if (await fetchPage(`${target.pathname}${target.search}`, false)) {
    history.pushState({ url: target.pathname + target.search }, '', target.href);
  }
}

function installLinkNavigation(root: HTMLElement) {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-ej-link]') : null;
    if (!target || target.target && target.target !== '_self' || target.hasAttribute('download')) return;
    event.preventDefault();
    void navigate(target.href);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

async function start() {
  await loadPlugins();
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  const removeLinks = installLinkNavigation(root);
  window.addEventListener('popstate', () => {
    void fetchPage(window.location.pathname + window.location.search);
  });
  await mountPage(root, currentPage, routeMapStore.getSnapshot(), {
    initial: isInjected && root.hasChildNodes(),
    host: window.location.host,
    navigate,
  });
  void removeLinks;
}

void start();

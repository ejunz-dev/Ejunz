import isRelativeUrl from 'is-relative-url';
import type { PageData } from './context/page-data';

const hasDocument = typeof document !== 'undefined';
const hasWindow = typeof window !== 'undefined';
const injectionEl = hasDocument ? document.getElementById('__EJUNZ_INJECTION__') : null;
let injectionData: Record<string, any> = {};
if (injectionEl) {
  try {
    injectionData = JSON.parse(injectionEl.textContent!);
    console.log('[Ejunz] initial data:', injectionData);
  } catch (e) {
    console.error('[Ejunz] Failed to parse injection data:', e);
  }
}

export const isInjected: boolean = !!injectionData.EJUNZ_INJECTED;
export const ejunzDomains: string[] = injectionData.ejunz_domains ?? [];
export const pluginsUrl: string | undefined = injectionData.plugins_url;

interface RouteMapStore {
  _routeMap: Record<string, string>;
  _listeners: Set<() => void>;
  getSnapshot: () => Record<string, string>;
  subscribe: (listener: () => void) => () => void;
  set: (map: Record<string, string>) => void;
}

function createRouteMapStore(initial: Record<string, string>): RouteMapStore {
  const store: RouteMapStore = {
    _routeMap: initial,
    _listeners: new Set(),
    getSnapshot: () => store._routeMap,
    subscribe: (listener: () => void) => {
      store._listeners.add(listener);
      return () => { store._listeners.delete(listener); };
    },
    set: (map: Record<string, string>) => {
      store._routeMap = { ...store._routeMap, ...map };
      store._listeners.forEach((l) => l());
    },
  };
  return store;
}

export const routeMapStore: RouteMapStore = import.meta.hot?.data?.routeMapStore
  ?? createRouteMapStore(injectionData.route_map || {});
if (import.meta.hot) import.meta.hot.data.routeMapStore = routeMapStore;

export const endpoints: string[] = (() => {
  const protocol = hasWindow ? window.location.protocol : 'http:';
  if (ejunzDomains.length) {
    return ejunzDomains
      .map((d) => d.includes('://') ? d : `${protocol}//${d}`)
      .map((d) => d.replace(/\/$/, ''));
  }
  if (typeof injectionData.endpoint === 'string') {
    const ep = injectionData.endpoint;
    if (isRelativeUrl(ep, { allowProtocolRelative: false })) {
      const base = hasWindow ? window.location.href : 'http://localhost/';
      return [new URL(ep, base).href.replace(/\/$/, '')];
    }
    return [ep.replace(/\/$/, '')];
  }
  return [hasWindow ? window.location.origin : 'http://localhost'];
})();
export const endpointOrigins = new Set(endpoints.map((ep) => new URL(ep).origin));

export const initialPage: PageData = {
  name: (injectionData.name as string) || '',
  template: (injectionData.template as string) || '',
  args: (injectionData.args as any) || {},
  url: (injectionData.url as string) || (hasWindow ? window.location.pathname + window.location.search : '/'),
};

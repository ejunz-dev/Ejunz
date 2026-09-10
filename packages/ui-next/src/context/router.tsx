/* eslint-disable react-refresh/only-export-components */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { endpointOrigins, endpoints, isInjected, routeMapStore } from '../globals';
import { useSetPageData } from './page-data';

interface InternalState {
  status: 'idle' | 'loading' | 'error';
  error: Error | null;
}

type RouterAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS' }
  | { type: 'FETCH_ERROR', error: Error }
  | { type: 'FETCH_ABORT' };

function routerReducer(state: InternalState, action: RouterAction): InternalState {
  switch (action.type) {
    case 'FETCH_START': return { status: 'loading', error: null };
    case 'FETCH_SUCCESS': return { status: 'idle', error: null };
    case 'FETCH_ERROR': return { status: 'error', error: action.error };
    case 'FETCH_ABORT': return state;
    default: return state;
  }
}

export interface RouterState {
  loading: boolean;
  error: Error | null;
}

export interface RefreshOptions {
  context?: boolean | string[];
}

interface RouterNavigateContextValue {
  navigate: (url: string) => Promise<void>;
  refresh: (options?: RefreshOptions) => Promise<void>;
}

const RouterStateContext = createContext<RouterState | null>(null);
const RouterNavigateContext = createContext<RouterNavigateContextValue | null>(null);

export const RouterProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(routerReducer, { status: 'idle', error: null });
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  const setData = useSetPageData();

  const isSameOrigin = useCallback((url: string) => {
    try {
      return endpointOrigins.has(new URL(url, endpoints[0]).origin);
    } catch {
      return false;
    }
  }, []);

  const fetchPage = useCallback(
    async (url: string, init = false) => {
      abortRef.current?.abort();
      const gen = ++genRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      dispatch({ type: 'FETCH_START' });

      let lastError: Error | null = null;
      for (const ep of endpoints) {
        try {
          const signal = endpoints.length > 1
            ? AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
            : controller.signal;
          const reqUrl = new URL(url, ep).href;
          const res = await fetch(reqUrl, {
            signal,
            headers: {
              Accept: 'application/json',
              'x-ejunz-inject': [
                'uicontext', 'usercontext', 'pagename',
                ...(init ? ['routemap'] : []),
              ].join(','),
            },
          });
          if (res.redirected) {
            window.location.href = res.url;
            return false;
          }
          if (!res.ok) throw new Error(`Navigation failed: ${res.status} ${res.statusText}`);
          const body = await res.json();
          const pageName = res.headers.get('x-ejunz-page') || '';
          const template = res.headers.get('x-ejunz-template') || '';
          console.log('[Ejunz] data from', reqUrl, 'received:', body, 'pageName:', pageName);

          if (gen !== genRef.current) return false;

          if (init && body.routeMap && typeof body.routeMap === 'object') {
            routeMapStore.set(body.routeMap);
          }
          setData((prev) => ({
            ...prev,
            args: body,
            name: pageName,
            template,
            url,
          }));
          dispatch({ type: 'FETCH_SUCCESS' });
          return true;
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            dispatch({ type: 'FETCH_ABORT' });
            console.log('[Ejunz] navigation to', url, 'aborted');
            return false;
          }
          lastError = e instanceof Error ? e : new Error(String(e));
          console.warn('[Ejunz] endpoint', ep, 'failed:', lastError.message);
          if (controller.signal.aborted) {
            // User-initiated abort propagated through AbortSignal.any
            dispatch({ type: 'FETCH_ABORT' });
            return false;
          }
        }
      }

      console.error('[Ejunz] all endpoints failed:', lastError);
      if (gen !== genRef.current) return false;
      dispatch({ type: 'FETCH_ERROR', error: lastError! });
      window.location.href = url;
      return false;
    },
    [setData],
  );

  useEffect(() => {
    const handler = (e: PopStateEvent) => {
      const url: string =
        (e.state as { url?: string } | null)?.url
        ?? window.location.pathname + window.location.search;
      fetchPage(url);
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [fetchPage]);

  // If no server-side injection, fetch initial page data from the API
  useEffect(() => {
    if (!isInjected) {
      console.log('[Ejunz] no initial data injection found, fetching page data for current URL');
      fetchPage(window.location.pathname + window.location.search, true);
    }
  }, [fetchPage]);

  const stateValue = useMemo(
    () => ({ loading: state.status === 'loading', error: state.error }),
    [state.status, state.error],
  );

  const navigate = useCallback(async (url: string) => {
    if (!isSameOrigin(url)) {
      window.location.href = url;
      return;
    }
    const ok = await fetchPage(url);
    if (ok) history.pushState({ url }, '', url);
  }, [fetchPage, isSameOrigin]);

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    // Re-fetch the current page's content data. Keep the shared
    // UiContext/UserContext by default so ordinary page refreshes preserve the
    // surrounding shell; callers can opt in when server-side context changed.
    const url = window.location.pathname + window.location.search;
    const contextFields = Array.isArray(options.context) ? new Set(options.context) : null;
    const inject = options.context
      ? `${contextFields ? 'uicontext' : 'uicontext,usercontext'},pagename`
      : 'pagename';
    abortRef.current?.abort();
    const gen = ++genRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    for (const ep of endpoints) {
      try {
        const signal = endpoints.length > 1
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
          : controller.signal;
        const reqUrl = new URL(url, ep).href;
        const res = await fetch(reqUrl, {
          signal,
          headers: {
            Accept: 'application/json',
            'x-ejunz-inject': inject,
          },
        });
        if (res.redirected) {
          window.location.href = res.url;
          return;
        }
        if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${res.statusText}`);
        const body = await res.json();
        const pageName = res.headers.get('x-ejunz-page') || '';
        const template = res.headers.get('x-ejunz-template') || '';
        if (gen !== genRef.current) return;
        setData((prev) => {
          const { UiContext, UserContext, ...pageArgs } = body;
          const args = { ...prev.args, ...pageArgs };

          if (contextFields) {
            const nextUiContext = { ...prev.args.UiContext };
            for (const key of contextFields) {
              if (UiContext && Object.prototype.hasOwnProperty.call(UiContext, key)) {
                nextUiContext[key] = UiContext[key];
              } else {
                delete nextUiContext[key];
              }
            }
            args.UiContext = nextUiContext;
          } else if (options.context) {
            args.UiContext = { ...prev.args.UiContext, ...(UiContext || {}) };
            args.UserContext = { ...prev.args.UserContext, ...(UserContext || {}) };
          }

          return {
            ...prev,
            args,
            name: pageName,
            template,
            url,
          };
        });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        console.warn('[Ejunz] refresh endpoint', ep, 'failed:', e instanceof Error ? e.message : String(e));
      }
    }
  }, [endpoints, setData]);

  const navigateValue = useMemo<RouterNavigateContextValue>(() => ({ navigate, refresh }), [navigate, refresh]);

  return (
    <RouterNavigateContext.Provider value={navigateValue}>
      <RouterStateContext.Provider value={stateValue}>
        {children}
      </RouterStateContext.Provider>
    </RouterNavigateContext.Provider>
  );
};

export function useRouterState(): RouterState {
  const ctx = useContext(RouterStateContext);
  if (!ctx) throw new Error('useRouterState must be used within RouterProvider');
  return ctx;
}

export function useNavigate(): (url: string) => Promise<void> {
  const ctx = useContext(RouterNavigateContext);
  if (!ctx) throw new Error('useNavigate must be used within RouterProvider');
  return ctx.navigate;
}

export function useRefresh(): (options?: RefreshOptions) => Promise<void> {
  const ctx = useContext(RouterNavigateContext);
  if (!ctx) throw new Error('useRefresh must be used within RouterProvider');
  return ctx.refresh;
}

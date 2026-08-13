/* eslint-disable react-refresh/only-export-components */

import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

export interface PageData {
  name: string;
  template: string;
  args: {
    UserContext: Record<string, any>;
    UiContext: Record<string, any>;
    [key: string]: any;
  };
  url: string;
}

interface PageDataContextValue {
  data: PageData;
  setData: React.Dispatch<React.SetStateAction<PageData>>;
}

const PageDataContext = createContext<PageDataContextValue | null>(null);

interface PageDataProviderProps {
  initial: PageData;
  children: ReactNode;
}

export function PageDataProvider({ initial, children }: PageDataProviderProps) {
  const [data, setData] = useState<PageData>(initial);
  const value = useMemo(() => ({ data, setData }), [data]);

  return <PageDataContext.Provider value={value}>{children}</PageDataContext.Provider>;
}

function usePageDataContext(): PageDataContextValue {
  const ctx = useContext(PageDataContext);
  if (!ctx) throw new Error('usePageData must be used within PageDataProvider');
  return ctx;
}

export function usePageData(): PageData {
  return usePageDataContext().data;
}

export function useSetPageData(): React.Dispatch<React.SetStateAction<PageData>> {
  return usePageDataContext().setData;
}

function parseContext(value: unknown): Record<string, any> {
  if (value && typeof value === 'object') return value as Record<string, any>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, any>;
    } catch {
      // Keep the empty context fallback for malformed or legacy payloads.
    }
  }
  return {};
}

export function useUiContext(): PageData['args']['UiContext'] {
  return parseContext(usePageDataContext().data.args.UiContext);
}

export function useUserContext(): PageData['args']['UserContext'] {
  return parseContext(usePageDataContext().data.args.UserContext);
}

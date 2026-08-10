import { lazy } from 'react';
import { store } from './store';
import type { PageEntry, PageLoader, PageSlotName, RegisterPageOptions } from './types';

export function registerPage<P = any>(
  name: string,
  loader: PageLoader<P>,
  options: RegisterPageOptions = {},
) {
  let pending: Promise<React.ComponentType<P>> | undefined;
  const load = () => {
    if (!pending) {
      pending = loader().then((module) => module.default);
    }
    return pending;
  };
  const Page = lazy(() => load().then((component) => ({ default: component })));
  const entry: PageEntry<P> = { Page, load, layout: options.layout ?? 'default' };
  store.setDefault(`page:${name}` as PageSlotName, entry);
}

export async function preloadPage(name: string): Promise<boolean> {
  const entry = store.getDefault(`page:${name}` as PageSlotName) as PageEntry | undefined;
  if (!entry) return false;
  entry.component ??= await entry.load();
  return true;
}

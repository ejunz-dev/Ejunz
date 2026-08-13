import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BaseDetailApp } from './BaseDetailApp';
import type { BaseDetailDomContext } from './types';

export type {
  BaseDetailCard,
  BaseDetailDoc,
  BaseDetailDomContext,
  BaseDetailEdge,
  BaseDetailNode,
} from './types';
export type { BaseDetailDoc as BaseDetailPayload } from './types';

export interface BaseDetailMountContext extends BaseDetailDomContext {
  navigate?(url: string): Promise<void>;
}

export function renderBaseDetail(ctx: BaseDetailDomContext): string {
  return renderToStaticMarkup(<BaseDetailApp ctx={ctx} />);
}

export async function mountBaseDetail(
  root: HTMLElement,
  ctx: BaseDetailMountContext,
): Promise<void | (() => void)> {
  if (typeof window === 'undefined') return undefined;
  // Hydrate the SSR markup into a fully interactive tree. React is provided by
  // the ui-next shell through module federation; import lazily so SSR never
  // pulls client-only code in.
  const { hydrateRoot } = await import('react-dom/client');
  const hydrated = hydrateRoot(root, <BaseDetailApp ctx={ctx} />);
  return () => hydrated.unmount();
}

export const BaseDetailDomRenderer = {
  render: renderBaseDetail,
  mount: mountBaseDetail,
};

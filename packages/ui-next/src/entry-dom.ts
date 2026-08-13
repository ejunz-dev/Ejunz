import './pages';

import type { PageData } from './context/page-data';
import { renderPage } from './dom/runtime';

export { installPlugin, installPlugins } from './dom/registry';

export function renderDomPage(
  page: PageData,
  routeMap: Record<string, string>,
  host = 'localhost',
): string {
  return renderPage(page, routeMap, host);
}

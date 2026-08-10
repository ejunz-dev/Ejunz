import './pages';

import { renderToString } from 'react-dom/server';
import type { PageData } from './context/page-data';
import { routeMapStore } from './globals';
import { installPlugin } from './registry';
import { preloadPage } from './registry/page';
import UiNextRoot from './root';

type PluginModule = {
  name?: string;
  setup?: Parameters<typeof installPlugin>[0]['setup'];
};

let pluginsReady: Promise<void> | undefined;

async function loadPlugins() {
  if (!pluginsReady) {
    pluginsReady = (async () => {
      try {
        const module = await import('virtual:ejunz-plugins') as { default?: PluginModule[] };
        for (const plugin of module.default || []) {
          if (typeof plugin.setup !== 'function') continue;
          installPlugin({ name: plugin.name || 'unknown', setup: plugin.setup });
        }
      } catch {
        // Production can render built-in pages without the dev-only virtual module.
      }
    })();
  }
  await pluginsReady;
}

export async function renderPage(initial: PageData, routeMap: Record<string, string>): Promise<string> {
  await loadPlugins();
  routeMapStore.set(routeMap);
  await preloadPage(initial.name);
  return renderToString(<UiNextRoot initial={initial} />);
}

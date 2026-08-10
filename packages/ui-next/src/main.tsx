/// <reference path="./vite-env.d.ts" />

import './pages';

import { hydrateRoot } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import * as api from './api';
import UiNextRoot from './root';
import { initialPage, isInjected, pluginsUrl } from './globals';
import { installPlugin } from './registry';
import { preloadPage } from './registry/page';


declare global {
  interface Window {
    __ejunzExports: typeof api;
    __ejunzPlugins?: api.PluginDefinition[];
  }
}

window.__ejunzExports = api;

async function loadPlugins() {
  let plugins: api.PluginDefinition[] = [];
  if (import.meta.env.DEV) {
    const mod = await import('virtual:ejunz-plugins');
    plugins = mod.default || [];
  } else {
    try {
      await import(/* @vite-ignore */ pluginsUrl || '/plugins.js');
      plugins = window.__ejunzPlugins || [];
    } catch (e) {
      console.warn('[Ejunz] Failed to load plugins:', e);
    }
  }

  for (const plugin of plugins) {
    console.log(`[Ejunz] Installing plugin: ${plugin.name}`);
    try {
      installPlugin(plugin);
    } catch (e) {
      console.error(`[Ejunz] Failed to install plugin ${plugin.name}:`, e);
    }
  }
}

// eslint-disable-next-line antfu/no-top-level-await
await loadPlugins();
await preloadPage(initialPage.name);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const app = <UiNextRoot initial={initialPage} />;
if (isInjected && root.hasChildNodes()) {
  hydrateRoot(root, app);
} else {
  createRoot(root).render(app);
}

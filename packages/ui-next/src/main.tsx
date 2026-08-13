/// <reference path="./vite-env.d.ts" />

import './pages';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as api from './api';
import App from './app';
import { PageDataProvider } from './context/page-data';
import { RouterProvider } from './context/router';
import { initialPage, pluginsUrl } from './globals';
import { installPlugin } from './registry';

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PageDataProvider initial={initialPage}>
      <RouterProvider>
        <App />
      </RouterProvider>
    </PageDataProvider>
  </StrictMode>,
);

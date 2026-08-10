import type { PageData } from '../context/page-data';
import type { DomPluginDefinition, DomPluginAPI, PageDefinition } from './types';

const pages = new Map<string, PageDefinition>();

export function registerPage(name: string, definition: PageDefinition): void {
  pages.set(name, definition);
}

export function installPlugin(plugin: DomPluginDefinition): void {
  plugin.setup({ registerPage } satisfies DomPluginAPI);
}

export function installPlugins(plugins: DomPluginDefinition[]): void {
  for (const plugin of plugins) installPlugin(plugin);
}

export function resolvePage(page: PageData): PageDefinition | undefined {
  if ((page.args as Record<string, unknown>).error) return pages.get('error');
  const template = page.template.replace(/\.html$/, '');
  return pages.get(template) ?? pages.get(page.name);
}

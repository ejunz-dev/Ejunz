import type { PageData } from '../context/page-data';

export interface DomRenderContext {
  page: PageData;
  args: PageData['args'];
  routeMap: Record<string, string>;
  host: string;
  escape(value: unknown): string;
  buildUrl(name: string, params?: Record<string, string | number>, search?: Record<string, string>): string;
  link(url: string, content: string, attrs?: Record<string, string>): string;
}

export interface DomMountContext extends DomRenderContext {
  navigate(url: string): Promise<void>;
}

export interface PageDefinition {
  render(context: DomRenderContext): string;
  mount?(root: HTMLElement, context: DomMountContext): void | (() => void);
}

export interface DomPluginAPI {
  registerPage(name: string, definition: PageDefinition): void;
}

export interface DomPluginDefinition {
  name: string;
  setup(api: DomPluginAPI): void;
}

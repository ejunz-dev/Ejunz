export interface BaseDetailNode {
  id: string;
  text: string;
  type?: 'normal' | 'roadmap' | string;
  parentId?: string;
  children?: string[];
  expanded?: boolean;
  level?: number;
  order?: number;
  [key: string]: unknown;
}

export interface BaseDetailEdge {
  id?: string;
  source: string;
  target: string;
  label?: string;
}

export interface BaseDetailProblem {
  pid?: string;
  type?: string;
  stem?: string;
  options?: string[];
  answer?: unknown;
  analysis?: string;
  tags?: string[];
  faceA?: string;
  faceB?: string;
  hint?: string;
  answers?: string[];
  headers?: string[];
  columns?: string[][];
  rows?: Array<{ content?: string; rowType?: string }>;
  [key: string]: unknown;
}

export interface BaseDetailCard {
  docId: string;
  cid: number;
  title: string;
  content: string;
  cardType?: string;
  fileType?: string;
  fileName?: string;
  cardFace?: string;
  updateAt?: string | Date;
  createdAt?: string | Date;
  order?: number;
  nodeId?: string;
  tags?: string[];
  problems?: BaseDetailProblem[];
  [key: string]: unknown;
}

export interface BaseDetailDoc {
  docId?: string | number;
  bid?: string | number;
  slug?: string;
  title?: string;
  content?: string;
  domainId?: string;
  nodes?: BaseDetailNode[];
  edges?: BaseDetailEdge[];
  cardTags?: string[];
  problemTags?: string[];
  [key: string]: unknown;
}

export interface BaseDetailData {
  base: BaseDetailDoc;
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  prefs: { expandedNodeIds?: string[]; [key: string]: unknown };
  socketUrl?: string;
  wsPrefix?: string;
  domainId: string;
}

export type BaseDetailI18n = (key: string, ...args: unknown[]) => string;

export interface BaseDetailDomContext {
  args: Record<string, any>;
  page?: { url?: string };
  escape(value: unknown): string;
  buildUrl(name: string, params?: Record<string, string | number>, search?: Record<string, string>): string;
  link(url: string, content: string, attrs?: Record<string, string>): string;
}

export function i18nText(i18n: BaseDetailI18n | undefined, key: string, fallback: string): string {
  const value = i18n?.(key);
  return typeof value === 'string' && value && value !== key ? value : fallback;
}

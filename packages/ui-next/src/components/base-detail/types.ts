import type { BaseDetailDisplaySettings } from './display-settings';

export interface BaseDetailNode {
  id: string;
  text?: string;
  type?: string;
  expanded?: boolean;
  order?: number;
  createdAt?: string | Date;
  updateAt?: string | Date;
}

export interface BaseDetailEdge {
  id?: string;
  source: string;
  target: string;
  order?: number;
}

export interface BaseDetailProblem {
  pid?: string;
  title?: string;
  stem?: string;
  content?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface BaseDetailCard {
  docId: string;
  cid?: number;
  title?: string;
  content?: string;
  cardFace?: string;
  cardType?: string;
  fileType?: string;
  fileName?: string;
  order?: number;
  nodeId?: string;
  tags?: string[];
  problems?: BaseDetailProblem[];
  createdAt?: string | Date;
  updateAt?: string | Date;
}

export interface BaseDetailBase {
  docId?: string | number;
  bid?: string | number;
  domainId?: string;
  slug?: string;
  title?: string;
  content?: string;
  nodes?: BaseDetailNode[];
  edges?: BaseDetailEdge[];
  cardTags?: string[];
  problemTags?: string[];
}

export interface BaseDetailPrefs extends Partial<BaseDetailDisplaySettings> {
  expandedNodeIds?: string[];
}

export interface BaseDetailData {
  base: BaseDetailBase;
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  baseDetailUiPrefs: BaseDetailPrefs;
  socketUrl?: string;
  wsPrefix: string;
  domainId: string;
}

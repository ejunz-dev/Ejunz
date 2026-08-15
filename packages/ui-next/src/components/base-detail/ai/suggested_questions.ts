import { i18n } from '@/i18n';
import type { BaseDetailEdge, BaseDetailNode } from '../types';
import { getRootNodeIds, nodeDisplayLabel } from '../tree';

export function buildBaseTutorSuggestedQuestions(
  nodes: BaseDetailNode[],
  edges: BaseDetailEdge[],
  docTitle: string,
  max = 4,
): string[] {
  const rootIds = getRootNodeIds(nodes, edges);
  const labels = rootIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is BaseDetailNode => !!node)
    .map((node) => nodeDisplayLabel(node))
    .filter(Boolean)
    .filter((label, index, arr) => arr.indexOf(label) === index);

  const fromNodes = labels.slice(0, max).map((label) => (
    i18n('Roadmap AI tutor question node', label)
  ));
  if (fromNodes.length >= 2) return fromNodes.slice(0, max);

  const fallbacks = [
    i18n('Roadmap AI tutor question overview', docTitle || i18n('Knowledge Base')),
    i18n('Roadmap AI tutor question order'),
    i18n('Roadmap AI tutor question start'),
    i18n('Roadmap AI tutor question progress'),
  ];
  return [...fromNodes, ...fallbacks].slice(0, max);
}

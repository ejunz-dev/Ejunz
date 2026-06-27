import type { BaseEdge, BaseNode } from '../types';
import { i18n } from 'vj/utils';
import { getRootNodeIds, nodeDisplayLabel } from '../detail_tree';

export function buildBaseTutorSuggestedQuestions(
  nodes: BaseNode[],
  edges: BaseEdge[],
  docTitle: string,
  max = 4,
): string[] {
  const rootIds = getRootNodeIds(nodes, edges);
  const labels = rootIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is BaseNode => !!node)
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

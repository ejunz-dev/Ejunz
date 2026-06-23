import type { Node } from 'reactflow';
import { i18n } from 'vj/utils';
import { isTextNodeType } from '../node_kinds';

export function buildRoadmapTutorSuggestedQuestions(
  nodes: Node[],
  docTitle: string,
  max = 4,
): string[] {
  const labels = nodes
    .filter((node) => node.type === 'roadmap' && !isTextNodeType(node.data?.roadmapNodeType))
    .map((node) => String(node.data?.label || '').trim())
    .filter(Boolean)
    .filter((label, index, arr) => arr.indexOf(label) === index);

  const fromNodes = labels.slice(0, max).map((label) => (
    i18n('Roadmap AI tutor question node', label)
  ));
  if (fromNodes.length >= 2) return fromNodes.slice(0, max);

  const fallbacks = [
    i18n('Roadmap AI tutor question overview', docTitle || i18n('Roadmap')),
    i18n('Roadmap AI tutor question order'),
    i18n('Roadmap AI tutor question start'),
    i18n('Roadmap AI tutor question progress'),
  ];
  return [...fromNodes, ...fallbacks].slice(0, max);
}

import type { BaseEdge, BaseNode, Card } from '../types';
import { cardDisplayLabel, findCardHostNodeId, getSortedNodeCards, nodeDisplayLabel } from '../detail_tree';

function formatCardProblems(card: Card): string {
  const problems = card.problems || [];
  if (!problems.length) return 'none';
  return problems.map((p, index) => {
    const title = String((p as { title?: string }).title || '').trim();
    const kind = String((p as { type?: string }).type || 'single');
    return `    problem ${index + 1}: pid=${p.pid} kind=${kind}${title ? ` title="${title}"` : ''}`;
  }).join('\n');
}

function nodeTypeLabel(type?: BaseNode['type']): string {
  switch (type) {
    case 'roadmap': return 'roadmap';
    default: return 'normal';
  }
}

export function convertBaseToText(
  nodes: BaseNode[],
  edges: BaseEdge[],
  nodeCardsMap: Record<string, Card[]>,
): string {
  const lines: string[] = [
    'Knowledge base document structure (tree of nodes and cards).',
    'Node types: normal (content section), roadmap (embedded roadmap container).',
    '',
    'Nodes:',
  ];
  if (!nodes.length) {
    lines.push('  (empty)');
  } else {
    nodes.forEach((node) => {
      const label = nodeDisplayLabel(node);
      const cards = getSortedNodeCards(node.id, nodeCardsMap);
      lines.push(
        `  - [${nodeTypeLabel(node.type)}] id=${node.id} label="${label}"`,
      );
      if (node.type === 'roadmap') {
        lines.push('    (contains an embedded roadmap subgraph as child nodes)');
      }
      if (cards.length) {
        cards.forEach((card, index) => {
          lines.push(`    card ${index + 1}: id=${card.docId} title="${cardDisplayLabel(card)}"`);
          lines.push(`      problems: ${formatCardProblems(card)}`);
        });
      } else {
        lines.push('    cards: (none)');
      }
    });
  }
  lines.push('', 'Edges (parent → child):');
  if (!edges.length) {
    lines.push('  (none)');
  } else {
    edges.forEach((edge) => {
      lines.push(`  - ${edge.source} → ${edge.target}`);
    });
  }
  return lines.join('\n');
}

export function buildSelectedBaseNodeContext(
  selectedNode: BaseNode | null,
  selectedCard: Card | null,
  nodes: BaseNode[],
  nodeCardsMap: Record<string, Card[]>,
): string {
  if (!selectedNode && !selectedCard) return '';

  let hostNode = selectedNode;
  if (!hostNode && selectedCard) {
    const hostId = findCardHostNodeId(selectedCard.docId, nodeCardsMap) || selectedCard.nodeId || null;
    hostNode = hostId ? nodes.find((node) => node.id === hostId) || null : null;
  }

  const label = hostNode ? nodeDisplayLabel(hostNode) : '';
  const cards = hostNode ? getSortedNodeCards(hostNode.id, nodeCardsMap) : [];
  const card = selectedCard || cards[0];
  const problems = card?.problems || [];
  const problemsText = problems.length
    ? problems.map((p, index) => {
      const title = String((p as { title?: string }).title || '').trim();
      const kindName = String((p as { type?: string }).type || 'single');
      return `  ${index + 1}. pid=${p.pid} kind=${kindName}${title ? ` title="${title}"` : ''}`;
    }).join('\n')
    : '  (none)';

  return `
[Currently selected in the reader]
${hostNode ? `- node id: ${hostNode.id}
- node type: ${nodeTypeLabel(hostNode.type)}
- node label: ${label}` : ''}
${card ? `- card id: ${card.docId}
- card title: ${cardDisplayLabel(card)}
- problems:
${problemsText}` : '- card: (none selected)'}
`;
}

export function buildBaseAiTutorSystemPrompt(options: {
  baseText: string;
  selectedNodeContext: string;
  docTitle: string;
  branch: string;
  docDescription?: string;
  semanticResults?: Array<{
    nodeId: string;
    kind: 'node' | 'card';
    cardDocId?: string;
    cardTitle?: string;
    text: string;
    score: number;
  }>;
}): string {
  const { baseText, selectedNodeContext, docTitle, branch, docDescription, semanticResults } = options;
  const descBlock = docDescription?.trim()
    ? `\n[Document description]\n${docDescription.trim()}\n`
    : '';
  const semanticBlock = semanticResults?.length
    ? `\n[Semantically relevant content — matched by similarity to the user's question]\n${
        semanticResults.map((r) =>
          r.kind === 'node'
            ? `  - [node] "${r.text}" (score: ${r.score.toFixed(2)})`
            : `  - [card]${r.cardTitle ? ` "${r.cardTitle}":` : ''} "${r.text}" (score: ${r.score.toFixed(2)})`,
        ).join('\n')
      }\n`
    : '';
  return `You are an AI tutor helping a learner understand a knowledge base document. Answer in plain, helpful language.

[Knowledge base]
- Title: ${docTitle}
- Branch: ${branch}
${descBlock}
[Document structure and summaries]
${baseText}
${selectedNodeContext}
${semanticBlock}
[Your role]
- Explain sections, cards, learning paths, and how topics connect in the document tree.
- Answer questions about practice problems at a high level (do not reveal exact quiz answers unless the user asks for explanations after attempting).
- If the user asks about a node or card, refer to it by label and explain its role.
- Embedded roadmap containers contain sub-graphs; explain them when relevant.
- If information is missing, say so briefly and suggest what they could explore next.

[Response rules]
- Reply in the same language the user uses (Chinese if they write Chinese, English if English).
- Do not output JSON or operation blocks; only natural-language answers.
- Keep answers concise unless the user asks for depth; use bullet lists when comparing options or listing steps.`;
}

export function buildBaseTutorContext(
  nodes: BaseNode[],
  edges: BaseEdge[],
  nodeCardsMap: Record<string, Card[]>,
  selectedNode: BaseNode | null,
  selectedCard: Card | null,
): { baseText: string; selectedNodeContext: string } {
  return {
    baseText: convertBaseToText(nodes, edges, nodeCardsMap),
    selectedNodeContext: buildSelectedBaseNodeContext(selectedNode, selectedCard, nodes, nodeCardsMap),
  };
}

import type { Edge, Node } from 'reactflow';
import { i18n } from 'vj/utils';
import { flowEdgeToBaseEdge, flowNodeToBaseNode } from '../shared';
import { getRoadmapNodeKind, roadmapNodeKindLabel, supportsRoadmapPracticeProblems } from '../node_kinds';
import { getNodeLane } from '../lanes';
import type { EditorCard } from '../../editor_workspace/card_problems_panel';

function formatNodeProblems(card: EditorCard | undefined): string {
  const problems = card?.problems || [];
  if (!problems.length) return 'none';
  return problems.map((p, index) => {
    const title = String((p as { title?: string }).title || '').trim();
    const kind = String((p as { type?: string }).type || 'single');
    return `    problem ${index + 1}: pid=${p.pid} kind=${kind}${title ? ` title="${title}"` : ''}`;
  }).join('\n');
}

export function convertRoadmapToText(
  nodes: Node[],
  edges: Edge[],
  nodeCardsMap: Record<string, EditorCard[]>,
): string {
  const lines: string[] = [
    'Roadmap graph (3 lanes: 1=left, 2=center, 3=right).',
    'Node kinds: main, sub, hook, text.',
    'Edge lineStyle: solid (hierarchy) or dashed (cross-link). main cannot be dashed target; sub solid only from main.',
    '',
    'Nodes:',
  ];
  if (!nodes.length) {
    lines.push('  (empty)');
  } else {
    nodes.forEach((node) => {
      const base = flowNodeToBaseNode(node);
      const kind = getRoadmapNodeKind(base.data?.roadmapNodeType);
      const lane = getNodeLane(node);
      const label = String(node.data?.label || base.text || i18n('Unnamed Node')).trim();
      lines.push(
        `  - [${kind}] id=${node.id} lane=${lane} y=${Math.round(node.position.y)} label="${label}" status=${base.data?.status || 'planned'}`,
      );
      if (base.data?.description) {
        lines.push(`    description: ${String(base.data.description).slice(0, 200)}${String(base.data.description).length > 200 ? '…' : ''}`);
      }
      if (kind === 'text' && base.data?.nodeText) {
        lines.push(`    nodeText: ${String(base.data.nodeText).slice(0, 200)}${String(base.data.nodeText).length > 200 ? '…' : ''}`);
      }
      if (supportsRoadmapPracticeProblems(kind)) {
        const card = (nodeCardsMap[node.id] || [])[0];
        lines.push(`    problems: ${formatNodeProblems(card)}`);
        if (card) lines.push(`    cardId: ${card.docId}`);
      } else {
        lines.push('    problems: (not supported for this node kind)');
      }
    });
  }
  lines.push('', 'Edges:');
  if (!edges.length) {
    lines.push('  (none)');
  } else {
    edges.forEach((edge) => {
      const base = flowEdgeToBaseEdge(edge);
      const lineStyle = base.lineStyle || 'solid';
      lines.push(
        `  - id=${edge.id} ${edge.source}(${edge.sourceHandle || '?'}) → ${edge.target}(${edge.targetHandle || '?'}) ${lineStyle}${base.label ? ` label="${base.label}"` : ''}`,
      );
    });
  }
  return lines.join('\n');
}

export function buildSelectedRoadmapNodeContext(
  selectedNode: Node | null,
  nodeCardsMap: Record<string, EditorCard[]>,
): string {
  if (!selectedNode) return '';
  const base = flowNodeToBaseNode(selectedNode);
  const kind = getRoadmapNodeKind(base.data?.roadmapNodeType);
  const label = String(selectedNode.data?.label || base.text || i18n('Unnamed Node')).trim();
  const card = supportsRoadmapPracticeProblems(kind)
    ? (nodeCardsMap[selectedNode.id] || [])[0]
    : undefined;
  const problems = card?.problems || [];
  const problemsText = !supportsRoadmapPracticeProblems(kind)
    ? '  (not supported for hook or text nodes)'
    : problems.length
    ? problems.map((p, index) => {
      const title = String((p as { title?: string }).title || '').trim();
      const kindName = String((p as { type?: string }).type || 'single');
      return `  ${index + 1}. pid=${p.pid} kind=${kindName}${title ? ` title="${title}"` : ''}`;
    }).join('\n')
    : '  (none)';
  return `
[Currently selected roadmap node]
- id: ${selectedNode.id}
- kind: ${kind} (${roadmapNodeKindLabel(kind)})
- lane: ${getNodeLane(selectedNode)}
- label: ${label}
- status: ${base.data?.status || 'planned'}
- description: ${base.data?.description || i18n('(No content)')}
${kind === 'text' ? `- nodeText: ${base.data?.nodeText || ''}` : ''}
${supportsRoadmapPracticeProblems(kind)
    ? `- cardId: ${card?.docId || `temp-card-${selectedNode.id}`}
- problems:
${problemsText}`
    : '- practice problems: not supported for this node kind'}
`;
}

export function buildRoadmapAiSystemPrompt(options: {
  roadmapText: string;
  selectedNodeContext: string;
  docTitle: string;
  branch: string;
}): string {
  const { roadmapText, selectedNodeContext, docTitle, branch } = options;
  return `You are a roadmap editor assistant. You help users edit roadmap nodes, edges, and practice problems on nodes.

[Roadmap]
- Title: ${docTitle}
- Branch: ${branch}

[Graph]
${roadmapText}
${selectedNodeContext}

[Operations you can emit]
1. create_roadmap_node — add a node near an existing one or in a lane
2. update_roadmap_node — change label, kind, status, description, nodeText, hook fields
3. delete_roadmap_node — remove a node (edges to it are removed)
4. create_roadmap_edge — connect two nodes (respect lineStyle rules)
5. update_roadmap_edge — change edge label or lineStyle
6. delete_roadmap_edge — remove an edge
7. create_problem — add or update a practice problem on a main or sub node's card (use nodeId; include pid to update)

[Response format]
When performing mutations, include a JSON code block:
\`\`\`json
{
  "operations": [
    {
      "type": "create_roadmap_node",
      "kind": "sub",
      "relativeToNodeId": "node_xxx",
      "direction": "bottom",
      "text": "New node title",
      "clientId": "n1"
    },
    {
      "type": "create_roadmap_edge",
      "source": "node_xxx",
      "target": "n1",
      "lineStyle": "solid"
    },
    {
      "type": "update_roadmap_node",
      "nodeId": "node_xxx",
      "label": "Updated title",
      "status": "in_progress",
      "description": "Markdown body for center editor"
    },
    {
      "type": "create_problem",
      "nodeId": "node_xxx",
      "title": "Short label",
      "problemKind": "single",
      "stem": "Question?",
      "options": ["A", "B", "C", "D"],
      "answer": 0,
      "analysis": "Optional"
    }
  ]
}
\`\`\`

[Rules]
- Use exact node ids and edge ids from the graph above.
- For create_roadmap_node: set kind (main|sub|hook|text). Prefer relativeToNodeId + direction (top|bottom|left|right). Optional clientId lets later ops in the same batch reference the new node before it gets a real id.
- For text nodes use nodeText (markdown) instead of description when adding body content.
- create_roadmap_edge: sourceHandle bottom→targetHandle top for vertical; right→left for horizontal dashed links.
- create_problem: only on main or sub nodes. problemKind single|multi|true_false|flip|fill_blank|matching|super_flip|chain|ai_eval. Include title (short sidebar label). Use pid only to update an existing problem on that card.
- Emit one complete JSON object per operation inside the array. Stream-friendly: finish each { ... } before starting the next.
- Reply briefly in natural language outside the JSON block; put executable ops only in JSON.`;
}

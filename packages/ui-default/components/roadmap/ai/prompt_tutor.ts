import type { Edge, Node } from 'reactflow';
import { convertRoadmapToText, buildSelectedRoadmapNodeContext } from './prompt';
import type { EditorCard } from '../../editor_workspace/card_problems_panel';

export function buildRoadmapAiTutorSystemPrompt(options: {
  roadmapText: string;
  selectedNodeContext: string;
  docTitle: string;
  branch: string;
  docDescription?: string;
}): string {
  const { roadmapText, selectedNodeContext, docTitle, branch, docDescription } = options;
  const descBlock = docDescription?.trim()
    ? `\n[Roadmap description]\n${docDescription.trim()}\n`
    : '';
  return `You are an AI tutor helping a learner understand a roadmap. Answer in plain, helpful language.

[Roadmap]
- Title: ${docTitle}
- Branch: ${branch}
${descBlock}
[Graph structure and node summaries]
${roadmapText}
${selectedNodeContext}

[Your role]
- Explain nodes, learning paths, prerequisites, and how topics connect.
- Answer questions about practice problems at a high level (do not reveal exact quiz answers unless the user asks for explanations after attempting).
- If the user asks about a node, refer to it by label and explain its role in the path.
- If information is missing from the roadmap, say so briefly and suggest what they could explore next.

[Response rules]
- Reply in the same language the user uses (Chinese if they write Chinese, English if English).
- Do not output JSON or operation blocks; only natural-language answers.
- Keep answers concise unless the user asks for depth; use bullet lists when comparing options or listing steps.`;
}

export function buildRoadmapTutorContext(
  nodes: Node[],
  edges: Edge[],
  nodeCardsMap: Record<string, EditorCard[]>,
  selectedNode: Node | null,
): { roadmapText: string; selectedNodeContext: string } {
  return {
    roadmapText: convertRoadmapToText(nodes, edges, nodeCardsMap),
    selectedNodeContext: buildSelectedRoadmapNodeContext(selectedNode, nodeCardsMap),
  };
}

import { addEdge, type Edge, type Node } from 'reactflow';
import type React from 'react';
import Notification from 'vj/components/notification';
import { i18n } from 'vj/utils';
import {
  buildEdgeForNodes,
  computeAdjacentNodePlacement,
  connectionFromEdge,
  placementYForBottom,
  placementYForTop,
  type AddAdjacentDirection,
} from '../add_adjacent';
import {
  defaultNodeDataForKind,
  ROADMAP_NODE_KINDS,
  validateRoadmapConnection,
  type RoadmapNodeKind,
} from '../node_kinds';
import { alignNodesInSolidComponents, shouldAlignSolidConnection } from '../solid_links';
import { getNodeLane, nextLaneNodeY, snapNodeToLane } from '../lanes';
import type { RoadmapEdgeLineStyle } from '../shared';
import type { EditorCard } from '../../editor_workspace/card_problems_panel';
import { applyCreateProblemOp } from './create_problem_from_op';

export interface RoadmapAiExecuteContext {
  nodes: Node[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  setSelectedNodeId: (id: string | null) => void;
  markProblemsDirty: (cardId: string) => void;
  setCardsReloadEpoch: React.Dispatch<React.SetStateAction<number>>;
  newNodeId: () => string;
  newEdgeId: (source: string, target: string) => string;
  aiCreatedNodeIdsRef: React.MutableRefObject<Map<string, string>>;
}

function resolveNodeId(raw: unknown, aiCreatedNodeIds: Map<string, string>, nodes: Node[]): string | null {
  const id = raw != null ? String(raw) : '';
  if (!id) return null;
  if (aiCreatedNodeIds.has(id)) return aiCreatedNodeIds.get(id)!;
  if (nodes.some((node) => node.id === id)) return id;
  return null;
}

function parseKind(raw: unknown): RoadmapNodeKind {
  const k = String(raw || 'sub').trim() as RoadmapNodeKind;
  return ROADMAP_NODE_KINDS.includes(k) ? k : 'sub';
}

function parseDirection(raw: unknown): AddAdjacentDirection {
  const d = String(raw || 'bottom').trim();
  if (d === 'top' || d === 'bottom' || d === 'left' || d === 'right') return d;
  return 'bottom';
}

export async function executeRoadmapAiOperations(
  operations: unknown[],
  ctx: RoadmapAiExecuteContext,
  execOpts?: { quiet?: boolean },
): Promise<{ success: boolean; errors: string[] }> {
  const quiet = Boolean(execOpts?.quiet);
  const errors: string[] = [];
  const aiCreatedNodeIds = ctx.aiCreatedNodeIdsRef.current;
  if (!quiet) aiCreatedNodeIds.clear();
  const nodeCardsMap = ((window as any).UiContext?.nodeCardsMap || {}) as Record<string, EditorCard[]>;
  const workingNodes = [...ctx.nodes];
  const workingEdges = [...ctx.edges];

  const resolveWorkingNodeId = (raw: unknown): string | null => resolveNodeId(raw, aiCreatedNodeIds, workingNodes);

  for (const raw of operations) {
    const op = raw as Record<string, unknown>;
    const type = String(op?.type || '');
    try {
      if (type === 'create_roadmap_node') {
        const kind = parseKind(op.kind);
        const relativeId = resolveWorkingNodeId(op.relativeToNodeId);
        const parentNode = relativeId ? workingNodes.find((node) => node.id === relativeId) : undefined;
        const direction = parseDirection(op.direction);
        const lane = typeof op.lane === 'number'
          ? Math.min(3, Math.max(1, Number(op.lane))) as 1 | 2 | 3
          : (parentNode ? getNodeLane(parentNode) : 2);
        const newId = ctx.newNodeId();
        const label = kind === 'text'
          ? ''
          : String(op.text || op.label || i18n('Roadmap new node')).trim() || i18n('Roadmap new node');

        let position = {
          x: 0,
          y: parentNode ? parentNode.position.y : nextLaneNodeY(workingNodes, lane),
        };
        let edgeToAdd: Edge | null = null;

        if (parentNode) {
          const placement = computeAdjacentNodePlacement(parentNode, direction, workingNodes);
          if (placement) {
            position = { ...placement.position };
            if (direction === 'bottom') {
              position.y = placementYForBottom(workingNodes, placement.lane, position.y);
            } else if (direction === 'top') {
              position.y = placementYForTop(workingNodes, placement.lane, position.y);
            }
            const sourceId = placement.sourceId || newId;
            const targetId = placement.targetId || newId;
            edgeToAdd = buildEdgeForNodes(
              sourceId,
              targetId,
              placement.sourceHandle,
              placement.targetHandle,
              sourceId === newId ? kind : parentNode.data?.roadmapNodeType,
              targetId === newId ? kind : parentNode.data?.roadmapNodeType,
              ctx.newEdgeId(sourceId, targetId),
            );
          }
        } else if (typeof op.y === 'number') {
          position.y = Number(op.y);
        }

        const newNode: Node = {
          id: newId,
          type: 'roadmap',
          position,
          data: {
            label,
            lane,
            ...defaultNodeDataForKind(kind),
            ...(op.description != null ? { description: String(op.description) } : {}),
            ...(op.nodeText != null ? { nodeText: String(op.nodeText) } : {}),
            ...(op.status != null ? { status: op.status } : {}),
          },
        };
        const snapped = snapNodeToLane(newNode, lane);
        if (op.clientId || op.tempRef) {
          aiCreatedNodeIds.set(String(op.clientId || op.tempRef), newId);
        }
        let nextNodes = [...workingNodes, snapped];
        if (edgeToAdd) {
          workingEdges.push(edgeToAdd);
          if (shouldAlignSolidConnection(connectionFromEdge(edgeToAdd))) {
            nextNodes = alignNodesInSolidComponents(nextNodes, workingEdges);
          }
        }
        workingNodes.splice(0, workingNodes.length, ...nextNodes);
        ctx.setNodes(nextNodes);
        if (edgeToAdd) {
          ctx.setEdges([...workingEdges]);
        }
        ctx.setSelectedNodeId(newId);
      } else if (type === 'update_roadmap_node') {
        const nodeId = resolveWorkingNodeId(op.nodeId);
        if (!nodeId) {
          errors.push(`update_roadmap_node: unknown nodeId ${op.nodeId}`);
          continue;
        }
        const nextNodes = workingNodes.map((node) => {
          if (node.id !== nodeId) return node;
          const patch: Record<string, unknown> = {};
          if (op.label != null || op.text != null) patch.label = String(op.label ?? op.text);
          if (op.description != null) patch.description = String(op.description);
          if (op.nodeText != null) patch.nodeText = String(op.nodeText);
          if (op.status != null) patch.status = op.status;
          if (op.priority != null) patch.priority = op.priority;
          if (op.roadmapNodeType != null || op.kind != null) {
            Object.assign(patch, defaultNodeDataForKind(parseKind(op.roadmapNodeType ?? op.kind)));
            if (op.label != null || op.text != null) patch.label = String(op.label ?? op.text);
          }
          if (op.hookRoadmapDocId != null) patch.hookRoadmapDocId = op.hookRoadmapDocId;
          if (op.hookRoadmapBranch != null) patch.hookRoadmapBranch = op.hookRoadmapBranch;
          if (op.hookRoadmapTitle != null) patch.hookRoadmapTitle = op.hookRoadmapTitle;
          return { ...node, data: { ...node.data, ...patch } };
        });
        workingNodes.splice(0, workingNodes.length, ...nextNodes);
        ctx.setNodes(nextNodes);
      } else if (type === 'delete_roadmap_node') {
        const nodeId = resolveWorkingNodeId(op.nodeId);
        if (!nodeId) {
          errors.push(`delete_roadmap_node: unknown nodeId ${op.nodeId}`);
          continue;
        }
        const nextNodes = workingNodes.filter((node) => node.id !== nodeId);
        const nextEdges = workingEdges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
        workingNodes.splice(0, workingNodes.length, ...nextNodes);
        workingEdges.splice(0, workingEdges.length, ...nextEdges);
        ctx.setNodes(nextNodes);
        ctx.setEdges(nextEdges);
      } else if (type === 'create_roadmap_edge') {
        const source = resolveWorkingNodeId(op.source);
        const target = resolveWorkingNodeId(op.target);
        if (!source || !target) {
          errors.push('create_roadmap_edge: invalid source or target');
          continue;
        }
        const sourceNode = workingNodes.find((node) => node.id === source);
        const targetNode = workingNodes.find((node) => node.id === target);
        const lineStyle = (String(op.lineStyle || 'solid') === 'dashed' ? 'dashed' : 'solid') as RoadmapEdgeLineStyle;
        if (!validateRoadmapConnection(
          targetNode?.data?.roadmapNodeType,
          lineStyle,
          true,
          sourceNode?.data?.roadmapNodeType,
        )) {
          errors.push('create_roadmap_edge: connection not allowed');
          continue;
        }
        const sourceHandle = String(op.sourceHandle || (lineStyle === 'dashed' ? 'right' : 'bottom'));
        const targetHandle = String(op.targetHandle || (lineStyle === 'dashed' ? 'left' : 'top'));
        const edge = buildEdgeForNodes(
          source,
          target,
          sourceHandle,
          targetHandle,
          sourceNode?.data?.roadmapNodeType,
          targetNode?.data?.roadmapNodeType,
          op.edgeId ? String(op.edgeId) : ctx.newEdgeId(source, target),
        );
        const nextEdges = addEdge(edge, workingEdges);
        workingEdges.splice(0, workingEdges.length, ...nextEdges);
        ctx.setEdges(nextEdges);
        if (shouldAlignSolidConnection(connectionFromEdge(edge))) {
          const aligned = alignNodesInSolidComponents(workingNodes, nextEdges);
          workingNodes.splice(0, workingNodes.length, ...aligned);
          ctx.setNodes(aligned);
        }
      } else if (type === 'update_roadmap_edge') {
        const edgeId = String(op.edgeId || '');
        if (!workingEdges.some((item) => item.id === edgeId)) {
          errors.push(`update_roadmap_edge: unknown edge ${edgeId}`);
          continue;
        }
        const nextEdges = workingEdges.map((item) => {
          if (item.id !== edgeId) return item;
          const nextLineStyle = op.lineStyle != null
            ? (String(op.lineStyle) === 'dashed' ? 'dashed' : 'solid') as RoadmapEdgeLineStyle
            : undefined;
          const nextStyle = { ...(item.style || {}) } as Record<string, string | number>;
          if (nextLineStyle === 'dashed') nextStyle.strokeDasharray = '8 6';
          else if (nextLineStyle === 'solid') delete nextStyle.strokeDasharray;
          return {
            ...item,
            ...(op.label != null ? { label: String(op.label) } : {}),
            ...(nextLineStyle ? {
              type: nextLineStyle === 'dashed' ? 'default' : 'straight',
              data: { ...(item.data || {}), lineStyle: nextLineStyle },
              style: nextStyle,
            } : {}),
          };
        });
        workingEdges.splice(0, workingEdges.length, ...nextEdges);
        ctx.setEdges(nextEdges);
      } else if (type === 'delete_roadmap_edge') {
        const edgeId = String(op.edgeId || '');
        const nextEdges = workingEdges.filter((item) => item.id !== edgeId);
        workingEdges.splice(0, workingEdges.length, ...nextEdges);
        ctx.setEdges(nextEdges);
      } else if (type === 'create_problem') {
        const result = applyCreateProblemOp(op, nodeCardsMap, aiCreatedNodeIds);
        if (result.error) {
          errors.push(result.error);
          continue;
        }
        if (result.cardId) ctx.markProblemsDirty(result.cardId);
        ctx.setCardsReloadEpoch((epoch) => epoch + 1);
      } else {
        errors.push(`Unknown operation type: ${type}`);
      }
    } catch (err: any) {
      errors.push(err?.message || String(err));
    }
  }

  if ((window as any).UiContext) {
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
  }

  if (!quiet && errors.length === 0 && operations.length > 0) {
    Notification.success(i18n('Roadmap AI operations applied'));
  }
  if (errors.length && !quiet) {
    Notification.error(errors[0]);
  }
  return { success: errors.length === 0, errors };
}

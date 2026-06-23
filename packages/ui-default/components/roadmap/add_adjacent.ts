import type { Connection, Edge, Node } from 'reactflow';
import {
  getNodeLane,
  getRoadmapNodeWidth,
  laneNodeX,
  LANE_ADD_GAP,
  LANE_NODE_HEIGHT,
  LANE_START_Y,
  nextLaneNodeY,
  snapNodeToLane,
  type RoadmapLane,
} from './lanes';
import {
  inferConnectionLineStyle,
  type RoadmapNodeKind,
} from './node_kinds';
import {
  roadmapEdgeDashStyle,
  roadmapFlowEdgeType,
  type RoadmapEdgeLineStyle,
} from './shared';
import { shouldAlignSolidConnection } from './solid_links';

export type AddAdjacentDirection = 'top' | 'bottom' | 'left' | 'right';

export function oppositeAddDirection(direction: AddAdjacentDirection): AddAdjacentDirection {
  switch (direction) {
    case 'top': return 'bottom';
    case 'bottom': return 'top';
    case 'left': return 'right';
    case 'right': return 'left';
    default: return 'bottom';
  }
}

function handlesForDirection(direction: AddAdjacentDirection): {
  sourceHandle: string;
  targetHandle: string;
} {
  switch (direction) {
    case 'bottom':
      return { sourceHandle: 'bottom', targetHandle: 'top' };
    case 'top':
      return { sourceHandle: 'bottom', targetHandle: 'top' };
    case 'right':
      return { sourceHandle: 'right', targetHandle: 'left' };
    case 'left':
      return { sourceHandle: 'right', targetHandle: 'left' };
    default:
      return { sourceHandle: 'bottom', targetHandle: 'top' };
  }
}

export function computeAdjacentNodePlacement(
  sourceNode: Node,
  direction: AddAdjacentDirection,
  nodes: Node[],
): {
  lane: RoadmapLane;
  position: { x: number; y: number };
  sourceId: string;
  targetId: string;
  sourceHandle: string;
  targetHandle: string;
} | null {
  const lane = getNodeLane(sourceNode);
  const nodeWidth = getRoadmapNodeWidth(sourceNode);
  const handles = handlesForDirection(direction);

  if (direction === 'bottom') {
    const y = sourceNode.position.y + LANE_ADD_GAP;
    return {
      lane,
      position: { x: laneNodeX(lane, nodeWidth), y },
      sourceId: sourceNode.id,
      targetId: '',
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
    };
  }

  if (direction === 'top') {
    const y = Math.max(LANE_START_Y, sourceNode.position.y - LANE_ADD_GAP);
    return {
      lane,
      position: { x: laneNodeX(lane, nodeWidth), y },
      sourceId: '',
      targetId: sourceNode.id,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
    };
  }

  if (direction === 'right') {
    if (lane >= 3) return null;
    const nextLane = (lane + 1) as RoadmapLane;
    const nextWidth = nodeWidth;
    return {
      lane: nextLane,
      position: {
        x: laneNodeX(nextLane, nextWidth),
        y: sourceNode.position.y,
      },
      sourceId: sourceNode.id,
      targetId: '',
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
    };
  }

  if (lane <= 1) return null;
  const prevLane = (lane - 1) as RoadmapLane;
  return {
    lane: prevLane,
    position: {
      x: laneNodeX(prevLane, nodeWidth),
      y: sourceNode.position.y,
    },
    sourceId: '',
    targetId: sourceNode.id,
    sourceHandle: handles.sourceHandle,
    targetHandle: handles.targetHandle,
  };
}

export function buildEdgeForNodes(
  sourceId: string,
  targetId: string,
  sourceHandle: string,
  targetHandle: string,
  sourceType?: string,
  targetType?: string,
  edgeId?: string,
): Edge {
  const lineStyle = inferConnectionLineStyle(sourceType, targetType);
  const id = edgeId || `edge_${sourceId}_${targetId}`;
  return {
    id,
    source: sourceId,
    target: targetId,
    sourceHandle,
    targetHandle,
    type: roadmapFlowEdgeType(lineStyle),
    data: { lineStyle },
    style: {
      stroke: '#2b78e4',
      strokeWidth: 3,
      ...(lineStyle === 'dashed' ? roadmapEdgeDashStyle('dashed') : {}),
    },
    animated: false,
  };
}

export function connectionFromEdge(edge: Edge): Connection {
  return {
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle || null,
    targetHandle: edge.targetHandle || null,
  };
}

export function snapAdjacentNodes(
  nodes: Node[],
  edges: Edge[],
  newNodeId: string,
  placementLane: RoadmapLane,
): Node[] {
  const snapped = nodes.map((node) => {
    if (node.id !== newNodeId) return node;
    return snapNodeToLane(node, placementLane);
  });
  return snapped;
}

export function minYForLane(nodes: Node[], lane: RoadmapLane): number {
  const laneNodes = nodes.filter((node) => getNodeLane(node) === lane);
  if (!laneNodes.length) return LANE_START_Y;
  return Math.max(...laneNodes.map((node) => node.position.y + LANE_NODE_HEIGHT));
}

export function placementYForBottom(nodes: Node[], lane: RoadmapLane, fallbackY: number): number {
  const nextY = nextLaneNodeY(nodes, lane);
  return Math.max(nextY, fallbackY);
}

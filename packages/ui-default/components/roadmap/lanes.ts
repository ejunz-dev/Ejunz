import type { Node } from 'reactflow';

export type RoadmapLane = 1 | 2 | 3;

export const ROADMAP_LANES: RoadmapLane[] = [1, 2, 3];
export const LANE_WIDTH = 280;
export const LANE_GAP = 48;
export const LANE_START_X = 40;
export const LANE_START_Y = 72;
export const LANE_ADD_GAP = 120;
export const LANE_GUIDE_HEIGHT = 2400;
export const LANE_NODE_WIDTH = 260;
export const LANE_NODE_HEIGHT = 48;

export function laneRegionX(lane: RoadmapLane): number {
  return LANE_START_X + (lane - 1) * (LANE_WIDTH + LANE_GAP);
}

export function laneCenterX(lane: RoadmapLane): number {
  return laneRegionX(lane) + (LANE_WIDTH - LANE_NODE_WIDTH) / 2;
}

export function nearestLaneFromX(x: number): RoadmapLane {
  let best: RoadmapLane = 1;
  let min = Infinity;
  ROADMAP_LANES.forEach((lane) => {
    const dist = Math.abs(x - laneCenterX(lane));
    if (dist < min) {
      min = dist;
      best = lane;
    }
  });
  return best;
}

export function getNodeLane(node: Node): RoadmapLane {
  const lane = Number(node.data?.lane);
  if (lane >= 1 && lane <= 3) return lane as RoadmapLane;
  return nearestLaneFromX(node.position.x);
}

export function isRoadmapFlowNode(node: Node): boolean {
  return node.type === 'roadmap';
}

export function snapNodeToLane(node: Node, lane?: RoadmapLane): Node {
  const resolvedLane = lane ?? getNodeLane(node);
  return {
    ...node,
    position: {
      x: laneCenterX(resolvedLane),
      y: node.position.y,
    },
    data: {
      ...node.data,
      lane: resolvedLane,
    },
  };
}

export function snapRoadmapNodesToLanes(nodes: Node[], movedNodeId?: string): Node[] {
  return nodes
    .filter(isRoadmapFlowNode)
    .map((node) => {
      const lane = movedNodeId === node.id
        ? nearestLaneFromX(node.position.x)
        : getNodeLane(node);
      return snapNodeToLane(node, lane);
    });
}

export function nextLaneNodeY(nodes: Node[], lane: RoadmapLane): number {
  const laneNodes = nodes.filter((node) => getNodeLane(node) === lane);
  if (!laneNodes.length) return LANE_START_Y;
  return Math.max(...laneNodes.map((node) => node.position.y)) + LANE_ADD_GAP;
}

export function estimateLaneLayoutHeight(nodes: Node[]): number {
  const roadmapNodes = nodes.filter(isRoadmapFlowNode);
  if (!roadmapNodes.length) return LANE_START_Y + LANE_NODE_HEIGHT + 80;
  const maxY = Math.max(...roadmapNodes.map((node) => node.position.y));
  return maxY + LANE_NODE_HEIGHT + 80;
}

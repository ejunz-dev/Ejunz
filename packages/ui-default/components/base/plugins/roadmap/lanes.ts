import type { Node } from 'reactflow';

export type RoadmapLane = 1 | 2 | 3;

export const ROADMAP_LANES: RoadmapLane[] = [1, 2, 3];
export const LANE_WIDTH = 280;
export const LANE_GAP = 48;
export const LANE_START_X = 40;
export const LANE_START_Y = 72;
export const LANE_ADD_GAP = 120;
export const ADJACENT_VERTICAL_GAP = 32;
export const LANE_GUIDE_HEIGHT = 2400;
export const LANE_NODE_WIDTH = 260;
export const LANE_NODE_HEIGHT = 48;

/** Horizontal center of the middle lane — the canvas axis. */
export const ROADMAP_LANE_AXIS_X = LANE_START_X + LANE_WIDTH + LANE_GAP + LANE_WIDTH / 2;

export const ROADMAP_LANES_SPAN_WIDTH = ROADMAP_LANES.length * LANE_WIDTH
  + (ROADMAP_LANES.length - 1) * LANE_GAP;

export function laneRegionX(lane: RoadmapLane): number {
  return LANE_START_X + (lane - 1) * (LANE_WIDTH + LANE_GAP);
}

export function laneCenterAxisX(lane: RoadmapLane): number {
  return laneRegionX(lane) + LANE_WIDTH / 2;
}

export function laneNodeX(lane: RoadmapLane, nodeWidth = LANE_NODE_WIDTH): number {
  return laneRegionX(lane) + (LANE_WIDTH - nodeWidth) / 2;
}

export function laneCenterX(lane: RoadmapLane): number {
  return laneNodeX(lane, LANE_NODE_WIDTH);
}

export function getRoadmapNodeHeight(node: Node): number {
  if (typeof node.height === 'number' && node.height > 0) return node.height;
  const measured = (node as Node & { measured?: { height?: number } }).measured?.height;
  if (typeof measured === 'number' && measured > 0) return measured;
  return LANE_NODE_HEIGHT;
}

export function getRoadmapNodeWidth(node: Node): number {
  if (typeof node.width === 'number' && node.width > 0) return node.width;
  const measured = (node as Node & { measured?: { width?: number } }).measured?.width;
  if (typeof measured === 'number' && measured > 0) return measured;
  return LANE_NODE_WIDTH;
}

/** Lane snap uses persisted width only — ignore React Flow measured sizes. */
export function getSnapLaneNodeWidth(node: Node): number {
  if (typeof node.width === 'number' && node.width > 0) return node.width;
  return LANE_NODE_WIDTH;
}

export function nearestLaneFromX(x: number): RoadmapLane {
  let best: RoadmapLane = 1;
  let min = Infinity;
  ROADMAP_LANES.forEach((lane) => {
    const dist = Math.abs(x - laneCenterAxisX(lane));
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
  return nearestLaneFromX(node.position.x + getRoadmapNodeWidth(node) / 2);
}

export function isRoadmapFlowNode(node: Node): boolean {
  return node.type === 'roadmap';
}

export function snapNodeToLane(node: Node, lane?: RoadmapLane): Node {
  const resolvedLane = lane ?? getNodeLane(node);
  const nodeWidth = getSnapLaneNodeWidth(node);
  return {
    ...node,
    position: {
      x: laneNodeX(resolvedLane, nodeWidth),
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
        ? nearestLaneFromX(node.position.x + getRoadmapNodeWidth(node) / 2)
        : getNodeLane(node);
      return snapNodeToLane(node, lane);
    });
}

export function nextLaneNodeY(nodes: Node[], lane: RoadmapLane): number {
  const laneNodes = nodes.filter((node) => getNodeLane(node) === lane);
  if (!laneNodes.length) return LANE_START_Y;
  return Math.max(...laneNodes.map((node) => node.position.y + getRoadmapNodeHeight(node))) + LANE_ADD_GAP;
}

export function estimateLaneLayoutHeight(nodes: Node[]): number {
  const roadmapNodes = nodes.filter(isRoadmapFlowNode);
  if (!roadmapNodes.length) return LANE_START_Y + LANE_NODE_HEIGHT + 80;
  const maxY = Math.max(...roadmapNodes.map((node) => node.position.y));
  return maxY + LANE_NODE_HEIGHT + 80;
}

export function estimateRoadmapLaneGuideHeight(nodes: Node[]): number {
  return Math.max(LANE_GUIDE_HEIGHT, estimateLaneLayoutHeight(nodes));
}

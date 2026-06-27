import type { BaseEdge, BaseNode, PendingCreate } from 'vj/components/base/types';
import { allocateDefaultMainNodeNumber } from './node_numbering';
import { laneNodeX, LANE_START_Y } from './lanes';
import { defaultNodeDataForKind } from './node_kinds';
import { roadmapUntitledCardLabel } from './shared';

export const DEFAULT_ROADMAP_MAIN_LANE = 2 as const;

export function buildDefaultRoadmapMainCanvasSeed(
  roadmapNodeId: string,
  existingCanvasNodes: BaseNode[] = [],
): {
  mainNode: BaseNode;
  mainEdge: BaseEdge;
  pendingCreate: PendingCreate;
} {
  const mainTempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const posX = laneNodeX(DEFAULT_ROADMAP_MAIN_LANE);
  const posY = LANE_START_Y;
  const data = {
    ...defaultNodeDataForKind('main'),
    nodeNumber: allocateDefaultMainNodeNumber(existingCanvasNodes),
    lane: DEFAULT_ROADMAP_MAIN_LANE,
    posX,
    posY,
  };
  const text = roadmapUntitledCardLabel();

  return {
    mainNode: {
      id: mainTempId,
      text,
      x: posX,
      y: posY,
      data,
    },
    mainEdge: {
      id: `temp-edge-tree-${roadmapNodeId}-${mainTempId}`,
      source: roadmapNodeId,
      target: mainTempId,
    },
    pendingCreate: {
      type: 'node',
      nodeId: roadmapNodeId,
      text,
      tempId: mainTempId,
      data,
    },
  };
}

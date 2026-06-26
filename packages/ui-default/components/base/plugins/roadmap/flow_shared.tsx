import React from 'react';
import {
  Edge,
  Handle,
  Node,
  NodeProps,
  NodeResizer,
  NodeTypes,
  Position,
  useStore,
} from 'reactflow';
import {
  LANE_GUIDE_HEIGHT,
  LANE_WIDTH,
  laneRegionX,
  ROADMAP_LANES,
} from './lanes';
import { roadmapEdgeDashStyle, roadmapEdgeLineStyleFromStyle, roadmapUntitledCardLabel } from './shared';
import { getRoadmapNodeKind, isSubNodeType } from './node_kinds';
import type { AddAdjacentDirection } from './add_adjacent';
import { RoadmapTextNodeLead } from './RoadmapTextNodeLead';

let resizeObserverGuardInstalled = false;

export function installRoadmapResizeObserverErrorGuard() {
  if (resizeObserverGuardInstalled || typeof window === 'undefined') return;
  resizeObserverGuardInstalled = true;
  window.addEventListener('error', (event) => {
    if (event.message?.includes('ResizeObserver loop')) {
      event.stopImmediatePropagation();
    }
  });
}

export const RoadmapShNode = ({ data, selected }: NodeProps) => {
  const kind = getRoadmapNodeKind(data.roadmapNodeType);
  const titleText = String(data.label || roadmapUntitledCardLabel());
  const isTextKind = kind === 'text';
  const showResizer = isSubNodeType(data.roadmapNodeType) && selected && !data.isPendingGhost;
  const editable = Boolean(data.editable) && !data.isPendingGhost;
  const hookUrl = String(data.hookRoadmapUrl || '').trim();
  const isHookLink = kind === 'hook' && !editable && hookUrl;
  const onRequestAddAdjacent = data.onRequestAddAdjacent as
    | ((direction: AddAdjacentDirection, event: React.MouseEvent) => void)
    | undefined;
  const blockedAddDirections = new Set(
    (data.blockedAddDirections as AddAdjacentDirection[] | undefined) || [],
  );
  const showProblemCountBadge = Boolean(data.showProblemCountBadge);
  const problemCount = typeof data.problemCount === 'number' ? data.problemCount : 0;
  const showNodeNumber = Boolean(data.showNodeNumber);
  const nodeNumber = String(data.nodeNumber || '');

  const numberBadge = showNodeNumber && nodeNumber ? (
    <span
      className="roadmap-sh-node__number"
      aria-label={nodeNumber}
      title={nodeNumber}
    >
      {nodeNumber}
    </span>
  ) : null;

  const problemBadge = showProblemCountBadge ? (
    <span
      className="roadmap-sh-node__problem-badge"
      aria-label={String(problemCount)}
      title={String(problemCount)}
    >
      {problemCount}
    </span>
  ) : null;

  const plusBtn = (direction: AddAdjacentDirection, className: string) => {
    if (blockedAddDirections.has(direction)) return null;
    return (
      <button
        type="button"
        className={`roadmap-sh-node__add ${className}`}
        aria-label={direction}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onRequestAddAdjacent?.(direction, event);
        }}
      >
        +
      </button>
    );
  };

  const nodeClassName = `roadmap-sh-node roadmap-sh-node--kind-${kind}${isHookLink ? ' roadmap-sh-node--hook-link' : ''} ${selected ? 'is-selected' : ''}`;

  const nodeBody = (
    <>
      {numberBadge}
      {problemBadge}
      {showResizer ? (
        <NodeResizer
          minWidth={180}
          maxWidth={520}
          isVisible={selected}
          lineClassName="roadmap-sh-node__resize-line"
          handleClassName="roadmap-sh-node__resize-handle"
        />
      ) : null}
      <Handle type="target" position={Position.Top} id="top" className="roadmap-sh-node__handle" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="roadmap-sh-node__handle" />
      <Handle type="target" position={Position.Left} id="left" className="roadmap-sh-node__handle" />
      <Handle type="source" position={Position.Right} id="right" className="roadmap-sh-node__handle" />
      {editable ? (
        <>
          {plusBtn('top', 'roadmap-sh-node__add--top')}
          {plusBtn('bottom', 'roadmap-sh-node__add--bottom')}
          {plusBtn('left', 'roadmap-sh-node__add--left')}
          {plusBtn('right', 'roadmap-sh-node__add--right')}
        </>
      ) : null}
      {isTextKind ? (
        <RoadmapTextNodeLead markdown={String(data.nodeText || '')} />
      ) : (
        <div className="roadmap-sh-node__title">{titleText}</div>
      )}
      {kind === 'hook' && editable && data.hookRoadmapTitle && String(data.hookRoadmapTitle) !== titleText ? (
        <div className="roadmap-sh-node__hook-target">{String(data.hookRoadmapTitle)}</div>
      ) : null}
    </>
  );

  if (isHookLink) {
    return (
      <a
        className={nodeClassName}
        href={hookUrl}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {nodeBody}
      </a>
    );
  }

  return (
    <div className={nodeClassName}>
      {nodeBody}
    </div>
  );
};

export const roadmapShNodeTypes: NodeTypes = { roadmap: RoadmapShNode };

function RoadmapLaneGuidesWorld({
  guideHeight,
  x,
  y,
  zoom,
}: {
  guideHeight: number;
  x: number;
  y: number;
  zoom: number;
}) {
  return (
    <div
      className="roadmap-lane-overlay__world"
      style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}
    >
      {ROADMAP_LANES.map((lane) => (
        <div
          key={lane}
          className="roadmap-lane-guide"
          style={{
            left: laneRegionX(lane),
            width: LANE_WIDTH,
            height: guideHeight,
          }}
        >
          <div className="roadmap-lane-guide__label">{lane}</div>
        </div>
      ))}
    </div>
  );
}

export function RoadmapLaneOverlay({ guideHeight }: { guideHeight?: number }) {
  const transform = useStore((state) => state.transform);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const [tx, ty, zoom] = transform;

  return (
    <div className="roadmap-lane-overlay" style={{ width, height }}>
      <RoadmapLaneGuidesWorld
        guideHeight={guideHeight ?? LANE_GUIDE_HEIGHT}
        x={tx}
        y={ty}
        zoom={zoom}
      />
    </div>
  );
}

export function toRoadmapViewNodes(
  nodes: Node[],
  selectedNodeId?: string | null,
): Node[] {
  return nodes.map((node) => ({
    ...node,
    selected: node.id === selectedNodeId,
  }));
}

function roadmapFlowEdgeStroke(isSelected: boolean, theme: 'light' | 'dark' = 'light'): string {
  const isDark = theme === 'dark';
  if (isSelected) return isDark ? '#8ec5ff' : '#1a5fb4';
  return isDark ? '#6eb3ff' : '#2b78e4';
}

export function toRoadmapViewEdges(
  edges: Edge[],
  selectedEdgeId?: string | null,
  _pending?: unknown,
  theme: 'light' | 'dark' = 'light',
): Edge[] {
  return edges.map((edge) => {
    const isSelected = edge.id === selectedEdgeId;
    const lineStyle = roadmapEdgeLineStyleFromStyle(edge.style as Record<string, any>);
    const lineDashStyle = lineStyle === 'dashed' ? roadmapEdgeDashStyle('dashed') : {};
    return {
      ...edge,
      type: lineStyle === 'dashed' ? 'default' : 'straight',
      selected: isSelected,
      interactionWidth: 24,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      style: {
        stroke: roadmapFlowEdgeStroke(isSelected, theme),
        strokeWidth: isSelected ? 4 : 3,
        ...lineDashStyle,
      },
      markerEnd: undefined,
      data: {
        ...(edge.data || {}),
        lineStyle,
      },
    };
  });
}

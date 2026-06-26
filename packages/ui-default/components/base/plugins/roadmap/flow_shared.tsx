import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Edge,
  Handle,
  Node,
  NodeProps,
  NodeResizer,
  NodeTypes,
  Position,
  ReactFlowInstance,
  useStore,
  Viewport,
} from 'reactflow';
import {
  LANE_GUIDE_HEIGHT,
  LANE_WIDTH,
  laneRegionX,
  ROADMAP_LANE_AXIS_X,
  ROADMAP_LANES,
  ROADMAP_LANES_SPAN_WIDTH,
} from './lanes';
import { roadmapEdgeDashStyle, roadmapEdgeLineStyleFromStyle, roadmapUntitledCardLabel } from './shared';
import { getRoadmapNodeKind, isSubNodeType } from './node_kinds';
import type { AddAdjacentDirection } from './add_adjacent';
import { RoadmapTextNodeLead } from './RoadmapTextNodeLead';

let resizeObserverGuardInstalled = false;

function isResizeObserverLoopError(message: string | undefined): boolean {
  return Boolean(message?.includes('ResizeObserver loop'));
}

export function installRoadmapResizeObserverErrorGuard() {
  if (resizeObserverGuardInstalled || typeof window === 'undefined') return;
  resizeObserverGuardInstalled = true;

  const suppressErrorEvent = (event: ErrorEvent) => {
    if (!isResizeObserverLoopError(event.message)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  };

  window.addEventListener('error', suppressErrorEvent, true);
  window.addEventListener('error', suppressErrorEvent, false);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? '');
    if (!isResizeObserverLoopError(message)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  const previousOnError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    const msg = typeof message === 'string' ? message : String(message ?? '');
    if (isResizeObserverLoopError(msg) || isResizeObserverLoopError(error?.message)) {
      return true;
    }
    if (typeof previousOnError === 'function') {
      return previousOnError.call(window, message, source, lineno, colno, error) ?? false;
    }
    return false;
  };
}

if (typeof window !== 'undefined') {
  installRoadmapResizeObserverErrorGuard();
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
  const isPendingUpdate = Boolean(data.isPendingUpdate);

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

  const nodeClassName = `roadmap-sh-node roadmap-sh-node--kind-${kind}${isPendingUpdate ? ' roadmap-sh-node--pending-update' : ''}${isHookLink ? ' roadmap-sh-node--hook-link' : ''} ${selected ? 'is-selected' : ''}`;

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
  pendingNodeIds?: ReadonlySet<string>,
): Node[] {
  return nodes.map((node) => ({
    ...node,
    selected: node.id === selectedNodeId,
    data: {
      ...node.data,
      isPendingUpdate: Boolean(pendingNodeIds?.has(node.id)),
    },
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
  pendingEdgeIds?: ReadonlySet<string>,
  theme: 'light' | 'dark' = 'light',
): Edge[] {
  return edges.map((edge) => {
    const isSelected = edge.id === selectedEdgeId;
    const isPending = Boolean(pendingEdgeIds?.has(edge.id));
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
        stroke: isPending ? '#ff9800' : roadmapFlowEdgeStroke(isSelected, theme),
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

export const FLOW_PADDING = 48;
export const NODE_LAYOUT_HEIGHT = 48;

function computeRoadmapContentBounds(nodes: Node[]) {
  let minY = Infinity;
  let maxY = -Infinity;

  nodes.forEach((node) => {
    const height = node.height || NODE_LAYOUT_HEIGHT;
    minY = Math.min(minY, node.position.y);
    maxY = Math.max(maxY, node.position.y + height);
  });

  return {
    y: minY,
    height: Math.max(maxY - minY, NODE_LAYOUT_HEIGHT),
  };
}

export function computeRoadmapAxisViewport(
  nodes: Node[],
  containerWidth: number,
  containerHeight: number,
  options?: { padding?: number; maxZoom?: number },
): Viewport {
  const padding = options?.padding ?? 0.15;
  const maxZoom = options?.maxZoom ?? 2;
  const width = Math.max(containerWidth, 320);
  const height = Math.max(containerHeight, 320);
  const innerWidth = Math.max(width * (1 - padding * 2), 320);
  const innerHeight = Math.max(height * (1 - padding * 2), 240);
  const content = nodes.length ? computeRoadmapContentBounds(nodes) : { y: 0, height: NODE_LAYOUT_HEIGHT };
  const zoomX = innerWidth / ROADMAP_LANES_SPAN_WIDTH;
  const zoomY = innerHeight / content.height;
  const zoom = Math.min(maxZoom, zoomX, zoomY);
  const x = width / 2 - ROADMAP_LANE_AXIS_X * zoom;
  const y = (height - content.height * zoom) / 2 - content.y * zoom;

  return { x, y, zoom };
}

function deferViewportUpdate(run: () => void) {
  requestAnimationFrame(() => {
    requestAnimationFrame(run);
  });
}

function useContainerSize(outerRef: React.RefObject<HTMLDivElement>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    installRoadmapResizeObserverErrorGuard();

    let outerRafId = 0;
    let innerRafId = 0;
    const syncSize = () => {
      if (outerRafId) cancelAnimationFrame(outerRafId);
      if (innerRafId) cancelAnimationFrame(innerRafId);
      outerRafId = requestAnimationFrame(() => {
        innerRafId = requestAnimationFrame(() => {
          outerRafId = 0;
          innerRafId = 0;
          const el = outerRef.current;
          if (!el) return;
          const nextWidth = el.clientWidth;
          const nextHeight = el.clientHeight;
          setSize((prev) => (
            prev.width === nextWidth && prev.height === nextHeight
              ? prev
              : { width: nextWidth, height: nextHeight }
          ));
        });
      });
    };

    syncSize();
    window.addEventListener('resize', syncSize);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && outerRef.current) {
      observer = new ResizeObserver(() => {
        syncSize();
      });
      observer.observe(outerRef.current);
    }
    return () => {
      if (outerRafId) cancelAnimationFrame(outerRafId);
      if (innerRafId) cancelAnimationFrame(innerRafId);
      window.removeEventListener('resize', syncSize);
      observer?.disconnect();
    };
  }, [outerRef]);

  return size;
}

export function useRoadmapEditorLayout(nodes: Node[]) {
  const outerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const { width: containerWidth, height: containerHeight } = useContainerSize(outerRef);
  const lastFitKeyRef = useRef('');

  const applyAxisViewport = useCallback((instance: ReactFlowInstance, duration = 0) => {
    if (!containerWidth || !containerHeight) return;
    const viewport = computeRoadmapAxisViewport(nodes, containerWidth, containerHeight, {
      padding: 0.15,
      maxZoom: 2,
    });
    instance.setViewport(viewport, { duration });
  }, [containerHeight, containerWidth, nodes]);

  const fitToContent = useCallback(() => {
    const instance = flowRef.current;
    if (!instance) return;
    applyAxisViewport(instance, 200);
  }, [applyAxisViewport]);

  useEffect(() => {
    const instance = flowRef.current;
    if (!instance || !containerWidth || !containerHeight) return;
    const fitKey = `${containerWidth}:${containerHeight}`;
    if (fitKey === lastFitKeyRef.current) return;
    lastFitKeyRef.current = fitKey;
    deferViewportUpdate(() => {
      applyAxisViewport(instance, 0);
    });
  }, [applyAxisViewport, containerHeight, containerWidth]);

  const onFlowInit = useCallback((instance: ReactFlowInstance) => {
    flowRef.current = instance;
    deferViewportUpdate(() => {
      applyAxisViewport(instance, 0);
    });
  }, [applyAxisViewport]);

  return {
    outerRef,
    flowRef,
    onFlowInit,
    fitToContent,
  };
}

export const roadmapEditorFlowProps = {
  panOnDrag: true as const,
  panOnScroll: false as const,
  zoomOnScroll: true as const,
  zoomOnPinch: true as const,
  zoomOnDoubleClick: true as const,
  preventScrolling: true as const,
  minZoom: 0.25,
  maxZoom: 2,
  proOptions: { hideAttribution: true as const },
};

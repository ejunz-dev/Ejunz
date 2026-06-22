import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Edge,
  Handle,
  Node,
  NodeProps,
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
import { roadmapEdgeLineStyleFromStyle, RoadmapStatus, roadmapUntitledNodeLabel } from './shared';
import {
  ROADMAP_PENDING_COLORS,
  resolveRoadmapEdgePendingStatus,
  type RoadmapPendingStatus,
  type RoadmapPendingStatusMaps,
} from './pending_changes';
import { readEditorTheme, type EditorTheme } from '../editor_workspace/theme';

export const FLOW_PADDING = 48;
export const NODE_LAYOUT_WIDTH = 260;
export const NODE_LAYOUT_HEIGHT = 48;

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

export interface RoadmapScrollLayout {
  height: number;
  viewport: Viewport;
  zoom: number;
}

export const RoadmapShNode = ({ data, selected }: NodeProps) => {
  const status = (data.status || 'planned') as RoadmapStatus;
  const pendingStatus = data.pendingStatus as RoadmapPendingStatus | undefined;
  const pendingClass = pendingStatus ? ` roadmap-sh-node--pending-${pendingStatus}` : '';
  const ghostClass = data.isPendingGhost ? ' roadmap-sh-node--pending-ghost' : '';
  return (
    <div className={`roadmap-sh-node roadmap-sh-node--${status}${pendingClass}${ghostClass} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Top} id="top" className="roadmap-sh-node__handle" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="roadmap-sh-node__handle" />
      <Handle type="target" position={Position.Left} id="left" className="roadmap-sh-node__handle" />
      <Handle type="source" position={Position.Right} id="right" className="roadmap-sh-node__handle" />
      <div className="roadmap-sh-node__title">{data.label || roadmapUntitledNodeLabel()}</div>
    </div>
  );
};

export const roadmapShNodeTypes: NodeTypes = { roadmap: RoadmapShNode };

export const roadmapFlowNodeTypes: NodeTypes = { roadmap: RoadmapShNode };

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
  pending?: RoadmapPendingStatusMaps,
): Node[] {
  return nodes.map((node) => {
    const pendingStatus = pending?.nodeStatus.get(node.id);
    return {
      ...node,
      selected: node.id === selectedNodeId,
      data: {
        ...node.data,
        ...(pendingStatus ? { pendingStatus } : {}),
      },
    };
  });
}

function roadmapEdgePendingStyle(pendingStatus: RoadmapPendingStatus, isSelected: boolean) {
  return {
    stroke: ROADMAP_PENDING_COLORS[pendingStatus],
    strokeWidth: isSelected ? 4 : 3,
    strokeDasharray: '5,5',
  };
}

function roadmapFlowEdgeStroke(theme: EditorTheme, isSelected: boolean): string {
  const isDark = theme === 'dark';
  if (isSelected) return isDark ? '#8ec5ff' : '#1a5fb4';
  return isDark ? '#6eb3ff' : '#2b78e4';
}

export function toRoadmapViewEdges(
  edges: Edge[],
  selectedEdgeId?: string | null,
  pending?: RoadmapPendingStatusMaps,
  theme: EditorTheme = readEditorTheme(),
): Edge[] {
  return edges.map((edge) => {
    const isSelected = edge.id === selectedEdgeId;
    const pendingStatus = pending ? resolveRoadmapEdgePendingStatus(edge, pending) : undefined;
    const dash = (edge.style as any)?.strokeDasharray;
    const lineStyle = roadmapEdgeLineStyleFromStyle(edge.style as Record<string, any>);
    const pendingStyle = pendingStatus ? roadmapEdgePendingStyle(pendingStatus, isSelected) : null;
    const stroke = pendingStyle?.stroke || roadmapFlowEdgeStroke(theme, isSelected);
    return {
      ...edge,
      type: lineStyle === 'dashed' ? 'default' : 'straight',
      selected: isSelected,
      interactionWidth: pendingStatus === 'delete' ? 12 : 24,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      style: {
        stroke,
        strokeWidth: pendingStyle?.strokeWidth || (isSelected ? 4 : 3),
        ...(pendingStyle?.strokeDasharray
          ? { strokeDasharray: pendingStyle.strokeDasharray }
          : (dash ? { strokeDasharray: dash } : {})),
        ...(pendingStatus === 'delete' ? { opacity: 0.72 } : {}),
      },
      markerEnd: undefined,
      data: {
        ...(edge.data || {}),
        lineStyle,
        ...(pendingStatus ? { pendingStatus } : {}),
      },
    };
  });
}

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

export function computeScrollLayout(nodes: Node[], containerWidth: number): RoadmapScrollLayout {
  if (!nodes.length) {
    const width = Math.max(containerWidth, 320);
    return {
      height: 320,
      viewport: { x: width / 2 - ROADMAP_LANE_AXIS_X, y: FLOW_PADDING, zoom: 1 },
      zoom: 1,
    };
  }

  const content = computeRoadmapContentBounds(nodes);
  const width = Math.max(containerWidth, 320);
  const innerWidth = Math.max(width - FLOW_PADDING * 2, 320);
  const zoom = Math.min(1, innerWidth / ROADMAP_LANES_SPAN_WIDTH);
  const layoutHeight = content.height * zoom + FLOW_PADDING * 2;
  const x = width / 2 - ROADMAP_LANE_AXIS_X * zoom;
  const y = FLOW_PADDING - content.y * zoom;

  return {
    height: Math.max(layoutHeight, 320),
    viewport: { x, y, zoom },
    zoom,
  };
}

function useContainerSize(outerRef: React.RefObject<HTMLDivElement>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    installRoadmapResizeObserverErrorGuard();

    const syncSize = () => {
      const el = outerRef.current;
      if (!el) return;
      const nextWidth = el.clientWidth;
      const nextHeight = el.clientHeight;
      setSize((prev) => (
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight }
      ));
    };

    syncSize();
    window.addEventListener('resize', syncSize);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && outerRef.current) {
      observer = new ResizeObserver(syncSize);
      observer.observe(outerRef.current);
    }
    return () => {
      window.removeEventListener('resize', syncSize);
      observer?.disconnect();
    };
  }, [outerRef]);

  return size;
}

function deferSetViewport(instance: ReactFlowInstance, viewport: Viewport) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      instance.setViewport(viewport, { duration: 0 });
    });
  });
}

export function useRoadmapScrollLayout(nodes: Node[], options?: { fillContainer?: boolean }) {
  const fillContainer = options?.fillContainer ?? false;
  const outerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const { width: containerWidth, height: containerHeight } = useContainerSize(outerRef);
  const [canvasHeight, setCanvasHeight] = useState(320);

  const layout = useMemo(
    () => computeScrollLayout(nodes, containerWidth || 800),
    [containerWidth, nodes],
  );

  useEffect(() => {
    let outerFrame = 0;
    let innerFrame = 0;
    const contentHeight = layout.height;
    const nextHeight = fillContainer && containerHeight > 0
      ? Math.max(contentHeight, containerHeight)
      : contentHeight;

    outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        setCanvasHeight((prev) => (Math.abs(prev - nextHeight) < 1 ? prev : nextHeight));
      });
    });

    return () => {
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
    };
  }, [containerHeight, fillContainer, layout.height]);

  useEffect(() => {
    const instance = flowRef.current;
    if (!instance) return undefined;
    deferSetViewport(instance, layout.viewport);
    return undefined;
  }, [layout.viewport.x, layout.viewport.y, layout.zoom]);

  const onFlowInit = useCallback((instance: ReactFlowInstance) => {
    flowRef.current = instance;
    deferSetViewport(instance, layout.viewport);
  }, [layout.viewport]);

  return {
    outerRef,
    flowRef,
    canvasHeight,
    lockedZoom: layout.zoom,
    viewport: layout.viewport,
    onFlowInit,
  };
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
    const fitKey = `${containerWidth}:${containerHeight}:${nodes.length}`;
    if (fitKey === lastFitKeyRef.current) return;
    lastFitKeyRef.current = fitKey;
    requestAnimationFrame(() => {
      applyAxisViewport(instance, 0);
    });
  }, [applyAxisViewport, containerHeight, containerWidth, nodes.length]);

  const onFlowInit = useCallback((instance: ReactFlowInstance) => {
    flowRef.current = instance;
    requestAnimationFrame(() => {
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

export const roadmapScrollFlowProps = {
  panOnDrag: false as const,
  panOnScroll: false as const,
  zoomOnScroll: false as const,
  zoomOnPinch: false as const,
  zoomOnDoubleClick: false as const,
  preventScrolling: false as const,
  proOptions: { hideAttribution: true as const },
};

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

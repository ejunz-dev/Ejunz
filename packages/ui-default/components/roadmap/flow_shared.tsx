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
  ROADMAP_LANES,
} from './lanes';
import { roadmapEdgeLineStyleFromStyle, RoadmapStatus, roadmapUntitledNodeLabel } from './shared';

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
  return (
    <div className={`roadmap-sh-node roadmap-sh-node--${status} ${selected ? 'is-selected' : ''}`}>
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

export function RoadmapLaneOverlay() {
  const transform = useStore((state) => state.transform);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const [tx, ty, zoom] = transform;

  return (
    <div className="roadmap-lane-overlay" style={{ width, height }}>
      <div
        className="roadmap-lane-overlay__world"
        style={{ transform: `translate(${tx}px, ${ty}px) scale(${zoom})` }}
      >
        {ROADMAP_LANES.map((lane) => (
          <div
            key={lane}
            className="roadmap-lane-guide"
            style={{
              left: laneRegionX(lane),
              width: LANE_WIDTH,
              height: LANE_GUIDE_HEIGHT,
            }}
          >
            <div className="roadmap-lane-guide__label">{lane}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function toRoadmapViewNodes(nodes: Node[], selectedNodeId?: string | null): Node[] {
  return nodes.map((node) => ({
    ...node,
    selected: node.id === selectedNodeId,
  }));
}

export function toRoadmapViewEdges(edges: Edge[], selectedEdgeId?: string | null): Edge[] {
  return edges.map((edge) => {
    const isSelected = edge.id === selectedEdgeId;
    const stroke = isSelected ? '#1a5fb4' : '#2b78e4';
    const dash = (edge.style as any)?.strokeDasharray;
    const lineStyle = roadmapEdgeLineStyleFromStyle(edge.style as Record<string, any>);
    return {
      ...edge,
      type: lineStyle === 'dashed' ? 'default' : 'straight',
      selected: isSelected,
      interactionWidth: 24,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      style: {
        stroke,
        strokeWidth: isSelected ? 4 : 3,
        ...(dash ? { strokeDasharray: dash } : {}),
      },
      markerEnd: undefined,
      data: {
        ...(edge.data || {}),
        lineStyle,
      },
    };
  });
}

export function computeScrollLayout(nodes: Node[], containerWidth: number): RoadmapScrollLayout {
  if (!nodes.length) {
    return { height: 320, viewport: { x: FLOW_PADDING, y: FLOW_PADDING, zoom: 1 }, zoom: 1 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  nodes.forEach((node) => {
    const width = node.width || NODE_LAYOUT_WIDTH;
    const height = node.height || NODE_LAYOUT_HEIGHT;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  });

  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  const width = Math.max(containerWidth, 320);
  const innerWidth = Math.max(width - FLOW_PADDING * 2, 320);
  const zoom = Math.min(1, innerWidth / bounds.width);
  const height = bounds.height * zoom + FLOW_PADDING * 2;
  const x = (width - bounds.width * zoom) / 2 - bounds.x * zoom;
  const y = FLOW_PADDING - bounds.y * zoom;

  return {
    height: Math.max(height, 320),
    viewport: { x, y, zoom },
    zoom,
  };
}

function useContainerWidth(outerRef: React.RefObject<HTMLDivElement>) {
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    installRoadmapResizeObserverErrorGuard();

    const syncWidth = () => {
      const el = outerRef.current;
      if (!el) return;
      const nextWidth = el.clientWidth;
      setContainerWidth((prev) => (prev === nextWidth ? prev : nextWidth));
    };

    syncWidth();
    window.addEventListener('resize', syncWidth);
    return () => window.removeEventListener('resize', syncWidth);
  }, [outerRef]);

  return containerWidth;
}

function deferSetViewport(instance: ReactFlowInstance, viewport: Viewport) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      instance.setViewport(viewport, { duration: 0 });
    });
  });
}

export function useRoadmapScrollLayout(nodes: Node[]) {
  const outerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const containerWidth = useContainerWidth(outerRef);
  const [canvasHeight, setCanvasHeight] = useState(320);

  const layout = useMemo(
    () => computeScrollLayout(nodes, containerWidth || 800),
    [containerWidth, nodes],
  );

  useEffect(() => {
    let outerFrame = 0;
    let innerFrame = 0;
    const nextHeight = layout.height;

    outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        setCanvasHeight((prev) => (Math.abs(prev - nextHeight) < 1 ? prev : nextHeight));
      });
    });

    return () => {
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
    };
  }, [layout.height]);

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
    onFlowInit,
  };
}

export function useRoadmapEditorLayout(nodes: Node[]) {
  const outerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const containerWidth = useContainerWidth(outerRef);
  const lastFitKeyRef = useRef('');

  const fitToContent = useCallback(() => {
    const instance = flowRef.current;
    if (!instance || !nodes.length) return;
    instance.fitView({ padding: 0.15, duration: 200 });
  }, [nodes.length]);

  useEffect(() => {
    const instance = flowRef.current;
    if (!instance || !nodes.length || !containerWidth) return;
    const fitKey = `${containerWidth}:${nodes.length}`;
    if (fitKey === lastFitKeyRef.current) return;
    lastFitKeyRef.current = fitKey;
    requestAnimationFrame(() => {
      instance.fitView({ padding: 0.15, duration: 0 });
    });
  }, [containerWidth, nodes.length]);

  const onFlowInit = useCallback((instance: ReactFlowInstance) => {
    flowRef.current = instance;
    if (nodes.length) {
      requestAnimationFrame(() => {
        instance.fitView({ padding: 0.15, duration: 0 });
      });
    }
  }, [nodes.length]);

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

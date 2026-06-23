import type { BaseRoadmapEdge, BaseRoadmapNode, RoadmapStatus } from './shared';
import { getRoadmapNodeKind, nodeKindBackground } from './node_kinds';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PADDING = 48;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  node: BaseRoadmapNode;
}

function nodeId(node: BaseRoadmapNode, index: number): string {
  return String(node.id || `node_${index}`);
}

function estimateNodeSize(node: BaseRoadmapNode): { width: number; height: number } {
  if (typeof node.width === 'number' && node.width > 0 && typeof node.height === 'number' && node.height > 0) {
    return { width: node.width, height: node.height };
  }
  const text = (node.text || '未命名').trim() || '未命名';
  const width = Math.min(260, Math.max(132, text.length * 8.5 + 36));
  const height = node.data?.description ? 72 : 46;
  return { width, height };
}

function layoutNodes(nodes: BaseRoadmapNode[]): Map<string, LayoutNode> {
  const map = new Map<string, LayoutNode>();
  nodes.forEach((node, index) => {
    const id = nodeId(node, index);
    const { width, height } = estimateNodeSize(node);
    const x = typeof node.x === 'number' && Number.isFinite(node.x)
      ? node.x
      : 72 + (index % 3) * 280;
    const y = typeof node.y === 'number' && Number.isFinite(node.y)
      ? node.y
      : 72 + Math.floor(index / 3) * 140;
    map.set(id, { id, x, y, width, height, node });
  });
  return map;
}

function nodeFill(node: BaseRoadmapNode): string {
  if (node.backgroundColor) return node.backgroundColor;
  const kind = getRoadmapNodeKind(node.data?.roadmapNodeType);
  if (['main', 'sub', 'hook', 'text'].includes(kind)) return nodeKindBackground(kind);
  const status = node.data?.status as RoadmapStatus | undefined;
  switch (status) {
    case 'done': return '#cbcbcb';
    case 'in_progress': return '#dad1fd';
    case 'blocked': return '#ffcfcf';
    case 'planned':
    default: return '#ffe599';
  }
}

function nodeStroke(node: BaseRoadmapNode): string {
  if (node.color) return node.color;
  const type = node.data?.roadmapNodeType;
  if (type === 'decision') return '#111111';
  if (type === 'release') return '#4135d6';
  return '#4135d6';
}

function statusClass(status?: RoadmapStatus): string {
  switch (status) {
    case 'done': return 'done';
    case 'in_progress': return 'learning';
    case 'blocked': return 'blocked';
    case 'planned':
    default: return '';
  }
}

function edgePath(source: LayoutNode, target: LayoutNode): string {
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tx = target.x;
  const ty = target.y + target.height / 2;
  const mx = (sx + tx) / 2;
  return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
}

function makeSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | undefined> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  });
  return el;
}

function wrapText(text: string, maxChars = 22): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return ['未命名'];
  const lines: string[] = [];
  let current = '';
  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      return;
    }
    if (current) lines.push(current);
    current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
  });
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

function renderNodeGroup(layout: LayoutNode): SVGGElement {
  const { node, x, y, width, height } = layout;
  const status = node.data?.status as RoadmapStatus | undefined;
  const type = node.data?.roadmapNodeType || 'task';
  const group = makeSvgElement('g', {
    'data-node-id': layout.id,
    'data-type': type,
    'data-title': node.text || '未命名',
    class: statusClass(status),
  });

  const rx = node.shape === 'circle' ? height / 2 : 8;
  group.appendChild(makeSvgElement('rect', {
    x,
    y,
    width,
    height,
    rx,
    ry: rx,
    fill: nodeFill(node),
    stroke: nodeStroke(node),
    'stroke-width': 2,
  }));

  const lines = wrapText(node.text || '未命名');
  const text = makeSvgElement('text', {
    x: x + width / 2,
    y: y + (lines.length > 1 ? height / 2 - 6 : height / 2),
    fill: status === 'done' ? '#111111' : '#111111',
    'font-size': 15,
    'font-family': FONT_FAMILY,
    'font-weight': 500,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
  });
  lines.forEach((line, index) => {
    const tspan = makeSvgElement('tspan', {
      x: x + width / 2,
      dy: index === 0 ? 0 : 16,
    });
    tspan.textContent = line;
    text.appendChild(tspan);
  });
  group.appendChild(text);
  return group;
}

function computeBounds(layouts: LayoutNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  layouts.forEach((layout) => {
    minX = Math.min(minX, layout.x);
    minY = Math.min(minY, layout.y);
    maxX = Math.max(maxX, layout.x + layout.width);
    maxY = Math.max(maxY, layout.y + layout.height);
  });
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 400, maxY: 300 };
  }
  return { minX, minY, maxX, maxY };
}

export function renderRoadmapSvg(nodes: BaseRoadmapNode[], edges: BaseRoadmapEdge[] = []): SVGSVGElement {
  const layoutMap = layoutNodes(nodes);
  const layouts = Array.from(layoutMap.values());
  const bounds = computeBounds(layouts);
  const viewX = bounds.minX - PADDING;
  const viewY = bounds.minY - PADDING;
  const viewW = Math.max(bounds.maxX - bounds.minX + PADDING * 2, 320);
  const viewH = Math.max(bounds.maxY - bounds.minY + PADDING * 2, 240);

  const svg = makeSvgElement('svg', {
    xmlns: SVG_NS,
    viewBox: `${viewX} ${viewY} ${viewW} ${viewH}`,
    version: '1.1',
    role: 'img',
    'aria-label': 'Roadmap',
  });
  svg.style.fontFamily = FONT_FAMILY;

  const defs = makeSvgElement('defs');
  const marker = makeSvgElement('marker', {
    id: 'roadmap-arrow',
    markerWidth: 8,
    markerHeight: 8,
    refX: 7,
    refY: 4,
    orient: 'auto',
    markerUnits: 'strokeWidth',
  });
  marker.appendChild(makeSvgElement('path', {
    d: 'M0,0 L8,4 L0,8 Z',
    fill: '#2b78e4',
  }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  const edgeLayer = makeSvgElement('g', { 'data-layer': 'edges' });
  edges.forEach((edge, index) => {
    const source = layoutMap.get(edge.source);
    const target = layoutMap.get(edge.target);
    if (!source || !target) return;
    const path = makeSvgElement('path', {
      d: edgePath(source, target),
      fill: 'none',
      stroke: edge.color || '#2b78e4',
      'stroke-width': edge.width || 3,
      'marker-end': 'url(#roadmap-arrow)',
      'data-edge-id': edge.id || `edge_${index}`,
    });
    edgeLayer.appendChild(path);
    if (edge.label) {
      const midX = (source.x + source.width + target.x) / 2;
      const midY = (source.y + source.height / 2 + target.y + target.height / 2) / 2;
      const label = makeSvgElement('text', {
        x: midX,
        y: midY - 8,
        fill: '#555555',
        'font-size': 12,
        'font-family': FONT_FAMILY,
        'text-anchor': 'middle',
      });
      label.textContent = edge.label;
      edgeLayer.appendChild(label);
    }
  });
  svg.appendChild(edgeLayer);

  const nodeLayer = makeSvgElement('g', { 'data-layer': 'nodes' });
  layouts.forEach((layout) => nodeLayer.appendChild(renderNodeGroup(layout)));
  svg.appendChild(nodeLayer);

  return svg;
}

export function computeRoadmapAspectRatio(svg: SVGSVGElement): number {
  const box = svg.viewBox.baseVal;
  if (!box.width || !box.height) return 1;
  return box.width / box.height;
}

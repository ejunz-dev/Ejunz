import type { Node, Viewport } from 'reactflow';
import { NODE_LAYOUT_HEIGHT } from './flow_shared';

export function computeRoadmapNodeDocumentScrollTop(
  node: Node,
  viewport: Viewport,
  canvasElement: HTMLElement,
  options?: { nodeHeight?: number; offsetTop?: number },
): number {
  const nodeHeight = options?.nodeHeight ?? node.height ?? NODE_LAYOUT_HEIGHT;
  const offsetTop = options?.offsetTop ?? Math.round(window.innerHeight * 0.32);
  const nodeCanvasY = (node.position.y + nodeHeight / 2) * viewport.zoom + viewport.y;
  const canvasTop = canvasElement.getBoundingClientRect().top + window.scrollY;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  return Math.min(maxScroll, Math.max(0, canvasTop + nodeCanvasY - offsetTop));
}

export function scrollToRoadmapNode(
  node: Node,
  viewport: Viewport,
  canvasElement: HTMLElement,
  options?: { behavior?: ScrollBehavior; nodeHeight?: number; offsetTop?: number },
): void {
  const top = computeRoadmapNodeDocumentScrollTop(node, viewport, canvasElement, options);
  window.scrollTo({ top, behavior: options?.behavior ?? 'auto' });
}

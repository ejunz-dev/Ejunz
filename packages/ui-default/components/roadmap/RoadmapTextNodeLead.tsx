import $ from 'jquery';
import React, { useEffect, useMemo, useRef } from 'react';
import { renderRoadmapMarkdown } from './markdown_render';

export function RoadmapTextNodeLead({ markdown }: { markdown: string }) {
  const trimmed = String(markdown || '').trim();
  const html = useMemo(() => renderRoadmapMarkdown(trimmed), [trimmed]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !html) return;
    $(el).trigger('vjContentNew');
  }, [html]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const stopFlowCapture = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest('a')) event.stopPropagation();
    };
    el.addEventListener('pointerdown', stopFlowCapture);
    el.addEventListener('click', stopFlowCapture);
    return () => {
      el.removeEventListener('pointerdown', stopFlowCapture);
      el.removeEventListener('click', stopFlowCapture);
    };
  }, [html]);

  if (!trimmed) return null;

  return (
    <div
      ref={containerRef}
      className="roadmap-sh-node__lead roadmap-sh-node__lead-md"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

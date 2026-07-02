import React, { useMemo, useRef } from 'react';
import { renderRoadmapMarkdown } from '../roadmap/markdown_render';

export function AiTutorMarkdown({
  content,
  className,
  emptyLabel = '—',
}: {
  content: string;
  className?: string;
  emptyLabel?: string;
}) {
  const plain = (content || '').trim();
  const containerRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    if (!plain) return '';
    return renderRoadmapMarkdown(content);
  }, [content, plain]);

  if (!plain) {
    return <div ref={containerRef} className={className}>{emptyLabel}</div>;
  }
  if (!html) {
    return <div ref={containerRef} className={className}>{content}</div>;
  }
  return (
    <div
      ref={containerRef}
      className={`typo ${className || ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default AiTutorMarkdown;

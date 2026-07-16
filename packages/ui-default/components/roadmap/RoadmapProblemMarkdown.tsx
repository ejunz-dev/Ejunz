import React, { useMemo } from 'react';
import { renderRoadmapMarkdown } from './markdown_render';

export function RoadmapProblemMarkdown({
  markdown,
  inline = false,
  className,
  emptyLabel = '—',
}: {
  markdown: string;
  inline?: boolean;
  className?: string;
  emptyLabel?: string;
}) {
  const raw = markdown ?? '';
  const plain = raw.trim();

  const html = useMemo(() => {
    if (!plain) return '';
    return renderRoadmapMarkdown(raw, inline);
  }, [raw, plain, inline]);

  if (!plain) {
    return <div className={className}>{emptyLabel}</div>;
  }
  if (!html) {
    return <div className={className}>{raw}</div>;
  }
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

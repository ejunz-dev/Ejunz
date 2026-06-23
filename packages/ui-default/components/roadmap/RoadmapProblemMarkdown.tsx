import React, { useEffect, useRef, useState } from 'react';

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
  const [html, setHtml] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!plain) {
      setHtml('');
      return undefined;
    }
    let cancelled = false;
    fetch('/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: raw, inline }),
    })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error('markdown'))))
      .then((h) => {
        if (!cancelled) setHtml(h);
      })
      .catch(() => {
        if (!cancelled) setHtml('');
      });
    return () => {
      cancelled = true;
    };
  }, [raw, plain, inline]);

  if (!plain) {
    return <div ref={containerRef} className={className}>{emptyLabel}</div>;
  }
  if (!html) {
    return <div ref={containerRef} className={className}>{raw}</div>;
  }
  return (
    <div
      ref={containerRef}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

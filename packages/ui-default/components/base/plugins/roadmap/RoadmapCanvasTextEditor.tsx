import $ from 'jquery';
import React, { useEffect, useRef } from 'react';
import Editor from 'vj/components/editor';

/** Markdown editor for roadmap canvas text nodes — mirrors roadmap_edit.page.tsx. */
export function RoadmapCanvasTextEditor({
  nodeId,
  value,
  onChange,
}: {
  nodeId: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editorInstanceRef = useRef<InstanceType<typeof Editor> | null>(null);
  const isInitializingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    isInitializingRef.current = true;
    let currentEditor: InstanceType<typeof Editor> | null = null;
    const content = String(value || '');

    const timer = window.setTimeout(() => {
      const el = editorRef.current;
      if (!el) {
        isInitializingRef.current = false;
        return;
      }
      const $textarea = $(el);
      $textarea.attr('data-markdown', 'true');
      $textarea.val(content);
      try {
        currentEditor = new Editor($textarea, {
          value: content,
          onChange: (next: string) => {
            if (isInitializingRef.current) return;
            onChangeRef.current(next);
          },
        });
        editorInstanceRef.current = currentEditor;
        window.setTimeout(() => {
          isInitializingRef.current = false;
        }, 100);
      } catch {
        isInitializingRef.current = false;
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
      if (currentEditor) {
        try {
          currentEditor.destroy();
        } catch {
          /* ignore */
        }
      }
      editorInstanceRef.current = null;
      isInitializingRef.current = false;
    };
  }, [nodeId]);

  return (
    <div className="roadmap-node-markdown-editor" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <textarea
        key={nodeId}
        ref={editorRef}
        defaultValue={String(value || '')}
        className="roadmap-node-markdown-editor__textarea"
      />
    </div>
  );
}

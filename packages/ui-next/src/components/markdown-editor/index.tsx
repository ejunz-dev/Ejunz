import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import 'md-editor-rt/lib/style.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
  theme?: 'light' | 'dark';
  className?: string;
  style?: CSSProperties;
}

type EditorComponent = (props: Record<string, unknown>) => ReactElement;

export function MarkdownEditor({ value, onChange, theme = 'light', className = '', style }: Props) {
  const [Editor, setEditor] = useState<EditorComponent | null>(null);

  useEffect(() => {
    let cancelled = false;
    import('md-editor-rt').then(({ MdEditor }) => {
      if (!cancelled) setEditor(() => MdEditor as unknown as EditorComponent);
    }).catch(() => {
      if (!cancelled) setEditor(null);
    });
    return () => { cancelled = true; };
  }, []);

  if (!Editor) {
    return (
      <textarea
        className={`uix-markdown-editor__fallback ${className}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={style}
        placeholder="Markdown"
      />
    );
  }

  return (
    <Editor
      className={`uix-markdown-editor ${className}`}
      style={style}
      modelValue={value}
      onChange={(nextValue: string) => onChange(nextValue || '')}
      theme={theme}
      autoFocus={false}
      codeTheme="github"
      codeStyleReverse={false}
      noMermaid
      noPrettier
      autoDetectCode
      toolbarsExclude={['github', 'mermaid', 'prettier', 'katex', 'sub', 'sup', 'table']}
    />
  );
}

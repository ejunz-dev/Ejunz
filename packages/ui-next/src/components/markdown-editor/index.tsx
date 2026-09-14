import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { ExposeParam, UploadImgEvent } from 'md-editor-rt';
import 'md-editor-rt/lib/style.css';
import { i18n } from '../../i18n';
import Notification from '../notification';
import { isUploadableImage, useUserFileUpload } from './upload';
import './markdown-editor.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
  theme?: 'light' | 'dark';
  className?: string;
  style?: CSSProperties;
}

type EditorComponent = (props: Record<string, unknown>) => ReactElement;

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function imageMarkdown(urls: string[]): string {
  return urls.map((url) => `![](${url})`).join('\n');
}

export function MarkdownEditor({ value, onChange, theme = 'light', className = '', style }: Props) {
  const [Editor, setEditor] = useState<EditorComponent | null>(null);
  const [dropping, setDropping] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ExposeParam | null>(null);
  const dragDepthRef = useRef(0);
  const uploadFiles = useUserFileUpload();

  useEffect(() => {
    let cancelled = false;
    import('md-editor-rt').then(({ MdEditor }) => {
      if (!cancelled) setEditor(() => MdEditor as unknown as EditorComponent);
    }).catch(() => {
      if (!cancelled) setEditor(null);
    });
    return () => { cancelled = true; };
  }, []);

  const upload = useCallback(async (files: File[]): Promise<string[]> => {
    const images = files.filter(isUploadableImage);
    if (!images.length) {
      Notification.warn(i18n('Unsupported file type. Please upload an image (png, jpg, jpeg, gif).'));
      return [];
    }
    const notice = await Notification.info(i18n('Uploading...'));
    try {
      const urls = await uploadFiles(images);
      Notification.hide(notice);
      Notification.success(i18n('File uploaded successfully.'));
      return urls;
    } catch {
      Notification.hide(notice);
      Notification.error(i18n('Image upload failed'));
      return [];
    }
  }, [uploadFiles]);

  const handleUploadImg = useCallback<UploadImgEvent>((files, callback) => {
    void upload(files).then(callback);
  }, [upload]);

  const insertDroppedFiles = useCallback(async (files: File[]) => {
    const urls = await upload(files);
    if (!urls.length) return;
    const markdown = imageMarkdown(urls);
    editorRef.current?.insert(() => ({ targetValue: markdown }));
  }, [upload]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;
    const onDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDropping(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (!dragDepthRef.current) setDropping(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setDropping(false);
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) void insertDroppedFiles(files);
    };
    wrapper.addEventListener('dragenter', onDragEnter, true);
    wrapper.addEventListener('dragover', onDragOver, true);
    wrapper.addEventListener('dragleave', onDragLeave, true);
    wrapper.addEventListener('drop', onDrop, true);
    return () => {
      wrapper.removeEventListener('dragenter', onDragEnter, true);
      wrapper.removeEventListener('dragover', onDragOver, true);
      wrapper.removeEventListener('dragleave', onDragLeave, true);
      wrapper.removeEventListener('drop', onDrop, true);
    };
  }, [insertDroppedFiles]);

  const wrapperClass = `uix-markdown-editor__wrapper${className ? ` ${className}` : ''}`;

  if (!Editor) {
    return (
      <div ref={wrapperRef} className={wrapperClass} style={style}>
        <textarea
          className="uix-markdown-editor__fallback"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Markdown"
        />
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className={wrapperClass} style={style}>
      <Editor
        ref={editorRef}
        className="uix-markdown-editor"
        style={{ height: '100%' }}
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
        onUploadImg={handleUploadImg}
      />
      {dropping ? <div className="uix-markdown-editor__drop">{i18n('Upload image')}</div> : null}
    </div>
  );
}

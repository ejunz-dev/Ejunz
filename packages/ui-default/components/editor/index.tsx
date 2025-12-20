import $ from 'jquery';
import { nanoid } from 'nanoid';
import React from 'react';
import ReactDOM from 'react-dom/client';
import DOMAttachedObject from 'vj/components/DOMAttachedObject';
import { getTheme, i18n } from 'vj/utils';
import uploadFiles from '../upload';

interface MonacoOptions {
  language?: string;
  onChange?: (val: string) => any;
  theme?: string;
  model?: string;
  autoResize?: boolean;
  autoLayout?: boolean;
  value?: string;
  hide?: string[];
  lineNumbers?: 'on' | 'off' | 'relative' | 'interval';
}
type Options = MonacoOptions;

export default class Editor extends DOMAttachedObject {
  static DOMAttachKey = 'vjEditorInstance';
  model: import('../monaco').default.editor.IModel;
  editor: import('../monaco').default.editor.IStandaloneCodeEditor;
  markdownEditor: any;
  valueCache?: string;
  setMarkdownEditorValue?: (v: string) => void;
  reactRoot?: ReactDOM.Root;
  isValid: boolean;

  constructor($dom, public options: Options = {}) {
    super($dom);
    if (UserContext.preferredEditorType === 'monaco') this.initMonaco();
    else if (options.language && options.language !== 'markdown') this.initMonaco();
    else this.initMarkdownEditor();
  }

  async initMonaco() {
    const { load } = await import('vj/components/monaco/loader');
    const {
      onChange, language = 'markdown',
      theme = `vs-${getTheme()}`,
      model = `file://model-${Math.random().toString(16)}`,
      autoResize = true, autoLayout = true,
      hide = [], lineNumbers = 'on',
    } = this.options;
    const { monaco, registerAction } = await load([language]);
    const { $dom } = this;
    const hasFocus = $dom.is(':focus') || $dom.hasClass('autofocus');
    const origin = $dom.get(0);
    const ele = document.createElement('div');
    $(ele).width('100%').addClass('textbox');
    if (!autoResize && $dom.height()) $(ele).height($dom.height());
    $dom.hide();
    origin.parentElement.appendChild(ele);
    const value = this.options.value || $dom.val();
    this.model = typeof model === 'string'
      ? monaco.editor.getModel(monaco.Uri.parse(model))
      || monaco.editor.createModel(value, language === 'auto' ? undefined : language, monaco.Uri.parse(model))
      : model;
    if (!this.options.model) this.model.setValue(value);
    const cfg: import('../monaco').default.editor.IStandaloneEditorConstructionOptions = {
      theme,
      lineNumbers,
      glyphMargin: true,
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On },
      model: this.model,
      minimap: { enabled: false },
      hideCursorInOverviewRuler: true,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      fontFamily: UserContext.codeFontFamily,
      fontLigatures: '',
      unicodeHighlight: {
        ambiguousCharacters: language !== 'markdown',
      },
    };
    if (autoLayout) cfg.automaticLayout = true;
    let prevHeight = 0;
    const updateEditorHeight = () => {
      const editorElement = this.editor.getDomNode();
      if (!editorElement) return;
      const lineHeight = this.editor.getOption(monaco.editor.EditorOption.lineHeight);
      const lineCount = this.editor.getModel()?.getLineCount() || 1;
      let height = this.editor.getTopForLineNumber(lineCount + 1) + lineHeight;
      if (prevHeight !== height) {
        if (window.innerHeight * 1.5 < height) {
          height = window.innerHeight;
          this.editor.updateOptions({
            scrollbar: {
              vertical: 'auto',
              horizontal: 'auto',
              handleMouseWheel: true,
            },
          });
        } else {
          this.editor.updateOptions({
            scrollbar: {
              vertical: 'hidden',
              horizontal: 'hidden',
              handleMouseWheel: false,
            },
          });
        }
        prevHeight = height;
        editorElement.style.height = `${height}px`;
        this.editor.layout();
      }
    };
    if (autoResize) {
      cfg.wordWrap = 'bounded';
      cfg.scrollBeyondLastLine = false;
    }
    this.editor = monaco.editor.create(ele, cfg);
    if (hide.length) {
      const ranges = [];
      for (const text of hide) {
        const found = this.model.findMatches(text, true, false, true, '', true);
        ranges.push(...found.map((i) => i.range));
      }
      this.editor.deltaDecorations([], ranges.map((range) => ({ range, options: { inlineClassName: 'decoration-hide' } })));
    }
    registerAction(this.editor, this.model, this.$dom);
    if (autoResize) {
      this.editor.onDidChangeModelDecorations(() => {
        updateEditorHeight(); // typing
        requestAnimationFrame(updateEditorHeight); // folding
      });
    }
    this.editor.onDidChangeModelContent(() => {
      const val = this.editor.getValue({ lineEnding: '\n', preserveBOM: false });
      $dom.val(val);
      $dom.text(val);
      if (onChange) onChange(val);
    });
    this.isValid = true;
    if (hasFocus) this.focus();
    if (autoResize) updateEditorHeight();
    // @ts-ignore
    window.model = this.model;
    // @ts-ignore
    window.editor = this.editor;
  }

  async initMarkdownEditor() {
    const pagename = document.documentElement.getAttribute('data-page');
    const isProblemPage = ['problem_create', 'problem_edit'].includes(pagename);
    const isProblemEdit = pagename === 'problem_edit';
    const that = this;
    const { $dom } = this;
    const hasFocus = $dom.is(':focus') || $dom.hasClass('autofocus');
    const origin = $dom.get(0);
    const ele = document.createElement('div');
    const value = $dom.val();
    const { onChange } = this.options;
    const { MdEditor } = await import('./mdeditor');

    const renderCallback = (ref) => {
      this.markdownEditor = ref;
    };

    function EditorComponent() {
      const [val, setVal] = React.useState(value);
      const [isDragging, setIsDragging] = React.useState(false);
      const editorWrapperRef = React.useRef<HTMLDivElement>(null);
      that.setMarkdownEditorValue = setVal;

      const handleUploadFiles = async (fileList: FileList | File[]): Promise<string[]> => {
        const files = Array.from(fileList);
        const imageFiles: File[] = [];
        const filenameMap = new Map<File, string>();

        for (const file of files) {
          const matches = file.type.match(/^image\/(png|jpg|jpeg|gif|webp)$/i);
          if (matches) {
            imageFiles.push(file);
            const [, ext] = matches;
            const filename = `${nanoid()}.${ext}`;
            filenameMap.set(file, filename);
          }
        }

        if (imageFiles.length === 0) {
          return [];
        }

        const uploadedUrls: string[] = [];
        try {
          await uploadFiles(isProblemEdit ? './files' : '/file', imageFiles, {
            type: isProblemEdit ? 'additional_file' : undefined,
            filenameCallback: (file: File) => filenameMap.get(file) || file.name,
            singleFileUploadCallback: (file: File) => {
              const filename = filenameMap.get(file);
              if (filename) {
                uploadedUrls.push(`${isProblemPage ? 'file://' : `/file/${UserContext._id}/`}${filename}`);
              }
            },
          });
        } catch (err) {
          console.error('Failed to upload images:', err);
        }

        return uploadedUrls;
      };

      React.useEffect(() => {
        const wrapper = editorWrapperRef.current;
        if (!wrapper) return;

        const handleDragEnter = (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer?.types.includes('Files')) {
            setIsDragging(true);
          }
        };

        const handleDragOver = (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
          }
        };

        const handleDragLeave = (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          const rect = wrapper.getBoundingClientRect();
          const x = e.clientX;
          const y = e.clientY;
          if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
            setIsDragging(false);
          }
        };

        const handleDrop = async (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);

          const files = e.dataTransfer?.files;
          if (!files || files.length === 0) return;

          const uploadedUrls = await handleUploadFiles(files);
          if (uploadedUrls.length > 0) {
            const currentValue = val || '';
            
            const imageMarkdowns = uploadedUrls.map(url => `![image](${url})`).join('\n');
            
            let insertPosition = currentValue.length;
            try {
              if (that.markdownEditor && typeof that.markdownEditor.getCursor === 'function') {
                const cursor = that.markdownEditor.getCursor();
                if (cursor && typeof cursor.line === 'number') {
                  const lines = currentValue.split('\n');
                  let pos = 0;
                  for (let i = 0; i < cursor.line && i < lines.length; i++) {
                    pos += lines[i].length + 1; // +1 for newline
                  }
                  pos += cursor.column || 0;
                  insertPosition = Math.min(pos, currentValue.length);
                }
              }
            } catch (e) {
            }
            
            const before = currentValue.substring(0, insertPosition);
            const after = currentValue.substring(insertPosition);
            const newValue = before + (before && !before.endsWith('\n') ? '\n' : '') + imageMarkdowns + (after && !after.startsWith('\n') ? '\n' : '') + after;
            
            if (that.markdownEditor && typeof that.markdownEditor.setValue === 'function') {
              that.markdownEditor.setValue(newValue);
            }
            setVal(newValue);
            $dom.val(newValue);
            $dom.text(newValue);
            onChange?.(newValue);
          }
        };

        wrapper.addEventListener('dragenter', handleDragEnter);
        wrapper.addEventListener('dragover', handleDragOver);
        wrapper.addEventListener('dragleave', handleDragLeave);
        wrapper.addEventListener('drop', handleDrop);

        return () => {
          wrapper.removeEventListener('dragenter', handleDragEnter);
          wrapper.removeEventListener('dragover', handleDragOver);
          wrapper.removeEventListener('dragleave', handleDragLeave);
          wrapper.removeEventListener('drop', handleDrop);
        };
      }, []);

      return (
        <div
          ref={editorWrapperRef}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
          }}
        >
          {isDragging && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(33, 150, 243, 0.1)',
                border: '2px dashed #2196F3',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000,
                pointerEvents: 'none',
                fontSize: '16px',
                color: '#2196F3',
                fontWeight: '500',
              }}
            >
              释放以上传图片
            </div>
          )}
          <MdEditor
            className='textbox'
            autoFocus={hasFocus}
            codeTheme='github'
            codeStyleReverse={false}
            ref={renderCallback}
            modelValue={val}
            theme={getTheme()}
            noMermaid
            noPrettier
            autoDetectCode
            toolbarsExclude={[
              // 'bold',
              // 'underline',
              // 'italic',
              // '-',
              // 'strikeThrough',
              // 'title',
              // 'sub',
              // 'sup',
              // 'quote',
              // 'unorderedList',
              // 'orderedList',
              // 'task',
              // '-',
              // 'codeRow',
              // 'code',
              // 'link',
              // 'image',
              // 'table',
              'mermaid',
              // 'katex',
              // '-',
              // 'revoke',
              // 'next',
              'save',
              // '=',
              'pageFullscreen',
              'fullscreen',
              // 'preview',
              'previewOnly',
              'htmlPreview',
              // 'catalog',
              'github',
            ]}
            onChange={(v) => {
              that.valueCache = v;
              setVal(v);
              $dom.val(v);
              $dom.text(v);
              onChange?.(v);
            }}
            onUploadImg={async (files, callback) => {
              const uploadedUrls = await handleUploadFiles(files);
              callback(uploadedUrls);
              return null;
            }}
          />
        </div>
      );
    }

    this.reactRoot = ReactDOM.createRoot(ele);
    this.reactRoot.render(<EditorComponent />);
    $dom.hide();
    origin.parentElement.appendChild(ele);
    this.isValid = true;
    if (hasFocus) this.focus();
  }

  destroy() {
    this.detach();
    if (this.reactRoot) this.reactRoot.unmount();
    else if (this.editor?.dispose) this.editor.dispose();
  }

  ensureValid() {
    if (!this.isValid) throw new Error('Editor is not loaded');
  }

  value(val?: string) {
    this.ensureValid();
    if (typeof val === 'string') {
      if (this.editor) return this.editor.setValue(val);
      this.setMarkdownEditorValue?.(val);
      this.markdownEditor?.resetHistory?.();
    }
    if (this.editor) return this.editor.getValue({ lineEnding: '\n', preserveBOM: false });
    return this.valueCache;
  }

  focus() {
    this.ensureValid();
    if (!this.editor || !this.model) return;
    this.editor.focus();
    const range = this.model.getFullModelRange();
    this.editor.setPosition({ lineNumber: range.endLineNumber, column: range.endColumn });
  }
}

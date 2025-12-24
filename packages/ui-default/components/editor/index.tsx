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
      const [editorKey, setEditorKey] = React.useState(0);
      const [isDragging, setIsDragging] = React.useState(false);
      const editorWrapperRef = React.useRef<HTMLDivElement>(null);
      const uploadImgCallbackRef = React.useRef<((urls: string[]) => void) | null>(null);
      const valRef = React.useRef(val);
      that.setMarkdownEditorValue = setVal;
      
      React.useEffect(() => {
        valRef.current = val;
      }, [val]);
      
      React.useEffect(() => {
        if (that.markdownEditor && val !== undefined && val !== null) {
          try {
            const currentValue = typeof that.markdownEditor.getValue === 'function' 
              ? that.markdownEditor.getValue() 
              : that.markdownEditor.$props?.modelValue;
            
            if (currentValue !== val) {
              if (typeof that.markdownEditor.setValue === 'function') {
                that.markdownEditor.setValue(val);
              } else if (that.markdownEditor.$props) {
                that.markdownEditor.$props.modelValue = val;
                if (that.markdownEditor.$forceUpdate) {
                  that.markdownEditor.$forceUpdate();
                }
              }
            }
          } catch (e) {
            // Ignore errors
          }
        }
      }, [val]);

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
          const filenameByOriginalName = new Map<string, string>();
          for (const [file, filename] of filenameMap.entries()) {
            filenameByOriginalName.set(file.name, filename);
          }
          
          const getFilename = (file: File): string => {
            let filename = filenameMap.get(file);
            if (!filename) {
              filename = filenameByOriginalName.get(file.name);
            }
            if (!filename) {
              const matches = file.type.match(/^image\/(png|jpg|jpeg|gif|webp)$/i);
              if (matches) {
                const [, ext] = matches;
                filename = `${nanoid()}.${ext}`;
              } else {
                filename = file.name;
              }
            }
            return filename;
          };
          
          await uploadFiles(isProblemEdit ? './files' : '/file', imageFiles, {
            type: isProblemEdit ? 'additional_file' : undefined,
            filenameCallback: (file: File) => getFilename(file),
            singleFileUploadCallback: (file: File) => {
              const filename = getFilename(file);
              if (filename) {
                const url = `${isProblemPage ? 'file://' : `/file/${UserContext._id}/`}${filename}`;
                uploadedUrls.push(url);
              }
            },
          });
        } catch (err) {
          // Ignore upload errors
        }

        return uploadedUrls;
      };

      React.useEffect(() => {
        let savedCursorPosition: { line: number; column: number } | null = null;

        const handleDragEnter = (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer?.types.includes('Files')) {
            setIsDragging(true);
            try {
              if (that.markdownEditor && typeof that.markdownEditor.getCursor === 'function') {
                const cursor = that.markdownEditor.getCursor();
                if (cursor && typeof cursor.line === 'number') {
                  savedCursorPosition = {
                    line: cursor.line,
                    column: cursor.column || 0,
                  };
                }
              }
            } catch (e) {
              // Ignore errors
            }
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
          const wrapper = editorWrapperRef.current;
          if (wrapper) {
            const rect = wrapper.getBoundingClientRect();
            const x = e.clientX;
            const y = e.clientY;
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
              setIsDragging(false);
            }
          }
        };

        const handleDrop = async (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);

          const files = e.dataTransfer?.files;
          if (!files || files.length === 0) {
            return;
          }

          if (uploadImgCallbackRef.current) {
            try {
              const uploadedUrls = await handleUploadFiles(files);
              if (uploadedUrls.length > 0) {
                uploadImgCallbackRef.current(uploadedUrls);
                return;
              }
            } catch (e) {
              // Fallback to manual insertion
            }
          }
          
          try {
            const wrapper = editorWrapperRef.current;
            if (wrapper) {
              const uploadInput = wrapper.querySelector('input[type="file"]') as HTMLInputElement;
              if (uploadInput) {
                const dataTransfer = new DataTransfer();
                Array.from(files).forEach(file => dataTransfer.items.add(file));
                uploadInput.files = dataTransfer.files;
                uploadInput.dispatchEvent(new Event('change', { bubbles: true }));
                return;
              }
            }
          } catch (e) {
            // Fallback to manual insertion
          }
          
          const uploadedUrls = await handleUploadFiles(files);
          if (uploadedUrls.length === 0) {
            return;
          }
          let currentValue = valRef.current || '';
          try {
            if (that.markdownEditor) {
              if (typeof that.markdownEditor.getValue === 'function') {
                const editorValue = that.markdownEditor.getValue();
                if (editorValue !== undefined && editorValue !== null && editorValue !== '') {
                  currentValue = editorValue;
                }
              } else if (that.markdownEditor.$props && that.markdownEditor.$props.modelValue) {
                currentValue = that.markdownEditor.$props.modelValue;
              }
            }
            if (!currentValue && that.valueCache) {
              currentValue = that.valueCache;
            }
          } catch (e) {
            // Ignore errors
          }
          
          const imageMarkdowns = uploadedUrls.map(url => `![image](${url})`).join('\n');
          
          let insertPosition = currentValue.length;
          if (savedCursorPosition) {
            try {
              const lines = currentValue.split('\n');
              let cursorLine = savedCursorPosition.line;
              
              if (cursorLine > lines.length) {
                cursorLine = cursorLine - 1;
              }
              
              cursorLine = Math.max(0, Math.min(cursorLine, lines.length - 1));
              
              let pos = 0;
              for (let i = 0; i < cursorLine && i < lines.length; i++) {
                pos += lines[i].length + 1;
              }
              
              const currentLineLength = cursorLine < lines.length ? lines[cursorLine].length : 0;
              const cursorColumn = Math.max(0, Math.min(savedCursorPosition.column, currentLineLength));
              pos += cursorColumn;
              
              insertPosition = Math.min(pos, currentValue.length);
            } catch (e) {
              // Ignore errors
            }
          } else {
            try {
              if (that.markdownEditor && typeof that.markdownEditor.getCursor === 'function') {
                const cursor = that.markdownEditor.getCursor();
                if (cursor && typeof cursor.line === 'number') {
                  const lines = currentValue.split('\n');
                  let cursorLine = cursor.line;
                  
                  if (cursorLine > lines.length) {
                    cursorLine = cursorLine - 1;
                  }
                  cursorLine = Math.max(0, Math.min(cursorLine, lines.length - 1));
                  
                  let pos = 0;
                  for (let i = 0; i < cursorLine && i < lines.length; i++) {
                    pos += lines[i].length + 1;
                  }
                  const currentLineLength = cursorLine < lines.length ? lines[cursorLine].length : 0;
                  const cursorColumn = Math.max(0, Math.min(cursor.column || 0, currentLineLength));
                  pos += cursorColumn;
                  insertPosition = Math.min(pos, currentValue.length);
                }
              }
            } catch (e) {
              // Ignore errors
            }
          }
          
          const before = currentValue.substring(0, insertPosition);
          const after = currentValue.substring(insertPosition);
          const prefix = before && !before.endsWith('\n') ? '\n' : '';
          const suffix = after && !after.startsWith('\n') ? '\n' : '';
          const newValue = before + prefix + imageMarkdowns + suffix + after;
          
          that.valueCache = newValue;
          setVal(newValue);
          
          if (that.setMarkdownEditorValue) {
            that.setMarkdownEditorValue(newValue);
          }
          
          $dom.val(newValue);
          $dom.text(newValue);
          
          setTimeout(() => {
            if (that.markdownEditor) {
              const currentValue = typeof that.markdownEditor.getValue === 'function' 
                ? that.markdownEditor.getValue() 
                : that.markdownEditor.$props?.modelValue;
              if (currentValue !== newValue) {
                setEditorKey(prev => prev + 1);
              }
            }
          }, 200);
          
          if (that.markdownEditor) {
            try {
              if (typeof that.markdownEditor.setValue === 'function') {
                that.markdownEditor.setValue(newValue);
              } else if (that.markdownEditor.$props) {
                that.markdownEditor.$props.modelValue = newValue;
                if (that.markdownEditor.$forceUpdate) {
                  that.markdownEditor.$forceUpdate();
                }
              }
            } catch (e) {
              // Ignore errors
            }
          }
          
          requestAnimationFrame(() => {
            if (that.markdownEditor && typeof that.markdownEditor.setValue === 'function') {
              try {
                const currentEditorValue = that.markdownEditor.getValue?.() || '';
                if (currentEditorValue !== newValue) {
                  that.markdownEditor.setValue(newValue);
                }
              } catch (e) {
                // Ignore errors
              }
            }
            
            if (savedCursorPosition && that.markdownEditor) {
              try {
                const lines = newValue.split('\n');
                let insertLine = savedCursorPosition.line;
                let insertColumn = savedCursorPosition.column + prefix.length + imageMarkdowns.length + suffix.length;
                
                if (insertLine < lines.length) {
                  const maxColumn = lines[insertLine].length;
                  if (insertColumn > maxColumn) {
                    insertColumn = maxColumn;
                  }
                }
                
                if (typeof that.markdownEditor.setCursor === 'function') {
                  that.markdownEditor.setCursor({
                    line: insertLine,
                    column: insertColumn,
                  });
                } else if (typeof that.markdownEditor.focus === 'function') {
                  that.markdownEditor.focus();
                }
              } catch (e) {
                // Ignore errors
              }
            }
          });
          
          onChange?.(newValue);
          
          if (that.markdownEditor && typeof that.markdownEditor.onChange === 'function') {
            try {
              that.markdownEditor.onChange(newValue);
            } catch (e) {
              // Ignore errors
            }
          }
          
          setTimeout(() => {
            const currentVal = valRef.current;
            if (currentVal !== newValue) {
              setVal(newValue);
              that.valueCache = newValue;
            }
          }, 100);
          
          savedCursorPosition = null;
        };

        const timer = setTimeout(() => {
          const wrapper = editorWrapperRef.current;
          if (!wrapper) {
            return;
          }

          wrapper.addEventListener('dragenter', handleDragEnter, true);
          wrapper.addEventListener('dragover', handleDragOver, true);
          wrapper.addEventListener('dragleave', handleDragLeave, true);
          wrapper.addEventListener('drop', handleDrop, true);
        }, 100);

        return () => {
          clearTimeout(timer);
          const wrapper = editorWrapperRef.current;
          if (wrapper) {
            wrapper.removeEventListener('dragenter', handleDragEnter, true);
            wrapper.removeEventListener('dragover', handleDragOver, true);
            wrapper.removeEventListener('dragleave', handleDragLeave, true);
            wrapper.removeEventListener('drop', handleDrop, true);
          }
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
            key={editorKey}
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
              uploadImgCallbackRef.current = callback;
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

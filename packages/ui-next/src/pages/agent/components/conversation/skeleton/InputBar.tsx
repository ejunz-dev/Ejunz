import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, KeyboardEvent, MouseEvent, ReactNode, SyntheticEvent } from 'react';
import { IconPlusOutline16, IconSendOutline14, IconStopFill16 } from '../../../icons';
import { AttachmentRail } from '../../attachment/AttachmentRail';
import { formatBytes, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type DraftAttachment } from '../../../runtime/uploads';
import { COMMANDS, CommandMenu } from '../../commands/CommandMenu';
import { ModelPicker } from '../../model/ModelPicker';
import type { SessionModels } from '../../types';
import { StatsLine } from '../chat/StatsLine';
import css from './InputBar.module.css';

interface InputBarProps {
    input: string;
    setInput: (value: string) => void;
    send: (mode?: 'queue' | 'steer') => void;
    cancel: () => void;
    running: boolean;
    sending: boolean;
    attachments: DraftAttachment[];
    onAddFiles: (files: File[]) => void;
    onRemoveAttachment: (id: string) => void;
    models: SessionModels | null;
    showModelPicker?: boolean;
    modeAccessory?: ReactNode;
    modelMenuOpen: boolean;
    setModelMenuOpen: (value: boolean) => void;
    selectModel: (provider: string, model: string) => void;
    notice?: ReactNode;
    projections?: Record<string, unknown>;
    children?: ReactNode;
    hero?: boolean;
    placeholder: string;
}

interface InputBodyProps {
    input: string;
    placeholder: string;
    sending: boolean;
    commandVisible: boolean;
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    inputRef: (element: HTMLTextAreaElement | null) => void;
    scrollRef: (element: HTMLDivElement | null) => void;
    mirrorRef: (element: HTMLDivElement | null) => void;
}

function renderBackdrop(input: string): ReactNode[] {
    const backdrop: ReactNode[] = [];
    const tokenPattern = /(^|\s)([/@][\w-]+)/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(input)) !== null) {
        const start = match.index + (match[1]?.length ?? 0);
        if (start > cursor) backdrop.push(input.slice(cursor, start));
        backdrop.push(<mark key={start} className={css.textRef}>{match[2]}</mark>);
        cursor = start + match[2].length;
    }
    if (cursor < input.length) backdrop.push(input.slice(cursor));
    return backdrop;
}

function InputBody({ input, placeholder, sending, commandVisible, onPaste, onSelect, onCompositionStart, onCompositionEnd, onKeyDown, onChange, inputRef, scrollRef, mirrorRef }: InputBodyProps) {
    return <div ref={scrollRef} className={css.scroll} data-input-scroll>
        <div className={css.grow}>
            <div aria-hidden className={css.backdrop} data-input-backdrop>{renderBackdrop(input)}</div>
            <textarea
                ref={inputRef}
                className={css.input}
                value={input}
                readOnly={sending}
                placeholder={placeholder}
                rows={2}
                aria-haspopup={commandVisible ? 'listbox' : undefined}
                aria-expanded={commandVisible || undefined}
                onChange={onChange}
                onKeyDown={onKeyDown}
                onSelect={onSelect}
                onPaste={onPaste}
                onCompositionStart={onCompositionStart}
                onCompositionEnd={onCompositionEnd}
            />
            <div ref={mirrorRef} aria-hidden className={css.mirror} data-input-mirror>{`${input}\n`}</div>
        </div>
    </div>;
}

export function InputBar({ input, setInput, send, cancel, running, sending, attachments, onAddFiles, onRemoveAttachment, models, showModelPicker = true, modeAccessory, modelMenuOpen, setModelMenuOpen, selectModel, notice, projections, children, hero, placeholder }: InputBarProps) {
    const [commandOpen, setCommandOpen] = useState(false);
    const [commandIndex, setCommandIndex] = useState(0);
    const [dropActive, setDropActive] = useState(false);
    const [fileNotice, setFileNotice] = useState<string | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const mirrorRef = useRef<HTMLDivElement | null>(null);
    const composingRef = useRef(false);
    const dragDepthRef = useRef(0);
    const commandQuery = input.startsWith('/') ? input.slice(1).split(/\s/, 1)[0] : '';
    const commandVisible = commandOpen || (input.startsWith('/') && !input.includes(' '));
    const commandItems = useMemo(() => COMMANDS.filter((command) => command.name.includes(commandQuery.toLowerCase())), [commandQuery]);
    const empty = input.trim() === '' && attachments.length === 0;
    const uploading = attachments.some((attachment) => attachment.meta === undefined && attachment.error === undefined);
    const canDrop = !sending;

    const setInputRef = useCallback((element: HTMLTextAreaElement | null) => {
        inputRef.current = element;
    }, []);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const setFileInputRef = useCallback((element: HTMLInputElement | null) => {
        fileInputRef.current = element;
    }, []);
    const setScrollRef = useCallback((element: HTMLDivElement | null) => {
        scrollRef.current = element;
    }, []);
    const setMirrorRef = useCallback((element: HTMLDivElement | null) => {
        mirrorRef.current = element;
    }, []);

    const revealCaret = useCallback((caret: number): void => {
        const scrollElement = scrollRef.current;
        const mirrorElement = mirrorRef.current;
        const text = mirrorElement?.firstChild;
        if (scrollElement === null || mirrorElement === null || !(text instanceof Text)) return;
        if (scrollElement.scrollHeight <= scrollElement.clientHeight) return;
        const at = Math.min(caret, text.data.length);
        const afterNewline = at > 0 && text.data[at - 1] === '\n';
        const range = document.createRange();
        range.setStart(text, afterNewline ? at - 1 : at);
        if (afterNewline) range.setEnd(text, at);
        else range.collapse(true);
        const line = afterNewline ? Number.parseFloat(getComputedStyle(mirrorElement).lineHeight) : 0;
        const rect = range.getBoundingClientRect();
        const box = scrollElement.getBoundingClientRect();
        if (rect.bottom + line > box.bottom) scrollElement.scrollTop += rect.bottom + line - box.bottom;
        else if (rect.top + line < box.top) scrollElement.scrollTop -= box.top - rect.top - line;
    }, []);

    const revealSelectionFocus = useCallback((element: HTMLTextAreaElement): void => {
        const caret = element.selectionDirection === 'backward' ? element.selectionStart : element.selectionEnd;
        revealCaret(caret ?? element.value.length);
    }, [revealCaret]);

    const restoreCaret = useCallback((element: HTMLTextAreaElement, caret: number): void => {
        requestAnimationFrame(() => {
            element.setSelectionRange(caret, caret);
            revealCaret(caret);
        });
    }, [revealCaret]);

    useEffect(() => {
        const element = inputRef.current;
        if (element === null || sending) return;
        element.focus({ preventScroll: true });
        revealSelectionFocus(element);
    }, [revealSelectionFocus, sending, hero]);

    useEffect(() => {
        const element = inputRef.current;
        if (element === null || input === '') return;
        revealSelectionFocus(element);
    }, [input !== '', revealSelectionFocus]);

    useEffect(() => {
        const element = scrollRef.current;
        if (element === null) return;
        const onWheel = (event: WheelEvent): void => {
            const host = element.closest('[data-conversation-scroll]');
            if (!(host instanceof HTMLElement) || event.deltaY === 0) return;
            const atTop = element.scrollTop <= 0;
            const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
            if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atEnd)) return;
            event.preventDefault();
            host.scrollTop += event.deltaY;
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, []);

    const queueFiles = useCallback((files: Iterable<File>): void => {
        const picked = Array.from(files).filter((file) => file.size > 0);
        if (picked.length === 0) return;
        const oversized = picked.filter((file) => file.size > MAX_ATTACHMENT_BYTES);
        const accepted = picked.filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
        if (accepted.length === 0) {
            setFileNotice(`单个文件不能超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
            return;
        }
        const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
        if (room === 0) {
            setFileNotice(`最多添加 ${MAX_ATTACHMENTS} 个文件`);
            return;
        }
        const queued = accepted.slice(0, room);
        if (oversized.length > 0) setFileNotice(`单个文件不能超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
        else if (queued.length < picked.length) setFileNotice(`最多添加 ${MAX_ATTACHMENTS} 个文件`);
        else setFileNotice(null);
        onAddFiles(queued);
    }, [attachments.length, onAddFiles]);

    useEffect(() => {
        const hasFiles = (event: globalThis.DragEvent): boolean => event.dataTransfer?.types.includes('Files') ?? false;
        const reset = (): void => {
            dragDepthRef.current = 0;
            setDropActive(false);
        };
        const onDragEnter = (event: globalThis.DragEvent): void => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setDropActive(true);
        };
        const onDragOver = (event: globalThis.DragEvent): void => {
            if (!hasFiles(event) || event.dataTransfer === null) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
        };
        const onDragLeave = (event: globalThis.DragEvent): void => {
            if (!hasFiles(event)) return;
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setDropActive(false);
            const leavingViewport = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
            if ((event.target === document.documentElement || event.target === document.body) && leavingViewport) reset();
        };
        const onDrop = (event: globalThis.DragEvent): void => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            reset();
            if (canDrop) queueFiles(event.dataTransfer?.files ?? []);
        };
        document.addEventListener('dragenter', onDragEnter);
        document.addEventListener('dragover', onDragOver);
        document.addEventListener('dragleave', onDragLeave);
        document.addEventListener('drop', onDrop);
        window.addEventListener('dragend', reset);
        return () => {
            document.removeEventListener('dragenter', onDragEnter);
            document.removeEventListener('dragover', onDragOver);
            document.removeEventListener('dragleave', onDragLeave);
            document.removeEventListener('drop', onDrop);
            window.removeEventListener('dragend', reset);
        };
    }, [canDrop, queueFiles]);

    const selectCommand = useCallback((command: string): void => {
        if (command === 'attach') {
            fileInputRef.current?.click();
            setCommandOpen(false);
            setCommandIndex(0);
            return;
        }
        setInput(`/${command} `);
        setCommandOpen(false);
        setCommandIndex(0);
    }, [setInput]);

    const onCommandKey = useCallback((key: 'up' | 'down' | 'escape'): void => {
        if (key === 'escape') {
            setCommandOpen(false);
            return;
        }
        if (commandItems.length === 0) return;
        setCommandIndex((index) => key === 'up' ? (index - 1 + commandItems.length) % commandItems.length : (index + 1) % commandItems.length);
    }, [commandItems.length]);

    const onCommandSubmit = useCallback((): void => {
        const command = commandItems[commandIndex];
        if (command) selectCommand(command.name);
    }, [commandIndex, commandItems, selectCommand]);

    const onCompositionStart = useCallback(() => {
        composingRef.current = true;
    }, []);

    const onCompositionEnd = useCallback(() => {
        window.setTimeout(() => {
            composingRef.current = false;
        }, 10);
    }, []);

    const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
        if (sending) return;
        setInput(event.target.value);
    }, [sending, setInput]);

    const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key === 'Enter' && event.shiftKey) return;
        const composing = composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            if (commandVisible) {
                event.preventDefault();
                onCommandKey(event.key === 'ArrowUp' ? 'up' : 'down');
            }
            return;
        }
        if (event.key === 'Escape' && commandVisible) {
            event.preventDefault();
            onCommandKey('escape');
            return;
        }
        if (event.key !== 'Enter' || composing) return;
        event.preventDefault();
        if (event.repeat) return;
        if (commandVisible && commandItems.length > 0) {
            onCommandSubmit();
            return;
        }
        if (sending) return;
        void send(event.ctrlKey || event.metaKey ? 'steer' : 'queue');
    }, [commandItems.length, commandVisible, onCommandKey, onCommandSubmit, send, sending]);

    const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>): void => {
        const files = Array.from(event.clipboardData.files);
        const text = event.clipboardData.getData('text/plain');
        if (files.length === 0 || sending) {
            if (files.length > 0 && sending) event.preventDefault();
            if (files.length > 0 && text === '') {
                event.preventDefault();
                queueFiles(files);
            }
            return;
        }
        event.preventDefault();
        queueFiles(files);
        if (text === '') return;
        const element = event.currentTarget;
        const start = element.selectionStart ?? input.length;
        const end = element.selectionEnd ?? start;
        const next = input.slice(0, start) + text + input.slice(end);
        setInput(next);
        restoreCaret(element, start + text.length);
    }, [input, queueFiles, restoreCaret, sending, setInput]);

    const onSelect = useCallback((event: SyntheticEvent<HTMLTextAreaElement>): void => {
        void event;
    }, []);

    const keepFocus = useCallback((event: MouseEvent<HTMLButtonElement>): void => {
        event.preventDefault();
        inputRef.current?.focus({ preventScroll: true });
    }, []);

    const onPrimary = useCallback((): void => {
        if (running) {
            cancel();
            return;
        }
        if (!empty && !sending && !uploading) void send();
    }, [cancel, empty, running, send, sending, uploading]);

    return <div className={`${css.root}${hero ? ` ${css.hero}` : ''}`} data-drop-active={dropActive || undefined}>
        {(notice || fileNotice) && <div className={`${css.notice} ${css.noticeError}`} role="status">{notice ?? fileNotice}</div>}
        {hero && children && <div className={css.accessory}>{children}</div>}
        {!hero && children}
        <div className={css.card} data-composer-card>
            <div className={css.overlayAnchor}>
                {commandVisible && <CommandMenu query={commandQuery} activeIndex={commandIndex} onSelect={selectCommand} onClose={() => setCommandOpen(false)} />}
            </div>
            {attachments.length > 0 && <div className={css.attachments}><AttachmentRail attachments={attachments} onRemove={onRemoveAttachment} /></div>}
            <input ref={setFileInputRef} className="eja-fileInput" type="file" multiple onChange={(event) => { queueFiles(event.target.files ?? []); event.currentTarget.value = ''; }} />
            <div className={css.row}>
                <div className={css.tools}>
                    <button type="button" className={css.add} aria-label="命令" aria-haspopup="listbox" aria-expanded={commandVisible} disabled={sending} onMouseDown={keepFocus} onClick={() => setCommandOpen((value) => !value)}><IconPlusOutline16 size={14} /></button>
                    <div className={css.modes}>
                        {modeAccessory}
                    </div>
                </div>
                <InputBody
                    input={input}
                    placeholder={placeholder}
                    sending={sending}
                    commandVisible={commandVisible}
                    onPaste={onPaste}
                    onSelect={onSelect}
                    onCompositionStart={onCompositionStart}
                    onCompositionEnd={onCompositionEnd}
                    onKeyDown={onKeyDown}
                    onChange={onChange}
                    inputRef={setInputRef}
                    scrollRef={setScrollRef}
                    mirrorRef={setMirrorRef}
                />
                <div className={css.trailing}>
                    {showModelPicker && models && <ModelPicker models={models} open={modelMenuOpen} onToggle={() => setModelMenuOpen(!modelMenuOpen)} onSelect={selectModel} />}
                    {sending && <span className={css.pending} aria-label="发送中" />}
                    <button type="button" className={css.primary} aria-label={running ? '停止' : '发送'} disabled={running ? false : empty || sending || uploading} onMouseDown={keepFocus} onClick={onPrimary}>{running ? <IconStopFill16 size={16} /> : <IconSendOutline14 size={16} />}</button>
                </div>
            </div>
        </div>
        {!hero && <StatsLine projections={projections} />}
    </div>;
}

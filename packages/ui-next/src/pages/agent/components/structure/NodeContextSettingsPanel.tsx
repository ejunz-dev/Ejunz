import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownEditor } from '../../../../components/markdown-editor';
import { renderMarkdown } from '../../../../components/base-detail/markdown';
import type { AgentNode } from '../../runtime/session';

interface NodeContextSettingsPanelProps {
    node: AgentNode;
    editing: boolean;
    saving: boolean;
    onCloseEdit: () => void;
    onSave: (context: string) => Promise<void>;
}

const MAX_NODE_CONTEXT_CHARS = 20_000;

export function NodeContextSettingsPanel({ node, editing, saving, onCloseEdit, onSave }: NodeContextSettingsPanelProps) {
    const context = node.config?.context ?? '';
    const editorTheme = typeof document !== 'undefined' && document.documentElement.classList.contains('theme--dark') ? 'dark' : 'light';
    const [draft, setDraft] = useState(context);
    const [error, setError] = useState('');
    const savingRef = useRef(saving);
    savingRef.current = saving;

    useEffect(() => {
        if (!editing) return;
        setDraft(context);
        setError('');
    }, [context, editing]);

    const save = useCallback(async () => {
        if (savingRef.current) return;
        setError('');
        try {
            await onSave(draft);
            onCloseEdit();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [draft, onCloseEdit, onSave]);

    useEffect(() => {
        if (!editing) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !savingRef.current) onCloseEdit();
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void save();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [editing, onCloseEdit, save]);

    return <>
        <div className="bd-drawer__body eza-nodeContextPreview">
            {context.trim()
                ? <div className="bd-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(context) }} />
                : <p className="bd-muted">当前节点尚未配置上下文。</p>}
        </div>
        {editing ? createPortal(
            <div className="bd-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCloseEdit(); }}>
                <section className="bd-edit-dialog bd-edit-dialog--card" role="dialog" aria-modal="true" aria-labelledby="agent-node-context-edit-title">
                    <header className="bd-edit-dialog__header">
                        <h2 id="agent-node-context-edit-title">编辑节点上下文</h2>
                        <div className="bd-edit-dialog__actions">
                            {saving ? <span className="bd-edit-dialog__status">保存中…</span> : null}
                            <button type="button" className="bd-edit-button bd-edit-button--primary" disabled={saving} onClick={() => { void save(); }}>保存</button>
                            <button type="button" className="bd-edit-button" disabled={saving} onClick={onCloseEdit}>取消</button>
                        </div>
                    </header>
                    <div className="bd-edit-dialog__body">
                        {error ? <p className="bd-edit-dialog__error" role="alert">{error}</p> : null}
                        <div className="bd-edit-field bd-edit-field--content">
                            <span>上下文</span>
                            <MarkdownEditor value={draft} onChange={setDraft} theme={editorTheme} style={{ height: '100%', minHeight: '16rem' }} />
                            <span className="bd-muted">{draft.length.toLocaleString()} / {MAX_NODE_CONTEXT_CHARS.toLocaleString()}</span>
                        </div>
                    </div>
                </section>
            </div>,
            document.body,
        ) : null}
    </>;
}

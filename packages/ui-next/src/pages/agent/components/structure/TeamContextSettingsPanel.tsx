import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownEditor } from '../../../../components/markdown-editor';
import { i18n } from '@/i18n';
import { renderMarkdown } from '../../../../components/base-detail/markdown';
import type { AgentTeam } from '../../runtime/session';

interface TeamContextSettingsPanelProps {
    team: AgentTeam;
    editing: boolean;
    saving: boolean;
    onCloseEdit: () => void;
    onSave: (context: string) => Promise<void>;
}

const MAX_TEAM_CONTEXT_CHARS = 20_000;

export function TeamContextSettingsPanel({ team, editing, saving, onCloseEdit, onSave }: TeamContextSettingsPanelProps) {
    const context = team.config?.context ?? '';
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
        <div className="bd-drawer__body ea-teamContextPreview">
            {context.trim()
                ? <div className="bd-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(context) }} />
                : <p className="bd-muted">{i18n('This team has no context configured.')}</p>}
        </div>
        {editing ? createPortal(
            <div className="bd-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCloseEdit(); }}>
                <section className="bd-edit-dialog bd-edit-dialog--card" role="dialog" aria-modal="true" aria-labelledby="agent-team-context-edit-title">
                    <header className="bd-edit-dialog__header">
                        <h2 id="agent-team-context-edit-title">{i18n('Edit team context')}</h2>
                        <div className="bd-edit-dialog__actions">
                            {saving ? <span className="bd-edit-dialog__status">{i18n('Saving...')}</span> : null}
                            <button type="button" className="bd-edit-button bd-edit-button--primary" disabled={saving} onClick={() => { void save(); }}>{i18n('Save')}</button>
                            <button type="button" className="bd-edit-button" disabled={saving} onClick={onCloseEdit}>{i18n('Cancel')}</button>
                        </div>
                    </header>
                    <div className="bd-edit-dialog__body">
                        {error ? <p className="bd-edit-dialog__error" role="alert">{error}</p> : null}
                        <div className="bd-edit-field bd-edit-field--content">
                            <span>{i18n('Context')}</span>
                            <MarkdownEditor value={draft} onChange={setDraft} theme={editorTheme} style={{ height: '100%', minHeight: '16rem' }} />
                            <span className="bd-muted">{draft.length.toLocaleString()} / {MAX_TEAM_CONTEXT_CHARS.toLocaleString()}</span>
                        </div>
                    </div>
                </section>
            </div>,
            document.body,
        ) : null}
    </>;
}

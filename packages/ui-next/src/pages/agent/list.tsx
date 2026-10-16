import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ActionDialog } from './components/primitives/ActionDialog';
import { i18n } from '@/i18n';
import { domainPrefix, useAgentRpc } from './runtime/rpc';
import { useAgentTheme } from './runtime/theme';
import { Notification, useBuildUrl, useUiContext, useUserContext } from '@ejunz/ui-next';
import './tokens.css';
import './page.css';
import './list.css';

interface GroupDefinition {
    groupId: number;
    aid: string;
    title: string;
    content: string;
    updateAt?: string;
}

function summary(content: string): string {
    const value = content.replace(/\s+/g, ' ').trim();
    return value.length > 180 ? `${value.slice(0, 180)}…` : value;
}

function formatDate(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

export default function AgentListPage() {
    const rpc = useAgentRpc();
    const user = useUserContext();
    const { domainId, domain } = useUiContext();
    const buildUrl = useBuildUrl();
    const { dark } = useAgentTheme();
    const guest = !user || user._id == null || user._id === 0 || user._id === '0';
    const domainName = typeof domain?.name === 'string' && domain.name.trim() ? domain.name : String(domainId || 'system');
    const [agents, setAgents] = useState<GroupDefinition[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [creating, setCreating] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [createTitle, setCreateTitle] = useState('');
    const [createContent, setCreateContent] = useState('');
    const [createError, setCreateError] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [editingDocId, setEditingDocId] = useState<number | null>(null);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [deleting, setDeleting] = useState<GroupDefinition | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    useEffect(() => {
        if (!guest) return;
        const redirect = `${window.location.pathname}${window.location.search}`;
        window.location.href = buildUrl('user_login', {}, { redirect });
    }, [buildUrl, guest]);

    useEffect(() => {
        if (!createOpen) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !creating) setCreateOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [createOpen, creating]);

    const loadAgents = useCallback(async () => {
        setLoading(true);
        try {
            const value = await rpc('group.list', {}) as { items?: GroupDefinition[] };
            setAgents(Array.isArray(value.items) ? value.items : []);
            setLoadError(null);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            setLoading(false);
        }
    }, [rpc]);

    useEffect(() => {
        if (!guest) void loadAgents();
    }, [guest, loadAgents]);

    const startCreate = useCallback(() => {
        setCreateTitle('');
        setCreateContent('');
        setCreateError(null);
        setCreateOpen(true);
    }, []);

    const startEdit = useCallback((agent: GroupDefinition) => {
        setEditingDocId(agent.groupId);
        setTitle(agent.title);
        setContent(agent.content);
        setLoadError(null);
    }, []);

    const saveAgent = useCallback(async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const normalizedTitle = title.trim();
        if (editingDocId === null || !normalizedTitle || saving) return;
        setSaving(true);
        try {
            const value = await rpc('group.update', { groupId: editingDocId, title: normalizedTitle, content }) as { group?: GroupDefinition };
            if (!value.group) throw new Error(i18n('Group save failed'));
            setAgents((items) => items.map((agent) => agent.groupId === editingDocId ? value.group! : agent));
            startEdit(value.group);
            setLoadError(null);
            await Notification.success(i18n('Group saved'));
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    }, [content, editingDocId, rpc, saving, startEdit, title]);

    const createAgent = useCallback(async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const normalizedTitle = createTitle.trim();
        if (!normalizedTitle || creating) return;
        setCreating(true);
        setCreateError(null);
        try {
            const value = await rpc('group.create', { title: normalizedTitle, content: createContent }) as { group?: GroupDefinition };
            if (!value.group) throw new Error(i18n('Group creation failed'));
            setAgents((items) => [value.group!, ...items]);
            setCreateOpen(false);
            setCreateTitle('');
            setCreateContent('');
            await Notification.success(i18n('Group created'));
        } catch (error) {
            setCreateError(error instanceof Error ? error.message : String(error));
        } finally {
            setCreating(false);
        }
    }, [createContent, createTitle, creating, rpc]);

    const confirmDelete = useCallback(async () => {
        if (!deleting || deleteBusy) return;
        setDeleteBusy(true);
        setDeleteError(null);
        try {
            await rpc('group.delete', { groupId: deleting.groupId });
            setAgents((items) => items.filter((agent) => agent.groupId !== deleting.groupId));
            if (editingDocId === deleting.groupId) {
                setEditingDocId(null);
                setTitle('');
                setContent('');
                setLoadError(null);
            }
            setDeleting(null);
            await Notification.success(i18n('Group deleted'));
        } catch (error) {
            setDeleteError(error instanceof Error ? error.message : String(error));
        } finally {
            setDeleteBusy(false);
        }
    }, [deleteBusy, deleting, editingDocId, rpc]);

    if (guest) return null;

    return (
        <div className="eza-app" data-ds-dark-theme={dark || undefined}>
            <main className="eza-agentCatalog">
                <header className="eza-agentCatalog__header">
                    <div>
                        <h1>{i18n('Groups')}</h1>
                        <p>{i18n('Manage Groups available in {0}.', domainName)}</p>
                    </div>
                    <nav className="eza-agentCatalog__headerActions" aria-label={i18n('Group management actions')}>
                        <a className="eza-agentCatalog__link" href={`${domainPrefix(String(domainId || 'system'))}/corp/chat`}>{i18n('Open chat workspace')}</a>
                        <button type="button" className="eza-agentCatalog__primary" onClick={startCreate}>{i18n('New Group')}</button>
                    </nav>
                </header>

                {loadError && !editingDocId ? <p className="eza-agentCatalog__notice" role="alert">{loadError}</p> : null}

                <div className="eza-agentCatalog__layout" data-editing={editingDocId !== null || undefined} aria-busy={loading || saving || creating}>
                    <section className="eza-agentCatalog__list" aria-label={i18n('Group list')}>
                        <div className="eza-agentCatalog__listHeader">
                            <h2>{i18n('Configuration')}</h2>
                            <span>{loading ? i18n('Loading...') : i18n('{0} items', agents.length)}</span>
                        </div>
                        {loading ? <p className="eza-agentCatalog__state">{i18n('Loading Groups...')}</p> : null}
                        {!loading && agents.length === 0 ? (
                            <div className="eza-agentCatalog__empty">
                                <strong>{i18n('No Groups yet')}</strong>
                                <p>{i18n('Create a configuration to save its name and behavior description.')}</p>
                                <button type="button" onClick={startCreate}>{i18n('Create your first Group')}</button>
                            </div>
                        ) : null}
                        <ul className="eza-agentCatalog__items">
                            {agents.map((agent) => (
                                <li key={agent.groupId}>
                                    <article className="eza-agentCatalog__item" data-selected={editingDocId === agent.groupId || undefined}>
                                        <button type="button" className="eza-agentCatalog__itemMain" onClick={() => startEdit(agent)} aria-current={editingDocId === agent.groupId ? 'true' : undefined}>
                                            <span className="eza-agentCatalog__itemTitle">{agent.title || i18n('Untitled Group')}</span>
                                            <span className="eza-agentCatalog__itemMeta">#{agent.groupId} <span aria-hidden="true">·</span> {formatDate(agent.updateAt) || i18n('Not updated yet')}</span>
                                            <span className="eza-agentCatalog__itemSummary">{summary(agent.content) || i18n('No behavior description added.')}</span>
                                        </button>
                                        <div className="eza-agentCatalog__itemActions">
                                            <a href={`${domainPrefix(String(domainId || 'system'))}/corp/group/${agent.groupId}`}>{i18n('Open Group workspace')}</a>
                                            <button type="button" className="eza-agentCatalog__delete" onClick={() => { setDeleting(agent); setDeleteError(null); }}>{i18n('Delete')}</button>
                                        </div>
                                    </article>
                                </li>
                            ))}
                        </ul>
                    </section>

                    {editingDocId !== null && <section className="eza-agentCatalog__editor" aria-label={i18n('Edit Group')}>
                        <div className="eza-agentCatalog__editorHeading">
                            <div>
                                <h2>{i18n('Edit Group')}</h2>
                                <p>{i18n('Configuration ID: {0}', editingDocId)}</p>
                            </div>
                        </div>
                        <form className="eza-agentCatalog__form" onSubmit={(event) => { void saveAgent(event); }}>
                            <label className="eza-agentCatalog__field">
                                <span>{i18n('Name')}</span>
                                <input autoComplete="off" maxLength={256} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={i18n('e.g. Research assistant')} required />
                            </label>
                            <label className="eza-agentCatalog__field">
                                <span>{i18n('Behavior description')}</span>
                                <textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={100000} rows={15} placeholder={i18n('Describe this Group’s role, goals, and way of working.')} />
                                <small>{i18n('Up to 100000 characters')}</small>
                            </label>
                            {loadError ? <p className="eza-agentCatalog__notice" role="alert">{loadError}</p> : null}
                            <div className="eza-agentCatalog__formActions">
                                <button type="submit" className="eza-agentCatalog__primary" disabled={saving || !title.trim()}>{saving ? i18n('Saving...') : i18n('Save changes')}</button>
                                <button type="button" className="eza-agentCatalog__secondary" onClick={() => setEditingDocId(null)} disabled={saving}>{i18n('Close editor')}</button>
                            </div>
                        </form>
                    </section>}
                </div>
            </main>
            {createOpen && <div className="eza-agentCreateModal" role="presentation">
                <button type="button" className="eza-agentCreateModal__mask" aria-label={i18n('Close new Group dialog')} disabled={creating} onClick={() => setCreateOpen(false)} />
                <section className="eza-agentCreateModal__dialog" role="dialog" aria-modal="true" aria-labelledby="eza-agentCreateModal-title">
                    <header className="eza-agentCreateModal__header">
                        <div>
                            <h2 id="eza-agentCreateModal-title">{i18n('New Group')}</h2>
                            <p>{i18n('Enter a name and behavior description. You can open its workspace after creation.')}</p>
                        </div>
                        <button type="button" aria-label={i18n('Close')} disabled={creating} onClick={() => setCreateOpen(false)}>×</button>
                    </header>
                    <form className="eza-agentCatalog__form" onSubmit={(event) => { void createAgent(event); }}>
                        <label className="eza-agentCatalog__field">
                            <span>{i18n('Name')}</span>
                            <input autoFocus autoComplete="off" maxLength={256} value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder={i18n('e.g. Research assistant')} required />
                        </label>
                        <label className="eza-agentCatalog__field">
                            <span>{i18n('Behavior description')}</span>
                            <textarea value={createContent} onChange={(event) => setCreateContent(event.target.value)} maxLength={100000} rows={10} placeholder={i18n('Describe this Group’s role, goals, and way of working.')} />
                            <small>{i18n('Up to 100000 characters')}</small>
                        </label>
                        {createError ? <p className="eza-agentCatalog__notice" role="alert">{createError}</p> : null}
                        <div className="eza-agentCatalog__formActions">
                            <button type="button" className="eza-agentCatalog__secondary" disabled={creating} onClick={() => setCreateOpen(false)}>{i18n('Cancel')}</button>
                            <button type="submit" className="eza-agentCatalog__primary" disabled={creating || !createTitle.trim()}>{creating ? i18n('Creating...') : i18n('Create Group')}</button>
                        </div>
                    </form>
                </section>
            </div>}
            <ActionDialog
                open={deleting !== null}
                title={i18n('Delete Group?')}
                description={deleting ? i18n('Delete "{0}" to remove only its configuration. Existing sessions will remain. This cannot be undone.', deleting.title) : undefined}
                confirmLabel={i18n('Delete Group')}
                danger
                busy={deleteBusy}
                error={deleteError}
                onClose={() => { if (!deleteBusy) setDeleting(null); }}
                onConfirm={() => { void confirmDelete(); }}
            />
        </div>
    );
}

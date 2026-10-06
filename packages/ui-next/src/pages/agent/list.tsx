import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ActionDialog } from './components/primitives/ActionDialog';
import { domainPrefix, useAgentRpc } from './runtime/rpc';
import { useAgentTheme } from './runtime/theme';
import { Notification, useBuildUrl, useUiContext, useUserContext } from '@ejunz/ui-next';
import './tokens.css';
import './page.css';
import './list.css';

interface AgentDefinition {
    docId: number;
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
    const [agents, setAgents] = useState<AgentDefinition[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [editingDocId, setEditingDocId] = useState<number | null>(null);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [deleting, setDeleting] = useState<AgentDefinition | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    useEffect(() => {
        if (!guest) return;
        const redirect = `${window.location.pathname}${window.location.search}`;
        window.location.href = buildUrl('user_login', {}, { redirect });
    }, [buildUrl, guest]);

    const loadAgents = useCallback(async () => {
        setLoading(true);
        try {
            const value = await rpc('agent.list', {}) as { items?: AgentDefinition[] };
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
        setEditingDocId(null);
        setTitle('');
        setContent('');
        setLoadError(null);
    }, []);

    const startEdit = useCallback((agent: AgentDefinition) => {
        setEditingDocId(agent.docId);
        setTitle(agent.title);
        setContent(agent.content);
        setLoadError(null);
    }, []);

    const saveAgent = useCallback(async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const normalizedTitle = title.trim();
        if (!normalizedTitle || saving) return;
        setSaving(true);
        try {
            const value = editingDocId
                ? await rpc('agent.update', { docId: editingDocId, title: normalizedTitle, content }) as { agent?: AgentDefinition }
                : await rpc('agent.create', { title: normalizedTitle, content }) as { agent?: AgentDefinition };
            if (!value.agent) throw new Error('Agent 保存失败');
            setAgents((items) => editingDocId
                ? items.map((agent) => agent.docId === editingDocId ? value.agent! : agent)
                : [value.agent!, ...items]);
            startEdit(value.agent);
            setLoadError(null);
            await Notification.success(editingDocId ? 'Agent 已保存' : 'Agent 已创建');
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    }, [content, editingDocId, rpc, saving, startEdit, title]);

    const confirmDelete = useCallback(async () => {
        if (!deleting || deleteBusy) return;
        setDeleteBusy(true);
        setDeleteError(null);
        try {
            await rpc('agent.delete', { docId: deleting.docId });
            setAgents((items) => items.filter((agent) => agent.docId !== deleting.docId));
            if (editingDocId === deleting.docId) startCreate();
            setDeleting(null);
            await Notification.success('Agent 已删除');
        } catch (error) {
            setDeleteError(error instanceof Error ? error.message : String(error));
        } finally {
            setDeleteBusy(false);
        }
    }, [deleteBusy, deleting, editingDocId, rpc, startCreate]);

    if (guest) return null;

    return (
        <div className="eja-app" data-ds-dark-theme={dark || undefined}>
            <main className="eja-agentCatalog">
                <header className="eja-agentCatalog__header">
                    <div>
                        <h1>Agents</h1>
                        <p>管理 {domainName} 中可用的 Agent 配置。</p>
                    </div>
                    <nav className="eja-agentCatalog__headerActions" aria-label="Agent 页面操作">
                        <a className="eja-agentCatalog__link" href={`${domainPrefix(String(domainId || 'system'))}/agent/chat`}>打开聊天工作台</a>
                        <button type="button" className="eja-agentCatalog__primary" onClick={startCreate}>新建 Agent</button>
                    </nav>
                </header>

                {loadError && !editingDocId ? <p className="eja-agentCatalog__notice" role="alert">{loadError}</p> : null}

                <div className="eja-agentCatalog__layout" aria-busy={loading || saving}>
                    <section className="eja-agentCatalog__list" aria-label="Agent 列表">
                        <div className="eja-agentCatalog__listHeader">
                            <h2>配置</h2>
                            <span>{loading ? '加载中…' : `${agents.length} 个`}</span>
                        </div>
                        {loading ? <p className="eja-agentCatalog__state">正在读取 Agent…</p> : null}
                        {!loading && agents.length === 0 ? (
                            <div className="eja-agentCatalog__empty">
                                <strong>还没有 Agent</strong>
                                <p>创建一个配置，保存它的名称和行为说明。</p>
                                <button type="button" onClick={startCreate}>创建第一个 Agent</button>
                            </div>
                        ) : null}
                        <ul className="eja-agentCatalog__items">
                            {agents.map((agent) => (
                                <li key={agent.docId}>
                                    <article className="eja-agentCatalog__item" data-selected={editingDocId === agent.docId || undefined}>
                                        <button type="button" className="eja-agentCatalog__itemMain" onClick={() => startEdit(agent)} aria-current={editingDocId === agent.docId ? 'true' : undefined}>
                                            <span className="eja-agentCatalog__itemTitle">{agent.title || '未命名 Agent'}</span>
                                            <span className="eja-agentCatalog__itemMeta">#{agent.docId} <span aria-hidden="true">·</span> {formatDate(agent.updateAt) || '尚未更新'}</span>
                                            <span className="eja-agentCatalog__itemSummary">{summary(agent.content) || '尚未添加行为说明。'}</span>
                                        </button>
                                        <div className="eja-agentCatalog__itemActions">
                                            <a href={`${domainPrefix(String(domainId || 'system'))}/agent/${agent.docId}`}>打开工作区</a>
                                            <button type="button" className="eja-agentCatalog__delete" onClick={() => { setDeleting(agent); setDeleteError(null); }}>删除</button>
                                        </div>
                                    </article>
                                </li>
                            ))}
                        </ul>
                    </section>

                    <section className="eja-agentCatalog__editor" aria-label={editingDocId ? '编辑 Agent' : '新建 Agent'}>
                        <div className="eja-agentCatalog__editorHeading">
                            <div>
                                <h2>{editingDocId ? '编辑 Agent' : '新建 Agent'}</h2>
                                <p>{editingDocId ? `配置编号 ${editingDocId}` : '定义名称和 Agent 的行为说明。'}</p>
                            </div>
                            {editingDocId ? <button type="button" className="eja-agentCatalog__textButton" onClick={startCreate}>新建</button> : null}
                        </div>
                        <form className="eja-agentCatalog__form" onSubmit={(event) => { void saveAgent(event); }}>
                            <label className="eja-agentCatalog__field">
                                <span>名称</span>
                                <input autoComplete="off" maxLength={256} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：研究助理" required />
                            </label>
                            <label className="eja-agentCatalog__field">
                                <span>行为说明</span>
                                <textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={100000} rows={15} placeholder="描述这个 Agent 的职责、目标和工作方式。" />
                                <small>最多 100000 个字符</small>
                            </label>
                            {loadError ? <p className="eja-agentCatalog__notice" role="alert">{loadError}</p> : null}
                            <div className="eja-agentCatalog__formActions">
                                <button type="submit" className="eja-agentCatalog__primary" disabled={saving || !title.trim()}>{saving ? '保存中…' : editingDocId ? '保存更改' : '创建 Agent'}</button>
                                {editingDocId ? <button type="button" className="eja-agentCatalog__secondary" onClick={startCreate} disabled={saving}>取消编辑</button> : null}
                            </div>
                        </form>
                    </section>
                </div>
            </main>
            <ActionDialog
                open={deleting !== null}
                title="删除 Agent？"
                description={deleting ? `删除“${deleting.title}”只会移除这条配置，不会删除现有会话。此操作无法撤销。` : undefined}
                confirmLabel="删除 Agent"
                danger
                busy={deleteBusy}
                error={deleteError}
                onClose={() => { if (!deleteBusy) setDeleting(null); }}
                onConfirm={() => { void confirmDelete(); }}
            />
        </div>
    );
}

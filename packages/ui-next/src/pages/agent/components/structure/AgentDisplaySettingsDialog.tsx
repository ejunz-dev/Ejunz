import { useEffect, useState } from 'react';

export interface AgentDisplaySettings {
    showModel: boolean;
    showBase: boolean;
    showTimestamps: boolean;
    showStatus: boolean;
}

export const defaultAgentDisplaySettings: AgentDisplaySettings = {
    showModel: true,
    showBase: true,
    showTimestamps: true,
    showStatus: true,
};

export function readAgentDisplaySettings(raw: unknown): AgentDisplaySettings {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaultAgentDisplaySettings };
    const value = raw as Record<string, unknown>;
    return {
        showModel: value.showModel !== false,
        showBase: value.showBase !== false,
        showTimestamps: value.showTimestamps !== false,
        showStatus: value.showStatus as boolean,
    };
}

interface AgentDisplaySettingsDialogProps {
    open: boolean;
    settings: AgentDisplaySettings;
    saving?: boolean;
    onClose: () => void;
    onSave: (settings: AgentDisplaySettings) => void | Promise<void>;
}

const rows: Array<{ key: keyof AgentDisplaySettings; label: string; description: string }> = [
    { key: 'showModel', label: '显示模型', description: '在当前会话卡片的标签区域显示使用的模型。' },
    { key: 'showBase', label: '显示知识库', description: '在会话卡片的标签区域显示使用的知识库。' },
    { key: 'showTimestamps', label: '显示创建时间和修改时间', description: '使用 Base Detail 同款格式显示卡片创建时间和相对修改时间。' },
    { key: 'showStatus', label: '显示实时状态', description: '在每个会话卡片标题前显示当前运行状态。' },
];

export function AgentDisplaySettingsDialog({ open, settings, saving = false, onClose, onSave }: AgentDisplaySettingsDialogProps) {
    const [draft, setDraft] = useState(settings);

    useEffect(() => {
        if (!open) return undefined;
        setDraft(settings);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !saving) onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        const previousBodyOverflow = document.body.style.overflow;
        const previousDocumentOverflow = document.documentElement.style.overflow;
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            document.body.style.overflow = previousBodyOverflow;
            document.documentElement.style.overflow = previousDocumentOverflow;
        };
    }, [onClose, open, settings, saving]);

    if (!open) return null;
    return (
        <div className="bd-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
            <section className="bd-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="eja-display-settings-title">
                <header className="bd-settings-dialog__header">
                    <h2 id="eja-display-settings-title">◌ 显示设置</h2>
                    <button type="button" className="bd-settings-dialog__close" onClick={onClose} disabled={saving} aria-label="关闭">×</button>
                </header>
                <p className="bd-settings-dialog__hint">选择要显示在会话卡片中的信息。</p>
                <div className="bd-settings-dialog__list">
                    {rows.map((row) => (
                        <label className="bd-settings-dialog__row" key={row.key}>
                            <span className="bd-settings-dialog__row-text">
                                <span className="bd-settings-dialog__row-label">{row.label}</span>
                                <span className="bd-settings-dialog__row-description">{row.description}</span>
                            </span>
                            <input
                                type="checkbox"
                                checked={draft[row.key]}
                                disabled={saving}
                                onChange={(event) => {
                                    const checked = event.currentTarget.checked;
                                    setDraft((current) => ({ ...current, [row.key]: checked }));
                                }}
                            />
                        </label>
                    ))}
                </div>
                <footer className="bd-settings-dialog__footer">
                    <button type="button" className="bd-settings-button" onClick={onClose} disabled={saving}>取消</button>
                    <button type="button" className="bd-settings-button bd-settings-button--primary" onClick={() => void onSave(draft)} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
                </footer>
            </section>
        </div>
    );
}

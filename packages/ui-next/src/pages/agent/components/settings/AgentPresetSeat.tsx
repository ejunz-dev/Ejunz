import { useMemo, useState } from 'react';
import { IconAgentPresetOutline16, IconChevronDownOutline14 } from '../../icons';
import { Menu } from '../primitives/Menu';
import css from './AgentPresetControls.module.css';

export interface AgentPresetOption {
    id: string;
    trust: 'system' | 'user';
    name?: string;
    description?: string;
}

export interface AgentPresetSeatProps {
    options: readonly AgentPresetOption[];
    selectedId: string;
    disabled?: boolean;
    error?: string | null;
    onSelect: (id: string) => void;
}

const BUILT_IN_NAMES: Record<string, { name: string; description: string }> = {
    standard: { name: '标准模式', description: '功能完整的编码 Agent。' },
    code: { name: 'PTC 模式', description: '通过 Code Mode SDK 组合多步操作。' },
    minimal: { name: '极简模式', description: '仅提供持久 bash 与 str_replace_editor。' },
    cordis: { name: '创造模式', description: '用于创建自定义 Agent preset。' },
};

function presetText(option: AgentPresetOption): { name: string; description: string } {
    const builtIn = option.trust === 'system' ? BUILT_IN_NAMES[option.id] : undefined;
    return builtIn ?? { name: option.name ?? option.id, description: option.description ?? '暂无描述。' };
}

export function AgentPresetSeat({ options, selectedId, disabled, error, onSelect }: AgentPresetSeatProps) {
    const [open, setOpen] = useState(false);
    const selected = useMemo(() => options.find((option) => option.id === selectedId), [options, selectedId]);
    const label = selected ? presetText(selected).name : (selectedId || '加载中…');

    if (!options.length) return error ? <p className={css.error} role="alert">{error}</p> : null;

    return <>
        <Menu
            open={open}
            onClose={() => setOpen(false)}
            items={options.map((option) => {
                const text = presetText(option);
                return {
                    id: option.id,
                    label: <span className={css.menuLabel}><span className={css.optionName}>{text.name}{option.trust === 'user' ? ' · 自定义' : ''}</span><span className={css.optionDescription}>{text.description}</span></span>,
                };
            })}
            selectedId={selectedId}
            onSelect={(id) => { setOpen(false); onSelect(id); }}
            align="end"
            side="top"
            portal
            anchor={<button type="button" className={css.seat} aria-haspopup="menu" aria-expanded={open} title={error ?? '即将开始的会话所用的 Agent 预设'} disabled={disabled} onClick={() => { setOpen((value) => !value); }}>
                <IconAgentPresetOutline16 size={14} />
                <span className={css.seatLabel}>{label}</span>
                <IconChevronDownOutline14 size={14} className={css.chevron} />
            </button>}
        />
        {error ? <p className={css.error} role="alert">{error}</p> : null}
    </>;
}

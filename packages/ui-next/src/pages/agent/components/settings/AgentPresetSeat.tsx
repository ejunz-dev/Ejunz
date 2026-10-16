import { useMemo, useState } from 'react';
import { i18n } from '@/i18n';
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

function builtInText(id: string): { name: string; description: string } | undefined {
    if (id === 'standard') return { name: i18n('Standard mode'), description: i18n('A full-featured coding Agent.') };
    if (id === 'code') return { name: i18n('PTC mode'), description: i18n('Compose multi-step operations through the Code Mode SDK.') };
    if (id === 'minimal') return { name: i18n('Minimal mode'), description: i18n('Provides persistent bash and str_replace_editor only.') };
    if (id === 'cordis') return { name: i18n('Creator mode'), description: i18n('Create a custom Agent preset.') };
    return undefined;
}

function presetText(option: AgentPresetOption): { name: string; description: string } {
    const builtIn = option.trust === 'system' ? builtInText(option.id) : undefined;
    return builtIn ?? { name: option.name ?? option.id, description: option.description ?? i18n('No description available.') };
}

export function AgentPresetSeat({ options, selectedId, disabled, error, onSelect }: AgentPresetSeatProps) {
    const [open, setOpen] = useState(false);
    const selected = useMemo(() => options.find((option) => option.id === selectedId), [options, selectedId]);
    const label = selected ? presetText(selected).name : (selectedId || i18n('Loading...'));

    if (!options.length) return error ? <p className={css.error} role="alert">{error}</p> : null;

    return <>
        <Menu
            open={open}
            onClose={() => setOpen(false)}
            items={options.map((option) => {
                const text = presetText(option);
                return {
                    id: option.id,
                    label: <span className={css.menuLabel}><span className={css.optionName}>{text.name}{option.trust === 'user' ? ` · ${i18n('Custom')}` : ''}</span><span className={css.optionDescription}>{text.description}</span></span>,
                };
            })}
            selectedId={selectedId}
            onSelect={(id) => { setOpen(false); onSelect(id); }}
            align="end"
            side="top"
            portal
            anchor={<button type="button" className={css.seat} aria-haspopup="menu" aria-expanded={open} title={error ?? i18n('Agent preset used for upcoming sessions')} disabled={disabled} onClick={() => { setOpen((value) => !value); }}>
                <IconAgentPresetOutline16 size={14} />
                <span className={css.seatLabel}>{label}</span>
                <IconChevronDownOutline14 size={14} className={css.chevron} />
            </button>}
        />
        {error ? <p className={css.error} role="alert">{error}</p> : null}
    </>;
}

import { useEffect, useId, useRef, useState } from 'react';
import {
    IconAgentPresetOutline16, IconCloseOutline16, IconCodeOutline16, IconDataOutline16,
    IconPersonalizationOutline16, IconSettingsOutline16,
} from '../../icons';
import css from './SettingsRoot.module.css';

export interface SettingsSectionRow {
    id: string;
    label: string;
}

interface SettingsSection {
    id: string;
    label: string;
    render: () => React.ReactNode;
}

export interface SettingsRootProps {
    open: boolean;
    onClose: () => void;
    activeId: string | null;
    onSelect: (id: string) => void;
    headerAction?: React.ReactNode;
    sections: SettingsSection[];
}

function navIcon(id: string) {
    if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />;
    if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />;
    if (id === 'tools') return <IconCodeOutline16 className={css.navIcon} size={16} />;
    if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />;
    return <IconSettingsOutline16 className={css.navIcon} size={16} />;
}

interface PanelProps {
    sections: SettingsSection[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: () => void;
    headerAction?: React.ReactNode;
}

function SettingsPanel({ sections, activeId, onSelect, onClose, headerAction }: PanelProps) {
    const active = sections.find((section) => section.id === activeId)?.id ?? sections[0]?.id;
    const titleId = useId();

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('keydown', onKeyDown); };
    }, [onClose]);

    const closeButton = useRef<HTMLButtonElement | null>(null);
    useEffect(() => { closeButton.current?.focus(); }, []);

    return (
        <div className={css.overlay} role="presentation">
            <div className={css.mask} aria-hidden="true" onClick={onClose} />
            <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
                <nav className={css.nav}>
                    <div className={css.navTitle} id={titleId}>设置</div>
                    <div className={css.navList}>
                        {sections.map((section) => (
                            <button
                                key={section.id}
                                type="button"
                                className={section.id === active ? `${css.navCell} ${css.active}` : css.navCell}
                                aria-current={section.id === active ? 'true' : undefined}
                                onClick={() => { onSelect(section.id); }}
                            >
                                {navIcon(section.id)}
                                <span className={css.navLabel}>{section.label}</span>
                            </button>
                        ))}
                    </div>
                </nav>
                <div className={css.content}>
                    <div className={css.header}>
                        <div className={css.actions}>{headerAction}</div>
                        <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
                            <IconCloseOutline16 size={14} />
                            <span className={css.hiddenLabel}>关闭</span>
                        </button>
                    </div>
                    <div className={css.options}>
                        {active !== undefined && sections.find((section) => section.id === active)?.render()}
                    </div>
                </div>
            </div>
        </div>
    );
}

export function SettingsRoot({ open, onClose, activeId, onSelect, headerAction, sections }: SettingsRootProps) {
    if (!open) return null;
    return (
        <SettingsPanel
            sections={sections}
            activeId={activeId}
            onSelect={onSelect}
            onClose={onClose}
            headerAction={headerAction}
        />
    );
}

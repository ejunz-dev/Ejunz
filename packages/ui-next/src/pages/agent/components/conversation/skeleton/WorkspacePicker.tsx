import { useState } from 'react';
import { IconChevronDownOutline14 } from '../../../icons';
import type { WorkspaceView } from '../../../runtime/session';
import { Menu } from '../../primitives/Menu';
import css from './WorkspacePicker.module.css';

export interface WorkspacePickerProps {
    workspaces: readonly WorkspaceView[];
    selectedId?: string;
    onPick: (workspaceId: string) => void;
    onCreate: () => void;
}

export function WorkspacePicker({ workspaces, selectedId, onPick, onCreate }: WorkspacePickerProps) {
    const [open, setOpen] = useState(false);
    const current = workspaces.find((workspace) => workspace.workspaceId === selectedId);
    return <Menu
        open={open}
        onClose={() => setOpen(false)}
        items={[...workspaces.map((workspace) => ({ id: workspace.workspaceId, label: workspace.title })), { id: '::add-workspace', label: '添加工作区', icon: <span aria-hidden>＋</span> }]}
        selectedId={selectedId}
        onSelect={(id) => { setOpen(false); if (id === '::add-workspace') onCreate(); else onPick(id); }}
        side="bottom"
        portal
        anchor={<button type="button" className={css.trigger} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <span className={css.folder} aria-hidden>⌂</span>
            <span className={css.label}>{current?.title ?? '选择工作区'}</span>
            <IconChevronDownOutline14 size={14} className={open ? css.open : undefined} />
        </button>}
    />;
}

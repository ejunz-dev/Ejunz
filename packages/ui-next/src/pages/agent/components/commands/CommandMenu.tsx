import { useMemo } from 'react';
import { i18n } from '@/i18n';
import { Menu } from '../primitives/Menu';

export const COMMANDS = [
    { name: 'help', detail: i18n('Show available commands') },
    { name: 'compact', detail: i18n('Compact the current context') },
    { name: 'clear', detail: i18n('Clear the current input') },
    { name: 'model', detail: i18n('View model settings') },
    { name: 'attach', detail: i18n('Attach files') },
];

interface CommandMenuProps {
    query: string;
    activeIndex: number;
    onSelect: (command: string) => void;
    onClose: () => void;
}

export function CommandMenu({ query, activeIndex, onSelect, onClose }: CommandMenuProps) {
    const items = useMemo(() => COMMANDS.filter((command) => command.name.includes(query.toLowerCase())), [query]);
    const entries = items.length > 0
        ? items.map((item) => ({ id: item.name, label: `${item.name} · ${item.detail}` }))
        : [{ id: 'empty', label: i18n('No matching commands'), disabled: true }];
    return <Menu
        open
        onClose={onClose}
        items={entries}
        selectedId={items[activeIndex]?.name}
        onSelect={onSelect}
        side="top"
        anchor={null}
    />;
}

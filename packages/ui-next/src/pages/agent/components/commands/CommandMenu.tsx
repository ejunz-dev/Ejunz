import { useMemo } from 'react';
import { Menu } from '../primitives/Menu';

export const COMMANDS = [
    { name: 'help', detail: '查看可用命令' },
    { name: 'compact', detail: '压缩当前上下文' },
    { name: 'clear', detail: '清空当前输入' },
    { name: 'model', detail: '查看模型设置' },
    { name: 'attach', detail: '添加文件' },
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
        : [{ id: 'empty', label: '没有匹配的命令', disabled: true }];
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

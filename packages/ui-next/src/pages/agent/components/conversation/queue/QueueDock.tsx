import { useState } from 'react';
import type { QueueItem } from '../../types';

interface QueueDockProps {
    items: QueueItem[];
    running: boolean;
    onAction: (itemId: string, action: { kind: 'remove' | 'steer' | 'edit'; text?: string }) => Promise<void>;
}

export function QueueDock({ items, running, onAction }: QueueDockProps) {
    const [expanded, setExpanded] = useState(items.length < 2);
    const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    if (!items.length) return null;
    const run = async (itemId: string, action: { kind: 'remove' | 'steer' | 'edit'; text?: string }) => {
        setBusy(itemId);
        try {
            await onAction(itemId, action);
            if (editing?.id === itemId) setEditing(null);
        } finally {
            setBusy(null);
        }
    };
    return <div className="eja-queueDock">
        {items.length > 1 && <button type="button" className="eja-queueHeader" onClick={() => setExpanded((value) => !value)}>{expanded ? '⌄' : '›'} 队列中 {items.length} 条消息</button>}
        {expanded && items.map((item) => <div key={item.id} className="eja-queueRow">
            {editing?.id === item.id
                ? <input autoFocus value={editing.text} onChange={(event) => setEditing({ id: item.id, text: event.target.value })} onKeyDown={(event) => { if (event.key === 'Escape') setEditing(null); if (event.key === 'Enter') void run(item.id, { kind: 'edit', text: editing.text }); }} />
                : <span className="eja-queuePreview">{item.preview}</span>}
            <div className="eja-queueActions">
                {editing?.id === item.id
                    ? <button type="button" disabled={busy !== null || !editing.text.trim()} onClick={() => void run(item.id, { kind: 'edit', text: editing.text })}>保存</button>
                    : <button type="button" disabled={busy !== null || !item.text} onClick={() => setEditing({ id: item.id, text: item.text ?? item.preview })}>编辑</button>}
                <button type="button" disabled={busy !== null} onClick={() => void run(item.id, { kind: 'remove' })}>删除</button>
                <button type="button" disabled={busy !== null || !running} onClick={() => void run(item.id, { kind: 'steer' })}>插队</button>
            </div>
        </div>)}
    </div>;
}

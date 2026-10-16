import { useState } from 'react';
import { i18n } from '@/i18n';
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
    return <div className="eza-queueDock">
        {items.length > 1 && <button type="button" className="eza-queueHeader" onClick={() => setExpanded((value) => !value)}>{expanded ? '⌄' : '›'} {i18n('{0} messages queued', items.length)}</button>}
        {expanded && items.map((item) => <div key={item.id} className="eza-queueRow">
            {editing?.id === item.id
                ? <input autoFocus value={editing.text} onChange={(event) => setEditing({ id: item.id, text: event.target.value })} onKeyDown={(event) => { if (event.key === 'Escape') setEditing(null); if (event.key === 'Enter') void run(item.id, { kind: 'edit', text: editing.text }); }} />
                : <span className="eza-queuePreview">{item.preview}</span>}
            <div className="eza-queueActions">
                {editing?.id === item.id
                    ? <button type="button" disabled={busy !== null || !editing.text.trim()} onClick={() => void run(item.id, { kind: 'edit', text: editing.text })}>{i18n('Save')}</button>
                    : <button type="button" disabled={busy !== null || !item.text} onClick={() => setEditing({ id: item.id, text: item.text ?? item.preview })}>{i18n('Edit')}</button>}
                <button type="button" disabled={busy !== null} onClick={() => void run(item.id, { kind: 'remove' })}>{i18n('Delete')}</button>
                <button type="button" disabled={busy !== null || !running} onClick={() => void run(item.id, { kind: 'steer' })}>{i18n('Steer')}</button>
            </div>
        </div>)}
    </div>;
}

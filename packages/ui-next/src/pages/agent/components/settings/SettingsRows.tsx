import { useEffect, useState } from 'react';
import { i18n } from '@/i18n';
import { RowMenu, type RowMenuItem } from './RowMenu';
import css from './SettingsRows.module.css';

export interface SettingsRpc {
    <T>(method: string, payload: unknown): Promise<T>;
}

export interface SettingsRowShellProps {
    title: string;
    description?: string;
    alert?: boolean;
    children?: React.ReactNode;
}

function SettingsRowShell({ title, description, alert, children }: SettingsRowShellProps) {
    return <div className={css.row}>
        <div className={css.rowText}>
            <div className={css.title}>{title}</div>
            {description !== undefined && <div className={css.desc} role={alert ? 'alert' : undefined}>{description}</div>}
        </div>
        {children}
    </div>;
}

const LOCALE_ITEMS: RowMenuItem[] = [
    { id: 'zh', label: i18n('Chinese') },
    { id: 'en', label: i18n('English') },
];

export function LanguageRow({ rpc }: { rpc: SettingsRpc }) {
    const [active, setActive] = useState('zh');

    useEffect(() => {
        let disposed = false;
        void (async () => {
            try {
                const value = await rpc('settings.describe', {}) as { namespaces?: { ns?: string; value?: unknown }[] };
                const stored = (value.namespaces ?? []).find((item) => item.ns === 'locale')?.value;
                if (!disposed && stored && typeof stored === 'object' && typeof (stored as Record<string, unknown>).preference === 'string') {
                    setActive((stored as { preference: string }).preference);
                }
            } catch { }
        })();
        return () => { disposed = true; };
    }, [rpc]);

    const select = (id: string) => {
        setActive(id);
        window.location.reload();
    };

    return <SettingsRowShell title={i18n('Language')}>
        <RowMenu items={LOCALE_ITEMS} selectedId={active} onSelect={select} />
    </SettingsRowShell>;
}

const ENTER_ITEMS: RowMenuItem[] = [
    { id: 'queue', label: i18n('Queue send') },
    { id: 'steer', label: i18n('Steer send') },
];

export function EnterBehaviorRow({ rpc, onBehaviorChange }: { rpc: SettingsRpc; onBehaviorChange: (behavior: 'queue' | 'steer') => void }) {
    const [behavior, setBehavior] = useState<'queue' | 'steer'>('queue');

    useEffect(() => {
        let disposed = false;
        void (async () => {
            try {
                const value = await rpc('settings.describe', {}) as { namespaces?: { ns?: string; value?: unknown }[] };
                const stored = (value.namespaces ?? []).find((item) => item.ns === 'ui-conversation')?.value;
                if (!disposed && stored && typeof stored === 'object' && typeof (stored as Record<string, unknown>).busyEnter === 'string') {
                    const next = (stored as { busyEnter: string }).busyEnter;
                    if (next === 'queue' || next === 'steer') setBehavior(next);
                }
            } catch { }
        })();
        return () => { disposed = true; };
    }, [rpc]);

    const select = (id: string) => {
        const next = id === 'steer' ? 'steer' : 'queue';
        setBehavior(next);
        onBehaviorChange(next);
        void rpc('settings.update', { ns: 'ui-conversation', patch: { busyEnter: next } }).catch(() => { });
    };

    return <SettingsRowShell title={i18n('Enter behavior while busy')} description={i18n('Applies only while the Agent is running. Cmd/Ctrl+Enter uses the other behavior.')}>
        <RowMenu items={ENTER_ITEMS} selectedId={behavior} onSelect={select} />
    </SettingsRowShell>;
}

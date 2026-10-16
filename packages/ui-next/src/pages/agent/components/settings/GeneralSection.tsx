import { useEffect, useState } from 'react';
import { i18n } from '@/i18n';
import {
    IconDarkOutline16, IconFollowsystemOutline16, IconLightOutline16,
} from '../../icons';
import css from './GeneralSection.module.css';

export type ThemePreference = 'light' | 'dark' | 'system';

const CUBES: { id: ThemePreference; label: string; Icon: typeof IconLightOutline16 }[] = [
    { id: 'light', label: i18n('Light'), Icon: IconLightOutline16 },
    { id: 'dark', label: i18n('Dark'), Icon: IconDarkOutline16 },
    { id: 'system', label: i18n('Follow system'), Icon: IconFollowsystemOutline16 },
];

function systemDark(): boolean {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export interface AppearanceRowProps {
    rpc: <T>(method: string, payload: unknown) => Promise<T>;
    onThemeChange: (dark: boolean) => void;
}

export function AppearanceRow({ rpc, onThemeChange }: AppearanceRowProps) {
    const [preference, setPreference] = useState<ThemePreference>('system');

    useEffect(() => {
        let disposed = false;
        void (async () => {
            try {
                const value = await rpc('settings.describe', {}) as { namespaces?: { ns?: string; value?: unknown }[] };
                const row = (value.namespaces ?? []).find((item) => item.ns === 'ui-theme');
                const stored = row?.value;
                if (!disposed && stored && typeof stored === 'object' && typeof (stored as Record<string, unknown>).preference === 'string') {
                    setPreference((stored as { preference: ThemePreference }).preference);
                }
            } catch { }
        })();
        return () => { disposed = true; };
    }, [rpc]);

    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
            if (preference === 'system') onThemeChange(media.matches);
        };
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    }, [preference, onThemeChange]);

    const select = (id: ThemePreference) => {
        setPreference(id);
        onThemeChange(id === 'dark' || (id === 'system' && systemDark()));
        void rpc('settings.update', { ns: 'ui-theme', patch: { preference: id } }).catch(() => { });
    };

    return <div className={css.group}>
        <div className={css.title}>{i18n('Appearance')}</div>
        <div className={css.cubeRow}>
            {CUBES.map(({ id, label, Icon }) => (
                <button
                    key={id}
                    type="button"
                    className={preference === id ? `${css.themeCube} ${css.selected}` : css.themeCube}
                    aria-pressed={preference === id}
                    onClick={() => { select(id); }}
                >
                    <Icon />
                    {label}
                </button>
            ))}
        </div>
    </div>;
}

export function GeneralSection(props: AppearanceRowProps) {
    return <div className={css.section}>
        <AppearanceRow {...props} />
    </div>;
}

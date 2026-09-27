import { useEffect, useState } from 'react';
import css from './SettingsDocumentAction.module.css';

export interface SettingsDocumentActionProps {
    rpc: <T>(method: string, payload: unknown) => Promise<T>;
}

export function SettingsDocumentAction({ rpc }: SettingsDocumentActionProps) {
    const [available, setAvailable] = useState(false);
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let disposed = false;
        void rpc('settings.describe', {})
            .then((value) => {
                if (!disposed) setAvailable((value as { hasDocument?: boolean }).hasDocument === true);
            })
            .catch((caught) => {
                if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
            });
        return () => { disposed = true; };
    }, [rpc]);

    if (!available && !error) return null;

    const open = async () => {
        setOpening(true);
        setError(null);
        try {
            await rpc('settings.openDocument', {});
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setOpening(false);
        }
    };

    return <div className={css.action}>
        {error ? <span className={css.error} role="alert">{error}</span> : null}
        {available ? <button type="button" className={css.button} disabled={opening} onClick={() => { void open(); }}>{opening ? '正在打开…' : '打开设置文件'}</button> : null}
    </div>;
}

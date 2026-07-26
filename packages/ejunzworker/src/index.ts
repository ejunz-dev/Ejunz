import type { Context } from 'ejun';
import { WorkerSettings, overrideConfig } from './config';

export const Config = WorkerSettings;

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
    overrideConfig(config);
    // CLI boots addons for scripts/commands but must not consume the shared task queue.
    if (process.env.EJUNZ_CLI === 'true') {
        return;
    }
    if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') {
        return;
    }
    return require('./hosts/builtin').apply(ctx);
}

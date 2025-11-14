import { Context } from 'ejun';
import { WorkerSettings, overrideConfig } from './config';

export const Config = WorkerSettings;

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
    overrideConfig(config);
    if (process.env.NODE_APP_INSTANCE !== '0') return;
    return require('./hosts/builtin').apply(ctx);
}

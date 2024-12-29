import { Context } from 'ejun';

declare module 'ejun' {
    interface SystemKeys {
        'ejunzjudge.cache_dir': string;
        'ejunzjudge.tmp_dir': string;
        'ejunzjudge.sandbox_host': string;
        'ejunzjudge.memoryMax': string;
        'ejunzjudge.testcases_max': number;
        'ejunzjudge.total_time_limit': number;
        'ejunzjudge.parallelism': number;
        'ejunzjudge.disable': boolean;
        'ejunzjudge.detail': boolean;
    }
}

export function apply(ctx: Context) {
    if (process.env.NODE_APP_INSTANCE !== '0') return;
    ctx.once('app/started', () => require('./hosts/builtin').postInit(ctx));
}

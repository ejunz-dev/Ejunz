import log from './log';

export { SYSTEM_TOOLS_CATALOG, type SystemToolEntry } from './catalog';
export { executeSystemTool } from './execute';
export { ToolsSettings as Config, overrideConfig } from './config';

export function apply(ctx: any, config: any = {}) {
    const { overrideConfig } = require('./config');
    overrideConfig(config || {});
    if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') {
        log.info('Skipping ejunztools builtin startup on NODE_APP_INSTANCE=%s', process.env.NODE_APP_INSTANCE);
        return;
    }
    log.info('Starting ejunztools builtin MCP provider...');
    return require('./hosts/builtin').apply(ctx, config || {});
}

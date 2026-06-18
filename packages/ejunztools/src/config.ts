import os from 'os';
import path from 'path';
import cac from 'cac';
import Schema from 'schemastery';
import { fs, yaml } from '@ejunz/utils';

const argv = cac().parse();

export const ToolsHostSettings = Schema.object({
    type: Schema.string().default('ws').description('Ejunz Tools host type'),
    server_url: Schema.string().description('Ejunz domain server URL, e.g. http://localhost:8888/d/default/'),
    token: Schema.string().role('secret').description('Edge/MCP websocket token'),
    toolsId: Schema.string().description('Stable tools runtime id'),
    toolsLabel: Schema.string().description('Tools label shown in MCP dashboard'),
    toolsVersion: Schema.string().description('Tools version shown in MCP dashboard'),
    reconnect: Schema.boolean().default(true).description('Reconnect websocket after disconnect'),
});

export const ToolsSettings = Schema.object({
    tmp_dir: Schema.string().default(path.resolve(os.tmpdir(), 'ejunztools')).description('Temporary directory'),
    toolsId: Schema.string().description('Stable tools runtime id'),
    toolsLabel: Schema.string().description('Tools label shown in MCP dashboard'),
    toolsVersion: Schema.string().description('Tools version shown in MCP dashboard'),
    hosts: Schema.dict(ToolsHostSettings).default({}).description('Ejunz Tools hosts'),
});

const configPath = path.resolve(os.homedir(), '.ejunz', 'tools.yaml');

function withGlobalDefaults(base: any) {
    const out = { ...(base || {}) };
    out.hosts ||= {};
    for (const [name, host] of Object.entries(out.hosts) as [string, any][]) {
        host.host ||= name;
        host.toolsId ||= out.toolsId || name;
        host.toolsLabel ||= out.toolsLabel || name;
        host.toolsVersion ||= out.toolsVersion;
    }
    return out;
}

let config = global.Ejunz
    ? ToolsSettings({})
    : (() => {
        const base: any = {};
        const configFilePath = (process.env.CONFIG_FILE || argv.options.config)
            ? path.resolve(process.env.CONFIG_FILE || argv.options.config)
            : configPath;
        if (fs.existsSync(configFilePath)) {
            const configFile = fs.readFileSync(configFilePath, 'utf-8');
            Object.assign(base, yaml.load(configFile) as any);
        }
        const cfg = ToolsSettings(withGlobalDefaults(base));
        return ToolsSettings(withGlobalDefaults(cfg));
    })();

export function overrideConfig(update: ReturnType<typeof ToolsSettings>) {
    config = ToolsSettings(withGlobalDefaults(update));
}

export const getConfig: <K extends keyof typeof config>(key: K) => typeof config[K] = (key) => config[key];

export function packageVersion() {
    try {
        return require('../package.json').version;
    } catch {
        return 'unknown';
    }
}

export function toolsVersion(configLike: any = {}) {
    return process.env.EJUNZ_TOOLS_VERSION || configLike.toolsVersion || getConfig('toolsVersion') || packageVersion();
}

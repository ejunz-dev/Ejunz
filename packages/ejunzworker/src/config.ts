import os from 'os';
import path from 'path';
import cac from 'cac';
import Schema from 'schemastery';
import { fs, yaml } from '@ejunz/utils';

const argv = cac().parse();

export const HostSettings = Schema.object({
    type: Schema.string().default('ejunz').description('Worker host type'),
    server_url: Schema.string().description('Ejunz server URL'),
    uname: Schema.string().description('Worker login username'),
    password: Schema.string().role('secret').description('Worker login password'),
    cookie: Schema.string().description('Existing session cookie'),
    token: Schema.string().role('secret').description('Bearer session token'),
    workerId: Schema.string().description('Stable worker id for status reporting'),
    workerLabel: Schema.string().description('Worker label shown in status and chat'),
    workerVersion: Schema.string().description('Worker version shown in status and chat'),
    minPriority: Schema.number().description('Only consume tasks above this priority'),
    concurrency: Schema.number().default(4).min(1).step(1).description('Worker task concurrency'),
    toolcallConcurrency: Schema.number().min(1).step(1).description('Tool call concurrency alias'),
    taskTypes: Schema.array(Schema.string()).default(['agent_task', 'tool_call', 'mcp_tool_call', 'embedding_vectorize']).description('Task types this worker can execute'),
});

export const WorkerSettings = Schema.object({
    tmp_dir: Schema.string().default(path.resolve(os.tmpdir(), 'ejunzworker')).description('Temporary directory'),
    cache_dir: Schema.string().default(path.resolve(os.homedir(), '.cache', 'ejunzworker')).description('Cache directory'),
    toolcallConcurrency: Schema.number().default(10).min(1).step(1).description('Default worker task concurrency'),
    workerId: Schema.string().description('Stable worker id for status reporting'),
    workerLabel: Schema.string().description('Worker label shown in status and chat'),
    workerVersion: Schema.string().description('Worker version shown in status and chat'),
    hosts: Schema.dict(HostSettings).default({}).description('Worker hosts'),
});

const oldPath = path.resolve(os.homedir(), '.config', 'ejunz', 'worker.yaml');
const newPath = path.resolve(os.homedir(), '.ejunz', 'worker.yaml');

function withGlobalDefaults(base: any) {
    const out = { ...(base || {}) };
    out.hosts ||= {};
    for (const [name, host] of Object.entries(out.hosts) as [string, any][]) {
        host.host ||= name;
        host.workerId ||= out.workerId || name;
        host.workerLabel ||= out.workerLabel || name;
        host.workerVersion ||= out.workerVersion;
        host.concurrency ||= host.toolcallConcurrency || out.toolcallConcurrency || 4;
        host.taskTypes ||= ['agent_task', 'tool_call', 'mcp_tool_call', 'embedding_vectorize'];
    }
    return out;
}

let config = global.Ejunz
    ? WorkerSettings({})
    : (() => {
        const base: any = {};
        const configFilePath = (process.env.CONFIG_FILE || argv.options.config)
            ? path.resolve(process.env.CONFIG_FILE || argv.options.config)
            : fs.existsSync(oldPath) ? oldPath : newPath;
        if (fs.existsSync(configFilePath)) {
            const configFile = fs.readFileSync(configFilePath, 'utf-8');
            Object.assign(base, yaml.load(configFile) as any);
        }
        const cfg = WorkerSettings(withGlobalDefaults(base));
        return WorkerSettings(withGlobalDefaults(cfg));
    })();

export function overrideConfig(update: ReturnType<typeof WorkerSettings>) {
    config = WorkerSettings(withGlobalDefaults(update));
}

export const getConfig: <K extends keyof typeof config>(key: K) => typeof config[K] = (key) => config[key];

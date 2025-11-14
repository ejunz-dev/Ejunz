import os from 'os';
import path from 'path';
import cac from 'cac';
import Schema from 'schemastery';
import { fs, yaml } from '@ejunz/utils';

const argv = cac().parse();

export const WorkerSettings = Schema.object({
    toolcallConcurrency: Schema.number().default(10).min(1).step(1).description('Agent task concurrency'),
});

const oldPath = path.resolve(os.homedir(), '.config', 'ejunz', 'worker.yaml');
const newPath = path.resolve(os.homedir(), '.ejunz', 'worker.yaml');

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
        const cfg = WorkerSettings(base);
        return WorkerSettings(cfg);
    })();

export function overrideConfig(update: ReturnType<typeof WorkerSettings>) {
    config = WorkerSettings(update);
}

export const getConfig: <K extends keyof typeof config>(key: K) => typeof config[K] = (key) => config[key];

import os from 'os';
import path from 'path';
import cac from 'cac';
import Schema from 'schemastery';
import { fs, yaml } from '@ejunz/utils';

const argv = cac().parse();

const QuestgenSettings = Schema.object({
    api_url: Schema.string().role('link').default('http://localhost:3000'),
});

const oldPath = path.resolve(os.homedir(), '.config', 'ejun', 'judge.yaml');
const newPath = path.resolve(os.homedir(), '.ejunz', 'judge.yaml');

const config = global.Ejunz
    ? QuestgenSettings({})
    : (() => {
        const base: any = {};
        if (process.env.TEMP_DIR || argv.options.tmp) {
            base.tmp_dir = path.resolve(process.env.TEMP_DIR || argv.options.tmp);
        }
        if (process.env.CACHE_DIR || argv.options.cache) {
            base.cache_dir = path.resolve(process.env.CACHE_DIR || argv.options.cache);
        }
        if (process.env.EXECUTION_HOST || argv.options.sandbox) {
            base.ejunzquestgen = path.resolve(process.env.EXECUTION_HOST || argv.options.ejunzquestgen);
        }
        const configFilePath = (process.env.CONFIG_FILE || argv.options.config)
            ? path.resolve(process.env.CONFIG_FILE || argv.options.config)
            : fs.existsSync(oldPath) ? oldPath : newPath;
        const configFile = fs.readFileSync(configFilePath, 'utf-8');
        Object.assign(base, yaml.load(configFile) as any);
        const cfg = QuestgenSettings(base);
        return QuestgenSettings(cfg);
    })();

export const getConfig: <K extends keyof typeof config>(key: K) => typeof config[K] = global.Ejunz
    ? (key) => global.Ejunz.model.system.get(`ejunzquestgen.${key}`) ?? config[key]
    : (key) => config[key];

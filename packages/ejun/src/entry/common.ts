import '../lib/index';

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import { Context } from '../context';
import { Logger } from '../logger';
import { unwrapExports } from '../utils';

const logger = new Logger('common');

async function getFiles(folder: string, base = ''): Promise<string[]> {
    const files = [];
    const f = await fs.readdir(folder);
    for (const i of f) {
        if ((await fs.stat(path.join(folder, i))).isDirectory()) {
            files.push(...await getFiles(path.join(folder, i), path.join(base, i)));
        } else files.push(path.join(base, i));
    }
    return files.map((item) => item.replace(/\\/gmi, '/'));
}

function locateFile(basePath: string, filenames: string[]) {
    for (const i of filenames) {
        const p = path.resolve(basePath, i);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

type LoadTask = 'handler' | 'model' | 'addon' | 'lib' | 'script' | 'service';
const getLoader = (type: LoadTask, filename: string) => async function loader(pending: string[], fail: string[], ctx: Context) {
    for (const i of pending) {
        const p = locateFile(i, [`${filename}.ts`, `${filename}.js`]);
        if (p && !fail.includes(i)) {
            const name = type.replace(/^(.)/, (t) => t.toUpperCase());
            try {
                const m = unwrapExports(require(p));
                if (m.apply) {
                    ctx.loader.reloadPlugin(ctx, p, {});
                } else {
                    logger.info(`${name} init: %s`, i);
                }
            } catch (e) {
                logger.info(`${name} load fail: %s`, i);
                logger.error(e);
            }
        }
    }
};

export const handler = getLoader('handler', 'handler');
export const addon = getLoader('addon', 'index');
export const model = getLoader('model', 'model');
export const lib = getLoader('lib', 'lib');
export const script = getLoader('script', 'script');
export const service = getLoader('service', 'service');

export async function builtinModel(ctx: Context) {
    const modelDir = path.resolve(__dirname, '..', 'model');
    const models = await fs.readdir(modelDir);
    for (const t of models.filter((i) => i.endsWith('.ts'))) {
        const q = path.resolve(modelDir, t);
        if ('apply' in require(q)) ctx.loader.reloadPlugin(ctx, q, {}, `ejun/model/${t.split('.')[0]}`);
    }
}

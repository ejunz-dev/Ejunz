import os from 'os';
import path from 'path';
import cac from 'cac';
import fs from 'fs-extra';
import { Context } from '../context';
import { Logger } from '../logger';
import { load } from '../options';
import db from '../service/db';
import {
    handler, template,
} from './common'; 
const argv = cac().parse();
const logger = new Logger('worker');
const tmpdir = path.resolve(os.tmpdir(), 'ejunz');

export async function apply(ctx: Context) {
    fs.ensureDirSync(tmpdir);
    require('../utils');
    require('../error');
    require('../service/bus').apply(ctx);
    
    const config = load();
    if (!process.env.CI && !config) {
        logger.info('Starting setup');
        await require('./setup').load(ctx);
    }
    
    const pending = global.addons;
    const fail = [];

    await template(pending, fail);

    // 启动数据库
    await db.start();

    // 加载配置文件
    await require('../settings').loadConfig();

    const handlerDir = path.resolve(__dirname, '..', 'handler');
    const handlers = await fs.readdir(handlerDir);
    for (const h of handlers.filter((i) => i.endsWith('.ts'))) {
        ctx.loader.reloadPlugin(ctx, path.resolve(handlerDir, h), {}, `ejunz/handler/${h.split('.')[0]}`);
    }

    await ctx.lifecycle.flush();
    await ctx.parallel('app/started');

    for (const f of global.addons) {
        const dir = path.join(f, 'public');
        if (await fs.pathExists(dir)) await fs.copy(dir, path.join(os.homedir(), '.ejunz/static'));
    }

    await ctx.parallel('app/listen');
    logger.success('Server started');
    process.send?.('ready');
    await ctx.parallel('app/ready');
    return { fail };
}

/* eslint-disable no-await-in-loop */
import './utils';

import PQueue from 'p-queue';
import { fs } from '@ejunz/utils';
import { getConfig } from './config';
import EjunzHost from './hosts/ejunz';
import log from './log';

const hosts: Record<string, EjunzHost> = {};
let exit = false;

const terminate = async () => {
    log.info('Saving data...');
    try {
        await Promise.all(Object.values(hosts).map((f) => f.dispose?.()));
        process.exit(1);
    } catch (e) {
        if (exit) process.exit(1);
        log.error(e.stack);
        log.error('An error occurred.');
        log.error('Press Ctrl-C again to force quit.');
        exit = true;
    }
};
process.on('SIGINT', terminate);
process.on('SIGTERM', terminate);
process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise ', p);
});

async function daemon() {
    const _hosts = getConfig('hosts');
    const queue = new PQueue({ concurrency: Infinity });
    await fs.ensureDir(getConfig('tmp_dir'));
    queue.on('error', (e) => log.error(e));
    for (const i in _hosts) {
        _hosts[i].host ||= i;
        hosts[i] = new EjunzHost(_hosts[i]);
        await hosts[i].init();
    }
    for (const i in hosts) {
        hosts[i].consumeToolCall(queue);
    }
}

if (require.main === module) daemon();
export = daemon;

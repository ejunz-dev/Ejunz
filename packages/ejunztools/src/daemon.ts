/* eslint-disable no-await-in-loop */
import './tools';

import { fs } from '@ejunz/utils';
import { getConfig } from './config';
import WsHost from './hosts/ws';

const hosts: Record<string, WsHost> = {};
let exit = false;

function log(level: 'info' | 'warn' | 'error', message: string, ...args: any[]) {
    const fn = console[level] || console.log;
    fn(`[ejunztools] ${message}`, ...args);
}

const terminate = async () => {
    log('info', 'Shutting down...');
    try {
        await Promise.all(Object.values(hosts).map((host) => host.dispose?.()));
        process.exit(1);
    } catch (e: any) {
        if (exit) process.exit(1);
        log('error', e?.stack || e?.message || e);
        log('error', 'An error occurred. Press Ctrl-C again to force quit.');
        exit = true;
    }
};

process.on('SIGINT', terminate);
process.on('SIGTERM', terminate);
process.on('unhandledRejection', (reason, p) => {
    log('error', 'Unhandled Rejection at: Promise %o', p);
    log('error', reason instanceof Error ? reason.stack || reason.message : reason);
});

async function daemon() {
    const configuredHosts = getConfig('hosts');
    await fs.ensureDir(getConfig('tmp_dir'));
    for (const name in configuredHosts) {
        configuredHosts[name].host ||= name;
        hosts[name] = new WsHost(configuredHosts[name]);
    }
    for (const name in hosts) {
        hosts[name].connect();
    }
}

if (require.main === module) daemon();
export = daemon;

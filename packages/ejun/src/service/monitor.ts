import { dump } from 'js-yaml';
import superagent from 'superagent';
import type { StatusUpdate } from '@ejunz/utils/lib/sysinfo';
import * as sysinfo from '@ejunz/utils/lib/sysinfo';
import { Context } from '../context';
import { Logger } from '../logger';
import * as DocumentModel from '../model/document';
import DomainModel from '../model/domain';
import MessageModel from '../model/message';
import RecordModel from '../model/record';
import SystemModel from '../model/system';
import UserModel from '../model/user';
import bus from './bus';
import db from './db';

const coll = db.collection('status');
const logger = new Logger('monitor');

export async function feedback(): Promise<[string, StatusUpdate]> {
    const version = require('ejun/package.json').version;
    const [mid, $update, inf] = await sysinfo.update();
    const [installId, name, url] = SystemModel.getMany(['installid', 'server.name', 'server.url']);
    const [domainCount, userCount, problemCount, discussionCount, recordCount] = await Promise.all([
        DomainModel.coll.count(),
        UserModel.coll.count(),
        DocumentModel.coll.count({ docType: DocumentModel.TYPE_DISCUSSION }),
        RecordModel.coll.count(),
    ]);
    const info: Record<string, any> = {
        mid: mid.toString(),
        version,
        name,
        url,
        domainCount,
        userCount,
        discussionCount,
        recordCount,
        addons: Object.values(global.addons),
        memory: inf.memory,
        osinfo: inf.osinfo,
        cpu: inf.cpu,
    };
    try {
        const status = await db.db.admin().serverStatus();
        info.dbVersion = status.version;
    } catch (e) { }
    await bus.serial('monitor/collect', info);
    const payload = dump(info, {
        replacer: (key, value) => {
            if (typeof value === 'function') return '';
            return value;
        },
    });
    if (process.env.CI) return [mid, $update];
    superagent.post(`${SystemModel.get('server.center')}/report`)
        .send({ installId, payload })
        .then((res) => {
            if (res.body.updateUrl?.startsWith('https://')) SystemModel.set('server.center', res.body.updateUrl);
            if (res.body.notification) MessageModel.sendNotification(res.body.notification);
            if (res.body.reassignId) SystemModel.set('installid', res.body.reassignId);
        })
        .catch(() => logger.debug('Cannot connect to ejunz center.'));
    return [mid, $update];
}

export async function update() {
    const [mid, $update] = await feedback();
    const $set = {
        ...$update,
        updateAt: new Date(),
        reqCount: 0,
    };
    await bus.parallel('monitor/update', 'server', $set);
    await coll.updateOne(
        { mid, type: 'server' },
        { $set },
        { upsert: true },
    );
}

export async function updateworker(args) {
    const $set = { ...args, updateAt: new Date() };
    await bus.parallel('monitor/update', 'worker', $set);
    return await coll.updateOne(
        { mid: args.mid, type: 'worker' },
        { $set },
        { upsert: true },
    );
}

export async function apply(ctx: Context) {
    if (process.env.NODE_APP_INSTANCE !== '0') return;
    const info = await sysinfo.get();
    coll.updateOne(
        { mid: info.mid, type: 'server' },
        { $set: { ...info, updateAt: new Date(), type: 'server' } },
        { upsert: true },
    );
    feedback();
    return ctx.interval(update, 1800 * 1000); // eslint-disable-line
}
import { extname } from 'path';
import { escapeRegExp, omit } from 'lodash';
import moment from 'moment-timezone';
import { nanoid } from 'nanoid';
import type { Readable } from 'stream';
import { Context } from '../context';
import mime from '../lib/mime';
import db from '../service/db';
import storage from '../service/storage';
import ScheduleModel from './schedule';
import * as system from './system';

export class StorageModel {
    static coll = db.collection('storage');

    static generateId(ext: string) {
        return `${nanoid(3).replace(/[_-]/g, '0')}/${nanoid().replace(/[_-]/g, '0')}${ext}`.toLowerCase();
    }

    static async put(path: string, file: string | Buffer | Readable, owner?: number) {
        const meta = {};
        await StorageModel.del([path]);
        meta['Content-Type'] = mime(path);
        let _id = StorageModel.generateId(extname(path));
        // Make sure id is not used
        // eslint-disable-next-line no-await-in-loop
        while (await StorageModel.coll.findOne({ _id })) _id = StorageModel.generateId(extname(path));
        await storage.put(_id, file, meta);
        const { metaData, size, etag } = await storage.getMeta(_id);
        await StorageModel.coll.insertOne({
            _id, meta: metaData, path, size, etag, lastModified: new Date(), owner,
        });
        return path;
    }

    static async get(path: string, savePath?: string) {
        const { value } = await StorageModel.coll.findOneAndUpdate(
            { path, autoDelete: null },
            { $set: { lastUsage: new Date() } },
            { returnDocument: 'after' },
        );
        return await storage.get(value?.link || value?._id || path, savePath);
    }

    static async rename(path: string, newPath: string, operator = 1) {
        return await StorageModel.coll.updateOne(
            { path, autoDelete: null },
            { $set: { path: newPath }, $push: { operator } },
        );
    }

    static async del(path: string[], operator = 1) {
        if (!path.length) return;
        const affected = await StorageModel.coll.find({ path: { $in: path } }).toArray();
        if (!affected.length) return;
        const linked = await StorageModel.coll.find({ link: { $in: affected.map((i) => i._id) }, path: { $nin: path } }).toArray();
        const processedIds = [];
        for (const i of linked || []) {
            if (processedIds.includes(i.link)) continue;
            const current = affected.find((t) => t._id === i.link); // to be deleted
            // eslint-disable-next-line no-await-in-loop
            await Promise.all([
                StorageModel.coll.updateOne({ _id: current._id }, { $set: omit(i, ['_id']) }),
                StorageModel.coll.updateOne({ _id: i._id }, { $set: omit(current, ['_id']), $unset: { link: '' } }),
            ]);
            processedIds.push(i.link);
        }
        const autoDelete = moment().add(7, 'day').toDate();
        await StorageModel.coll.updateMany(
            { path: { $in: path }, autoDelete: null },
            { $set: { autoDelete }, $push: { operator } },
        );
    }

    static async list(target: string, recursive = true) {
        if (target.includes('..') || target.includes('//')) throw new Error('Invalid path');
        if (target.length && !target.endsWith('/')) target += '/';
        const results = await StorageModel.coll.find({
            path: { $regex: `^${escapeRegExp(target)}${recursive ? '' : '[^/]+$'}` },
            autoDelete: null,
        }).toArray();
        return results.map((i) => ({
            ...i, name: i.path.split(target)[1],
        }));
    }

    static async getMeta(path: string) {
        const { value } = await StorageModel.coll.findOneAndUpdate(
            { path, autoDelete: null },
            { $set: { lastUsage: new Date() } },
            { returnDocument: 'after' },
        );
        if (!value) return null;
        return {
            ...value.meta,
            size: value.size,
            lastModified: value.lastModified,
            etag: value.etag,
        };
    }

    static async signDownloadLink(target: string, filename?: string, noExpire = false, useAlternativeEndpointFor?: 'user' | 'judge') {
        const res = await StorageModel.coll.findOneAndUpdate(
            { path: target, autoDelete: null },
            { $set: { lastUsage: new Date() } },
        );
        return await storage.signDownloadLink(res.value?.link || res.value?._id || target, filename, noExpire, useAlternativeEndpointFor);
    }

    static async copy(src: string, dst: string) {
        const { value } = await StorageModel.coll.findOneAndUpdate(
            { path: src, autoDelete: null },
            { $set: { lastUsage: new Date() } },
            { returnDocument: 'after' },
        );
        const meta = {};
        await StorageModel.del([dst]);
        meta['Content-Type'] = mime(dst);
        let _id = StorageModel.generateId(extname(dst));
        // Make sure id is not used
        // eslint-disable-next-line no-await-in-loop
        while (await StorageModel.coll.findOne({ _id })) _id = StorageModel.generateId(extname(dst));
        await StorageModel.coll.insertOne({
            ...value, _id, path: dst, link: value._id, lastModified: new Date(), owner: value.owner || 1,
        });
        return _id;
    }
}

async function cleanFiles() {
    const submissionKeepDate = system.get('submission.saveDays');
    if (submissionKeepDate) {
        const shouldDelete = moment().subtract(submissionKeepDate, 'day').toDate();
        const res = await StorageModel.coll.find({
            path: /^submission\//g,
            lastModified: { $lt: shouldDelete },
        }).toArray();
        const paths = res.map((i) => i.path);
        await StorageModel.del(paths);
    }
    if (system.get('server.keepFiles')) return;
    let res = await StorageModel.coll.findOneAndDelete({ autoDelete: { $lte: new Date() } });
    while (res.value) {
        // eslint-disable-next-line no-await-in-loop
        if (!res.value.link) await storage.del(res.value._id);
        // eslint-disable-next-line no-await-in-loop
        res = await StorageModel.coll.findOneAndDelete({ autoDelete: { $lte: new Date() } });
    }
}

export function apply(ctx: Context) {
    ctx.inject(['worker'], (c) => {
        c.worker.addHandler('storage.prune', cleanFiles);
    });
    ctx.on('domain/delete', async (domainId) => {
        const [problemFiles, contestFiles, trainingFiles] = await Promise.all([
            StorageModel.list(`problem/${domainId}`),
            StorageModel.list(`contest/${domainId}`),
            StorageModel.list(`training/${domainId}`),
        ]);
        await StorageModel.del(problemFiles.concat(contestFiles).concat(trainingFiles).map((i) => i.path));
    });

    if (process.env.NODE_APP_INSTANCE !== '0') return;
    ctx.on('ready', async () => {
        await db.ensureIndexes(
            StorageModel.coll,
            { key: { path: 1 }, name: 'path' },
            { key: { path: 1, autoDelete: 1 }, sparse: true, name: 'autoDelete' },
            { key: { link: 1 }, sparse: true, name: 'link' },
        );
        if (!await ScheduleModel.count({ type: 'schedule', subType: 'storage.prune' })) {
            await ScheduleModel.add({
                type: 'schedule',
                subType: 'storage.prune',
                executeAfter: moment().startOf('hour').toDate(),
                interval: [1, 'hour'],
            });
        }
    });
}

global.Ejunz.model.storage = StorageModel;
export default StorageModel;

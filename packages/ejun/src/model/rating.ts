import moment from 'moment-timezone';
import { Context } from '../context';
import { Logger } from '../logger';
import {
    buildSortedConsumptionRows,
    buildSortedContributionRows,
} from '../lib/homepageRanking';
import domain from './domain';
import ScheduleModel from './schedule';
import db from '../service/db';

const logger = new Logger('rating');
const coll = db.collection('rating');

export type RatingKind = 'contribution' | 'consumption';

class RatingModel {
    static coll = coll;

    static async refreshDomain(domainId: string) {
        const mongo = db as { db?: import('mongodb').Db };
        const nativeDb = mongo.db;
        if (!nativeDb) {
            logger.warn('skip refreshDomain: db not ready');
            return;
        }
        const [contrib, consum] = await Promise.all([
            buildSortedContributionRows(domainId),
            buildSortedConsumptionRows(nativeDb, domainId),
        ]);
        await Promise.all([
            coll.updateOne(
                { domainId, kind: 'contribution' },
                { $set: { domainId, kind: 'contribution', updateAt: new Date(), rows: contrib } },
                { upsert: true },
            ),
            coll.updateOne(
                { domainId, kind: 'consumption' },
                { $set: { domainId, kind: 'consumption', updateAt: new Date(), rows: consum } },
                { upsert: true },
            ),
        ]);
    }

    static async refreshAll() {
        const list = await domain.getMulti().project({ _id: 1 }).toArray();
        for (const d of list) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await RatingModel.refreshDomain(d._id);
            } catch (e) {
                logger.error('refresh rating %s: %o', d._id, e);
            }
        }
        logger.info('rating cache: %d domains', list.length);
    }

    static async getTop(domainId: string, kind: RatingKind, limit: number) {
        const cap = Math.min(100, Math.max(1, limit));
        const doc = await coll.findOne({ domainId, kind });
        if (!doc?.rows?.length) return null;
        return { rows: doc.rows.slice(0, cap) };
    }
}

export async function apply(ctx: Context) {
    ctx.inject(['worker'], (c) => {
        c.worker.addHandler('task.rating', async () => {
            await RatingModel.refreshAll();
        });
    });

    ctx.on('domain/delete', (did) => coll.deleteMany({ domainId: did }));

    if (process.env.NODE_APP_INSTANCE !== '0') return;
    await db.ensureIndexes(
        coll,
        { key: { domainId: 1, kind: 1 }, name: 'domain_kind', unique: true },
    );
    if (!(await ScheduleModel.count({ type: 'schedule', subType: 'task.rating' }))) {
        await ScheduleModel.add({
            type: 'schedule',
            subType: 'task.rating',
            executeAfter: moment().add(2, 'minutes').toDate(),
            interval: [1, 'hour'],
        });
    }
}

global.Ejunz.model.rating = RatingModel;
export default RatingModel;

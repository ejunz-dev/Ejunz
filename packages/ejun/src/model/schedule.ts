import moment from 'moment-timezone';
import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { Schedule } from '../interface';
import { Logger } from '../logger';
import db from '../service/db';
import type { WorkerService } from '../service/worker';
import RecordModel from './record';

const logger = new Logger('model/schedule');
const coll = db.collection('schedule');

async function getFirst(query: Filter<Schedule>) {
    if (process.env.CI) return null;
    const q = { ...query };
    q.executeAfter ||= { $lt: new Date() };
    const res = await coll.findOneAndDelete(q);
    if (res.value) {
        logger.debug('%o', res.value);
        if (res.value.interval) {
            const executeAfter = moment(res.value.executeAfter).add(...res.value.interval).toDate();
            await coll.insertOne({ ...res.value, executeAfter });
        }
        return res.value;
    }
    return null;
}

class ScheduleModel {
    static coll = coll;

    static async add(task: Partial<Schedule> & { type: string }) {
        const res = await coll.insertOne({
            ...task,
            executeAfter: task.executeAfter || new Date(),
            _id: new ObjectId(),
        });
        return res.insertedId;
    }

    static get(_id: ObjectId) {
        return coll.findOne({ _id });
    }

    static count(query: Filter<Schedule>) {
        return coll.countDocuments(query);
    }

    static del(_id: ObjectId) {
        return coll.deleteOne({ _id });
    }

    static deleteMany(query: Filter<Schedule>) {
        return coll.deleteMany(query);
    }

    static getFirst = getFirst;
    /** @deprecated use ctx.inject(['worker'], cb) instead */
    static Worker: WorkerService;
}

export async function apply(ctx: Context) {
    ctx.inject(['worker'], (c) => {
        ScheduleModel.Worker = c.worker;
        c.worker.addHandler('task.daily', async () => {
            await RecordModel.coll.deleteMany({ contest: { $in: [RecordModel.RECORD_PRETEST, RecordModel.RECORD_GENERATE] } });
            await global.Ejunz.script.rp?.run({}, new Logger('task/rp').debug);
            await global.Ejunz.script.problemStat?.run({}, new Logger('task/problem').debug);
            if (global.Ejunz.model.system.get('server.checkUpdate') && !(new Date().getDay() % 3)) {
                await global.Ejunz.script.checkUpdate?.run({}, new Logger('task/checkUpdate').debug);
            }
            await ctx.parallel('task/daily');
        });
    });

    ctx.on('domain/delete', (domainId) => coll.deleteMany({ domainId }));

    if (process.env.NODE_APP_INSTANCE !== '0') return;
    if (!await ScheduleModel.count({ type: 'schedule', subType: 'task.daily' })) {
        await ScheduleModel.add({
            type: 'schedule',
            subType: 'task.daily',
            executeAfter: moment().add(1, 'day').hour(3).minute(0).second(0).millisecond(0).toDate(),
            interval: [1, 'day'],
        });
    }
    await db.ensureIndexes(coll, { name: 'schedule', key: { type: 1, subType: 1, executeAfter: -1 } });
}

export default ScheduleModel;
global.Ejunz.model.schedule = ScheduleModel;

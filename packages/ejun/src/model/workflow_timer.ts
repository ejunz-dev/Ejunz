import moment from 'moment-timezone';
import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import db from '../service/db';

const logger = new Logger('model/workflow_timer');

export interface WorkflowTimerDoc {
    _id: ObjectId;
    domainId: string;
    workflowId: number;
    nodeId: number;
    executeAfter: Date;
    interval?: [number, string]; // [1, 'day'] 格式
    triggerData?: Record<string, any>;
    createdAt: Date;
    updatedAt: Date;
}

const coll = db.collection('workflow_timer');

async function getFirst(query: Filter<WorkflowTimerDoc>) {
    if (process.env.CI) return null;
    const q = { ...query };
    q.executeAfter ||= { $lt: new Date() };
    const res = await coll.findOneAndDelete(q) as any;
    if (res?.value) {
        const doc = res.value;
        logger.debug('Workflow timer triggered: %o', doc);
        if (doc.interval) {
            const executeAfter = moment(doc.executeAfter).add(...doc.interval).toDate();
            await coll.insertOne({ ...doc, executeAfter, updatedAt: new Date() });
        }
        return doc;
    }
    return null;
}

class WorkflowTimerModel {
    static coll = coll;

    static async add(timer: Partial<WorkflowTimerDoc> & { 
        domainId: string; 
        workflowId: number; 
        nodeId: number;
        executeAfter: Date;
    }) {
        const now = new Date();
        const doc: WorkflowTimerDoc = {
            _id: new ObjectId(),
            domainId: timer.domainId,
            workflowId: timer.workflowId,
            nodeId: timer.nodeId,
            executeAfter: timer.executeAfter,
            interval: timer.interval,
            triggerData: timer.triggerData || {},
            createdAt: now,
            updatedAt: now,
        };
        await coll.insertOne(doc);
        return doc;
    }

    static get(_id: ObjectId) {
        return coll.findOne({ _id });
    }

    static getByWorkflow(domainId: string, workflowId: number) {
        return coll.find({ domainId, workflowId }).toArray();
    }

    static getByNode(domainId: string, workflowId: number, nodeId: number) {
        return coll.findOne({ domainId, workflowId, nodeId });
    }

    static count(query: Filter<WorkflowTimerDoc>) {
        return coll.countDocuments(query);
    }

    static del(_id: ObjectId) {
        return coll.deleteOne({ _id });
    }

    static deleteMany(query: Filter<WorkflowTimerDoc>) {
        return coll.deleteMany(query);
    }

    static getFirst = getFirst;
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => coll.deleteMany({ domainId }));

    if (process.env.NODE_APP_INSTANCE !== '0') return;
    await db.ensureIndexes(
        coll,
        { key: { domainId: 1, workflowId: 1, nodeId: 1 }, name: 'workflow_node', unique: true },
        { key: { executeAfter: 1 }, name: 'executeAfter' },
        { key: { domainId: 1, executeAfter: 1 }, name: 'domain_execute' },
    );
}

export default WorkflowTimerModel;

// 导出到全局类型系统
global.Ejunz.model.workflowTimer = WorkflowTimerModel;


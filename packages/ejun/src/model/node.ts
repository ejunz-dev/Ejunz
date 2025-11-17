import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import db from '../service/db';
import * as document from './document';
import type { NodeDoc } from '../interface';

const logger = new Logger('model/node');

export interface NodeDeviceDoc {
    _id: ObjectId;
    nodeId: ObjectId;
    domainId: string;
    deviceId: string; // 设备唯一标识
    name: string;
    type: string; // 设备类型，如 'sensor', 'switch', 'light', 'thermostat' 等
    manufacturer?: string;
    model?: string;
    state: Record<string, any>; // 设备状态，如 { on: true, brightness: 50 }
    capabilities: string[]; // 设备能力，如 ['on', 'off', 'brightness']
    lastSeen: Date;
    createdAt: Date;
    updatedAt: Date;
}

const collDevice = db.collection('node.device');

class NodeModel {
    static collDevice = collDevice;

    static async generateNextNodeId(domainId: string): Promise<number> {
        const lastNode = await document.getMulti(domainId, document.TYPE_NODE, {})
            .sort({ nid: -1 })
            .limit(1)
            .project({ nid: 1 })
            .toArray();
        return (lastNode[0]?.nid || 0) + 1;
    }

    static async add(node: Partial<NodeDoc> & { domainId: string; name: string; owner: number; edgeId?: number }): Promise<NodeDoc> {
        const nid = await this.generateNextNodeId(node.domainId);
        const now = new Date();
        
        const payload: Partial<NodeDoc> = {
            domainId: node.domainId,
            nid,
            name: node.name,
            description: node.description,
            status: node.status || 'inactive',
            edgeId: node.edgeId,
            createdAt: now,
            updatedAt: now,
            owner: node.owner,
        };

        // docId 由 mongo 自动生成（ObjectId），nid 是业务 ID（从 1 开始）
        await document.add(
            node.domainId,
            node.name, // content
            node.owner,
            document.TYPE_NODE,
            null, // 让系统自动生成 docId
            null,
            null,
            payload,
        );

        return await this.getByNodeId(node.domainId, nid) as NodeDoc;
    }

    static async get(_id: ObjectId): Promise<NodeDoc | null> {
        // 通过 _id 查找需要先找到对应的 domainId 和 nid
        const doc = await document.coll.findOne({ _id });
        if (!doc) return null;
        return await this.getByNodeId(doc.domainId, doc.nid);
    }

    static async getByDomain(domainId: string): Promise<NodeDoc[]> {
        return await document.getMulti(domainId, document.TYPE_NODE, {}).toArray() as NodeDoc[];
    }

    static async getByOwner(domainId: string, owner: number): Promise<NodeDoc[]> {
        return await document.getMulti(domainId, document.TYPE_NODE, { owner }).toArray() as NodeDoc[];
    }

    static async update(domainId: string, nid: number, update: Partial<NodeDoc>): Promise<NodeDoc> {
        const node = await this.getByNodeId(domainId, nid);
        if (!node) throw new Error('Node not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_NODE, node.docId, $set) as NodeDoc;
    }

    static async del(domainId: string, nid: number) {
        const node = await this.getByNodeId(domainId, nid);
        if (!node) return;
        // 删除节点时同时删除相关设备
        if (node._id) {
            await collDevice.deleteMany({ nodeId: node._id });
        }
        return await document.deleteOne(domainId, document.TYPE_NODE, node.docId);
    }

    static async findByDomainAndNodeId(domainId: string, nid: number): Promise<NodeDoc | null> {
        return await this.getByNodeId(domainId, nid);
    }

    static async getByNodeId(domainId: string, nid: number): Promise<NodeDoc | null> {
        // 通过 nid 查询，因为 docId 是 ObjectId
        const nodes = await document.getMulti(domainId, document.TYPE_NODE, { nid })
            .limit(1)
            .toArray();
        return (nodes[0] as NodeDoc) || null;
    }
    
    static async getByEdgeId(domainId: string, edgeId: number): Promise<NodeDoc | null> {
        // 通过 edgeId 查找关联的 node
        const nodes = await document.getMulti(domainId, document.TYPE_NODE, { edgeId })
            .limit(1)
            .toArray();
        return (nodes[0] as NodeDoc) || null;
    }
}

class NodeDeviceModel {
    static coll = collDevice;

    static async add(device: Partial<NodeDeviceDoc> & { nodeId: ObjectId; domainId: string; deviceId: string; name: string; type: string }) {
        const now = new Date();
        const doc: NodeDeviceDoc = {
            _id: new ObjectId(),
            nodeId: device.nodeId,
            domainId: device.domainId,
            deviceId: device.deviceId,
            name: device.name,
            type: device.type,
            manufacturer: device.manufacturer,
            model: device.model,
            state: device.state || {},
            capabilities: device.capabilities || [],
            lastSeen: now,
            createdAt: now,
            updatedAt: now,
        };
        await collDevice.insertOne(doc);
        return doc;
    }

    static async get(_id: ObjectId) {
        return collDevice.findOne({ _id });
    }

    static async getByNode(nodeId: ObjectId) {
        return collDevice.find({ nodeId }).toArray();
    }

    static async getByDeviceId(nodeId: ObjectId, deviceId: string) {
        return collDevice.findOne({ nodeId, deviceId });
    }

    // 通过 deviceId 查找设备（不需要 nodeId）
    static async getByDeviceIdString(deviceId: string) {
        return collDevice.findOne({ deviceId });
    }

    static async upsertByDeviceId(nodeId: ObjectId, deviceId: string, update: Partial<NodeDeviceDoc>) {
        const doc = { ...update, updatedAt: new Date(), lastSeen: new Date() };
        return collDevice.updateOne(
            { nodeId, deviceId },
            { $set: doc },
            { upsert: true },
        );
    }

    static async update(_id: ObjectId, update: Partial<NodeDeviceDoc>) {
        const doc = { ...update, updatedAt: new Date(), lastSeen: new Date() };
        return collDevice.updateOne({ _id }, { $set: doc });
    }

    static async updateState(_id: ObjectId, state: Record<string, any>) {
        return collDevice.updateOne(
            { _id },
            { $set: { state, updatedAt: new Date(), lastSeen: new Date() } },
        );
    }

    static async del(_id: ObjectId) {
        return collDevice.deleteOne({ _id });
    }

    static async delByNode(nodeId: ObjectId) {
        return collDevice.deleteMany({ nodeId });
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', async (domainId) => {
        const nodes = await document.getMulti(domainId, document.TYPE_NODE, {}).toArray();
        for (const node of nodes) {
            if (node._id) {
                await collDevice.deleteMany({ nodeId: node._id });
            }
        }
        // document 系统会自动处理删除
    });

    if (process.env.NODE_APP_INSTANCE !== '0') return;
    // document 集合的索引由 document 模块管理
    await db.ensureIndexes(
        collDevice,
        { key: { nodeId: 1, deviceId: 1 }, name: 'node_device', unique: true },
        { key: { nodeId: 1 }, name: 'nodeId' },
        { key: { domainId: 1 }, name: 'domainId' },
    );
}

export default NodeModel;
export { NodeDeviceModel };

// 导出到全局类型系统
global.Ejunz.model.node = NodeModel;
global.Ejunz.model.nodeDevice = NodeDeviceModel;


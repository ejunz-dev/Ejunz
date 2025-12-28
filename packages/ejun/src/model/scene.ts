import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import type { SceneDoc, SceneEventDoc } from '../interface';

const logger = new Logger('model/scene');

class SceneModel {
    static async generateNextSceneId(domainId: string): Promise<number> {
        const lastScene = await document.getMulti(domainId, document.TYPE_SCENE, {})
            .sort({ sid: -1 })
            .limit(1)
            .project({ sid: 1 })
            .toArray();
        return (lastScene[0]?.sid || 0) + 1;
    }

    static async add(scene: Partial<SceneDoc> & { domainId: string; name: string; owner: number }): Promise<SceneDoc> {
        const sid = await this.generateNextSceneId(scene.domainId);
        const now = new Date();
        
        const payload: Partial<SceneDoc> = {
            domainId: scene.domainId,
            sid,
            name: scene.name,
            description: scene.description,
            enabled: scene.enabled || false,
            createdAt: now,
            updatedAt: now,
            owner: scene.owner,
        };

        await document.add(
            scene.domainId,
            scene.name, // content
            scene.owner,
            document.TYPE_SCENE,
            null, // 让系统自动生成 docId
            null,
            null,
            payload,
        );

        return await this.getBySceneId(scene.domainId, sid) as SceneDoc;
    }

    static async get(_id: ObjectId): Promise<SceneDoc | null> {
        const doc = await document.coll.findOne({ _id });
        if (!doc) return null;
        return await this.getBySceneId(doc.domainId, doc.sid);
    }

    static async getByDomain(domainId: string): Promise<SceneDoc[]> {
        return await document.getMulti(domainId, document.TYPE_SCENE, {}).toArray() as SceneDoc[];
    }

    static async getByOwner(domainId: string, owner: number): Promise<SceneDoc[]> {
        return await document.getMulti(domainId, document.TYPE_SCENE, { owner }).toArray() as SceneDoc[];
    }

    static async getBySceneId(domainId: string, sid: number): Promise<SceneDoc | null> {
        const scenes = await document.getMulti(domainId, document.TYPE_SCENE, { sid })
            .limit(1)
            .toArray();
        return (scenes[0] as SceneDoc) || null;
    }

    static async update(domainId: string, sid: number, update: Partial<SceneDoc>): Promise<SceneDoc> {
        const scene = await this.getBySceneId(domainId, sid);
        if (!scene) throw new Error('Scene not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_SCENE, scene.docId, $set) as SceneDoc;
    }

    static async del(domainId: string, sid: number) {
        const scene = await this.getBySceneId(domainId, sid);
        if (!scene) return;
        // 删除场景时同时删除相关事件
        await SceneEventModel.deleteByScene(domainId, scene.docId);
        return await document.deleteOne(domainId, document.TYPE_SCENE, scene.docId);
    }

    // 启用场景（会自动禁用同域其他场景）
    static async enable(domainId: string, sid: number): Promise<SceneDoc> {
        // 先禁用所有场景
        await document.coll.updateMany(
            { domainId, docType: document.TYPE_SCENE },
            { $set: { enabled: false } }
        );
        // 启用指定场景
        return await this.update(domainId, sid, { enabled: true });
    }

    // 禁用场景
    static async disable(domainId: string, sid: number): Promise<SceneDoc> {
        return await this.update(domainId, sid, { enabled: false });
    }

    // 获取当前启用的场景
    static async getEnabled(domainId: string): Promise<SceneDoc | null> {
        const scenes = await document.getMulti(domainId, document.TYPE_SCENE, { enabled: true })
            .limit(1)
            .toArray();
        return (scenes[0] as SceneDoc) || null;
    }
}

class SceneEventModel {
    static async generateNextEventId(domainId: string, sceneDocId: ObjectId): Promise<number> {
        const lastEvent = await document.getMulti(domainId, document.TYPE_EVENT, { sceneDocId })
            .sort({ eid: -1 })
            .limit(1)
            .project({ eid: 1 })
            .toArray();
        return (lastEvent[0]?.eid || 0) + 1;
    }

    static async add(event: Partial<SceneEventDoc> & {
        domainId: string;
        sceneId: number;
        sceneDocId: ObjectId;
        name: string;
        sourceNodeId: number;
        sourceDeviceId: string;
        targets: Array<{ targetNodeId: number; targetDeviceId: string; targetAction: string; targetValue?: any; order?: number }>;
        owner: number;
    }): Promise<SceneEventDoc> {
        const eid = await this.generateNextEventId(event.domainId, event.sceneDocId);
        const now = new Date();
        
        const payload: Partial<SceneEventDoc> = {
            domainId: event.domainId,
            sceneId: event.sceneId,
            sceneDocId: event.sceneDocId,
            parentType: document.TYPE_SCENE,
            parentId: event.sceneDocId,
            eid,
            name: event.name,
            description: event.description,
            sourceNodeId: event.sourceNodeId,
            sourceDeviceId: event.sourceDeviceId,
            sourceAction: event.sourceAction,
            targets: event.targets,
            enabled: event.enabled !== undefined ? event.enabled : true,
            createdAt: now,
            updatedAt: now,
            owner: event.owner,
        };

        await document.add(
            event.domainId,
            event.name, // content
            event.owner,
            document.TYPE_EVENT,
            null,
            document.TYPE_SCENE,
            event.sceneDocId,
            payload,
        );

        return await this.getByEventId(event.domainId, event.sceneId, eid) as SceneEventDoc;
    }

    static async get(_id: ObjectId): Promise<SceneEventDoc | null> {
        const doc = await document.coll.findOne({ _id });
        if (!doc) return null;
        return await this.getByEventId(doc.domainId, doc.sceneId, doc.eid);
    }

    static async getByScene(domainId: string, sceneDocId: ObjectId): Promise<SceneEventDoc[]> {
        return await document.getMulti(domainId, document.TYPE_EVENT, { sceneDocId }).toArray() as SceneEventDoc[];
    }

    static async getBySceneId(domainId: string, sceneId: number): Promise<SceneEventDoc[]> {
        return await document.getMulti(domainId, document.TYPE_EVENT, { sceneId }).toArray() as SceneEventDoc[];
    }

    static async getByEventId(domainId: string, sceneId: number, eid: number): Promise<SceneEventDoc | null> {
        const events = await document.getMulti(domainId, document.TYPE_EVENT, { sceneId, eid })
            .limit(1)
            .toArray();
        return (events[0] as SceneEventDoc) || null;
    }

    static async update(domainId: string, sceneId: number, eid: number, update: Partial<SceneEventDoc>): Promise<SceneEventDoc> {
        const event = await this.getByEventId(domainId, sceneId, eid);
        if (!event) throw new Error('Event not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_EVENT, event.docId, $set) as SceneEventDoc;
    }

    static async del(domainId: string, sceneId: number, eid: number) {
        const event = await this.getByEventId(domainId, sceneId, eid);
        if (!event) return;
        return await document.deleteOne(domainId, document.TYPE_EVENT, event.docId);
    }

    static async deleteByScene(domainId: string, sceneDocId: ObjectId) {
        return await document.coll.deleteMany({ domainId, docType: document.TYPE_EVENT, sceneDocId });
    }
}

export default SceneModel;
export { SceneEventModel };

// 导出到全局类型系统
if (typeof global !== 'undefined' && (global as any).Ejunz) {
    (global as any).Ejunz.model.scene = SceneModel;
    (global as any).Ejunz.model.sceneEvent = SceneEventModel;
}

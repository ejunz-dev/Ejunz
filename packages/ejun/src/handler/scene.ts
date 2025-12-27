import { ObjectId } from 'mongodb';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from '../context';
import { ValidationError, PermissionError, NotFoundError } from '../error';
import { Logger } from '../logger';
import SceneModel, { SceneEventModel } from '../model/scene';
import NodeModel, { NodeDeviceModel } from '../model/node';
import { PRIV } from '../model/builtin';

const logger = new Logger('handler/scene');

// 场景日志缓冲区
const sceneLogBuffer: Map<number, Array<{ 
    time: string; 
    level: string; 
    message: string; 
    sceneId: number;
    eventId?: number;
    eventName?: string;
    details?: any;
}>> = new Map();
const MAX_SCENE_LOG_BUFFER = 1000;
const sceneLogConnections: Map<number, Set<any>> = new Map();

// 事件触发去重缓存（避免短时间内重复触发）
interface TriggerCacheEntry {
    sceneId: number;
    eventId: number;
    sourceNodeId: number;
    sourceDeviceId: string;
    stateHash: string; // 状态的哈希值，用于判断状态是否真的变化了
    timestamp: number;
}

const triggerCache: Map<string, TriggerCacheEntry> = new Map();
const TRIGGER_DEBOUNCE_MS = 2000; // 2秒内的重复触发会被忽略

// 生成状态哈希（用于判断状态是否真的变化了）
function getStateHash(state: Record<string, any>): string {
    // 只关注关键状态字段
    const relevantFields: Record<string, any> = {};
    for (const key of Object.keys(state)) {
        if (key === 'on' || key === 'state' || key.startsWith('state_')) {
            relevantFields[key] = state[key];
        }
    }
    return JSON.stringify(relevantFields);
}

// 检查是否应该触发事件（去重检查）
function shouldTriggerEvent(
    sceneId: number, 
    eventId: number, 
    sourceNodeId: number, 
    sourceDeviceId: string, 
    stateHash: string
): boolean {
    const cacheKey = `${sceneId}_${eventId}_${sourceNodeId}_${sourceDeviceId}`;
    const cached = triggerCache.get(cacheKey);
    const now = Date.now();
    
    if (cached) {
        // 如果状态哈希相同，说明状态没有变化，不触发
        if (cached.stateHash === stateHash) {
            logger.debug('Event %d: state hash unchanged, skipping trigger', eventId);
            return false;
        }
        
        // 如果状态哈希不同，但在去重时间窗口内，也不触发（避免频繁触发）
        if (now - cached.timestamp < TRIGGER_DEBOUNCE_MS) {
            logger.debug('Event %d: trigger debounced (last trigger was %dms ago)', 
                eventId, now - cached.timestamp);
            return false;
        }
    }
    
    // 更新缓存
    triggerCache.set(cacheKey, {
        sceneId,
        eventId,
        sourceNodeId,
        sourceDeviceId,
        stateHash,
        timestamp: now,
    });
    
    // 清理过期缓存（保留最近1分钟的）
    if (triggerCache.size > 100) {
        const oneMinuteAgo = now - 60000;
        for (const [key, entry] of triggerCache.entries()) {
            if (entry.timestamp < oneMinuteAgo) {
                triggerCache.delete(key);
            }
        }
    }
    
    return true;
}

export function addSceneLog(
    sceneId: number, 
    level: string, 
    message: string, 
    eventId?: number,
    eventName?: string,
    details?: any
) {
    if (!sceneLogBuffer.has(sceneId)) {
        sceneLogBuffer.set(sceneId, []);
    }
    const logs = sceneLogBuffer.get(sceneId)!;
    const time = new Date().toISOString();
    const logEntry = { time, level, message, sceneId, eventId, eventName, details };
    logs.push(logEntry);
    
    if (logs.length > MAX_SCENE_LOG_BUFFER) {
        logs.shift();
    }
    
    broadcastSceneLog(sceneId, logEntry);
}

function broadcastSceneLog(sceneId: number, logData: any) {
    const connections = sceneLogConnections.get(sceneId);
    if (connections) {
        connections.forEach(conn => {
            try {
                conn.send({ type: 'log', data: logData });
            } catch (error) {
                logger.error(`Failed to broadcast log to connection: ${error}`);
            }
        });
    }
}

// 获取场景列表
export class SceneDomainHandler extends Handler<Context> {
    async get() {
        const scenes = await SceneModel.getByDomain(this.domain._id);
        // 按 sid 排序
        scenes.sort((a, b) => (a.sid || 0) - (b.sid || 0));
        this.response.template = 'scene_domain.html';
        this.response.body = { scenes, domainId: this.domain._id };
    }
}

// 创建/编辑场景
export class SceneEditHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid } = this.request.params;
        
        let scene = null;
        if (sid) {
            const sidNum = parseInt(sid, 10);
            if (!isNaN(sidNum) && sidNum >= 1) {
                scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
                if (scene) {
                    // 检查权限
                    if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
                        throw new PermissionError(PRIV.PRIV_USER_PROFILE);
                    }
                }
            }
        }

        this.response.template = 'scene_edit.html';
        this.response.body = { scene };
    }

    async postCreate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { name, description } = this.request.body;
        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }

        const scene = await SceneModel.add({
            domainId: this.domain._id,
            name,
            description,
            owner: this.user._id,
        });

        this.response.redirect = this.url('scene_detail', { domainId: this.domain._id, sid: scene.sid });
    }

    async postUpdate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid } = this.request.params;
        const { name, description } = this.request.body;
        
        const sidNum = parseInt(sid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }

        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await SceneModel.update(this.domain._id, sidNum, { name, description });
        this.response.redirect = this.url('scene_detail', { domainId: this.domain._id, sid: sidNum });
    }

    async postDelete() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid } = this.request.params;
        
        const sidNum = parseInt(sid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await SceneModel.del(this.domain._id, sidNum);
        this.response.redirect = '/scene';
    }
}

// 获取场景详情
export class SceneDetailHandler extends Handler<Context> {
    async get() {
        const { sid } = this.request.params;
        
        // 排除静态资源文件（如 .css.map）
        if (sid && (sid.includes('.') || !/^\d+$/.test(sid))) {
            throw new NotFoundError(sid);
        }
        
        const sidNum = parseInt(sid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 获取场景的所有事件
        const events = await SceneEventModel.getBySceneId(this.domain._id, sidNum);
        // 按 eid 排序
        events.sort((a, b) => (a.eid || 0) - (b.eid || 0));

        // 获取所有节点和设备（用于下拉选择）
        const nodes = await NodeModel.getByDomain(this.domain._id);
        const nodeDevicesMap: Record<number, any[]> = {};
        for (const node of nodes) {
            const devices = await NodeDeviceModel.getByNode(node._id);
            // 只保留开关类型的设备
            const switchDevices = devices.filter(d => 
                d.type === 'switch' || 
                d.capabilities?.includes('on') || 
                d.capabilities?.includes('off') ||
                d.state?.on !== undefined ||
                d.state?.state !== undefined
            );
            if (switchDevices.length > 0) {
                nodeDevicesMap[node.nid] = switchDevices;
            }
        }

        // 清理 events 数据，将 ObjectId 和 Date 转换为可序列化的格式
        const cleanedEvents = events.map(event => ({
            ...event,
            _id: event._id.toString(),
            docId: event.docId.toString(),
            sceneDocId: event.sceneDocId.toString(),
            createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
            updatedAt: event.updatedAt instanceof Date ? event.updatedAt.toISOString() : event.updatedAt,
        }));

        // 清理 nodeDevicesMap 数据
        const cleanedNodeDevicesMap: Record<number, any[]> = {};
        for (const [nodeId, devices] of Object.entries(nodeDevicesMap)) {
            cleanedNodeDevicesMap[parseInt(nodeId, 10)] = devices.map(device => ({
                ...device,
                _id: device._id.toString(),
                nodeId: device.nodeId.toString(),
                lastSeen: device.lastSeen instanceof Date ? device.lastSeen.toISOString() : device.lastSeen,
                createdAt: device.createdAt instanceof Date ? device.createdAt.toISOString() : device.createdAt,
                updatedAt: device.updatedAt instanceof Date ? device.updatedAt.toISOString() : device.updatedAt,
            }));
        }

        this.response.template = 'scene_detail.html';
        this.response.body = { 
            scene, 
            events: cleanedEvents,
            eventsJson: JSON.stringify(cleanedEvents),
            nodes,
            nodeDevicesMap: cleanedNodeDevicesMap,
            nodeDevicesMapJson: JSON.stringify(cleanedNodeDevicesMap),
            domainId: this.domain._id,
        };
    }
}

// 启用/禁用场景
export class SceneToggleHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid } = this.request.params;
        const { enabled } = this.request.body;
        
        const sidNum = parseInt(sid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        if (enabled === true || enabled === 'true') {
            await SceneModel.enable(this.domain._id, sidNum);
            addSceneLog(sidNum, 'info', `场景已启用`, undefined, undefined, { operator: this.user._id });
        } else {
            await SceneModel.disable(this.domain._id, sidNum);
            addSceneLog(sidNum, 'info', `场景已禁用`, undefined, undefined, { operator: this.user._id });
        }

        this.response.body = { success: true };
    }
}

// 事件编辑页面
export class SceneEventEditHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid, eid } = this.request.params;
        
        // 排除静态资源文件
        if (this.request.path.match(/\.(css|js|map|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/i)) {
            throw new NotFoundError(this.request.path);
        }
        
        const sidNum = parseInt(sid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 获取所有节点和设备（用于下拉选择）
        const nodes = await NodeModel.getByDomain(this.domain._id);
        const nodeDevicesMap: Record<number, any[]> = {};
        for (const node of nodes) {
            const devices = await NodeDeviceModel.getByNode(node._id);
            // 只保留开关类型的设备
            const switchDevices = devices.filter(d => 
                d.type === 'switch' || 
                d.capabilities?.includes('on') || 
                d.capabilities?.includes('off') ||
                d.state?.on !== undefined ||
                d.state?.state !== undefined
            );
            if (switchDevices.length > 0) {
                nodeDevicesMap[node.nid] = switchDevices;
            }
        }

        let event = null;
        if (eid) {
            const eidNum = parseInt(eid, 10);
            if (!isNaN(eidNum) && eidNum >= 1) {
                event = await SceneEventModel.getByEventId(this.domain._id, sidNum, eidNum);
                if (event) {
                    // 清理事件数据，将 ObjectId 和 Date 转换为可序列化的格式
                    event = {
                        ...event,
                        _id: event._id.toString(),
                        docId: event.docId.toString(),
                        sceneDocId: event.sceneDocId.toString(),
                        createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
                        updatedAt: event.updatedAt instanceof Date ? event.updatedAt.toISOString() : event.updatedAt,
                    };
                }
            }
        }

        // 清理 nodeDevicesMap 数据
        const cleanedNodeDevicesMap: Record<number, any[]> = {};
        for (const [nodeId, devices] of Object.entries(nodeDevicesMap)) {
            cleanedNodeDevicesMap[parseInt(nodeId, 10)] = devices.map(device => ({
                ...device,
                _id: device._id.toString(),
                nodeId: device.nodeId.toString(),
                lastSeen: device.lastSeen instanceof Date ? device.lastSeen.toISOString() : device.lastSeen,
                createdAt: device.createdAt instanceof Date ? device.createdAt.toISOString() : device.createdAt,
                updatedAt: device.updatedAt instanceof Date ? device.updatedAt.toISOString() : device.updatedAt,
            }));
        }

        this.response.template = 'scene_event_edit.html';
        this.response.body = {
            scene,
            event,
            eventJson: event ? JSON.stringify(event) : 'null',
            nodes,
            nodeDevicesMap: cleanedNodeDevicesMap,
            nodeDevicesMapJson: JSON.stringify(cleanedNodeDevicesMap),
            sceneId: sidNum,
            domainId: this.domain._id,
        };
    }

    async postCreate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid } = this.request.params;
        const { 
            name, 
            description, 
            sourceNodeId, 
            sourceDeviceId, 
            sourceAction,
            targetNodeId, 
            targetDeviceId, 
            targetAction,
            targetValue,
            enabled,
        } = this.request.body;
        
        const sidNum = parseInt(sid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 验证必填字段
        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }
        const sourceNodeIdNum = typeof sourceNodeId === 'string' ? parseInt(sourceNodeId, 10) : sourceNodeId;
        const targetNodeIdNum = typeof targetNodeId === 'string' ? parseInt(targetNodeId, 10) : targetNodeId;
        
        if (!sourceNodeIdNum || isNaN(sourceNodeIdNum)) {
            throw new ValidationError('sourceNodeId');
        }
        if (!sourceDeviceId || typeof sourceDeviceId !== 'string') {
            throw new ValidationError('sourceDeviceId');
        }
        if (!targetNodeIdNum || isNaN(targetNodeIdNum)) {
            throw new ValidationError('targetNodeId');
        }
        if (!targetDeviceId || typeof targetDeviceId !== 'string') {
            throw new ValidationError('targetDeviceId');
        }
        if (!targetAction || typeof targetAction !== 'string') {
            throw new ValidationError('targetAction');
        }

        // 验证节点和设备是否存在
        const sourceNode = await NodeModel.getByNodeId(this.domain._id, sourceNodeIdNum);
        if (!sourceNode) {
            throw new ValidationError('sourceNodeId');
        }
        const sourceDevices = await NodeDeviceModel.getByNode(sourceNode._id);
        if (!sourceDevices.find(d => d.deviceId === sourceDeviceId)) {
            throw new ValidationError('sourceDeviceId');
        }

        const targetNode = await NodeModel.getByNodeId(this.domain._id, targetNodeIdNum);
        if (!targetNode) {
            throw new ValidationError('targetNodeId');
        }
        const targetDevices = await NodeDeviceModel.getByNode(targetNode._id);
        if (!targetDevices.find(d => d.deviceId === targetDeviceId)) {
            throw new ValidationError('targetDeviceId');
        }

        // 检查是否已存在相同的事件（防止重复创建）
        const existingEvents = await SceneEventModel.getByScene(this.domain._id, scene.docId);
        const duplicate = existingEvents.find(e => 
            e.sourceNodeId === sourceNodeIdNum &&
            e.sourceDeviceId === sourceDeviceId &&
            e.sourceAction === sourceAction &&
            e.targetNodeId === targetNodeIdNum &&
            e.targetDeviceId === targetDeviceId &&
            e.targetAction === targetAction
        );
        
        if (duplicate) {
            // 如果已存在相同的事件，直接重定向到详情页
            logger.warn(`Duplicate event creation attempted for scene ${sidNum}`);
            this.response.redirect = this.url('scene_detail', { domainId: this.domain._id, sid: sidNum });
            return;
        }

        const event = await SceneEventModel.add({
            domainId: this.domain._id,
            sceneId: sidNum,
            sceneDocId: scene.docId,
            name,
            description,
            sourceNodeId: sourceNodeIdNum,
            sourceDeviceId,
            sourceAction,
            targetNodeId: targetNodeIdNum,
            targetDeviceId,
            targetAction,
            targetValue,
            enabled: enabled !== undefined ? (enabled === true || enabled === 'true' || enabled === '1') : true,
            owner: this.user._id,
        });

        this.response.redirect = this.url('scene_detail', { domainId: this.domain._id, sid: sidNum });
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid, eid } = this.request.params;
        const { operation } = this.request.body;
        
        // 排除静态资源文件
        if (this.request.path.match(/\.(css|js|map|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/i)) {
            throw new NotFoundError(this.request.path);
        }
        
        // 如果路由路径以 /delete 结尾，直接调用 postDelete
        if (this.request.path.endsWith('/delete') && eid) {
            return await this.postDelete();
        }
        
        if (operation === 'delete' && eid) {
            return await this.postDelete();
        } else if (operation === 'update' && eid) {
            return await this.postUpdate();
        } else if (operation === 'create' || (!eid && !operation)) {
            // 只有在没有 eid 且没有 operation 参数时才创建
            return await this.postCreate();
        } else {
            throw new ValidationError('operation');
        }
    }

    async postUpdate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid, eid } = this.request.params;
        const { 
            name, 
            description, 
            sourceNodeId, 
            sourceDeviceId, 
            sourceAction,
            targetNodeId, 
            targetDeviceId, 
            targetAction,
            targetValue,
            enabled,
        } = this.request.body;
        
        const sidNum = parseInt(sid, 10);
        const eidNum = parseInt(eid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }
        if (isNaN(eidNum) || eidNum < 1) {
            throw new ValidationError('eid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const event = await SceneEventModel.getByEventId(this.domain._id, sidNum, eidNum);
        if (!event) {
            throw new ValidationError('eid');
        }

        const sourceNodeIdNum = sourceNodeId ? (typeof sourceNodeId === 'string' ? parseInt(sourceNodeId, 10) : sourceNodeId) : event.sourceNodeId;
        const targetNodeIdNum = targetNodeId ? (typeof targetNodeId === 'string' ? parseInt(targetNodeId, 10) : targetNodeId) : event.targetNodeId;

        const update: any = {};
        if (name !== undefined) update.name = name;
        if (description !== undefined) update.description = description;
        if (sourceNodeId !== undefined) update.sourceNodeId = sourceNodeIdNum;
        if (sourceDeviceId !== undefined) update.sourceDeviceId = sourceDeviceId;
        if (sourceAction !== undefined) update.sourceAction = sourceAction;
        if (targetNodeId !== undefined) update.targetNodeId = targetNodeIdNum;
        if (targetDeviceId !== undefined) update.targetDeviceId = targetDeviceId;
        if (targetAction !== undefined) update.targetAction = targetAction;
        if (targetValue !== undefined) update.targetValue = targetValue;
        if (enabled !== undefined) update.enabled = enabled === true || enabled === 'true' || enabled === '1';

        // 如果更新了节点或设备，验证它们是否存在
        if (update.sourceNodeId || update.sourceDeviceId) {
            const sourceNodeId = update.sourceNodeId || event.sourceNodeId;
            const sourceDeviceId = update.sourceDeviceId || event.sourceDeviceId;
            const sourceNode = await NodeModel.getByNodeId(this.domain._id, sourceNodeId);
            if (!sourceNode) {
                throw new ValidationError('sourceNodeId');
            }
            const sourceDevices = await NodeDeviceModel.getByNode(sourceNode._id);
            if (!sourceDevices.find(d => d.deviceId === sourceDeviceId)) {
                throw new ValidationError('sourceDeviceId');
            }
        }

        if (update.targetNodeId || update.targetDeviceId) {
            const targetNodeId = update.targetNodeId || event.targetNodeId;
            const targetDeviceId = update.targetDeviceId || event.targetDeviceId;
            const targetNode = await NodeModel.getByNodeId(this.domain._id, targetNodeId);
            if (!targetNode) {
                throw new ValidationError('targetNodeId');
            }
            const targetDevices = await NodeDeviceModel.getByNode(targetNode._id);
            if (!targetDevices.find(d => d.deviceId === targetDeviceId)) {
                throw new ValidationError('targetDeviceId');
            }
        }

        await SceneEventModel.update(this.domain._id, sidNum, eidNum, update);
        this.response.redirect = this.url('scene_detail', { domainId: this.domain._id, sid: sidNum });
    }

    async postDelete() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid, eid } = this.request.params;
        
        const sidNum = parseInt(sid, 10);
        const eidNum = parseInt(eid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }
        if (isNaN(eidNum) || eidNum < 1) {
            throw new ValidationError('eid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await SceneEventModel.del(this.domain._id, sidNum, eidNum);
        this.response.redirect = this.url('scene_detail', { domainId: this.domain._id, sid: sidNum });
    }
}

// 事件 CRUD（保留用于 API）
export class SceneEventHandler extends Handler<Context> {
    async postCreate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid } = this.request.params;
        const { 
            name, 
            description, 
            sourceNodeId, 
            sourceDeviceId, 
            sourceAction,
            targetNodeId, 
            targetDeviceId, 
            targetAction,
            targetValue,
            enabled,
        } = this.request.body;
        
        const sidNum = parseInt(sid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 验证必填字段
        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }
        if (!sourceNodeId || typeof sourceNodeId !== 'number') {
            throw new ValidationError('sourceNodeId');
        }
        if (!sourceDeviceId || typeof sourceDeviceId !== 'string') {
            throw new ValidationError('sourceDeviceId');
        }
        if (!targetNodeId || typeof targetNodeId !== 'number') {
            throw new ValidationError('targetNodeId');
        }
        if (!targetDeviceId || typeof targetDeviceId !== 'string') {
            throw new ValidationError('targetDeviceId');
        }
        if (!targetAction || typeof targetAction !== 'string') {
            throw new ValidationError('targetAction');
        }

        // 验证节点和设备是否存在
        const sourceNode = await NodeModel.getByNodeId(this.domain._id, sourceNodeId);
        if (!sourceNode) {
            throw new ValidationError('sourceNodeId');
        }
        const sourceDevices = await NodeDeviceModel.getByNode(sourceNode._id);
        if (!sourceDevices.find(d => d.deviceId === sourceDeviceId)) {
            throw new ValidationError('sourceDeviceId');
        }

        const targetNode = await NodeModel.getByNodeId(this.domain._id, targetNodeId);
        if (!targetNode) {
            throw new ValidationError('targetNodeId');
        }
        const targetDevices = await NodeDeviceModel.getByNode(targetNode._id);
        if (!targetDevices.find(d => d.deviceId === targetDeviceId)) {
            throw new ValidationError('targetDeviceId');
        }

        const event = await SceneEventModel.add({
            domainId: this.domain._id,
            sceneId: sidNum,
            sceneDocId: scene.docId,
            name,
            description,
            sourceNodeId,
            sourceDeviceId,
            sourceAction,
            targetNodeId,
            targetDeviceId,
            targetAction,
            targetValue,
            enabled: enabled !== undefined ? (enabled === true || enabled === 'true') : true,
            owner: this.user._id,
        });

        this.response.body = { success: true, event };
    }

    async postUpdate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid, eid } = this.request.params;
        const { 
            name, 
            description, 
            sourceNodeId, 
            sourceDeviceId, 
            sourceAction,
            targetNodeId, 
            targetDeviceId, 
            targetAction,
            targetValue,
            enabled,
        } = this.request.body;
        
        const sidNum = parseInt(sid, 10);
        const eidNum = parseInt(eid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }
        if (isNaN(eidNum) || eidNum < 1) {
            throw new ValidationError('eid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const event = await SceneEventModel.getByEventId(this.domain._id, sidNum, eidNum);
        if (!event) {
            throw new ValidationError('eid');
        }

        const update: any = {};
        if (name !== undefined) update.name = name;
        if (description !== undefined) update.description = description;
        if (sourceNodeId !== undefined) update.sourceNodeId = sourceNodeId;
        if (sourceDeviceId !== undefined) update.sourceDeviceId = sourceDeviceId;
        if (sourceAction !== undefined) update.sourceAction = sourceAction;
        if (targetNodeId !== undefined) update.targetNodeId = targetNodeId;
        if (targetDeviceId !== undefined) update.targetDeviceId = targetDeviceId;
        if (targetAction !== undefined) update.targetAction = targetAction;
        if (targetValue !== undefined) update.targetValue = targetValue;
        if (enabled !== undefined) update.enabled = enabled === true || enabled === 'true';

        // 如果更新了节点或设备，验证它们是否存在
        if (update.sourceNodeId || update.sourceDeviceId) {
            const sourceNodeId = update.sourceNodeId || event.sourceNodeId;
            const sourceDeviceId = update.sourceDeviceId || event.sourceDeviceId;
            const sourceNode = await NodeModel.getByNodeId(this.domain._id, sourceNodeId);
            if (!sourceNode) {
                throw new ValidationError('sourceNodeId');
            }
            const sourceDevices = await NodeDeviceModel.getByNode(sourceNode._id);
            if (!sourceDevices.find(d => d.deviceId === sourceDeviceId)) {
                throw new ValidationError('sourceDeviceId');
            }
        }

        if (update.targetNodeId || update.targetDeviceId) {
            const targetNodeId = update.targetNodeId || event.targetNodeId;
            const targetDeviceId = update.targetDeviceId || event.targetDeviceId;
            const targetNode = await NodeModel.getByNodeId(this.domain._id, targetNodeId);
            if (!targetNode) {
                throw new ValidationError('targetNodeId');
            }
            const targetDevices = await NodeDeviceModel.getByNode(targetNode._id);
            if (!targetDevices.find(d => d.deviceId === targetDeviceId)) {
                throw new ValidationError('targetDeviceId');
            }
        }

        await SceneEventModel.update(this.domain._id, sidNum, eidNum, update);
        this.response.body = { success: true };
    }

    async postDelete() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid, eid } = this.request.params;
        
        const sidNum = parseInt(sid, 10);
        const eidNum = parseInt(eid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }
        if (isNaN(eidNum) || eidNum < 1) {
            throw new ValidationError('eid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await SceneEventModel.del(this.domain._id, sidNum, eidNum);
        this.response.body = { success: true };
    }
}

// 获取节点设备列表（用于下拉选择）
export class SceneNodeDevicesHandler extends Handler<Context> {
    async get() {
        const { nid } = this.request.params;
        
        const nidNum = parseInt(nid, 10);
        if (isNaN(nidNum) || nidNum < 1) {
            throw new ValidationError('nid');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nidNum);
        if (!node) {
            throw new ValidationError('nid');
        }

        const devices = await NodeDeviceModel.getByNode(node._id);
        // 只返回开关类型的设备
        const switchDevices = devices.filter(d => 
            d.type === 'switch' || 
            d.capabilities?.includes('on') || 
            d.capabilities?.includes('off') ||
            d.state?.on !== undefined ||
            d.state?.state !== undefined
        );

        this.response.body = { devices: switchDevices };
    }
}

// 批量操作事件
export class SceneEventBulkHandler extends Handler<Context> {
    private async handleBulkOperation(operation: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid } = this.request.params;
        const { eids } = this.request.body;
        
        const sidNum = parseInt(sid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }

        if (!Array.isArray(eids) || eids.length === 0) {
            throw new ValidationError('eids');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const results = {
            success: 0,
            failed: 0,
            errors: [] as string[],
        };

        for (const eid of eids) {
            const eidNum = typeof eid === 'string' ? parseInt(eid, 10) : eid;
            if (isNaN(eidNum) || eidNum < 1) {
                results.failed++;
                results.errors.push(`Invalid event ID: ${eid}`);
                continue;
            }

            try {
                const event = await SceneEventModel.getByEventId(this.domain._id, sidNum, eidNum);
                if (!event) {
                    results.failed++;
                    results.errors.push(`Event ${eidNum} not found`);
                    continue;
                }

                if (operation === 'delete') {
                    await SceneEventModel.del(this.domain._id, sidNum, eidNum);
                    results.success++;
                } else if (operation === 'enable') {
                    await SceneEventModel.update(this.domain._id, sidNum, eidNum, { enabled: true });
                    results.success++;
                } else if (operation === 'disable') {
                    await SceneEventModel.update(this.domain._id, sidNum, eidNum, { enabled: false });
                    results.success++;
                } else {
                    results.failed++;
                    results.errors.push(`Unknown operation: ${operation}`);
                }
            } catch (error) {
                results.failed++;
                results.errors.push(`Event ${eidNum}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }

        this.response.body = {
            success: results.success,
            failed: results.failed,
            errors: results.errors,
        };
    }

    async postDelete() {
        return await this.handleBulkOperation('delete');
    }

    async postEnable() {
        return await this.handleBulkOperation('enable');
    }

    async postDisable() {
        return await this.handleBulkOperation('disable');
    }
}

// 场景日志页面
export class SceneLogsHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { sid } = this.request.params;
        
        const sidNum = parseInt(sid, 10);
        if (isNaN(sidNum) || sidNum < 1) {
            throw new ValidationError('sid');
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            throw new ValidationError('sid');
        }

        // 检查权限
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 获取所有事件（用于过滤）
        const events = await SceneEventModel.getBySceneId(this.domain._id, sidNum);
        events.sort((a, b) => (a.eid || 0) - (b.eid || 0));

        const logs = sceneLogBuffer.get(sidNum) || [];
        
        // 清理日志数据，将 details 转换为 JSON 字符串
        const cleanedLogs = logs.slice(-100).map(log => ({
            ...log,
            details: log.details ? JSON.stringify(log.details) : null,
        }));
        
        this.response.template = 'scene_logs.html';
        this.response.body = { 
            scene, 
            domainId: this.domain._id, 
            logs: cleanedLogs,
            events: events.map(e => ({ eid: e.eid, name: e.name }))
        };
    }
}

// 场景日志 WebSocket 连接
export class SceneLogsConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;
    private sceneId: number | null = null;

    async prepare() {
        const { sid } = this.request.query;
        const sidNum = parseInt(sid as string, 10);
        
        if (isNaN(sidNum) || sidNum < 1) {
            this.close(1000, 'Invalid sceneId');
            return;
        }

        const scene = await SceneModel.getBySceneId(this.domain._id, sidNum);
        if (!scene) {
            this.close(1000, 'Scene not found');
            return;
        }

        if (!this.user || !this.user._id) {
            this.close(1000, 'Authentication required');
            return;
        }
        
        if (scene.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            this.close(1000, 'Permission denied');
            return;
        }

        this.sceneId = sidNum;

        // 添加到连接集合
        if (!sceneLogConnections.has(sidNum)) {
            sceneLogConnections.set(sidNum, new Set());
        }
        sceneLogConnections.get(sidNum)!.add(this);

        // 发送历史日志
        const logs = sceneLogBuffer.get(sidNum) || [];
        const recentLogs = logs.slice(-50);
        this.send({ type: 'history', logs: recentLogs });
    }

    async message(msg: any) {
        // 日志连接不需要处理消息
    }

    async cleanup() {
        if (this.sceneId) {
            const connections = sceneLogConnections.get(this.sceneId);
            if (connections) {
                connections.delete(this);
                if (connections.size === 0) {
                    sceneLogConnections.delete(this.sceneId);
                }
            }
        }
    }
}

// 执行场景事件
async function executeSceneEvent(event: any, ctx: Context) {
    try {
        const targetNode = await NodeModel.getByNodeId(event.domainId, event.targetNodeId);
        if (!targetNode) {
            logger.warn('Target node not found: sceneId=%d, eventId=%d, targetNodeId=%d', 
                event.sceneId, event.eid, event.targetNodeId);
            addSceneLog(event.sceneId, 'error', 
                `执行事件失败: 目标节点 ${event.targetNodeId} 不存在`, 
                event.eid, event.name);
            return;
        }

        const targetDevice = await NodeDeviceModel.getByDeviceId(targetNode._id, event.targetDeviceId);
        if (!targetDevice) {
            logger.warn('Target device not found: sceneId=%d, eventId=%d, targetDeviceId=%s', 
                event.sceneId, event.eid, event.targetDeviceId);
            addSceneLog(event.sceneId, 'error', 
                `执行事件失败: 目标设备 ${event.targetDeviceId} 不存在`, 
                event.eid, event.name);
            return;
        }

        // 构建控制命令
        let command: Record<string, any> = {};
        
        if (event.targetAction === 'on' || event.targetAction === '开') {
            command.on = true;
        } else if (event.targetAction === 'off' || event.targetAction === '关') {
            command.on = false;
        } else if (event.targetAction === 'toggle' || event.targetAction === '切换') {
            // 切换：取当前状态的相反值
            const currentState = targetDevice.state?.on ?? false;
            command.on = !currentState;
        } else {
            // 其他动作或自定义值
            if (event.targetValue !== undefined && event.targetValue !== null && event.targetValue !== '') {
                try {
                    // 尝试解析 JSON
                    const parsed = typeof event.targetValue === 'string' 
                        ? JSON.parse(event.targetValue) 
                        : event.targetValue;
                    command = { ...command, ...parsed };
                } catch {
                    // 如果不是 JSON，直接使用 targetValue
                    command = { ...command, [event.targetAction]: event.targetValue };
                }
            } else {
                command[event.targetAction] = true;
            }
        }

        // 通过 MQTT 发送控制命令
        await ctx.inject(['mqtt'], async ({ mqtt }) => {
            if (mqtt) {
                logger.info('Executing scene event: sceneId=%d, eventId=%d, targetNode=%d, targetDevice=%s, command=%O',
                    event.sceneId, event.eid, event.targetNodeId, event.targetDeviceId, command);
                await (mqtt as any).sendDeviceControlViaMqtt(targetNode._id, event.targetDeviceId, command);
                
                // 更新设备状态（模拟）
                await NodeDeviceModel.updateState(targetDevice._id, { ...targetDevice.state, ...command });
                
                addSceneLog(event.sceneId, 'success', 
                    `事件执行成功: 目标设备 ${event.targetDeviceId} 执行动作 ${event.targetAction}`, 
                    event.eid, event.name, { command, targetNodeId: event.targetNodeId, targetDeviceId: event.targetDeviceId });
            } else {
                logger.warn('MQTT service not available for scene event execution');
                addSceneLog(event.sceneId, 'error', 
                    `执行事件失败: MQTT 服务不可用`, 
                    event.eid, event.name);
            }
        });
    } catch (error: any) {
        logger.error('Error executing scene event: sceneId=%d, eventId=%d, error=%s', 
            event.sceneId, event.eid, error.message);
        addSceneLog(event.sceneId, 'error', 
            `执行事件失败: ${error.message}`, 
            event.eid, event.name);
    }
}


export async function apply(ctx: Context) {
    // 监听设备状态更新事件，执行场景事件
    (ctx.on as any)('node/device/update', async (nodeId: ObjectId, deviceId: string, newState: Record<string, any>) => {
        try {
            logger.debug('Scene handler received device update: nodeId=%s, deviceId=%s, newState=%O', 
                nodeId, deviceId, newState);
            
            const node = await NodeModel.get(nodeId);
            if (!node) {
                logger.debug('Node not found: nodeId=%s', nodeId);
                return;
            }

            const domainId = node.domainId;
            logger.debug('Checking scene events for domain: %s, node: %d', domainId, node.nid);
            
            // 获取启用的场景
            const enabledScene = await SceneModel.getEnabled(domainId);
            if (!enabledScene) {
                logger.debug('No enabled scene found for domain: %s', domainId);
                return; // 没有启用的场景，不处理
            }

            logger.debug('Found enabled scene: sceneId=%d', enabledScene.sid);

            // 获取场景的所有启用事件
            const events = await SceneEventModel.getBySceneId(domainId, enabledScene.sid);
            const enabledEvents = events.filter(e => e.enabled);
            
            logger.debug('Found %d enabled events for scene %d', enabledEvents.length, enabledScene.sid);
            logger.debug('Checking events for sourceNodeId=%d, sourceDeviceId=%s', node.nid, deviceId);

            // 检查每个事件是否匹配
            for (const event of enabledEvents) {
                logger.debug('Checking event %d: sourceNodeId=%d, sourceDeviceId=%s', 
                    event.eid, event.sourceNodeId, event.sourceDeviceId);
                
                // 检查节点 ID 是否匹配
                if (event.sourceNodeId !== node.nid) {
                    logger.debug('Event %d: node ID mismatch (expected %d, got %d)', 
                        event.eid, event.sourceNodeId, node.nid);
                    continue;
                }

                // 检查设备 ID 是否匹配（支持部分匹配，如 0xa4c138197c862f7b_l1 匹配 0xa4c138197c862f7b）
                const deviceIdMatches = event.sourceDeviceId === deviceId || 
                    deviceId.startsWith(event.sourceDeviceId) || 
                    event.sourceDeviceId.startsWith(deviceId);
                
                if (!deviceIdMatches) {
                    logger.debug('Event %d: device ID mismatch (expected %s, got %s)', 
                        event.eid, event.sourceDeviceId, deviceId);
                    continue;
                }

                logger.debug('Event %d: device ID matched! Checking state condition...', event.eid);

                // 检查状态是否匹配事件条件
                let shouldTrigger = false;
                
                if (!event.sourceAction) {
                    // 如果没有指定 sourceAction，任何状态变化都匹配
                    logger.debug('Event %d: no sourceAction specified, triggering on any state change', event.eid);
                    shouldTrigger = true;
                } else {
                    const sourceAction = event.sourceAction.toLowerCase();
                    
                    // 检查状态字段（支持 on, state, state_l1 等）
                    let currentOn = false;
                    if (newState.on !== undefined) {
                        currentOn = newState.on === true || newState.on === 'ON' || newState.on === 'on';
                    } else if (newState.state !== undefined) {
                        const stateValue = newState.state;
                        currentOn = stateValue === 'ON' || stateValue === 'on' || stateValue === true || stateValue === 1;
                    } else {
                        // 检查是否有 state_l1, state_l2 等字段
                        for (const key of Object.keys(newState)) {
                            if (key.startsWith('state_')) {
                                const stateValue = newState[key];
                                if (stateValue === 'ON' || stateValue === 'on') {
                                    currentOn = true;
                                    break;
                                }
                            }
                        }
                    }
                    
                    logger.debug('Event %d: sourceAction=%s, currentOn=%s', event.eid, sourceAction, currentOn);
                    
                    if (sourceAction === 'on' || sourceAction === '开') {
                        shouldTrigger = currentOn === true;
                    } else if (sourceAction === 'off' || sourceAction === '关') {
                        shouldTrigger = currentOn === false;
                    } else if (sourceAction === 'toggle' || sourceAction === '切换') {
                        // 对于切换，我们检查状态是否有变化（通过检查状态字段是否存在变化）
                        // 由于我们无法获取旧状态，我们假设任何状态更新都可能触发切换
                        shouldTrigger = true;
                    } else {
                        // 其他情况：检查指定字段的值
                        shouldTrigger = newState[event.sourceAction] !== undefined;
                    }
                }

                if (shouldTrigger) {
                    // 生成状态哈希
                    const stateHash = getStateHash(newState);
                    
                    // 检查是否应该触发（去重）
                    if (!shouldTriggerEvent(enabledScene.sid, event.eid, node.nid, deviceId, stateHash)) {
                        logger.debug('Event %d: trigger skipped due to debounce or duplicate state', event.eid);
                        continue;
                    }
                    
                    logger.info('Scene event triggered: sceneId=%d, eventId=%d, sourceNode=%d, sourceDevice=%s (matched %s), newState=%O',
                        enabledScene.sid, event.eid, node.nid, deviceId, event.sourceDeviceId, newState);
                    
                    addSceneLog(enabledScene.sid, 'info', 
                        `事件触发: 监听源设备 ${deviceId} (匹配 ${event.sourceDeviceId}) 状态变化 (${event.sourceAction || 'any'})`, 
                        event.eid, event.name, { 
                            sourceNodeId: node.nid, 
                            sourceDeviceId: deviceId,
                            matchedDeviceId: event.sourceDeviceId,
                            newState,
                            sourceAction: event.sourceAction
                        });

                    // 执行事件
                    await executeSceneEvent(event, ctx);
                } else {
                    logger.debug('Event %d: state condition not met', event.eid);
                }
            }
        } catch (error) {
            logger.error('Error handling device update event for scene trigger: %s', (error as Error).message);
            logger.error('Error stack: %s', (error as Error).stack);
        }
    });

    ctx.Route('scene_domain', '/scene', SceneDomainHandler);
    ctx.Route('scene_create', '/scene/create', SceneEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_edit', '/scene/:sid/edit', SceneEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_delete', '/scene/:sid/delete', SceneEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_toggle', '/scene/:sid/toggle', SceneToggleHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_event_create', '/scene/:sid/event/create', SceneEventEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_event_edit', '/scene/:sid/event/:eid/edit', SceneEventEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_event_delete', '/scene/:sid/event/:eid/delete', SceneEventEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_event_bulk', '/scene/:sid/events/bulk', SceneEventBulkHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_event_api_create', '/scene/:sid/event', SceneEventHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_event_api_update', '/scene/:sid/event/:eid', SceneEventHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('scene_node_devices', '/scene/node/:nid/devices', SceneNodeDevicesHandler);
    ctx.Route('scene_logs', '/scene/:sid/logs', SceneLogsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('scene_logs_conn', '/scene/logs/ws', SceneLogsConnectionHandler);
    // 最后注册 :sid 路由，作为兜底
    ctx.Route('scene_detail', '/scene/:sid', SceneDetailHandler);
}


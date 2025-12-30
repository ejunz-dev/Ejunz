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

// GSI事件触发去重缓存
interface GsiTriggerCacheEntry {
    sceneId: number;
    eventId: number;
    sourceClientId: number;
    sourceGsiPath: string;
    valueHash: string;
    timestamp: number;
}

const gsiTriggerCache: Map<string, GsiTriggerCacheEntry> = new Map();

// 事件触发次数统计缓存
interface EventTriggerCountEntry {
    sceneId: number;
    eventId: number;
    count: number;
    firstTriggerTime: number;
}

const eventTriggerCountCache: Map<string, EventTriggerCountEntry> = new Map();

// GSI值变化缓存（用于string类型：只在值从非目标值变成目标值时触发）
interface GsiValueChangeEntry {
    sceneId: number;
    eventId: number;
    sourceClientId: number;
    sourceGsiPath: string;
    lastValue: any; // 上一次的值
    timestamp: number;
}

const gsiValueChangeCache: Map<string, GsiValueChangeEntry> = new Map();

function shouldTriggerGsiEvent(
    sceneId: number,
    eventId: number,
    sourceClientId: number,
    sourceGsiPath: string,
    valueHash: string
): boolean {
    const cacheKey = `${sceneId}_${eventId}_${sourceClientId}_${sourceGsiPath}`;
    const cached = gsiTriggerCache.get(cacheKey);
    const now = Date.now();
    
    if (cached) {
        if (cached.valueHash === valueHash) {
            return false;
        }
        
        if (now - cached.timestamp < TRIGGER_DEBOUNCE_MS) {
            return false;
        }
    }
    
    gsiTriggerCache.set(cacheKey, {
        sceneId,
        eventId,
        sourceClientId,
        sourceGsiPath,
        valueHash,
        timestamp: now,
    });
    
    if (gsiTriggerCache.size > 100) {
        const oneMinuteAgo = now - 60000;
        for (const [key, entry] of gsiTriggerCache.entries()) {
            if (entry.timestamp < oneMinuteAgo) {
                gsiTriggerCache.delete(key);
            }
        }
    }
    
    return true;
}

// 从对象路径获取值，支持嵌套路径如 "player.state.health"
function getValueByPath(obj: any, path: string): any {
    if (!path || !obj) return undefined;
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        current = current[part];
    }
    return current;
}

// 检查GSI数据是否满足条件
function checkGsiCondition(
    gsiData: any,
    sourceGsiPath: string,
    sourceGsiOperator: string,
    sourceGsiValue: any
): boolean {
    if (!sourceGsiPath) return false;
    
    const actualValue = getValueByPath(gsiData, sourceGsiPath);
    if (actualValue === undefined) {
        logger.debug('GSI condition check failed: actualValue is undefined for path=%s', sourceGsiPath);
        return false;
    }
    
    const operator = (sourceGsiOperator || 'eq').toLowerCase();
    
    logger.debug('GSI condition check: path=%s, actualValue=%o (type: %s), expectedValue=%o (type: %s), operator=%s', 
        sourceGsiPath, actualValue, typeof actualValue, sourceGsiValue, typeof sourceGsiValue, operator);
    
    switch (operator) {
        case 'eq':
        case '==':
        case '===':
            // 使用 == 进行宽松比较，支持字符串和数字的自动转换
            const result = actualValue == sourceGsiValue;
            logger.debug('GSI eq comparison: %o == %o = %s', actualValue, sourceGsiValue, result);
            return result;
        case 'ne':
        case '!=':
        case '!==':
            return actualValue != sourceGsiValue;
        case 'gt':
        case '>':
            return Number(actualValue) > Number(sourceGsiValue);
        case 'gte':
        case '>=':
            return Number(actualValue) >= Number(sourceGsiValue);
        case 'lt':
        case '<':
            return Number(actualValue) < Number(sourceGsiValue);
        case 'lte':
        case '<=':
            return Number(actualValue) <= Number(sourceGsiValue);
        case 'in':
            if (Array.isArray(sourceGsiValue)) {
                return sourceGsiValue.includes(actualValue);
            }
            return false;
        case 'contains':
            if (typeof actualValue === 'string' && typeof sourceGsiValue === 'string') {
                return actualValue.includes(sourceGsiValue);
            }
            return false;
        default:
            return false;
    }
}

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
        if (cached.stateHash === stateHash) {
            return false;
        }
        
        if (now - cached.timestamp < TRIGGER_DEBOUNCE_MS) {
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

        // 获取所有Client和组件列表（用于下拉选择）
        const ClientModel = require('../model/client').default;
        const clients = await ClientModel.getByDomain(this.domain._id);
        const cleanedClients = clients.map(c => ({
            clientId: c.clientId,
            name: c.name,
        }));
        
        // 获取每个client的widget列表（从数据库读取，优先；如果数据库没有则从内存读取，向后兼容）
        const clientWidgetsMap: Record<number, string[]> = {};
        const { ClientWidgetModel, ClientGsiFieldModel } = require('../model/client');
        const ClientConnectionHandler = require('./client').ClientConnectionHandler;
        for (const client of clients) {
            try {
                // 优先从数据库读取
                const dbWidgets = await ClientWidgetModel.getByClient(this.domain._id, client.clientId);
                if (dbWidgets && dbWidgets.length > 0) {
                    clientWidgetsMap[client.clientId] = dbWidgets.map(w => w.widgetName);
                } else {
                    // 如果数据库没有，尝试从内存读取（向后兼容）
                    const handler = ClientConnectionHandler.getConnection(client.clientId);
                    if (handler) {
                        const widgetList = handler.getWidgetList();
                        if (widgetList && widgetList.length > 0) {
                            clientWidgetsMap[client.clientId] = widgetList.map((w: any) => typeof w === 'string' ? w : w.name);
                        }
                    }
                }
            } catch (error) {
                logger.error('Failed to load widgets for client %d: %o', client.clientId, error);
                // 降级到内存读取
                const handler = ClientConnectionHandler.getConnection(client.clientId);
                if (handler) {
                    const widgetList = handler.getWidgetList();
                    if (widgetList && widgetList.length > 0) {
                        clientWidgetsMap[client.clientId] = widgetList.map((w: any) => typeof w === 'string' ? w : w.name);
                    }
                }
            }
        }
        
        // 获取每个client的GSI字段列表（用于下拉选择）
        const clientGsiFieldsMap: Record<number, Array<{ path: string; type: string; values?: string[]; range?: [number, number]; nullable?: boolean }>> = {};
        for (const client of clients) {
            try {
                const gsiFields = await ClientGsiFieldModel.getByClient(this.domain._id, client.clientId);
                if (gsiFields && gsiFields.length > 0) {
                    clientGsiFieldsMap[client.clientId] = gsiFields.map(f => ({
                        path: f.fieldPath,
                        type: f.type,
                        values: f.values,
                        range: f.range,
                        nullable: f.nullable,
                    }));
                }
            } catch (error) {
                logger.error('Failed to load GSI fields for client %d: %o', client.clientId, error);
            }
        }

        let event = null;
        if (eid) {
            const eidNum = parseInt(eid, 10);
            if (!isNaN(eidNum) && eidNum >= 1) {
                event = await SceneEventModel.getByEventId(this.domain._id, sidNum, eidNum);
                if (event) {
                    // 清理事件数据，将 ObjectId 和 Date 转换为可序列化的格式
                    // 确保 targets 数组存在且格式正确
                    const cleanedEvent: any = {
                        ...event,
                        _id: event._id.toString(),
                        docId: event.docId.toString(),
                        sceneDocId: event.sceneDocId.toString(),
                        createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
                        updatedAt: event.updatedAt instanceof Date ? event.updatedAt.toISOString() : event.updatedAt,
                    };
                    
                    // 确保 targets 数组存在且格式正确
                    if (cleanedEvent.targets && Array.isArray(cleanedEvent.targets)) {
                        cleanedEvent.targets = cleanedEvent.targets.map((target: any) => ({
                            targetNodeId: target.targetNodeId,
                            targetDeviceId: target.targetDeviceId,
                            targetClientId: target.targetClientId,
                            targetWidgetName: target.targetWidgetName,
                            targetAction: target.targetAction,
                            targetValue: target.targetValue !== undefined ? target.targetValue : null,
                            order: target.order !== undefined ? target.order : 0,
                        }));
                    } else {
                        // 如果没有 targets，设置为空数组（不应该发生，但为了安全）
                        cleanedEvent.targets = [];
                    }
                    
                    // 确保 sourceClientId 和 sourceWidgetName 被正确传递
                    // 这些字段已经在 cleanedEvent 中（通过 ...event 展开），但确保它们存在
                    if (cleanedEvent.sourceClientId !== undefined) {
                        cleanedEvent.sourceClientId = cleanedEvent.sourceClientId;
                        cleanedEvent.sourceWidgetName = cleanedEvent.sourceWidgetName;
                    }
                    if (cleanedEvent.sourceNodeId !== undefined) {
                        cleanedEvent.sourceNodeId = cleanedEvent.sourceNodeId;
                        cleanedEvent.sourceDeviceId = cleanedEvent.sourceDeviceId;
                    }
                    
                    event = cleanedEvent;
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

        // 清理 nodes 数据
        const cleanedNodes = nodes.map(node => ({
            nid: node.nid,
            name: node.name,
            _id: node._id.toString(),
        }));

        this.response.template = 'scene_event_edit.html';
        this.response.body = {
            scene,
            event,
            eventJson: event ? JSON.stringify(event) : '{}',
            nodes: cleanedNodes,
            nodesJson: JSON.stringify(cleanedNodes),
            nodeDevicesMap: cleanedNodeDevicesMap,
            nodeDevicesMapJson: JSON.stringify(cleanedNodeDevicesMap),
            clients: cleanedClients,
            clientsJson: JSON.stringify(cleanedClients),
            clientWidgetsMap: clientWidgetsMap,
            clientWidgetsMapJson: JSON.stringify(clientWidgetsMap),
            clientGsiFieldsMap: clientGsiFieldsMap,
            clientGsiFieldsMapJson: JSON.stringify(clientGsiFieldsMap),
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
            sourceClientId,
            sourceWidgetName,
            sourceGsiPath,
            sourceGsiOperator,
            sourceGsiValue,
            sourceAction,
            targetNodeId, 
            targetDeviceId, 
            targetAction,
            targetValue,
            targets,
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

        // 验证监听源：支持Node设备、Client组件或GSI数据
        let sourceNodeIdNum: number | undefined;
        let sourceDeviceIdStr: string | undefined;
        let sourceClientIdNum: number | undefined;
        let sourceWidgetNameStr: string | undefined;
        let sourceGsiPathStr: string | undefined;
        let sourceGsiOperatorStr: string | undefined;
        let sourceGsiValueAny: any = undefined;

        if (sourceGsiPath !== undefined && sourceGsiPath !== null && sourceGsiPath !== '') {
            // GSI数据监听源
            sourceGsiPathStr = typeof sourceGsiPath === 'string' ? sourceGsiPath : String(sourceGsiPath);
            if (!sourceGsiPathStr) {
                throw new ValidationError('sourceGsiPath');
            }
            if (sourceClientId === undefined || sourceClientId === null || sourceClientId === '') {
                throw new ValidationError('sourceClientId for GSI');
            }
            sourceClientIdNum = typeof sourceClientId === 'string' ? parseInt(sourceClientId, 10) : sourceClientId;
            if (!sourceClientIdNum || isNaN(sourceClientIdNum)) {
                throw new ValidationError('sourceClientId');
            }
            sourceGsiOperatorStr = sourceGsiOperator || 'eq';
            sourceGsiValueAny = sourceGsiValue;

            // 验证Client是否存在
            const ClientModel = require('../model/client').default;
            const sourceClient = await ClientModel.getByClientId(this.domain._id, sourceClientIdNum);
            if (!sourceClient) {
                throw new ValidationError('sourceClientId');
            }
        } else if (sourceClientId !== undefined && sourceClientId !== null && sourceClientId !== '') {
            // Client组件监听源
            sourceClientIdNum = typeof sourceClientId === 'string' ? parseInt(sourceClientId, 10) : sourceClientId;
            if (!sourceClientIdNum || isNaN(sourceClientIdNum)) {
                throw new ValidationError('sourceClientId');
            }
            if (!sourceWidgetName || typeof sourceWidgetName !== 'string') {
                throw new ValidationError('sourceWidgetName');
            }
            sourceWidgetNameStr = sourceWidgetName;

            // 验证Client是否存在
            const ClientModel = require('../model/client').default;
            const sourceClient = await ClientModel.getByClientId(this.domain._id, sourceClientIdNum);
            if (!sourceClient) {
                throw new ValidationError('sourceClientId');
            }
        } else {
            // Node设备监听源
            sourceNodeIdNum = typeof sourceNodeId === 'string' ? parseInt(sourceNodeId, 10) : sourceNodeId;
            if (!sourceNodeIdNum || isNaN(sourceNodeIdNum)) {
                throw new ValidationError('sourceNodeId');
            }
            if (!sourceDeviceId || typeof sourceDeviceId !== 'string') {
                throw new ValidationError('sourceDeviceId');
            }
            sourceDeviceIdStr = sourceDeviceId;

            // 验证节点和设备是否存在
            const sourceNode = await NodeModel.getByNodeId(this.domain._id, sourceNodeIdNum);
            if (!sourceNode) {
                throw new ValidationError('sourceNodeId');
            }
            const sourceDevices = await NodeDeviceModel.getByNode(sourceNode._id);
            if (!sourceDevices.find(d => d.deviceId === sourceDeviceId)) {
                throw new ValidationError('sourceDeviceId');
            }
        }

        // 验证 targets 数组
        if (!targets || !Array.isArray(targets) || targets.length === 0) {
            throw new ValidationError('targets');
        }

        const processedTargets: Array<{ targetNodeId?: number; targetDeviceId?: string; targetClientId?: number; targetWidgetName?: string; targetAction: string; targetValue?: any; order?: number }> = [];
        for (const target of targets) {
            if (!target.targetAction || typeof target.targetAction !== 'string') {
                throw new ValidationError('target.targetAction');
            }

            if (target.targetClientId !== undefined && target.targetClientId !== null && target.targetClientId !== '') {
                // Client组件触发效果
                const targetClientIdNum = typeof target.targetClientId === 'string' ? parseInt(target.targetClientId, 10) : target.targetClientId;
                if (!targetClientIdNum || isNaN(targetClientIdNum)) {
                    throw new ValidationError('target.targetClientId');
                }
                if (!target.targetWidgetName || typeof target.targetWidgetName !== 'string') {
                    throw new ValidationError('target.targetWidgetName');
                }

                // 验证Client是否存在
                const ClientModel = require('../model/client').default;
                const targetClient = await ClientModel.getByClientId(this.domain._id, targetClientIdNum);
                if (!targetClient) {
                    throw new ValidationError('target.targetClientId');
                }

                processedTargets.push({
                    targetClientId: targetClientIdNum,
                    targetWidgetName: target.targetWidgetName,
                    targetAction: target.targetAction,
                    order: target.order !== undefined ? target.order : processedTargets.length,
                });
            } else {
                // Node设备触发效果
                const targetNodeIdNum = typeof target.targetNodeId === 'string' ? parseInt(target.targetNodeId, 10) : target.targetNodeId;
                if (!targetNodeIdNum || isNaN(targetNodeIdNum)) {
                    throw new ValidationError('target.targetNodeId');
                }
                if (!target.targetDeviceId || typeof target.targetDeviceId !== 'string') {
                    throw new ValidationError('target.targetDeviceId');
                }

                // 验证目标节点和设备是否存在
                const targetNode = await NodeModel.getByNodeId(this.domain._id, targetNodeIdNum);
                if (!targetNode) {
                    throw new ValidationError('target.targetNodeId');
                }
                const targetDevices = await NodeDeviceModel.getByNode(targetNode._id);
                if (!targetDevices.find(d => d.deviceId === target.targetDeviceId)) {
                    throw new ValidationError('target.targetDeviceId');
                }

                processedTargets.push({
                    targetNodeId: targetNodeIdNum,
                    targetDeviceId: target.targetDeviceId,
                    targetAction: target.targetAction,
                    targetValue: target.targetValue,
                    order: target.order !== undefined ? target.order : processedTargets.length,
                });
            }
        }

        const existingEvents = await SceneEventModel.getByScene(this.domain._id, scene.docId);
        
        const duplicate = existingEvents.find(e => {
            const eIsClient = (e.sourceClientId !== undefined && e.sourceClientId !== null);
            const newIsClient = (sourceClientIdNum !== undefined);
            
            if (eIsClient !== newIsClient) {
                return false;
            }
            
            if (newIsClient) {
                const eClientId = typeof e.sourceClientId === 'number' ? e.sourceClientId : (e.sourceClientId ? parseInt(String(e.sourceClientId), 10) : undefined);
                if (eClientId !== sourceClientIdNum || e.sourceWidgetName !== sourceWidgetNameStr) {
                    return false;
                }
                const eAction = e.sourceAction || '';
                const newAction = sourceAction || '';
                if (eAction !== newAction) {
                    return false;
                }
            } else {
                const eNodeId = typeof e.sourceNodeId === 'number' ? e.sourceNodeId : (e.sourceNodeId ? parseInt(String(e.sourceNodeId), 10) : undefined);
                if (eNodeId !== sourceNodeIdNum || e.sourceDeviceId !== sourceDeviceIdStr) {
                    return false;
                }
                const eAction = e.sourceAction || '';
                const newAction = sourceAction || '';
                if (eAction !== newAction) {
                    return false;
                }
            }
            
            if (!e.targets || !Array.isArray(e.targets) || e.targets.length === 0) {
                return false;
            }
            if (processedTargets.length !== e.targets.length) {
                return false;
            }
            
            return e.targets.every((et: any, idx: number) => {
                const pt = processedTargets[idx];
                if (pt.targetClientId !== undefined) {
                    const etClientId = typeof et.targetClientId === 'number' ? et.targetClientId : (et.targetClientId ? parseInt(String(et.targetClientId), 10) : undefined);
                    return etClientId === pt.targetClientId &&
                        et.targetWidgetName === pt.targetWidgetName &&
                        et.targetAction === pt.targetAction;
                } else {
                    const etNodeId = typeof et.targetNodeId === 'number' ? et.targetNodeId : (et.targetNodeId ? parseInt(String(et.targetNodeId), 10) : undefined);
                    return etNodeId === pt.targetNodeId &&
                        et.targetDeviceId === pt.targetDeviceId &&
                        et.targetAction === pt.targetAction;
                }
            });
        });
        
        if (duplicate) {
            this.response.redirect = this.url('scene_event_edit', { 
                domainId: this.domain._id, 
                sid: sidNum, 
                eid: duplicate.eid 
            });
            return;
        }

        const eventData: any = {
            domainId: this.domain._id,
            sceneId: sidNum,
            sceneDocId: scene.docId,
            name,
            description,
            sourceAction,
            targets: processedTargets,
            enabled: enabled !== undefined ? (enabled === true || enabled === 'true' || enabled === '1') : true,
            owner: this.user._id,
        };

        if (sourceGsiPathStr !== undefined) {
            // GSI数据监听源
            eventData.sourceClientId = sourceClientIdNum;
            eventData.sourceGsiPath = sourceGsiPathStr;
            eventData.sourceGsiOperator = sourceGsiOperatorStr;
            eventData.sourceGsiValue = sourceGsiValueAny;
        } else if (sourceClientIdNum !== undefined) {
            // Client组件监听源
            eventData.sourceClientId = sourceClientIdNum;
            eventData.sourceWidgetName = sourceWidgetNameStr;
        } else {
            // Node设备监听源
            eventData.sourceNodeId = sourceNodeIdNum;
            eventData.sourceDeviceId = sourceDeviceIdStr;
        }

        const event = await SceneEventModel.add(eventData);

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
            sourceClientId,
            sourceWidgetName,
            sourceGsiPath,
            sourceGsiOperator,
            sourceGsiValue,
            sourceAction,
            targets,
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
        if (sourceAction !== undefined) update.sourceAction = sourceAction;
        if (enabled !== undefined) update.enabled = enabled === true || enabled === 'true' || enabled === '1';

        // 处理监听源更新：支持GSI、Client组件或Node设备
        // 优先判断GSI数据：如果request.body中存在sourceGsiPath字段，就认为是GSI类型
        const isGsiSource = 'sourceGsiPath' in this.request.body;
        if (isGsiSource) {
            // 验证sourceGsiPath是否有值
            if (!sourceGsiPath || sourceGsiPath === '') {
                throw new ValidationError('sourceGsiPath');
            }
            // GSI数据监听源
            if (!sourceClientId) {
                throw new ValidationError('sourceClientId for GSI');
            }
            const sourceClientIdNum = typeof sourceClientId === 'string' ? parseInt(sourceClientId, 10) : sourceClientId;
            if (!sourceClientIdNum || isNaN(sourceClientIdNum)) {
                throw new ValidationError('sourceClientId');
            }
            const ClientModel = require('../model/client').default;
            const sourceClient = await ClientModel.getByClientId(this.domain._id, sourceClientIdNum);
            if (!sourceClient) {
                throw new ValidationError('sourceClientId');
            }
            update.sourceClientId = sourceClientIdNum;
            update.sourceGsiPath = sourceGsiPath;
            update.sourceGsiOperator = sourceGsiOperator || 'eq';
            update.sourceGsiValue = sourceGsiValue;
            update.sourceWidgetName = undefined; // 清除widget相关字段
            update.sourceNodeId = undefined;
            update.sourceDeviceId = undefined;
        } else if (sourceClientId !== undefined && sourceClientId !== null && sourceClientId !== '') {
            // Client组件监听源
            const sourceClientIdNum = typeof sourceClientId === 'string' ? parseInt(sourceClientId, 10) : sourceClientId;
            if (!sourceClientIdNum || isNaN(sourceClientIdNum)) {
                throw new ValidationError('sourceClientId');
            }
            if (!sourceWidgetName || typeof sourceWidgetName !== 'string') {
                throw new ValidationError('sourceWidgetName');
            }
            const ClientModel = require('../model/client').default;
            const sourceClient = await ClientModel.getByClientId(this.domain._id, sourceClientIdNum);
            if (!sourceClient) {
                throw new ValidationError('sourceClientId');
            }
            update.sourceClientId = sourceClientIdNum;
            update.sourceWidgetName = sourceWidgetName;
            update.sourceGsiPath = undefined; // 清除GSI相关字段
            update.sourceGsiOperator = undefined;
            update.sourceGsiValue = undefined;
            update.sourceNodeId = undefined;
            update.sourceDeviceId = undefined;
        } else if (sourceNodeId !== undefined || sourceDeviceId !== undefined) {
            // Node设备监听源
            const sourceNodeIdNum = sourceNodeId ? (typeof sourceNodeId === 'string' ? parseInt(sourceNodeId, 10) : sourceNodeId) : event.sourceNodeId;
            const sourceDeviceIdStr = sourceDeviceId || event.sourceDeviceId;
            if (!sourceNodeIdNum || isNaN(sourceNodeIdNum)) {
                throw new ValidationError('sourceNodeId');
            }
            if (!sourceDeviceIdStr || typeof sourceDeviceIdStr !== 'string') {
                throw new ValidationError('sourceDeviceId');
            }
            const sourceNode = await NodeModel.getByNodeId(this.domain._id, sourceNodeIdNum);
            if (!sourceNode) {
                throw new ValidationError('sourceNodeId');
            }
            const sourceDevices = await NodeDeviceModel.getByNode(sourceNode._id);
            if (!sourceDevices.find(d => d.deviceId === sourceDeviceIdStr)) {
                throw new ValidationError('sourceDeviceId');
            }
            update.sourceNodeId = sourceNodeIdNum;
            update.sourceDeviceId = sourceDeviceIdStr;
            update.sourceClientId = undefined; // 清除client相关字段
            update.sourceWidgetName = undefined;
            update.sourceGsiPath = undefined;
            update.sourceGsiOperator = undefined;
            update.sourceGsiValue = undefined;
        }

        // 处理 targets 数组
        if (targets !== undefined) {
            if (!Array.isArray(targets) || targets.length === 0) {
                throw new ValidationError('targets');
            }
            const processedTargets: Array<{ targetNodeId?: number; targetDeviceId?: string; targetClientId?: number; targetWidgetName?: string; targetAction: string; targetValue?: any; order?: number }> = [];
            for (const target of targets) {
                if (!target.targetAction || typeof target.targetAction !== 'string') {
                    throw new ValidationError('target.targetAction');
                }

                // 判断是否为Client类型：targetClientId存在且不为空字符串
                const hasTargetClientId = target.targetClientId !== undefined && 
                                         target.targetClientId !== null && 
                                         target.targetClientId !== '';
                
                if (hasTargetClientId) {
                    // Client组件触发效果
                    const targetClientIdNum = typeof target.targetClientId === 'string' ? parseInt(target.targetClientId, 10) : target.targetClientId;
                    if (isNaN(targetClientIdNum) || targetClientIdNum < 1) {
                        throw new ValidationError('target.targetClientId');
                    }
                    if (!target.targetWidgetName || typeof target.targetWidgetName !== 'string') {
                        throw new ValidationError('target.targetWidgetName');
                    }

                    // 验证Client是否存在
                    const ClientModel = require('../model/client').default;
                    const targetClient = await ClientModel.getByClientId(this.domain._id, targetClientIdNum);
                    if (!targetClient) {
                        throw new ValidationError('target.targetClientId');
                    }

                    processedTargets.push({
                        targetClientId: targetClientIdNum,
                        targetWidgetName: target.targetWidgetName,
                        targetAction: target.targetAction,
                        targetValue: target.targetValue,
                        order: target.order !== undefined ? target.order : processedTargets.length,
                    });
                } else {
                    // Node设备触发效果
                    const targetNodeIdNum = typeof target.targetNodeId === 'string' ? parseInt(target.targetNodeId, 10) : target.targetNodeId;
                    if (!targetNodeIdNum || isNaN(targetNodeIdNum)) {
                        throw new ValidationError('target.targetNodeId');
                    }
                    if (!target.targetDeviceId || typeof target.targetDeviceId !== 'string') {
                        throw new ValidationError('target.targetDeviceId');
                    }

                    // 验证目标节点和设备是否存在
                    const targetNode = await NodeModel.getByNodeId(this.domain._id, targetNodeIdNum);
                    if (!targetNode) {
                        throw new ValidationError('target.targetNodeId');
                    }
                    const targetDevices = await NodeDeviceModel.getByNode(targetNode._id);
                    if (!targetDevices.find(d => d.deviceId === target.targetDeviceId)) {
                        throw new ValidationError('target.targetDeviceId');
                    }

                    processedTargets.push({
                        targetNodeId: targetNodeIdNum,
                        targetDeviceId: target.targetDeviceId,
                        targetAction: target.targetAction,
                        targetValue: target.targetValue,
                        order: target.order !== undefined ? target.order : processedTargets.length,
                    });
                }
            }
            update.targets = processedTargets;
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
            targets,
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
        if (!sourceNodeIdNum || isNaN(sourceNodeIdNum)) {
            throw new ValidationError('sourceNodeId');
        }
        if (!sourceDeviceId || typeof sourceDeviceId !== 'string') {
            throw new ValidationError('sourceDeviceId');
        }
        if (!targets || !Array.isArray(targets) || targets.length === 0) {
            throw new ValidationError('targets');
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

        // 验证 targets
        const processedTargets: Array<{ targetNodeId: number; targetDeviceId: string; targetAction: string; targetValue?: any; order?: number }> = [];
        for (const target of targets) {
            const targetNodeIdNum = typeof target.targetNodeId === 'string' ? parseInt(target.targetNodeId, 10) : target.targetNodeId;
            if (!targetNodeIdNum || isNaN(targetNodeIdNum)) {
                throw new ValidationError('target.targetNodeId');
            }
            if (!target.targetDeviceId || typeof target.targetDeviceId !== 'string') {
                throw new ValidationError('target.targetDeviceId');
            }
            if (!target.targetAction || typeof target.targetAction !== 'string') {
                throw new ValidationError('target.targetAction');
            }

            const targetNode = await NodeModel.getByNodeId(this.domain._id, targetNodeIdNum);
            if (!targetNode) {
                throw new ValidationError('target.targetNodeId');
            }
            const targetDevices = await NodeDeviceModel.getByNode(targetNode._id);
            if (!targetDevices.find(d => d.deviceId === target.targetDeviceId)) {
                throw new ValidationError('target.targetDeviceId');
            }

            processedTargets.push({
                targetNodeId: targetNodeIdNum,
                targetDeviceId: target.targetDeviceId,
                targetAction: target.targetAction,
                targetValue: target.targetValue,
                order: target.order !== undefined ? target.order : processedTargets.length,
            });
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
            targets: processedTargets,
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
            sourceClientId,
            sourceWidgetName,
            sourceAction,
            targets,
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
        if (sourceAction !== undefined) update.sourceAction = sourceAction;
        if (enabled !== undefined) update.enabled = enabled === true || enabled === 'true';

        // 处理监听源：支持Node设备或Client组件
        if (sourceClientId !== undefined && sourceClientId !== null && sourceClientId !== '') {
            // Client组件监听源
            const sourceClientIdNum = typeof sourceClientId === 'string' ? parseInt(sourceClientId, 10) : sourceClientId;
            if (!sourceClientIdNum || isNaN(sourceClientIdNum)) {
                throw new ValidationError('sourceClientId');
            }
            if (!sourceWidgetName || typeof sourceWidgetName !== 'string') {
                throw new ValidationError('sourceWidgetName');
            }

            // 验证Client是否存在
            const ClientModel = require('../model/client').default;
            const sourceClient = await ClientModel.getByClientId(this.domain._id, sourceClientIdNum);
            if (!sourceClient) {
                throw new ValidationError('sourceClientId');
            }

            update.sourceClientId = sourceClientIdNum;
            update.sourceWidgetName = sourceWidgetName;
            // 清除Node设备相关字段
            update.sourceNodeId = undefined;
            update.sourceDeviceId = undefined;
        } else if (sourceNodeId !== undefined || sourceDeviceId !== undefined) {
            // Node设备监听源
            const sourceNodeIdNum = sourceNodeId !== undefined 
                ? (typeof sourceNodeId === 'string' ? parseInt(sourceNodeId, 10) : sourceNodeId)
                : event.sourceNodeId;
            const sourceDeviceIdStr = sourceDeviceId !== undefined ? sourceDeviceId : event.sourceDeviceId;

            if (!sourceNodeIdNum || isNaN(sourceNodeIdNum)) {
                throw new ValidationError('sourceNodeId');
            }
            if (!sourceDeviceIdStr || typeof sourceDeviceIdStr !== 'string') {
                throw new ValidationError('sourceDeviceId');
            }

            // 验证节点和设备是否存在
            const sourceNode = await NodeModel.getByNodeId(this.domain._id, sourceNodeIdNum);
            if (!sourceNode) {
                throw new ValidationError('sourceNodeId');
            }
            const sourceDevices = await NodeDeviceModel.getByNode(sourceNode._id);
            if (!sourceDevices.find(d => d.deviceId === sourceDeviceIdStr)) {
                throw new ValidationError('sourceDeviceId');
            }

            update.sourceNodeId = sourceNodeIdNum;
            update.sourceDeviceId = sourceDeviceIdStr;
            // 清除Client组件相关字段
            update.sourceClientId = undefined;
            update.sourceWidgetName = undefined;
        }

        // 处理 targets 数组
        if (targets !== undefined) {
            if (!Array.isArray(targets) || targets.length === 0) {
                throw new ValidationError('targets');
            }
            const processedTargets: Array<{ targetNodeId?: number; targetDeviceId?: string; targetClientId?: number; targetWidgetName?: string; targetAction: string; targetValue?: any; order?: number }> = [];
            for (const target of targets) {
                if (!target.targetAction || typeof target.targetAction !== 'string') {
                    throw new ValidationError('target.targetAction');
                }

                if (target.targetClientId !== undefined && target.targetClientId !== null && target.targetClientId !== '') {
                    // Client组件触发效果
                    const targetClientIdNum = typeof target.targetClientId === 'string' ? parseInt(target.targetClientId, 10) : target.targetClientId;
                    if (!targetClientIdNum || isNaN(targetClientIdNum)) {
                        throw new ValidationError('target.targetClientId');
                    }
                    if (!target.targetWidgetName || typeof target.targetWidgetName !== 'string') {
                        throw new ValidationError('target.targetWidgetName');
                    }

                    // 验证Client是否存在
                    const ClientModel = require('../model/client').default;
                    const targetClient = await ClientModel.getByClientId(this.domain._id, targetClientIdNum);
                    if (!targetClient) {
                        throw new ValidationError('target.targetClientId');
                    }

                    processedTargets.push({
                        targetClientId: targetClientIdNum,
                        targetWidgetName: target.targetWidgetName,
                        targetAction: target.targetAction,
                        order: target.order !== undefined ? target.order : processedTargets.length,
                    });
                } else {
                    // Node设备触发效果
                    const targetNodeIdNum = typeof target.targetNodeId === 'string' ? parseInt(target.targetNodeId, 10) : target.targetNodeId;
                    if (!targetNodeIdNum || isNaN(targetNodeIdNum)) {
                        throw new ValidationError('target.targetNodeId');
                    }
                    if (!target.targetDeviceId || typeof target.targetDeviceId !== 'string') {
                        throw new ValidationError('target.targetDeviceId');
                    }

                    const targetNode = await NodeModel.getByNodeId(this.domain._id, targetNodeIdNum);
                    if (!targetNode) {
                        throw new ValidationError('target.targetNodeId');
                    }
                    const targetDevices = await NodeDeviceModel.getByNode(targetNode._id);
                    if (!targetDevices.find(d => d.deviceId === target.targetDeviceId)) {
                        throw new ValidationError('target.targetDeviceId');
                    }

                    processedTargets.push({
                        targetNodeId: targetNodeIdNum,
                        targetDeviceId: target.targetDeviceId,
                        targetAction: target.targetAction,
                        targetValue: target.targetValue,
                        order: target.order !== undefined ? target.order : processedTargets.length,
                    });
                }
            }
            update.targets = processedTargets;
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

// 执行单个触发效果
async function executeTargetAction(
    sceneId: number,
    eventId: number,
    eventName: string,
    target: { targetNodeId?: number; targetDeviceId?: string; targetClientId?: number; targetWidgetName?: string; targetAction: string; targetValue?: any },
    domainId: string,
    ctx: Context
) {
    try {
        // 验证 domainId
        if (!domainId) {
            logger.error('Domain ID is invalid: sceneId=%d, eventId=%d', sceneId, eventId);
            addSceneLog(sceneId, 'error', 
                `执行触发效果失败: 域ID无效`, 
                eventId, eventName);
            return;
        }

        // 判断是Client组件控制还是Node设备控制
        if (target.targetClientId !== undefined && target.targetClientId !== null) {
            // Client组件控制
            if (!target.targetWidgetName) {
                logger.warn('Target widget name missing: sceneId=%d, eventId=%d, targetClientId=%d', 
                    sceneId, eventId, target.targetClientId);
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: 组件名称未指定`, 
                    eventId, eventName);
                return;
            }

            const ClientModel = require('../model/client').default;
            const targetClient = await ClientModel.getByClientId(domainId, target.targetClientId);
            if (!targetClient) {
                logger.warn('Target client not found: sceneId=%d, eventId=%d, targetClientId=%d', 
                    sceneId, eventId, target.targetClientId);
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: 目标Client ${target.targetClientId} 不存在`, 
                    eventId, eventName);
                return;
            }

            // 确定visible值
            let visible: boolean;
            if (target.targetAction === 'on' || target.targetAction === 'show' || target.targetAction === '显示') {
                visible = true;
            } else if (target.targetAction === 'off' || target.targetAction === 'hide' || target.targetAction === '隐藏') {
                visible = false;
            } else if (target.targetAction === 'toggle' || target.targetAction === '切换') {
                // 切换：从ClientConnectionHandler的内存状态获取当前状态，然后取反
                const ClientConnectionHandler = require('./client').ClientConnectionHandler;
                const handler = ClientConnectionHandler.getConnection(target.targetClientId);
                const currentVisible = handler?.getWidgetState(target.targetWidgetName) ?? false;
                visible = !currentVisible;
                logger.info('Toggle widget state: sceneId=%d, eventId=%d, widgetName=%s, currentVisible=%s, newVisible=%s',
                    sceneId, eventId, target.targetWidgetName, currentVisible, visible);
            } else {
                logger.warn('Invalid target action for client widget: sceneId=%d, eventId=%d, action=%s', 
                    sceneId, eventId, target.targetAction);
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: 无效的动作 ${target.targetAction}`, 
                    eventId, eventName);
                return;
            }

            // 通过ClientConnectionHandler发送控制命令
            const ClientConnectionHandler = require('./client').ClientConnectionHandler;
            const handler = ClientConnectionHandler.getConnection(target.targetClientId);
            if (!handler) {
                logger.warn('Target client not connected: sceneId=%d, eventId=%d, targetClientId=%d', 
                    sceneId, eventId, target.targetClientId);
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: 目标Client ${target.targetClientId} 未连接`, 
                    eventId, eventName);
                return;
            }

            const traceId = `scene-event-${sceneId}-${eventId}-${Date.now()}`;
            const controlMessage = {
                protocol: 'ejunz',
                action: 'control',
                payload: {
                    widgetName: target.targetWidgetName,
                    visible: visible
                },
                traceId: traceId,
                direction: 'inbound'
            };

            try {
                // 更新内存中的状态（乐观更新，control/ack会确认）
                handler.setWidgetState(target.targetWidgetName, visible);
                
                handler.send(controlMessage);
                logger.info('Executing client widget control: sceneId=%d, eventId=%d, targetClientId=%d, widgetName=%s, visible=%s',
                    sceneId, eventId, target.targetClientId, target.targetWidgetName, visible);
                addSceneLog(sceneId, 'success', 
                    `触发效果执行成功: Client ${target.targetClientId} 组件 ${target.targetWidgetName} ${visible ? '显示' : '隐藏'}`, 
                    eventId, eventName, { targetClientId: target.targetClientId, targetWidgetName: target.targetWidgetName, visible });
            } catch (error: any) {
                logger.error('Client widget control error: sceneId=%d, eventId=%d, error=%s', 
                    sceneId, eventId, error.message);
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: ${error.message}`, 
                    eventId, eventName);
            }
        } else {
            // Node设备控制（原有逻辑）
            if (!target.targetNodeId || !target.targetDeviceId) {
                logger.warn('Target node/device missing: sceneId=%d, eventId=%d', sceneId, eventId);
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: 目标节点或设备未指定`, 
                    eventId, eventName);
                return;
            }

            const targetNode = await NodeModel.getByNodeId(domainId, target.targetNodeId);
            if (!targetNode) {
                logger.warn('Target node not found: sceneId=%d, eventId=%d, targetNodeId=%d, domainId=%s', 
                    sceneId, eventId, target.targetNodeId, ctx.domain._id);
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: 目标节点 ${target.targetNodeId} 不存在`, 
                    eventId, eventName);
                return;
            }

            if (!targetNode._id) {
                logger.error('Target node missing _id: sceneId=%d, eventId=%d, targetNodeId=%d, node=%O', 
                    sceneId, eventId, target.targetNodeId, targetNode);
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: 目标节点数据无效`, 
                    eventId, eventName);
                return;
            }

            const targetDevice = await NodeDeviceModel.getByDeviceId(targetNode._id, target.targetDeviceId);
            if (!targetDevice) {
                logger.warn('Target device not found: sceneId=%d, eventId=%d, targetDeviceId=%s, nodeId=%s', 
                    sceneId, eventId, target.targetDeviceId, targetNode._id.toString());
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: 目标设备 ${target.targetDeviceId} 不存在`, 
                    eventId, eventName);
                return;
            }

            if (!targetDevice._id) {
                logger.error('Target device missing _id: sceneId=%d, eventId=%d, targetDeviceId=%s, device=%O', 
                    sceneId, eventId, target.targetDeviceId, targetDevice);
                addSceneLog(sceneId, 'error', 
                    `执行触发效果失败: 目标设备数据无效`, 
                    eventId, eventName);
                return;
            }

            // 构建控制命令
            let command: Record<string, any> = {};
            
            if (target.targetAction === 'on' || target.targetAction === '开') {
                command.on = true;
            } else if (target.targetAction === 'off' || target.targetAction === '关') {
                command.on = false;
            } else if (target.targetAction === 'toggle' || target.targetAction === '切换') {
                // 切换：取当前状态的相反值
                const currentState = targetDevice.state?.on ?? false;
                command.on = !currentState;
            } else {
                // 其他动作或自定义值
                if (target.targetValue !== undefined && target.targetValue !== null && target.targetValue !== '') {
                    try {
                        // 尝试解析 JSON
                        const parsed = typeof target.targetValue === 'string' 
                            ? JSON.parse(target.targetValue) 
                            : target.targetValue;
                        command = { ...command, ...parsed };
                    } catch {
                        // 如果不是 JSON，直接使用 targetValue
                        command = { ...command, [target.targetAction]: target.targetValue };
                    }
                } else {
                    command[target.targetAction] = true;
                }
            }

            // 保存变量到局部作用域，确保在回调中可用
            const targetNodeId = targetNode._id;
            const targetDeviceId = targetDevice._id;
            const deviceState = targetDevice.state || {};
            
            // 通过 MQTT 发送控制命令
            await ctx.inject(['mqtt'], async ({ mqtt }) => {
                if (mqtt) {
                    logger.info('Executing target action: sceneId=%d, eventId=%d, targetNode=%s, targetDevice=%s, command=%O',
                        sceneId, eventId, targetNodeId.toString(), target.targetDeviceId, command);
                    
                    try {
                        await (mqtt as any).sendDeviceControlViaMqtt(targetNodeId, target.targetDeviceId, command);
                        
                        // 更新设备状态
                        await NodeDeviceModel.updateState(targetDeviceId, { ...deviceState, ...command });
                        
                        addSceneLog(sceneId, 'success', 
                            `触发效果执行成功: 目标设备 ${target.targetDeviceId} 执行动作 ${target.targetAction}`, 
                            eventId, eventName, { command, targetNodeId: target.targetNodeId, targetDeviceId: target.targetDeviceId });
                    } catch (mqttError: any) {
                        logger.error('MQTT execution error: sceneId=%d, eventId=%d, error=%s', 
                            sceneId, eventId, mqttError.message);
                        addSceneLog(sceneId, 'error', 
                            `执行触发效果失败: ${mqttError.message}`, 
                            eventId, eventName);
                    }
                } else {
                    logger.warn('MQTT service not available for scene event execution');
                    addSceneLog(sceneId, 'error', 
                        `执行触发效果失败: MQTT 服务不可用`, 
                        eventId, eventName);
                }
            });
        }
    } catch (error: any) {
        logger.error('Error executing target action: sceneId=%d, eventId=%d, error=%s', 
            sceneId, eventId, error.message);
        addSceneLog(sceneId, 'error', 
            `执行触发效果失败: ${error.message}`, 
            eventId, eventName);
    }
}

// 执行场景事件（支持多个触发效果）
async function executeSceneEvent(event: any, domainId: string, ctx: Context) {
    try {
        // 验证 targets 数组
        if (!event.targets || !Array.isArray(event.targets) || event.targets.length === 0) {
            logger.warn('No targets found for event: sceneId=%d, eventId=%d', event.sceneId, event.eid);
            addSceneLog(event.sceneId, 'error', 
                `执行事件失败: 未找到触发效果配置`, 
                event.eid, event.name);
            return;
        }

        // 按顺序执行所有触发效果
        const targetsToExecute = event.targets.sort((a: any, b: any) => (a.order || 0) - (b.order || 0));

        // 按顺序执行所有触发效果
        for (const target of targetsToExecute) {
            await executeTargetAction(event.sceneId, event.eid, event.name, target, domainId, ctx);
            // 添加小延迟，避免同时执行多个命令导致的问题
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } catch (error: any) {
        logger.error('Error executing scene event: sceneId=%d, eventId=%d, error=%s', 
            event.sceneId, event.eid, error.message);
        addSceneLog(event.sceneId, 'error', 
            `执行事件失败: ${error.message}`, 
            event.eid, event.name);
    }
}


export async function apply(ctx: Context) {
    // 监听Client组件状态更新事件，执行场景事件
    (ctx.on as any)('client/widget/update', async (clientId: number, widgetName: string, visible: boolean, domainId?: string) => {
        try {
            logger.info('Scene handler received client/widget/update: clientId=%d, widgetName=%s, visible=%s, domainId=%s', 
                clientId, widgetName, visible, domainId || 'not provided');
            
            const ClientModel = require('../model/client').default;
            let client = null;
            let finalDomainId = domainId || 'system';
            
            // 如果提供了domainId，直接使用；否则尝试查找
            if (domainId) {
                client = await ClientModel.getByClientId(domainId, clientId);
            } else {
                // 尝试从system域查找
                client = await ClientModel.getByClientId('system', clientId);
                if (client) {
                    finalDomainId = client.domainId || 'system';
                } else {
                    logger.warn('Client not found: clientId=%d, tried domain=system', clientId);
                    return;
                }
            }
            
            if (!client) {
                logger.warn('Client not found: clientId=%d, domainId=%s', clientId, finalDomainId);
                return;
            }
            
            logger.info('Found client: clientId=%d, domainId=%s', clientId, finalDomainId);
            
            const enabledScene = await SceneModel.getEnabled(finalDomainId);
            if (!enabledScene) {
                logger.info('No enabled scene found for domain: %s', finalDomainId);
                return;
            }
            
            logger.info('Found enabled scene: sceneId=%d', enabledScene.sid);

            const events = await SceneEventModel.getBySceneId(finalDomainId, enabledScene.sid);
            const enabledEvents = events.filter(e => e.enabled);
            
            logger.info('Checking %d enabled events for clientId=%d, widgetName=%s', 
                enabledEvents.length, clientId, widgetName);

            for (const event of enabledEvents) {
                if (event.sourceClientId === undefined || event.sourceClientId === null) {
                    continue;
                }
                
                logger.info('Checking event %d: sourceClientId=%d, sourceWidgetName=%s', 
                    event.eid, event.sourceClientId, event.sourceWidgetName);
                
                if (event.sourceClientId !== clientId) {
                    logger.info('Event %d: clientId mismatch (expected %d, got %d)', 
                        event.eid, event.sourceClientId, clientId);
                    continue;
                }

                if (event.sourceWidgetName !== widgetName) {
                    logger.info('Event %d: widgetName mismatch (expected %s, got %s)', 
                        event.eid, event.sourceWidgetName, widgetName);
                    continue;
                }
                
                logger.info('Event %d: matched clientId and widgetName, checking action condition', event.eid);

                // 检查动作是否匹配事件条件
                let shouldTrigger = false;
                
                if (!event.sourceAction) {
                    shouldTrigger = true;
                } else {
                    const sourceAction = event.sourceAction.toLowerCase();
                    
                    if (sourceAction === 'on' || sourceAction === 'show' || sourceAction === '显示') {
                        shouldTrigger = visible === true;
                    } else if (sourceAction === 'off' || sourceAction === 'hide' || sourceAction === '隐藏') {
                        shouldTrigger = visible === false;
                    } else if (sourceAction === 'toggle' || sourceAction === '切换') {
                        // 切换：任何状态变化都触发
                        shouldTrigger = true;
                    } else {
                        shouldTrigger = true;
                    }
                }

                if (shouldTrigger) {
                    // 检查触发次数限制
                    const triggerLimit = event.triggerLimit;
                    if (triggerLimit !== undefined && triggerLimit !== null && triggerLimit !== 0) {
                        const countKey = `${event.sceneId}_${event.eid}`;
                        const countEntry = eventTriggerCountCache.get(countKey);
                        const currentCount = countEntry ? countEntry.count : 0;
                        
                        if (triggerLimit > 0 && currentCount >= triggerLimit) {
                            logger.debug('Event %d skipped due to trigger limit: current=%d, limit=%d', 
                                event.eid, currentCount, triggerLimit);
                            continue;
                        }
                        
                        // 更新触发次数
                        if (!countEntry) {
                            eventTriggerCountCache.set(countKey, {
                                sceneId: event.sceneId,
                                eventId: event.eid,
                                count: 1,
                                firstTriggerTime: Date.now(),
                            });
                        } else {
                            countEntry.count = currentCount + 1;
                        }
                    }
                    
                    logger.info('Triggering scene event: sceneId=%d, eventId=%d, eventName=%s, clientId=%d, widgetName=%s, visible=%s, triggerLimit=%o, triggerDelay=%o',
                        enabledScene.sid, event.eid, event.name, clientId, widgetName, visible, triggerLimit, event.triggerDelay);
                    addSceneLog(enabledScene.sid, 'info', 
                        `事件触发: 监听源Client ${clientId} 组件 ${widgetName} 状态变化 (${visible ? '显示' : '隐藏'})`, 
                        event.eid, event.name, {
                            sourceClientId: clientId,
                            sourceWidgetName: widgetName,
                            visible: visible
                        });
                    
                    // 延时触发
                    const triggerDelay = event.triggerDelay || 0;
                    if (triggerDelay > 0) {
                        logger.debug('Event %d will be executed after %d ms delay', event.eid, triggerDelay);
                        setTimeout(async () => {
                            await executeSceneEvent(event, finalDomainId, ctx);
                        }, triggerDelay);
                    } else {
                        await executeSceneEvent(event, finalDomainId, ctx);
                    }
                }
            }
        } catch (error: any) {
            logger.error('Error handling client widget update: clientId=%d, widgetName=%s, error=%s', 
                clientId, widgetName, error.message);
        }
    });

    // 监听设备状态更新事件，执行场景事件
    (ctx.on as any)('node/device/update', async (nodeId: ObjectId, deviceId: string, newState: Record<string, any>) => {
        try {
            const node = await NodeModel.get(nodeId);
            if (!node) {
                return;
            }

            const domainId = node.domainId;
            
            const enabledScene = await SceneModel.getEnabled(domainId);
            if (!enabledScene) {
                return;
            }

            const events = await SceneEventModel.getBySceneId(domainId, enabledScene.sid);
            const enabledEvents = events.filter(e => e.enabled);
            
            for (const event of enabledEvents) {
                if (!event.targets || !Array.isArray(event.targets) || event.targets.length === 0) {
                    logger.warn('Event %d (sceneId=%d) has no valid targets array: %O', 
                        event.eid, enabledScene.sid, event);
                }
            }

            for (const event of enabledEvents) {
                if (event.sourceClientId !== undefined && event.sourceClientId !== null) {
                    continue;
                }
                
                if (event.sourceNodeId !== node.nid) {
                    continue;
                }

                const deviceIdMatches = event.sourceDeviceId === deviceId || 
                    deviceId.startsWith(event.sourceDeviceId) || 
                    event.sourceDeviceId.startsWith(deviceId);
                
                if (!deviceIdMatches) {
                    continue;
                }

                // 检查状态是否匹配事件条件
                let shouldTrigger = false;
                
                if (!event.sourceAction) {
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
                    
                    if (!shouldTriggerEvent(enabledScene.sid, event.eid, node.nid, deviceId, stateHash)) {
                        continue;
                    }
                    
                    // 检查触发次数限制
                    const triggerLimit = event.triggerLimit;
                    if (triggerLimit !== undefined && triggerLimit !== null && triggerLimit !== 0) {
                        const countKey = `${event.sceneId}_${event.eid}`;
                        const countEntry = eventTriggerCountCache.get(countKey);
                        const currentCount = countEntry ? countEntry.count : 0;
                        
                        if (triggerLimit > 0 && currentCount >= triggerLimit) {
                            logger.debug('Event %d skipped due to trigger limit: current=%d, limit=%d', 
                                event.eid, currentCount, triggerLimit);
                            continue;
                        }
                        
                        // 更新触发次数
                        if (!countEntry) {
                            eventTriggerCountCache.set(countKey, {
                                sceneId: event.sceneId,
                                eventId: event.eid,
                                count: 1,
                                firstTriggerTime: Date.now(),
                            });
                        } else {
                            countEntry.count = currentCount + 1;
                        }
                    }
                    
                    logger.info('Scene event triggered: sceneId=%d, eventId=%d, sourceNode=%d, sourceDevice=%s (matched %s), newState=%O, triggerLimit=%o, triggerDelay=%o',
                        enabledScene.sid, event.eid, node.nid, deviceId, event.sourceDeviceId, newState, triggerLimit, event.triggerDelay);
                    
                    addSceneLog(enabledScene.sid, 'info', 
                        `事件触发: 监听源设备 ${deviceId} (匹配 ${event.sourceDeviceId}) 状态变化 (${event.sourceAction || 'any'})`, 
                        event.eid, event.name, { 
                            sourceNodeId: node.nid, 
                            sourceDeviceId: deviceId,
                            matchedDeviceId: event.sourceDeviceId,
                            newState,
                            sourceAction: event.sourceAction
                        });

                    // 延时触发
                    const triggerDelay = event.triggerDelay || 0;
                    if (triggerDelay > 0) {
                        logger.debug('Event %d will be executed after %d ms delay', event.eid, triggerDelay);
                        setTimeout(async () => {
                            await executeSceneEvent(event, domainId, ctx);
                        }, triggerDelay);
                    } else {
                        await executeSceneEvent(event, domainId, ctx);
                    }
                }
            }
        } catch (error) {
            logger.error('Error handling device update event for scene trigger: %s', (error as Error).message);
            logger.error('Error stack: %s', (error as Error).stack);
        }
    });
    
    // 监听GSI数据更新事件，执行场景事件
    (ctx.on as any)('client/gsi/update', async (clientId: number, gsiData: any, timestamp: number, domainId?: string) => {
        try {
            logger.info('Scene handler received client/gsi/update: clientId=%d, domainId=%s', 
                clientId, domainId || 'not provided');
            
            const ClientModel = require('../model/client').default;
            let client = null;
            let finalDomainId = domainId || 'system';
            
            if (domainId) {
                client = await ClientModel.getByClientId(domainId, clientId);
            } else {
                client = await ClientModel.getByClientId('system', clientId);
                if (client) {
                    finalDomainId = client.domainId || 'system';
                } else {
                    logger.warn('Client not found: clientId=%d, tried domain=system', clientId);
                    return;
                }
            }
            
            if (!client) {
                logger.warn('Client not found: clientId=%d, domainId=%s', clientId, finalDomainId);
                return;
            }
            
            const enabledScene = await SceneModel.getEnabled(finalDomainId);
            if (!enabledScene) {
                logger.info('No enabled scene found for domain: %s', finalDomainId);
                return;
            }
            
            const events = await SceneEventModel.getBySceneId(finalDomainId, enabledScene.sid);
            const enabledEvents = events.filter(e => e.enabled);
            
            logger.info('Checking %d enabled events for GSI data: clientId=%d', 
                enabledEvents.length, clientId);
            
            for (const event of enabledEvents) {
                // 只处理GSI数据源的事件
                if (!event.sourceGsiPath || event.sourceClientId !== clientId) {
                    logger.debug('Event %d skipped: sourceGsiPath=%s, sourceClientId=%d, clientId=%d', 
                        event.eid, event.sourceGsiPath, event.sourceClientId, clientId);
                    continue;
                }
                
                // 获取实际值用于调试和去重
                const actualValue = getValueByPath(gsiData, event.sourceGsiPath);
                logger.debug('Checking event %d: path=%s, actualValue=%o, expectedValue=%o, operator=%s', 
                    event.eid, event.sourceGsiPath, actualValue, event.sourceGsiValue, event.sourceGsiOperator || 'eq');
                
                // 检查GSI条件是否满足
                const conditionMet = checkGsiCondition(
                    gsiData,
                    event.sourceGsiPath,
                    event.sourceGsiOperator || 'eq',
                    event.sourceGsiValue
                );
                
                logger.debug('Event %d condition check result: %s', event.eid, conditionMet);
                
                if (!conditionMet) {
                    // 条件不满足时，更新上一次的值（用于string类型的值变化检测）
                    const changeKey = `${event.sceneId}_${event.eid}_${clientId}_${event.sourceGsiPath}`;
                    gsiValueChangeCache.set(changeKey, {
                        sceneId: event.sceneId,
                        eventId: event.eid,
                        sourceClientId: clientId,
                        sourceGsiPath: event.sourceGsiPath,
                        lastValue: actualValue,
                        timestamp: Date.now(),
                    });
                    continue;
                }
                
                // 对于string类型的GSI值，检查值是否发生变化（从非目标值变成目标值）
                const isStringValue = typeof event.sourceGsiValue === 'string' && typeof actualValue === 'string';
                let shouldSkipStringValueCheck = false;
                
                if (isStringValue) {
                    const changeKey = `${event.sceneId}_${event.eid}_${clientId}_${event.sourceGsiPath}`;
                    const lastEntry = gsiValueChangeCache.get(changeKey);
                    
                    if (lastEntry) {
                        // 如果上一次的值也是目标值，说明值没有变化，不触发
                        // 直接比较上一次的值和目标值
                        const lastValueMatches = (event.sourceGsiOperator || 'eq').toLowerCase() === 'eq' 
                            ? lastEntry.lastValue == event.sourceGsiValue
                            : checkGsiCondition(
                                { [event.sourceGsiPath]: lastEntry.lastValue },
                                event.sourceGsiPath,
                                event.sourceGsiOperator || 'eq',
                                event.sourceGsiValue
                            );
                        
                        if (lastValueMatches) {
                            logger.debug('Event %d skipped: string value unchanged (lastValue=%o, currentValue=%o, both match target=%o)', 
                                event.eid, lastEntry.lastValue, actualValue, event.sourceGsiValue);
                            // 更新缓存中的值（即使不触发也要更新，以便下次比较）
                            lastEntry.lastValue = actualValue;
                            lastEntry.timestamp = Date.now();
                            shouldSkipStringValueCheck = true;
                        } else {
                            // 如果上一次的值不是目标值，现在变成目标值了，应该触发
                            logger.debug('Event %d will trigger: string value changed from %o to %o (target=%o)', 
                                event.eid, lastEntry.lastValue, actualValue, event.sourceGsiValue);
                        }
                    } else {
                        // 第一次检测到string类型值匹配，应该触发
                        logger.debug('Event %d will trigger: string value first time match (currentValue=%o, target=%o)', 
                            event.eid, actualValue, event.sourceGsiValue);
                    }
                    
                    if (shouldSkipStringValueCheck) {
                        continue;
                    }
                    
                    // 更新缓存
                    gsiValueChangeCache.set(changeKey, {
                        sceneId: event.sceneId,
                        eventId: event.eid,
                        sourceClientId: clientId,
                        sourceGsiPath: event.sourceGsiPath,
                        lastValue: actualValue,
                        timestamp: Date.now(),
                    });
                }
                
                // 生成值哈希用于去重（非string类型或string类型但值已变化）
                const valueHash = JSON.stringify(actualValue);
                
                // 对于string类型，如果已经通过值变化检测，使用包含时间戳的唯一哈希以确保能触发
                // 对于非string类型，使用标准去重逻辑
                const finalValueHash = isStringValue ? `${valueHash}_${Date.now()}` : valueHash;
                
                // 检查是否应该触发（去重）
                if (!shouldTriggerGsiEvent(
                    event.sceneId,
                    event.eid,
                    clientId,
                    event.sourceGsiPath,
                    finalValueHash
                )) {
                    logger.debug('Event %d skipped by shouldTriggerGsiEvent', event.eid);
                    continue;
                }
                
                // 检查触发次数限制
                const triggerLimit = event.triggerLimit;
                if (triggerLimit !== undefined && triggerLimit !== null && triggerLimit !== 0) {
                    const countKey = `${event.sceneId}_${event.eid}`;
                    const countEntry = eventTriggerCountCache.get(countKey);
                    const currentCount = countEntry ? countEntry.count : 0;
                    
                    if (triggerLimit > 0 && currentCount >= triggerLimit) {
                        logger.debug('Event %d skipped due to trigger limit: current=%d, limit=%d', 
                            event.eid, currentCount, triggerLimit);
                        continue;
                    }
                    
                    // 更新触发次数
                    if (!countEntry) {
                        eventTriggerCountCache.set(countKey, {
                            sceneId: event.sceneId,
                            eventId: event.eid,
                            count: 1,
                            firstTriggerTime: Date.now(),
                        });
                    } else {
                        countEntry.count = currentCount + 1;
                    }
                }
                
                logger.info('GSI condition met, executing scene event: sceneId=%d, eventId=%d, eventName=%s, gsiPath=%s, value=%o, triggerLimit=%o, triggerDelay=%o',
                    event.sceneId, event.eid, event.name, event.sourceGsiPath, actualValue, triggerLimit, event.triggerDelay);
                
                addSceneLog(event.sceneId, 'info',
                    `GSI数据触发: ${event.sourceGsiPath} = ${JSON.stringify(actualValue)}`,
                    event.eid, event.name, { 
                        sourceGsiPath: event.sourceGsiPath,
                        actualValue: actualValue,
                        operator: event.sourceGsiOperator,
                        expectedValue: event.sourceGsiValue
                    });
                
                // 延时触发
                const triggerDelay = event.triggerDelay || 0;
                if (triggerDelay > 0) {
                    logger.debug('Event %d will be executed after %d ms delay', event.eid, triggerDelay);
                    setTimeout(async () => {
                        await executeSceneEvent(event, finalDomainId, ctx);
                    }, triggerDelay);
                } else {
                    await executeSceneEvent(event, finalDomainId, ctx);
                }
            }
        } catch (error: any) {
            logger.error('Error handling GSI update: %s', error.message);
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


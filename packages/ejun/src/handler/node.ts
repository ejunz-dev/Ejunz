import { ObjectId } from 'mongodb';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from '../context';
import { ValidationError, PermissionError, NotFoundError } from '../error';
import { Logger } from '../logger';
import NodeModel, { NodeDeviceModel } from '../model/node';
import EdgeTokenModel from '../model/edge_token';
import { PRIV } from '../model/builtin';

const logger = new Logger('handler/node');

// 获取节点列表
export class NodeDomainHandler extends Handler<Context> {
    async get() {
        const { page = 1 } = this.request.query;
        const nodes = await NodeModel.getByDomain(this.domain._id);
        // 按 nodeId 排序
        nodes.sort((a, b) => (a.nodeId || 0) - (b.nodeId || 0));
        this.response.template = 'node_domain.html';
        this.response.body = { nodes, domainId: this.domain._id };
    }
}

// 创建/编辑节点
export class NodeEditHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nodeId } = this.request.params;
        
        let node = null;
        if (nodeId) {
            const nodeIdNum = parseInt(nodeId, 10);
            if (!isNaN(nodeIdNum) && nodeIdNum >= 1) {
                node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
                if (node) {
                    // 检查权限
                    if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
                        throw new PermissionError(PRIV.PRIV_USER_PROFILE);
                    }
                }
            }
        }

        this.response.template = 'node_edit.html';
        this.response.body = { node };
    }

    async postCreate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { name, description } = this.request.body;
        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }

        const node = await NodeModel.add({
            domainId: this.domain._id,
            name,
            description,
            owner: this.user._id,
        });

        this.response.redirect = `/node/${node.nodeId}`;
    }

    async postUpdate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nodeId } = this.request.params;
        const { name, description } = this.request.body;
        
        const nodeIdNum = parseInt(nodeId, 10);
        if (isNaN(nodeIdNum) || nodeIdNum < 1) {
            throw new ValidationError('nodeId');
        }

        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
        if (!node) {
            throw new ValidationError('nodeId');
        }

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await NodeModel.update(this.domain._id, nodeIdNum, { name, description });
        this.response.redirect = `/node/${nodeIdNum}`;
    }
}

// 获取节点详情
export class NodeDetailHandler extends Handler<Context> {
    async get() {
        const { nodeId } = this.request.params;
        
        // 如果 nodeId 包含点号（如 .css.map），说明是静态资源，不应该匹配这个路由
        // 框架应该先处理静态资源，但如果到达这里，说明是无效的 nodeId
        if (nodeId && (nodeId.includes('.') || !/^\d+$/.test(nodeId))) {
            // 返回 404，让静态资源处理器处理
            throw new NotFoundError(nodeId);
        }
        
        const nodeIdNum = parseInt(nodeId, 10);
        if (isNaN(nodeIdNum) || nodeIdNum < 1) {
            throw new ValidationError('nodeId');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
        if (!node) {
            throw new ValidationError('nodeId');
        }

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const devices = await NodeDeviceModel.getByNode(node._id);
        
        // 调试：记录设备状态
        logger.debug('Device states for node %s: %O', node._id, devices.map(d => ({ 
            deviceId: d.deviceId, 
            state: d.state,
            hasOn: d.state?.on !== undefined,
            hasState: d.state?.state !== undefined,
        })));
        
        // 生成连接信息（如果已生成接入点）
        let connectionInfo = null;
        if (node.wsEndpoint) {
            const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
            const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
            const host = this.request.host;
            const mqttTcpHost = host.split(':')[0];
            const mqttTcpPort = parseInt(process.env.MQTT_PORT || '1883', 10);
            
            // 从 host 中提取端口，如果没有则使用默认端口
            const hostParts = host.split(':');
            let wsPort: number | string = '';
            if (hostParts.length > 1) {
                wsPort = hostParts[1];
            } else {
                // 如果没有端口，根据协议使用默认端口
                wsPort = protocol === 'https' ? 443 : 80;
            }
            
            connectionInfo = {
                clientWsUrl: `${wsProtocol}://${host}/node/client/ws?domainId=${node.domainId}&nodeId=${node.nodeId}`,
                mqtt: {
                    wsUrl: `${wsProtocol}://${host}/mqtt/ws`,
                    wsHost: mqttTcpHost,
                    wsPort: wsPort,
                    tcpUrl: `mqtt://${mqttTcpHost}:${mqttTcpPort}`,
                    tcpHost: mqttTcpHost,
                    tcpPort: mqttTcpPort,
                    username: `${node.domainId}:${node.nodeId}`,
                    password: `${node.domainId}:${node.nodeId}`,
                },
            };
        }
        
        // 将节点数据传递给前端，用于 MQTT 连接
        const nodeData = {
            nodeId: node.nodeId,
            domainId: node.domainId,
            connectionInfo,
        };
        
        // 将 nodeData 序列化为 JSON 字符串，方便前端直接使用
        const nodeDataJson = JSON.stringify(nodeData);
        
        this.response.template = 'node_detail.html';
        this.response.body = { node, devices, connectionInfo, domainId: this.domain._id, nodeData, nodeDataJson };
    }

    async postGenerateEndpoint() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nodeId } = this.request.params;
        const nodeIdNum = parseInt(nodeId, 10);
        if (isNaN(nodeIdNum) || nodeIdNum < 1) {
            throw new ValidationError('nodeId');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
        if (!node) {
            throw new ValidationError('nodeId');
        }

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 生成接入点
        const wsEndpoint = `/node/ws/${node.domainId}/${node.nodeId}`;
        await NodeModel.update(node.domainId, node.nodeId, { wsEndpoint });

        const updatedNode = await NodeModel.getByNodeId(node.domainId, node.nodeId);
        const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
        const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
        const host = this.request.host;
        const mqttTcpHost = host.split(':')[0];
        const mqttTcpPort = parseInt(process.env.MQTT_PORT || '1883', 10);
        
        // 从 host 中提取端口，如果没有则使用默认端口
        const hostParts = host.split(':');
        let wsPort: number | string = '';
        if (hostParts.length > 1) {
            wsPort = hostParts[1];
        } else {
            // 如果没有端口，根据协议使用默认端口
            wsPort = protocol === 'https' ? 443 : 80;
        }

        this.response.body = {
            connectionInfo: {
                clientWsUrl: `${wsProtocol}://${host}/node/client/ws?domainId=${node.domainId}&nodeId=${node.nodeId}`,
                mqtt: {
                    wsUrl: `${wsProtocol}://${host}/mqtt/ws`,
                    wsHost: mqttTcpHost,
                    wsPort: wsPort,
                    tcpUrl: `mqtt://${mqttTcpHost}:${mqttTcpPort}`,
                    tcpHost: mqttTcpHost,
                    tcpPort: mqttTcpPort,
                    username: `${node.domainId}:${node.nodeId}`,
                    password: `${node.domainId}:${node.nodeId}`,
                },
            },
        };
    }

    async postDeleteEndpoint() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nodeId } = this.request.params;
        const nodeIdNum = parseInt(nodeId, 10);
        if (isNaN(nodeIdNum) || nodeIdNum < 1) {
            throw new ValidationError('nodeId');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
        if (!node) {
            throw new ValidationError('nodeId');
        }

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 删除接入点
        await NodeModel.update(node.domainId, node.nodeId, { wsEndpoint: null });
        this.response.body = { success: true };
    }
}

// 删除节点
export class NodeDeleteHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nodeId } = this.request.body;
        const nodeIdNum = parseInt(nodeId, 10);
        if (isNaN(nodeIdNum) || nodeIdNum < 1) {
            throw new ValidationError('nodeId');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
        if (!node) {
            throw new ValidationError('nodeId');
        }

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await NodeModel.del(node.domainId, node.nodeId);
        this.response.body = { ok: 1 };
    }
}


// 获取设备列表
export class NodeDeviceListHandler extends Handler<Context> {
    async get() {
        const { nodeId } = this.request.params;
        const nodeIdNum = parseInt(nodeId, 10);
        if (isNaN(nodeIdNum) || nodeIdNum < 1) {
            throw new ValidationError('nodeId');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
        if (!node) {
            throw new ValidationError('nodeId');
        }

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const devices = await NodeDeviceModel.getByNode(node._id);
        this.response.body = { devices };
    }
}

// 控制设备
export class NodeDeviceControlHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nodeId, deviceId, command } = this.request.body;
        
        logger.info('Device control request: nodeId=%s, deviceId=%s, command=%O', nodeId, deviceId, command);
        
        const nodeIdNum = parseInt(nodeId, 10);
        if (isNaN(nodeIdNum) || nodeIdNum < 1) {
            logger.warn('Invalid nodeId: %s', nodeId);
            throw new ValidationError('nodeId');
        }
        if (!deviceId || typeof deviceId !== 'string') {
            logger.warn('Invalid deviceId: %s', deviceId);
            throw new ValidationError('deviceId');
        }
        if (!command || typeof command !== 'object') {
            logger.warn('Invalid command: %O', command);
            throw new ValidationError('command');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
        if (!node) {
            logger.warn('Node not found: domainId=%s, nodeId=%s', this.domain._id, nodeIdNum);
            throw new ValidationError('nodeId');
        }

        // 通过本地 MQTT broker 发送设备控制指令
        // Node 端需要订阅 node/{nodeId}/devices/+/set 来接收控制命令
        try {
            await this.ctx.inject(['mqtt'], async ({ mqtt }) => {
                if (mqtt) {
                    logger.info('Sending device control via local MQTT broker: nodeId=%s, deviceId=%s, command=%O', node._id, deviceId, command);
                    // 只通过本地 MQTT broker 发送控制指令
                    await mqtt.sendDeviceControlViaMqtt(node._id, deviceId, command);
                    logger.info('Device control command sent successfully via MQTT');
                } else {
                    logger.warn('MQTT service not available');
                    throw new Error('MQTT service not available');
                }
            });
        } catch (error) {
            logger.error('Failed to send device control: %s', (error as Error).message);
            logger.error('Error stack: %s', (error as Error).stack);
            throw error;
        }

        this.response.body = { ok: 1 };
    }
}

// WebSocket 连接处理器，用于实时更新
export class NodeConnectionHandler extends ConnectionHandler<Context> {
    private nodeId: ObjectId | null = null;
    private subscriptions: Array<{ dispose: () => void }> = [];

    async prepare() {
        const { nodeId } = this.request.query;
        const nodeIdNum = parseInt(nodeId as string, 10);
        if (isNaN(nodeIdNum) || nodeIdNum < 1) {
            this.close(1000, 'Invalid nodeId');
            return;
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
        if (!node) {
            this.close(1000, 'Node not found');
            return;
        }

        this.nodeId = node._id;

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            this.close(1000, 'Permission denied');
            return;
        }

        logger.info('Node WebSocket connected: %s', this.nodeId);

        // 发送初始数据
        const devices = await NodeDeviceModel.getByNode(this.nodeId);
        this.send({ type: 'init', node, devices });

        // 订阅设备状态更新和 node 状态更新
        const dispose1 = this.ctx.on('node/device/update' as any, async (...args: any[]) => {
            const [updateNodeId, deviceId, state] = args;
            if (updateNodeId.toString() === this.nodeId!.toString()) {
                // 获取完整的设备信息，确保包含完整的状态
                const device = await NodeDeviceModel.getByDeviceId(this.nodeId!, deviceId);
                if (device) {
                    // 发送完整的状态（合并更新后的状态和设备的完整状态）
                    const fullState = { ...device.state, ...state };
                    this.send({ type: 'device/update', deviceId, state: fullState });
                }
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        const dispose2 = this.ctx.on('node/status/update' as any, async (...args: any[]) => {
            const [updateNodeId, status] = args;
            if (updateNodeId.toString() === this.nodeId!.toString()) {
                const node = await NodeModel.get(this.nodeId!);
                if (node) {
                    this.send({ type: 'node/status', status, node });
                }
            }
        });
        this.subscriptions.push({ dispose: dispose2 });

        const dispose3 = this.ctx.on('node/devices/update' as any, async (...args: any[]) => {
            const [updateNodeId] = args;
            if (updateNodeId.toString() === this.nodeId!.toString()) {
                const devices = await NodeDeviceModel.getByNode(this.nodeId!);
                this.send({ type: 'devices', devices });
            }
        });
        this.subscriptions.push({ dispose: dispose3 });
    }

    async message(msg: any) {
        if (!this.nodeId) return;

        if (msg && typeof msg === 'object') {
            const { type } = msg;
            switch (type) {
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'refresh':
                {
                    const devices = await NodeDeviceModel.getByNode(this.nodeId);
                    this.send({ type: 'devices', devices });
                }
                break;
            default:
                logger.debug('Unknown message type: %s', type);
            }
        }
    }

    async cleanup() {
        for (const sub of this.subscriptions) {
            try {
                sub.dispose?.();
            } catch {
                // ignore
            }
        }
        this.subscriptions = [];
        if (this.nodeId) {
            logger.info('Node WebSocket disconnected: %s', this.nodeId);
        }
    }
}

// 外部 Node 客户端连接处理器（用于 node 客户端连接）
export class NodeClientConnectionHandler extends ConnectionHandler<Context> {
    private nodeId: ObjectId | null = null;
    private nodeDoc: any = null;

    async prepare() {
        const { token } = this.request.query;
        
        if (!token || typeof token !== 'string') {
            this.close(4000, 'Token is required');
            return;
        }

        // 使用统一的 token 验证
        const tokenDoc = await EdgeTokenModel.getByToken(token);
        if (!tokenDoc || tokenDoc.type !== 'node' || tokenDoc.domainId !== this.domain._id) {
            logger.warn('Node WebSocket connection rejected: Invalid token');
            this.close(4000, 'Invalid token');
            return;
        }

        // 更新 token 最后使用时间
        await EdgeTokenModel.updateLastUsed(token);

        // 查找第一个可用的 node（或者根据 token 关联的 nodeId，这里简化处理）
        const nodes = await NodeModel.getByDomain(this.domain._id);
        const node = nodes[0]; // 简化：使用第一个 node，实际可以根据 token 关联
        
        if (!node) {
            logger.warn('Node WebSocket connection rejected: No node found');
            this.close(4000, 'No node found');
            return;
        }

        this.nodeId = node._id;
        this.nodeDoc = node;

        // 更新 node 状态为 active
        await NodeModel.update(node.domainId, node.nodeId, { status: 'active' });

        // 注册到 MQTT 服务
        try {
            await this.ctx.inject(['mqtt'], ({ mqtt }) => {
                if (mqtt) {
                    mqtt.registerNodeConnection(node._id, this);
                }
            });
        } catch (error) {
            // MQTT 服务可能未初始化，忽略错误
            logger.debug('MQTT service not available for node connection');
        }

        logger.info('Node client connected: %s (node: %s)', this.request.ip, node._id);
        this.send({ type: 'connected', nodeId: node._id.toString() });

        // 通知前端 node 状态更新
        (this.ctx.emit as any)('node/status/update', node._id, 'active');
    }

    async message(msg: any) {
        if (!this.nodeId || !msg || typeof msg !== 'object') return;

        const { type } = msg;

        switch (type) {
        case 'init': {
            // 处理初始化消息：{ type: 'init', nodeId, host, port }
            const { nodeId: clientNodeId, host, port } = msg;
            try {
                // 更新 node 信息
                const update: any = { status: 'active' };
                if (host) update.host = host;
                if (port) update.port = port;
                // 需要通过 nodeId 找到对应的 domainId
                const node = await NodeModel.getByNodeId(this.nodeDoc.domainId, this.nodeDoc.nodeId);
                if (node) {
                    await NodeModel.update(node.domainId, node.nodeId, update);
                }

                logger.info('Node initialized: %s, host: %s, port: %s', this.nodeId, host, port);
                this.send({ type: 'init', ok: 1 });
            } catch (error) {
                logger.error('Failed to initialize node: %s', (error as Error).message);
                this.send({ type: 'error', error: (error as Error).message });
            }
            break;
        }
        case 'devices/discover': {
            // 处理设备发现：{ type: 'devices/discover', devices: [...] }
            const { devices } = msg;
            if (Array.isArray(devices)) {
                try {
                    for (const device of devices) {
                        await NodeDeviceModel.upsertByDeviceId(
                            this.nodeId,
                            device.id || device.deviceId,
                            {
                                domainId: this.nodeDoc.domainId, // 确保包含 domainId
                                name: device.name || device.id,
                                type: device.type || 'unknown',
                                manufacturer: device.manufacturer,
                                model: device.model,
                                state: device.state || {},
                                capabilities: device.capabilities || [],
                            },
                        );
                    }
                    logger.info('Discovered %d devices for node %s', devices.length, this.nodeId);
                    this.send({ type: 'devices/discover', ok: 1 });
                    // 通知前端设备更新
                    (this.ctx.emit as any)('node/devices/update', this.nodeId);
                } catch (error) {
                    logger.error('Failed to discover devices: %s', (error as Error).message);
                    this.send({ type: 'error', error: (error as Error).message });
                }
            }
            break;
        }
        case 'device/state': {
            // 处理设备状态更新：{ type: 'device/state', deviceId, state }
            const { deviceId, state } = msg;
            if (deviceId && state) {
                try {
                    let device = await NodeDeviceModel.getByDeviceId(this.nodeId, deviceId);
                    if (!device) {
                        // 如果设备不存在，自动创建
                        device = await NodeDeviceModel.add({
                            nodeId: this.nodeId,
                            domainId: this.nodeDoc.domainId,
                            deviceId,
                            name: deviceId,
                            type: 'unknown',
                            state,
                            capabilities: [],
                        });
                        logger.info('Auto-registered device %s for node %s via WebSocket', deviceId, this.nodeId);
                    } else {
                        await NodeDeviceModel.updateState(device._id, state);
                    }
                    logger.debug('Updated state for device %s', deviceId);
                    // 通知前端设备状态更新
                    (this.ctx.emit as any)('node/device/update', this.nodeId, deviceId, state);
                } catch (error) {
                    logger.error('Failed to update device state: %s', (error as Error).message);
                }
            }
            break;
        }
        case 'device-control': {
            // 处理设备控制指令：{ type: 'device-control', deviceId, payload }
            const { deviceId, payload } = msg;
            if (deviceId && payload) {
                logger.info('Received device control command: deviceId=%s, payload=%O', deviceId, payload);
                // 这里应该将控制指令转发给实际的设备
                // 注意：这个 handler 是 node 客户端连接，它应该将控制指令发送给设备
                // 目前只是记录日志，实际的控制逻辑应该在 node 客户端实现
                this.send({ type: 'device-control', deviceId, payload, ok: 1 });
                logger.info('Device control command forwarded to node client: deviceId=%s', deviceId);
            } else {
                logger.warn('Invalid device-control message: missing deviceId or payload');
                this.send({ type: 'error', error: 'Invalid device-control message' });
            }
            break;
        }
        case 'pong':
            // 心跳响应
            break;
        default:
            logger.debug('Unknown message type from node: %s', type);
        }
    }

    async cleanup() {
        if (this.nodeId) {
            // 更新 node 状态为 disconnected
            if (this.nodeDoc) {
                await NodeModel.update(this.nodeDoc.domainId, this.nodeDoc.nodeId, { status: 'disconnected' });
            }

            // 取消注册
            try {
                await this.ctx.inject(['mqtt'], ({ mqtt }) => {
                    if (mqtt) {
                        mqtt.unregisterNodeConnection(this.nodeId);
                    }
                });
            } catch (error) {
                // MQTT 服务可能未初始化，忽略错误
                logger.debug('MQTT service not available for node disconnection');
            }

            // 通知前端 node 状态更新
            (this.ctx.emit as any)('node/status/update', this.nodeId, 'disconnected');

            logger.info('Node client disconnected: %s', this.nodeId);
        }
    }
}

// MQTT over WebSocket connection handler
export class NodeMqttConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;
    active = true; // Prevent framework heartbeat from closing MQTT connection

    async prepare() {
        logger.info('=== MQTT WebSocket connection attempt ===');
        logger.info('Request path: %s', this.request.path);
        logger.info('Request headers: %O', this.request.headers);
        logger.info('Connection object: %s', this.conn?.constructor?.name || 'unknown');
        
        try {
            await this.ctx.inject(['mqtt'], ({ mqtt }) => {
                if (mqtt && mqtt.broker) {
                    const ws = this.conn as any;
                    const req = (this.context as any)?.req 
                        || (this.context as any)?.request?.req 
                        || this.request as any;
                    
                    logger.info('MQTT WebSocket connection via handler: %s', req?.url || 'unknown');
                    logger.debug('WebSocket object type: %s, readyState: %s, has on: %s', 
                        ws?.constructor?.name, ws?.readyState, typeof ws?.on);
                    logger.debug('Request object: %s, has headers: %s', 
                        req?.constructor?.name, !!req?.headers);
                    
                    if (!ws || typeof ws.on !== 'function') {
                        logger.error('Invalid WebSocket object for MQTT broker');
                        this.close(500, 'Invalid WebSocket connection');
                        return;
                    }
                    
                    try {
                        if (!req || !req.headers) {
                            logger.error('Invalid request object for MQTT broker');
                            this.close(500, 'Invalid request');
                            return;
                        }
                        
                        // Wrap WebSocket as stream for Aedes broker
                        const stream = mqtt.createWebSocketStream(ws, req);
                        mqtt.broker.handle(stream, req);
                        logger.info('MQTT WebSocket connection passed to broker via handler (with stream adapter)');
                    } catch (error) {
                        logger.error('Error passing WebSocket to broker: %s', (error as Error).message);
                        logger.error('Error stack: %s', (error as Error).stack);
                        ws.close(1011, 'Internal error');
                    }
                } else {
                    logger.warn('MQTT service not available');
                    this.close(503, 'MQTT service unavailable');
                }
            });
            
            // Replace framework message handler: MQTT uses binary messages, not JSON
            // Framework heartbeat (ping/pong) still works, but MQTT messages are handled by stream adapter
            process.nextTick(() => {
                const ws = this.conn as any;
                if (ws.onmessage) {
                    const originalOnMessage = ws.onmessage;
                    ws.onmessage = (e: any) => {
                        // Only handle framework heartbeat, MQTT messages handled by stream adapter
                        if (e.data === 'ping' || e.data === 'pong') {
                            if (originalOnMessage) {
                                originalOnMessage.call(ws, e);
                            }
                        }
                    };
                    logger.debug('Replaced framework message handler for MQTT connection');
                }
            });
        } catch (error) {
            logger.error('MQTT connection handler error: %s', (error as Error).message);
            this.close(500, 'Internal error');
        }
    }

    async message() {
        // MQTT messages are handled by Aedes broker, framework shouldn't call this
        logger.warn('MQTT message handler called by framework, this should not happen');
    }

    async cleanup() {
        // Don't call parent cleanup: MQTT connection is managed by broker
        logger.debug('MQTT connection handler cleanup called, but connection is managed by broker');
    }
}

export async function apply(ctx: Context) {
    ctx.Route('node_domain', '/node', NodeDomainHandler);
    ctx.Route('node_create', '/node/create', NodeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_edit', '/node/:nodeId/edit', NodeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_delete', '/node/delete', NodeDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_device_control', '/node/device/control', NodeDeviceControlHandler, PRIV.PRIV_USER_PROFILE);
    // 将 node_detail 放在最后，避免匹配静态资源文件
    // 但需要确保 nodeId 是数字，避免匹配 .css.map 等文件
    ctx.Route('node_device_list', '/node/:nodeId/devices', NodeDeviceListHandler);
    ctx.Route('node_detail', '/node/:nodeId', NodeDetailHandler);
    ctx.Connection('node_conn', '/node/ws', NodeConnectionHandler);
    // 外部 node 客户端连接端点（通过 domainId + nodeId 验证）
    ctx.Connection('node_client_conn', '/node/client/ws', NodeClientConnectionHandler);
    // MQTT over WebSocket 连接端点
    ctx.Connection('node_mqtt_conn', '/mqtt/ws', NodeMqttConnectionHandler);
}


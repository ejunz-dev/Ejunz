import { ObjectId } from 'mongodb';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from '../context';
import { ValidationError, PermissionError, NotFoundError } from '../error';
import { Logger } from '../logger';
import NodeModel, { NodeDeviceModel } from '../model/node';
import EdgeTokenModel from '../model/edge_token';
import EdgeModel from '../model/edge';
import { PRIV } from '../model/builtin';

const logger = new Logger('handler/node');

// 获取节点列表
export class NodeDomainHandler extends Handler<Context> {
    async get() {
        const { page = 1 } = this.request.query;
        const nodes = await NodeModel.getByDomain(this.domain._id);
        // 按 nid 排序
        nodes.sort((a, b) => (a.nid || 0) - (b.nid || 0));
        this.response.template = 'node_domain.html';
        this.response.body = { nodes, domainId: this.domain._id };
    }
}

// 创建/编辑节点
export class NodeEditHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nid } = this.request.params;
        
        let node = null;
        if (nid) {
            const nidNum = parseInt(nid, 10);
            if (!isNaN(nidNum) && nidNum >= 1) {
                node = await NodeModel.getByNodeId(this.domain._id, nidNum);
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

        this.response.redirect = `/node/${node.nid}`;
    }

    async postUpdate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nid } = this.request.params;
        const { name, description } = this.request.body;
        
        const nidNum = parseInt(nid, 10);
        if (isNaN(nidNum) || nidNum < 1) {
            throw new ValidationError('nid');
        }

        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nidNum);
        if (!node) {
            throw new ValidationError('nid');
        }

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await NodeModel.update(this.domain._id, nidNum, { name, description });
        this.response.redirect = `/node/${nidNum}`;
    }
}

// 获取节点详情
export class NodeDetailHandler extends Handler<Context> {
    async get() {
        const { nid } = this.request.params;
        
        if (nid && (nid.includes('.') || !/^\d+$/.test(nid))) {
            // 返回 404，让静态资源处理器处理
            throw new NotFoundError(nid);
        }
        
        const nidNum = parseInt(nid, 10);
        if (isNaN(nidNum) || nidNum < 1) {
            throw new ValidationError('nid');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nidNum);
        if (!node) {
            throw new ValidationError('nid');
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
        
        // 获取关联的 edge 信息（如果通过 edge 接入）
        let edge = null;
        if (node.edgeId) {
            edge = await EdgeModel.getByEdgeId(this.domain._id, node.edgeId);
        }
        
        // 生成连接信息（优先使用 Edge 统一接入点）
        let connectionInfo = null;
        const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
        const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
        const host = this.request.host;
        
        if (edge && edge.token) {
            // 使用 Edge 统一接入点（推荐）
            connectionInfo = {
                type: 'edge',
                edgeToken: edge.token,
                edgeWsUrl: `${wsProtocol}://${host}/mcp/ws?token=${edge.token}`,
                note: '使用 Edge 统一接入点，支持 MCP + MQTT 混合协议（Envelope 格式）',
                deprecated: {
                    clientWsUrl: `${wsProtocol}://${host}/node/client/ws?domainId=${node.domainId}&nid=${node.nid}`,
                    mqttWsUrl: `${wsProtocol}://${host}/mqtt/ws`,
                    note: '旧接入点已废弃，请使用 Edge 接入点',
                },
            };
        } else if (node.wsEndpoint) {
            // 兼容旧接入点（已废弃）
            const mqttTcpHost = host.split(':')[0];
            const mqttTcpPort = parseInt(process.env.MQTT_PORT || '1883', 10);
            const hostParts = host.split(':');
            let wsPort: number | string = '';
            if (hostParts.length > 1) {
                wsPort = hostParts[1];
            } else {
                wsPort = protocol === 'https' ? 443 : 80;
            }
            
            connectionInfo = {
                type: 'legacy',
                deprecated: true,
                clientWsUrl: `${wsProtocol}://${host}/node/client/ws?domainId=${node.domainId}&nid=${node.nid}`,
                mqtt: {
                    wsUrl: `${wsProtocol}://${host}/mqtt/ws`,
                    wsHost: mqttTcpHost,
                    wsPort: wsPort,
                    tcpUrl: `mqtt://${mqttTcpHost}:${mqttTcpPort}`,
                    tcpHost: mqttTcpHost,
                    tcpPort: mqttTcpPort,
                    username: `${node.domainId}:${node.nid}`,
                    password: `${node.domainId}:${node.nid}`,
                },
                note: '⚠️ 旧接入点已废弃，请使用 Edge 接入点。在 Edge 页面生成 node 类型的 token 后使用 /mcp/ws?token=xxx',
            };
        }
        
        // 将节点数据传递给前端，用于 MQTT 连接
        const nodeData = {
            nid: node.nid,
            domainId: node.domainId,
            connectionInfo,
        };
        
        // 将 nodeData 序列化为 JSON 字符串，方便前端直接使用
        const nodeDataJson = JSON.stringify(nodeData);
        
        this.response.template = 'node_detail.html';
        this.response.body = { node, devices, connectionInfo, edge, domainId: this.domain._id, nodeData, nodeDataJson };
    }

    async postGenerateEndpoint() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nid } = this.request.params;
        const nidNum = parseInt(nid, 10);
        if (isNaN(nidNum) || nidNum < 1) {
            throw new ValidationError('nid');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nidNum);
        if (!node) {
            throw new ValidationError('nid');
        }

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 检查是否已有 Edge 关联
        let edge = null;
        if (node.edgeId) {
            edge = await EdgeModel.getByEdgeId(this.domain._id, node.edgeId);
        }

        if (edge && edge.token) {
            // 已有 Edge 关联，返回 Edge 连接信息
            const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
            const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
            const host = this.request.host;
            
            this.response.body = {
                connectionInfo: {
                    type: 'edge',
                    edgeToken: edge.token,
                    edgeWsUrl: `${wsProtocol}://${host}/mcp/ws?token=${edge.token}`,
                    note: '使用 Edge 统一接入点，支持 MCP + MQTT 混合协议（Envelope 格式）',
                },
                message: 'Node 已关联 Edge，请使用 Edge 接入点连接',
            };
        } else {
            // 没有 Edge 关联，引导用户创建 Edge token
            this.response.body = {
                connectionInfo: null,
                message: '⚠️ 旧接入点已废弃。请在 Edge 页面生成 node 类型的 token，然后使用 /mcp/ws?token=xxx 连接。',
                redirectUrl: `/edge?domainId=${this.domain._id}`,
            };
        }
    }

    async postDeleteEndpoint() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nid } = this.request.params;
        const nidNum = parseInt(nid, 10);
        if (isNaN(nidNum) || nidNum < 1) {
            throw new ValidationError('nid');
        }

        const node = await NodeModel.getByNodeId(this.domain._id, nidNum);
        if (!node) {
            throw new ValidationError('nid');
        }

        // 检查权限
        if (node.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 删除接入点
        await NodeModel.update(node.domainId, node.nid, { wsEndpoint: null });
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

        await NodeModel.del(node.domainId, node.nid);
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

// 外部 Node 客户端连接处理器（已废弃，请使用 Edge 接入点 /mcp/ws）
// DEPRECATED: 此接入点已废弃，请使用 Edge 统一接入点 /mcp/ws?token=xxx
// 所有 MCP + MQTT 通信现在通过 Edge 的 Envelope 协议统一处理
export class NodeClientConnectionHandler extends ConnectionHandler<Context> {
    async prepare() {
        logger.warn('DEPRECATED: /node/client/ws is deprecated. Please use Edge endpoint /mcp/ws?token=xxx instead.');
        logger.warn('All MCP + MQTT communication should now go through Edge unified endpoint with Envelope protocol.');
        this.close(4001, 'DEPRECATED: This endpoint is deprecated. Please use /mcp/ws?token=xxx instead. See docs for Edge WS Bridge protocol.');
    }
}

// MQTT over WebSocket connection handler（已废弃，请使用 Edge 接入点 /mcp/ws）
// DEPRECATED: 此接入点已废弃，MQTT 通信现在通过 Edge 统一接入点 /mcp/ws?token=xxx 使用 Envelope 协议处理
// 所有 MQTT 消息应封装为 Envelope (protocol: 'mqtt') 通过 Edge WebSocket 发送
export class NodeMqttConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;

    async prepare() {
        logger.warn('DEPRECATED: /mqtt/ws is deprecated. Please use Edge endpoint /mcp/ws?token=xxx instead.');
        logger.warn('MQTT communication should now go through Edge unified endpoint with Envelope protocol (protocol: "mqtt").');
        this.close(4001, 'DEPRECATED: This endpoint is deprecated. Please use /mcp/ws?token=xxx with Envelope protocol instead. See docs for Edge WS Bridge protocol.');
    }
}

export async function apply(ctx: Context) {
    ctx.Route('node_domain', '/node', NodeDomainHandler);
    ctx.Route('node_create', '/node/create', NodeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_edit', '/node/:nid/edit', NodeEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_delete', '/node/delete', NodeDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('node_device_control', '/node/device/control', NodeDeviceControlHandler, PRIV.PRIV_USER_PROFILE);
    // 将 node_detail 放在最后，避免匹配静态资源文件
    // 但需要确保 nid 是数字，避免匹配 .css.map 等文件
    ctx.Route('node_device_list', '/node/:nid/devices', NodeDeviceListHandler);
    ctx.Route('node_detail', '/node/:nid', NodeDetailHandler);
    ctx.Connection('node_conn', '/node/ws', NodeConnectionHandler);
    // 外部 node 客户端连接端点（通过 domainId + nodeId 验证）
    ctx.Connection('node_client_conn', '/node/client/ws', NodeClientConnectionHandler);
    // MQTT over WebSocket 连接端点
    ctx.Connection('node_mqtt_conn', '/mqtt/ws', NodeMqttConnectionHandler);
}


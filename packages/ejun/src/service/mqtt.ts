import Aedes from 'aedes';
import { Server } from 'net';
import { Context, Service } from '../context';
import { Logger } from '../logger';
import { ObjectId } from 'mongodb';
import NodeModel, { NodeDeviceModel } from '../model/node';
import * as document from '../model/document';
import { Duplex } from 'stream';

const logger = new Logger('mqtt');

// Adapt WebSocket to Aedes stream interface
function createWebSocketStream(ws: any, req: any): Duplex {
    const stream = new Duplex({
        objectMode: false,
        read() {
        },
        write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
            try {
                if (ws.readyState === ws.OPEN || ws.readyState === 1) {
                    ws.send(chunk);
                    callback();
                } else {
                    callback(new Error('WebSocket is not open'));
                }
            } catch (error) {
                callback(error as Error);
            }
        },
    });

    // 将 WebSocket 事件映射到流事件
    // 注意：需要移除框架设置的 onmessage，只使用 'message' 事件
    const messageHandler = (data: Buffer | string) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        stream.push(buffer);
    };
    ws.on('message', messageHandler);

    ws.on('error', (error: Error) => {
        stream.destroy(error);
    });

    ws.on('close', () => {
        stream.push(null);
        stream.destroy();
    });
    
    stream.on('close', () => {
        ws.removeListener('message', messageHandler);
    });

    stream.on('end', () => {
        if (ws.readyState === ws.OPEN || ws.readyState === 1) {
            ws.close();
        }
    });

    stream.on('error', (error: Error) => {
        if (ws.readyState === ws.OPEN || ws.readyState === 1) {
            ws.close();
        }
    });

    (stream as any).socket = ws;
    (stream as any).getBuffer = () => {
        return Buffer.alloc(0);
    };

    return stream;
}

declare module '../context' {
    interface Context {
        mqtt: MqttService;
    }
}

export class MqttService extends Service {
    broker: Aedes;
    private tcpServer: Server | null = null;
    private activeConnections: Map<string, { nodeId: ObjectId; clientId: string }> = new Map();
    private nodeConnections: Map<ObjectId, any> = new Map();

    createWebSocketStream(ws: any, req: any): Duplex {
        return createWebSocketStream(ws, req);
    }

    constructor(ctx: Context) {
        super(ctx, 'mqtt');
    }

    async *[Service.init]() {
        logger.info('Initializing MQTT service...');
        this.broker = new Aedes({
            authenticate: (client, username, password, callback) => {
                logger.info('MQTT authentication attempt: client=%s, username=%s, password=%s', 
                    client.id, username || 'none', password ? '***' : 'none');
                logger.debug('MQTT client details: id=%s, protocol=%s', client.id, (client as any).stream?.socket?.protocol || 'unknown');
                // Aedes authenticate callback doesn't support async, handle Promise manually
                (async () => {
                try {
                    const authStr = password?.toString() || username?.toString();
                    if (!authStr) {
                        logger.warn('MQTT authentication failed: no username or password provided');
                        const err = new Error('Authentication failed: username and password required') as any;
                        err.returnCode = 4; // Not authorized
                        callback(err, null);
                        return;
                    }

                    logger.debug('MQTT auth string: %s', authStr);

                    const parts = authStr.split(':');
                    if (parts.length !== 2) {
                        logger.warn('MQTT authentication failed: invalid format, expected domainId:nodeId, got: %s', authStr);
                        const err = new Error('Invalid authentication format: expected domainId:nodeId') as any;
                        err.returnCode = 4; // Not authorized
                        callback(err, null);
                        return;
                    }

                    const [domainId, nodeIdStr] = parts;
                    const nodeId = parseInt(nodeIdStr, 10);
                    if (isNaN(nodeId) || nodeId < 1) {
                        logger.warn('MQTT authentication failed: invalid nodeId %s (domainId: %s)', nodeIdStr, domainId);
                        const err = new Error('Invalid nodeId: must be a positive integer') as any;
                        err.returnCode = 4; // Not authorized
                        callback(err, null);
                        return;
                    }

                    logger.debug('Looking up node: domainId=%s, nodeId=%s', domainId, nodeId);
                    const node = await NodeModel.getByNodeId(domainId, nodeId);
                    if (!node) {
                        logger.warn('MQTT authentication failed: node not found (domainId: %s, nodeId: %s)', domainId, nodeId);
                        const err = new Error('Node not found') as any;
                        err.returnCode = 4; // Not authorized
                        callback(err, null);
                        return;
                    }
                    
                    logger.info('Node found for MQTT authentication: nodeId=%s, domainId=%s', node.nodeId, node.domainId);

                    await NodeModel.update(node.domainId, node.nodeId, { status: 'active', mqttClientId: client.id });
                    // Get node document _id (ObjectId) for device queries
                    const nodeDoc = await document.coll.findOne({ domainId, docType: document.TYPE_NODE, nodeId: node.nodeId });
                    if (nodeDoc && nodeDoc._id) {
                        this.activeConnections.set(client.id, { nodeId: nodeDoc._id, clientId: client.id });
                        logger.info('MQTT client authenticated: %s (node: %s)', client.id, nodeDoc._id);
                    } else {
                        logger.warn('Failed to find node document for domainId: %s, nodeId: %s', domainId, node.nodeId);
                    }
                    callback(null, true);
                } catch (error) {
                    logger.error('MQTT authentication error: %s', (error as Error).message);
                    logger.error('MQTT authentication error stack: %s', (error as Error).stack);
                    const err = error as any;
                    err.returnCode = err.returnCode || 4; // Not authorized
                    callback(err, null);
                }
                })().catch((error) => {
                    logger.error('MQTT authentication unhandled error: %s', (error as Error).message);
                    const err = error as any;
                    err.returnCode = err.returnCode || 4;
                    callback(err, null);
                });
            },
            authorizePublish: (client, packet, callback) => {
                if (typeof callback === 'function') {
                    callback(null);
                }
            },
            authorizeSubscribe: (client, subscription, callback) => {
                // Aedes authorizeSubscribe signature: callback(error, subscription)
                if (typeof callback === 'function') {
                    callback(null, subscription);
                }
            },
        });

        this.broker.on('client', (client) => {
            logger.info('MQTT client connected: %s, protocol=%s', client.id, (client as any).stream?.socket?.protocol || 'unknown');
        });
        
        this.broker.on('clientReady', (client) => {
            logger.info('MQTT client ready: %s', client.id);
        });

        this.broker.on('clientDisconnect', async (client) => {
            logger.info('MQTT client disconnected: %s', client.id);
            const conn = this.activeConnections.get(client.id);
            if (conn) {
                try {
                    const node = await document.coll.findOne({ _id: conn.nodeId });
                    if (node) {
                        // NodeModel.update requires numeric nodeId, not ObjectId docId
                        await NodeModel.update(node.domainId, node.nodeId, { status: 'disconnected' });
                        (this.ctx.emit as any)('node/status/update', conn.nodeId, 'disconnected');
                    } else {
                        logger.warn('Node not found for disconnected client: %s (nodeId: %s)', client.id, conn.nodeId);
                    }
                } catch (error) {
                    logger.error('Error updating node status on disconnect: %s', (error as Error).message);
                } finally {
                    this.activeConnections.delete(client.id);
                }
            }
        });

        this.broker.on('publish', async (packet, client) => {
            if (!client) return;

            const conn = this.activeConnections.get(client.id);
            const topic = packet.topic;
            const payload = packet.payload.toString();

            try {
                // Bridge zigbee2mqtt messages to our format
                if (topic.startsWith('zigbee2mqtt/')) {
                    logger.info('Processing zigbee2mqtt message: topic=%s, client=%s', topic, client.id);
                    await this.handleZigbee2MqttMessage(topic, payload);
                    return;
                }

                if (!conn) {
                    logger.debug('MQTT message from unauthenticated client: %s, topic: %s', client.id, topic);
                    logger.debug('Active connections: %O', Array.from(this.activeConnections.keys()));
                    return;
                }

                logger.info('MQTT message received: topic=%s, client=%s, payload length=%d', topic, client.id, payload.length);
                logger.debug('MQTT message payload: %s', payload.substring(0, 200));

                if (topic.startsWith('node/')) {
                    logger.info('Processing node message: topic=%s, nodeId=%s', topic, conn.nodeId);
                    await this.handleNodeMessage(conn.nodeId, topic, payload);
                } else {
                    logger.debug('Ignoring non-node topic: %s', topic);
                }
            } catch (error) {
                logger.error('Error handling MQTT message: %s', (error as Error).message);
                logger.error('Error stack: %s', (error as Error).stack);
            }
        });

        this.tcpServer = require('net').createServer(this.broker.handle);
        const mqttPort = parseInt(process.env.MQTT_PORT || '1883', 10);
        this.tcpServer.listen(mqttPort, () => {
            logger.info('MQTT TCP server listening on port %d', mqttPort);
        });
        
        this.tcpServer.on('error', (error: Error) => {
            logger.error('MQTT TCP server error: %s', error.message);
        });
        
        logger.info('MQTT service initialized successfully');
        logger.info('  - MQTT TCP server: port %d', mqttPort);
        logger.info('  - MQTT WebSocket endpoint: /mqtt/ws (handled by NodeMqttConnectionHandler)');

        yield () => {
            if (this.tcpServer) {
                this.tcpServer.close();
            }
            this.broker.close();
        };
    }

    private async handleNodeMessage(nodeId: ObjectId, topic: string, payload: string) {
        try {
            const node = await NodeModel.get(nodeId);
            if (!node) {
                logger.warn('Node not found for nodeId: %s', nodeId);
                return;
            }
            const domainId = node.domainId;

            // Topic formats:
            // - node/{nodeId}/devices/discover - batch device discovery
            // - node/{nodeId}/devices/{deviceId}/register - single device registration
            // - node/{nodeId}/devices/{deviceId}/state - device state update
            // - node/{nodeId}/devices/{deviceId}/attributes - device attributes update

            const topicParts = topic.split('/').filter(p => p);
            let data: any;
            try {
                data = JSON.parse(payload);
            } catch (error) {
                logger.warn('Invalid JSON payload for topic %s: %s', topic, payload);
                return;
            }

            logger.debug('Topic parts: %O, length: %d', topicParts, topicParts.length);
            if (topicParts.length >= 4 && topicParts[0] === 'node' && topicParts[2] === 'devices' && topicParts[3] === 'discover') {
                logger.info('Processing device discovery for node %s, topic: %s', nodeId, topic);
                logger.debug('Discovery data: %O', data);
                if (Array.isArray(data.devices)) {
                    logger.info('Found %d devices in discovery message', data.devices.length);
                    for (const device of data.devices) {
                        const deviceId = device.id || device.deviceId || device.device_id;
                        if (!deviceId) continue;

                        await NodeDeviceModel.upsertByDeviceId(
                            nodeId,
                            deviceId,
                            {
                                domainId,
                                name: device.name || deviceId,
                                type: device.type || 'unknown',
                                manufacturer: device.manufacturer,
                                model: device.model,
                                state: device.state || {},
                                capabilities: device.capabilities || device.capability || [],
                            },
                        );
                    }
                    logger.info('Discovered %d devices for node %s via MQTT', data.devices.length, nodeId);
                    (this.ctx.emit as any)('node/devices/update', nodeId);
                }
            }
            else if (topicParts.length >= 5 && topicParts[0] === 'node' && topicParts[2] === 'devices' && topicParts[4] === 'register') {
                const deviceId = topicParts[3];
                logger.debug('Processing device registration for node %s, deviceId: %s', nodeId, deviceId);
                if (deviceId) {
                    await NodeDeviceModel.upsertByDeviceId(
                        nodeId,
                        deviceId,
                        {
                            domainId,
                            name: data.name || deviceId,
                            type: data.type || 'unknown',
                            manufacturer: data.manufacturer,
                            model: data.model,
                            state: data.state || {},
                            capabilities: data.capabilities || data.capability || [],
                        },
                    );
                    logger.info('Registered device %s for node %s via MQTT', deviceId, nodeId);
                    (this.ctx.emit as any)('node/devices/update', nodeId);
                }
            }
            else if (topicParts.length >= 5 && topicParts[0] === 'node' && topicParts[2] === 'devices' && topicParts[4] === 'state') {
                const deviceId = topicParts[3];
                logger.debug('Processing device state update for node %s, deviceId: %s', nodeId, deviceId);
                if (deviceId) {
                    // Normalize state: convert common state fields to standard format
                    const normalizedState = { ...data };
                    
                    // Convert state field (e.g., "ON"/"OFF") to boolean on
                    if (normalizedState.state !== undefined) {
                        const stateValue = normalizedState.state;
                        if (typeof stateValue === 'string') {
                            normalizedState.on = /^(ON|on|ONLINE|online|true|1)$/i.test(stateValue);
                        } else if (typeof stateValue === 'boolean') {
                            normalizedState.on = stateValue;
                        } else if (typeof stateValue === 'number') {
                            normalizedState.on = stateValue > 0;
                        }
                    }
                    
                    // Convert power field to on if on is not defined
                    if (normalizedState.power !== undefined && normalizedState.on === undefined) {
                        const powerValue = normalizedState.power;
                        if (typeof powerValue === 'string') {
                            normalizedState.on = /^(ON|on|ONLINE|online|true|1)$/i.test(powerValue);
                        } else if (typeof powerValue === 'boolean') {
                            normalizedState.on = powerValue;
                        } else if (typeof powerValue === 'number') {
                            normalizedState.on = powerValue > 0;
                        }
                    }
                    
                    let device = await NodeDeviceModel.getByDeviceId(nodeId, deviceId);
                    if (!device) {
                        device = await NodeDeviceModel.add({
                            nodeId,
                            domainId,
                            deviceId,
                            name: deviceId,
                            type: 'unknown',
                            state: normalizedState,
                            capabilities: [],
                        });
                        logger.info('Auto-registered device %s for node %s via MQTT state update', deviceId, nodeId);
                    } else {
                        await NodeDeviceModel.updateState(device._id, normalizedState);
                    }
                    logger.debug('Updated state for device %s via MQTT', deviceId);
                    (this.ctx.emit as any)('node/device/update', nodeId, deviceId, normalizedState);
                    (this.ctx.emit as any)('node/devices/update', nodeId);
                }
            }
            else if (topicParts.length >= 5 && topicParts[0] === 'node' && topicParts[2] === 'devices' && topicParts[4] === 'attributes') {
                const deviceId = topicParts[3];
                logger.debug('Processing device attributes update for node %s, deviceId: %s', nodeId, deviceId);
                if (deviceId) {
                    let device = await NodeDeviceModel.getByDeviceId(nodeId, deviceId);
                    if (!device) {
                        device = await NodeDeviceModel.add({
                            nodeId,
                            domainId,
                            deviceId,
                            name: data.name || deviceId,
                            type: data.type || 'unknown',
                            manufacturer: data.manufacturer,
                            model: data.model,
                            state: data.state || {},
                            capabilities: data.capabilities || data.capability || [],
                        });
                        logger.info('Auto-registered device %s for node %s via MQTT attributes', deviceId, nodeId);
                    } else {
                        await NodeDeviceModel.update(device._id, {
                            name: data.name || device.name,
                            type: data.type || device.type,
                            manufacturer: data.manufacturer || device.manufacturer,
                            model: data.model || device.model,
                            capabilities: data.capabilities || data.capability || device.capabilities,
                            state: data.state || device.state,
                        });
                    }
                    logger.debug('Updated attributes for device %s via MQTT', deviceId);
                    (this.ctx.emit as any)('node/devices/update', nodeId);
                }
            }
        } catch (error) {
            logger.error('Error handling node MQTT message: %s', (error as Error).message);
        }
    }

    async publishToNode(nodeId: ObjectId, topic: string, payload: any) {
        const node = await NodeModel.get(nodeId);
        if (!node) {
            logger.warn('Node not found for nodeId: %s', nodeId);
            return;
        }
        const fullTopic = `node/${node.nodeId}/${topic}`;
        const message = {
            cmd: 'publish' as const,
            topic: fullTopic,
            payload: Buffer.from(JSON.stringify(payload)),
            qos: 1 as const,
            dup: false,
            retain: false,
        };
        logger.info('Publishing MQTT message: topic=%s, payload=%O', fullTopic, payload);
        this.broker.publish(message, () => {
            logger.info('Published to node %s: topic=%s', node.nodeId, fullTopic);
        });
    }

    // Publish device control command via MQTT
    // Publishes to both standard format and zigbee2mqtt format
    async sendDeviceControlViaMqtt(nodeId: ObjectId, deviceId: string, command: Record<string, any>) {
        const node = await NodeModel.get(nodeId);
        if (!node) {
            logger.warn('Node not found for nodeId: %s', nodeId);
            return;
        }
        
        const topic = `devices/${deviceId}/set`;
        const fullTopic = `node/${node.nodeId}/${topic}`;
        logger.info('Publishing control command to local MQTT broker: topic=%s (full: %s), command=%O', 
            topic, fullTopic, command);
        await this.publishToNode(nodeId, topic, command);
        logger.info('Sent device control command via MQTT to local broker, node %s, device %s, full topic: %s', 
            node.nodeId, deviceId, fullTopic);
        
        // Also publish to zigbee2mqtt format: convert {"on": true} -> {"state": "ON"}
        const zigbee2mqttTopic = `zigbee2mqtt/${deviceId}/set`;
        let zigbee2mqttCommand: any = {};
        
        if (command.on !== undefined) {
            zigbee2mqttCommand.state = command.on ? 'ON' : 'OFF';
        } else {
            zigbee2mqttCommand = command;
        }
        
        const zigbee2mqttMessage = {
            cmd: 'publish' as const,
            topic: zigbee2mqttTopic,
            payload: Buffer.from(JSON.stringify(zigbee2mqttCommand)),
            qos: 1 as const,
            dup: false,
            retain: false,
        };
        logger.info('Publishing control command to zigbee2mqtt: topic=%s, command=%O', 
            zigbee2mqttTopic, zigbee2mqttCommand);
        this.broker.publish(zigbee2mqttMessage, () => {
            logger.info('Published to zigbee2mqtt: topic=%s', zigbee2mqttTopic);
        });
    }
    
    // Bridge zigbee2mqtt messages to our format
    // Topics: zigbee2mqtt/{deviceId} (state updates), zigbee2mqtt/{deviceId}/set (commands, ignored)
    private async handleZigbee2MqttMessage(topic: string, payload: string) {
        try {
            const topicParts = topic.split('/');
            if (topicParts.length < 2 || topicParts[0] !== 'zigbee2mqtt') {
                return;
            }
            
            const deviceId = topicParts[1];
            if (!deviceId) {
                return;
            }
            
            if (topicParts[2] === 'set') {
                logger.debug('Ignoring zigbee2mqtt set command (we published it): %s', topic);
                return;
            }
            
            let data: any;
            try {
                data = JSON.parse(payload);
            } catch (error) {
                logger.warn('Invalid JSON payload for zigbee2mqtt topic %s: %s', topic, payload);
                return;
            }
            
            const device = await NodeDeviceModel.getByDeviceIdString(deviceId);
            if (!device) {
                logger.debug('Device not found for zigbee2mqtt deviceId: %s, topic: %s', deviceId, topic);
                return;
            }
            
            const nodeId = device.nodeId;
            const node = await NodeModel.get(nodeId);
            if (!node) {
                logger.warn('Node not found for device: %s', deviceId);
                return;
            }
            
            // Convert zigbee2mqtt format {"state": "ON"/"OFF"} -> our format {"on": true/false}
            const normalizedState: any = { ...data };
            if (data.state !== undefined) {
                const stateValue = data.state;
                if (typeof stateValue === 'string') {
                    normalizedState.on = /^(ON|on|ONLINE|online|true|1)$/i.test(stateValue);
                } else if (typeof stateValue === 'boolean') {
                    normalizedState.on = stateValue;
                } else if (typeof stateValue === 'number') {
                    normalizedState.on = stateValue > 0;
                }
            }
            
            const stateTopic = `node/${node.nodeId}/devices/${deviceId}/state`;
            const stateMessage = {
                cmd: 'publish' as const,
                topic: stateTopic,
                payload: Buffer.from(JSON.stringify(normalizedState)),
                qos: 1 as const,
                dup: false,
                retain: false,
            };
            
            logger.info('Bridging zigbee2mqtt state to our format: zigbee2mqtt topic=%s -> our topic=%s', 
                topic, stateTopic);
            this.broker.publish(stateMessage, () => {
                logger.info('Bridged zigbee2mqtt message: %s -> %s', topic, stateTopic);
                this.handleNodeMessage(nodeId, stateTopic, JSON.stringify(normalizedState)).catch(err => {
                    logger.error('Error handling bridged message: %s', (err as Error).message);
                });
            });
        } catch (error) {
            logger.error('Error handling zigbee2mqtt message: %s', (error as Error).message);
            logger.error('Error stack: %s', (error as Error).stack);
        }
    }

    registerNodeConnection(nodeId: ObjectId, ws: any) {
        this.nodeConnections.set(nodeId, ws);
    }

    unregisterNodeConnection(nodeId: ObjectId) {
        this.nodeConnections.delete(nodeId);
    }

    async sendDeviceControl(nodeId: ObjectId, deviceId: string, payload: any) {
        const handler = this.nodeConnections.get(nodeId);
        if (handler) {
            try {
                handler.send({
                    type: 'device-control',
                    deviceId,
                    payload,
                });
                logger.debug('Sent device control to node %s: device %s', nodeId, deviceId);
            } catch (error) {
                logger.error('Failed to send device control: %s', (error as Error).message);
            }
        } else {
            logger.warn('Node %s WebSocket connection not found', nodeId);
        }
    }

    getActiveConnections() {
        return Array.from(this.activeConnections.entries()).map(([clientId, conn]) => ({
            clientId,
            nodeId: conn.nodeId,
        }));
    }
}

export default MqttService;


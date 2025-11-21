import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import WorkflowModel from './workflow';
import WorkflowNodeModel from './workflow_node';
import type { WorkflowDoc, WorkflowNodeDoc } from '../interface';
import { NodeDeviceModel } from './node';
import AgentModel from './agent';
import message from './message';
import ClientModel from './client';
import { processAgentChatInternal } from '../handler/agent';

const logger = new Logger('model/workflow_executor');

export interface WorkflowExecutionContext {
    workflowId: number;
    workflowDocId: ObjectId;
    domainId: string;
    variables: Record<string, any>;
    currentNodeId?: number;
    executionId: string;
    startTime: Date;
}

export class WorkflowExecutor {
    private ctx: Context;

    constructor(ctx: Context) {
        this.ctx = ctx;
    }

    async execute(domainId: string, workflowId: number, triggerData?: Record<string, any>): Promise<void> {
        const workflow = await WorkflowModel.getByWorkflowId(domainId, workflowId);
        if (!workflow) {
            throw new Error(`Workflow ${workflowId} not found`);
        }

        let startNode: WorkflowNodeDoc | null = null;

        if (triggerData?.nodeId !== undefined) {
            const nodeId = triggerData.nodeId;
            startNode = await WorkflowNodeModel.getByNodeId(domainId, nodeId);
            if (!startNode) {
                logger.warn(`Trigger node ${nodeId} not found in domain ${domainId}`);
                return;
            }
            if (startNode.workflowId !== workflowId || !startNode.workflowDocId.equals(workflow.docId)) {
                logger.warn(`Trigger node ${nodeId} does not belong to workflow ${workflowId}`);
                return;
            }
            logger.info(`Starting workflow ${workflowId} from trigger node ${nodeId} (${startNode.nodeType})`);
        } else {
            startNode = await WorkflowNodeModel.getStartNode(domainId, workflow.docId);
            if (!startNode) {
                logger.warn(`Workflow ${workflowId} has no start node and no trigger node specified`);
                return;
            }
            logger.info(`Starting workflow ${workflowId} from start node`);
        }

        const executionId = new ObjectId().toString();
        const context: WorkflowExecutionContext = {
            workflowId,
            workflowDocId: workflow.docId,
            domainId,
            variables: triggerData || {},
            executionId,
            startTime: new Date(),
        };

        logger.info(`Starting workflow execution: ${workflowId}, executionId: ${executionId}, from node: ${startNode.nid}`);
        
        await this.executeNode(startNode, context);
    }

    private async executeNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<void> {
        logger.info(`Executing node: ${node.nid} (${node.nodeType}) in workflow ${context.workflowId}`);
        
        context.currentNodeId = node.nid;

        try {
            let result: any = null;

            switch (node.nodeType) {
                case 'start':
                    result = await this.executeStartNode(node, context);
                    break;
                case 'timer':
                case 'button':
                    result = { success: true };
                    break;
                case 'device_control':
                case 'object_action':
                    result = await this.executeObjectActionNode(node, context);
                    break;
                case 'agent_message':
                case 'agent_action':
                    result = await this.executeAgentActionNode(node, context);
                    break;
                case 'condition':
                    result = await this.executeConditionNode(node, context);
                    break;
                case 'delay':
                    result = await this.executeDelayNode(node, context);
                    break;
                case 'receiver':
                    result = await this.executeReceiverNode(node, context);
                    break;
                case 'end':
                    logger.info(`Workflow ${context.workflowId} execution completed`);
                    return;
                default:
                    logger.warn(`Unknown node type: ${node.nodeType}`);
                    result = { success: false, error: `Unknown node type: ${node.nodeType}` };
            }

            if (result) {
                context.variables[`node_${node.nid}_result`] = result;
            }

            if (node.connections && node.connections.length > 0) {
                for (const connection of node.connections) {
                    const targetNode = await WorkflowNodeModel.getByNodeId(context.domainId, connection.targetNodeId);
                    if (targetNode) {
                        if (node.nodeType === 'condition' && connection.condition) {
                            const conditionMet = this.evaluateCondition(connection.condition, context);
                            if (conditionMet) {
                                await this.executeNode(targetNode, context);
                            }
                        } else {
                            await this.executeNode(targetNode, context);
                        }
                    }
                }
            }
        } catch (error) {
            logger.error(`Error executing node ${node.nid}:`, error);
            throw error;
        }
    }

    private async executeStartNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        return { success: true, message: 'Workflow started' };
    }

    private async executeObjectActionNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        
        const nodeId = config.nodeId ? parseInt(String(config.nodeId), 10) : null;
        const deviceId = this.resolveVariable(config.deviceId, context);
        const action = config.action || 'off';
        const property = config.property || 'on';
        const value = config.value !== undefined ? this.resolveVariable(config.value, context) : undefined;

        if (!deviceId) {
            throw new Error('Device ID is required for object action node');
        }

        let device = null;
        const NodeModel = global.Ejunz.model.node;
        
        if (nodeId) {
            const targetNode = await NodeModel.getByNodeId(context.domainId, nodeId);
            if (!targetNode) {
                throw new Error(`Node ${nodeId} not found`);
            }
            const devices = await NodeDeviceModel.getByNode(targetNode._id);
            device = devices.find(d => d.deviceId === deviceId);
        } else {
            device = await NodeDeviceModel.getByDeviceIdString(deviceId);
        }

        if (!device) {
            throw new Error(`Device ${deviceId} not found`);
        }

        let newState = { ...device.state };
        if (action === 'off') {
            newState[property] = false;
        } else if (action === 'on') {
            newState[property] = true;
        } else if (action === 'toggle') {
            newState[property] = !device.state[property];
        } else if (action === 'set' && value !== undefined) {
            newState[property] = value;
        }

        const command: Record<string, any> = {};
        command[property] = newState[property];

        const targetNode = await NodeModel.get(device.nodeId);
        if (!targetNode) {
            throw new Error(`Node not found for device ${deviceId}`);
        }

        try {
            await this.ctx.inject(['mqtt'], async ({ mqtt }) => {
                if (mqtt) {
                    logger.info(`Sending device control via MQTT: nodeId=${targetNode._id}, deviceId=${deviceId}, command=${JSON.stringify(command)}`);
                    await (mqtt as any).sendDeviceControlViaMqtt(targetNode._id, deviceId, command);
                    logger.info(`Device control command sent successfully via MQTT`);
                } else {
                    logger.warn('MQTT service not available, only updating database state');
                }
            });
        } catch (error) {
            logger.error(`Failed to send device control via MQTT: ${(error as Error).message}`);
        }

        await NodeDeviceModel.updateState(device._id, newState);

        logger.info(`Object action executed: device ${deviceId} ${property} set to ${newState[property]}`);

        return {
            success: true,
            deviceId,
            action,
            property,
            newState: newState[property],
        };
    }

    private async executeDeviceControlNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const deviceId = this.resolveVariable(config.deviceId, context);
        const action = config.action || 'off';
        const property = config.property || 'on';

        if (!deviceId) {
            throw new Error('Device ID is required for device control node');
        }

        const device = await NodeDeviceModel.getByDeviceIdString(deviceId);
        if (!device) {
            throw new Error(`Device ${deviceId} not found`);
        }

        let newState = { ...device.state };
        if (action === 'off') {
            newState[property] = false;
        } else if (action === 'on') {
            newState[property] = true;
        } else if (action === 'toggle') {
            newState[property] = !device.state[property];
        } else if (action === 'set' && config.value !== undefined) {
            newState[property] = this.resolveVariable(config.value, context);
        }

        await NodeDeviceModel.updateState(device._id, newState);

        logger.info(`Device ${deviceId} ${property} set to ${newState[property]}`);

        return {
            success: true,
            deviceId,
            action,
            property,
            newState: newState[property],
        };
    }

    private async executeAgentActionNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const agentId = this.resolveVariable(config.agentId, context);
        const prompt = this.resolveVariable(config.prompt || '', context);

        if (!agentId) {
            throw new Error('Agent ID is required for agent action node');
        }

        if (!prompt) {
            throw new Error('Prompt is required for agent action node');
        }

        const agent = await AgentModel.get(context.domainId, agentId);
        if (!agent) {
            throw new Error(`Agent ${agentId} not found`);
        }

        logger.info(`Using agent ${agentId} to generate content from prompt: ${prompt}`);

        const clientId = await this.findReceiverClientId(node, context);
        let accumulatedContent = '';
        let finalMessage = '';
        let ttsStreamed = false;

        const ClientConnectionHandler = require('../handler/client').ClientConnectionHandler;
        const clientHandler = clientId ? ClientConnectionHandler.getConnection(clientId) : null;

        await processAgentChatInternal(agent, prompt, [], {
            onContent: (content: string) => {
                accumulatedContent += content;
                if (clientHandler) {
                    ttsStreamed = true;
                    clientHandler.addTtsText(content).catch((error: any) => {
                        logger.warn('addTtsText failed: %s', error.message);
                    });
                }
            },
            onToolCall: async (tools: any[]) => {
                if (clientHandler && clientHandler.client?.settings?.tts && clientHandler.pendingCommits > 0) {
                    logger.info('Waiting for TTS playback before tool call: clientId=%d, pendingCommits=%d', clientId, clientHandler.pendingCommits);
                    
                    await new Promise<void>((resolve) => {
                        const checkInterval = setInterval(() => {
                            if (clientHandler.pendingCommits === 0) {
                                clearInterval(checkInterval);
                                resolve();
                            }
                        }, 100);
                        
                        setTimeout(() => {
                            clearInterval(checkInterval);
                            logger.warn('TTS generation timeout, continuing: clientId=%d', clientId);
                            resolve();
                        }, 10000);
                    });
                    
                    logger.info('Waiting for client-side TTS playback: clientId=%d', clientId);
                    clientHandler.sendEvent('agent/wait_tts_playback', []);
                    
                    await new Promise<void>((resolve) => {
                        const timeoutId = setTimeout(() => {
                            if (clientHandler.ttsPlaybackWaitPromise) {
                                logger.warn('TTS playback wait timeout, continuing: clientId=%d', clientId);
                                clientHandler.ttsPlaybackWaitPromise = null;
                                resolve();
                            }
                        }, 30000);
                        
                        const originalResolve = resolve;
                        clientHandler.ttsPlaybackWaitPromise = { 
                            resolve: () => {
                                clearTimeout(timeoutId);
                                clientHandler.ttsPlaybackWaitPromise = null;
                                originalResolve();
                            }, 
                            reject: () => {
                                clearTimeout(timeoutId);
                                clientHandler.ttsPlaybackWaitPromise = null;
                                originalResolve();
                            }
                        };
                    });
                    
                    logger.info('TTS playback completed, proceeding with tool call: clientId=%d', clientId);
                }
            },
            onToolResult: async (tool: string, result: any) => {
                logger.info(`Tool ${tool} completed with result`);
                if (clientHandler) {
                    try {
                        await clientHandler.ensureTtsConnection();
                    } catch (error: any) {
                        logger.warn(`Failed to ensure TTS connection after tool call: ${error.message}`);
                    }
                }
            },
            onDone: async (message: string, history: string) => {
                finalMessage = message;
                if (clientHandler && clientHandler.ttsTextBuffer && clientHandler.ttsTextBuffer.trim()) {
                    await clientHandler.flushTtsSentence(clientHandler.ttsTextBuffer);
                    clientHandler.ttsTextBuffer = '';
                }
            },
            onError: (error: string) => {
                logger.error(`Agent chat error: ${error}`);
                throw new Error(error);
            },
        });

        const generatedContent = finalMessage || accumulatedContent;
        context.variables[`agent_${node.nid}_content`] = generatedContent;
        context.variables[`agent_${node.nid}_tts_streamed`] = ttsStreamed;

        return {
            success: true,
            agentId,
            content: generatedContent,
            ttsStreamed,
        };
    }

    private async findReceiverClientId(agentNode: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<number | null> {
        if (!agentNode.connections || agentNode.connections.length === 0) {
            return null;
        }

        for (const connection of agentNode.connections) {
            const targetNode = await WorkflowNodeModel.getByNodeId(context.domainId, connection.targetNodeId);
            if (targetNode && targetNode.nodeType === 'receiver') {
                const config = targetNode.config || {};
                const clientId = config.clientId ? parseInt(String(this.resolveVariable(config.clientId, context)), 10) : null;
                if (clientId) {
                    logger.info(`Found receiver node ${targetNode.nid} with clientId ${clientId} for agent node ${agentNode.nid}`);
                    return clientId;
                }
            }
        }

        return null;
    }


    private async executeAgentMessageNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const newConfig = {
            ...config,
            action: 'message',
            prompt: config.message || '',
        };
        const newNode = { ...node, config: newConfig };
        return this.executeAgentActionNode(newNode, context);
    }

    private async executeConditionNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const condition = config.condition || 'true';
        const result = this.evaluateCondition(condition, context);
        return { success: true, conditionMet: result };
    }

    private async executeDelayNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const delayMs = this.resolveVariable(config.delayMs, context) || 0;
        
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        return { success: true, delayMs };
    }

    private resolveVariable(value: any, context: WorkflowExecutionContext): any {
        if (typeof value === 'string') {
            return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
                const varValue = context.variables[varName.trim()];
                return varValue !== undefined ? String(varValue) : match;
            });
        }
        return value;
    }

    private evaluateCondition(condition: string, context: WorkflowExecutionContext): boolean {
        try {
            let evalCondition = condition;
            for (const [key, value] of Object.entries(context.variables)) {
                const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
                evalCondition = evalCondition.replace(regex, JSON.stringify(value));
            }
            const result = new Function('return ' + evalCondition)();
            return Boolean(result);
        } catch (error) {
            logger.error('Error evaluating condition:', error);
            return false;
        }
    }

    private async executeReceiverNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const clientId = config.clientId ? parseInt(String(this.resolveVariable(config.clientId, context)), 10) : null;

        if (!clientId) {
            throw new Error('Client ID is required for receiver node');
        }

        let content = '';
        let latestAgentNodeId = 0;
        let ttsStreamed = false;
        
        for (const key in context.variables) {
            if (key.startsWith('agent_') && key.endsWith('_content')) {
                const nodeId = parseInt(key.replace('agent_', '').replace('_content', ''), 10);
                if (nodeId > latestAgentNodeId) {
                    latestAgentNodeId = nodeId;
                    content = context.variables[key];
                    const ttsStreamedKey = `agent_${nodeId}_tts_streamed`;
                    if (context.variables[ttsStreamedKey] === true) {
                        ttsStreamed = true;
                    }
                }
            }
        }

        if (!content) {
            for (const key in context.variables) {
                if (key.startsWith('node_') && key.endsWith('_result')) {
                    const result = context.variables[key];
                    if (result && result.content) {
                        content = result.content;
                        if (result.ttsStreamed === true) {
                            ttsStreamed = true;
                        }
                        break;
                    }
                }
            }
        }

        const client = await ClientModel.getByClientId(context.domainId, clientId);
        if (!client) {
            throw new Error(`Client ${clientId} not found`);
        }

        if (ttsStreamed) {
            logger.info(`Receiver node: TTS was already streamed by agent node ${latestAgentNodeId}, skipping duplicate send`);
        } else if (content) {
            logger.info(`Sending TTS text to client ${clientId} via event system: ${content.substring(0, 50)}...`);
            (this.ctx.emit as any)('client/tts/text', clientId, { text: content });
        } else {
            throw new Error('No content found to send. Please ensure an agent action node is executed before the receiver node.');
        }

        return {
            success: true,
            clientId,
            content: content || 'TTS was streamed during agent execution',
            ttsStreamed,
        };
    }
}

export default WorkflowExecutor;


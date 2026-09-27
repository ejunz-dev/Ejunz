import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import WorkflowModel from './workflow';
import WorkflowNodeModel from './workflow_node';
import type { WorkflowDoc, WorkflowNodeDoc } from '../interface';
import { NodeDeviceModel } from '../../../../plugins/edge/model/node';

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
                case 'receiver':
                    throw new Error('Legacy Agent workflow nodes are no longer supported; use the /agent application.');
                case 'condition':
                    result = await this.executeConditionNode(node, context);
                    break;
                case 'delay':
                    result = await this.executeDelayNode(node, context);
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

}

export default WorkflowExecutor;


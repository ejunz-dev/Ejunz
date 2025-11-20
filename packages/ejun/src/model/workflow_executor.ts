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

const logger = new Logger('model/workflow_executor');

export interface WorkflowExecutionContext {
    workflowId: number;
    workflowDocId: ObjectId;
    domainId: string;
    variables: Record<string, any>; // 工作流变量
    currentNodeId?: number;
    executionId: string; // 执行实例 ID
    startTime: Date;
}

export class WorkflowExecutor {
    private ctx: Context;

    constructor(ctx: Context) {
        this.ctx = ctx;
    }

    /**
     * 执行工作流
     */
    async execute(domainId: string, workflowId: number, triggerData?: Record<string, any>): Promise<void> {
        const workflow = await WorkflowModel.getByWorkflowId(domainId, workflowId);
        if (!workflow) {
            throw new Error(`Workflow ${workflowId} not found`);
        }

        let startNode: WorkflowNodeDoc | null = null;

        // 如果 triggerData 中指定了 nodeId，从该节点开始执行（用于按钮触发器等）
        if (triggerData?.nodeId !== undefined) {
            const nodeId = triggerData.nodeId;
            startNode = await WorkflowNodeModel.getByNodeId(domainId, nodeId);
            if (!startNode) {
                logger.warn(`Trigger node ${nodeId} not found in domain ${domainId}`);
                return;
            }
            // 验证节点属于该工作流
            if (startNode.workflowId !== workflowId || !startNode.workflowDocId.equals(workflow.docId)) {
                logger.warn(`Trigger node ${nodeId} does not belong to workflow ${workflowId}`);
                return;
            }
            logger.info(`Starting workflow ${workflowId} from trigger node ${nodeId} (${startNode.nodeType})`);
        } else {
            // 否则，从 start 节点开始执行
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
        
        // 从指定节点执行
        await this.executeNode(startNode, context);
    }

    /**
     * 执行单个节点
     */
    private async executeNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<void> {
        logger.info(`Executing node: ${node.nid} (${node.nodeType}) in workflow ${context.workflowId}`);
        
        context.currentNodeId = node.nid;

        try {
            let result: any = null;

            // 根据节点类型执行不同的逻辑
            switch (node.nodeType) {
                case 'start':
                    result = await this.executeStartNode(node, context);
                    break;
                case 'timer':
                case 'button':
                    // 定时器和按钮节点通常用于触发，不在这里执行
                    result = { success: true };
                    break;
                case 'device_control':
                case 'object_action':
                    // 兼容旧类型和新类型
                    result = await this.executeObjectActionNode(node, context);
                    break;
                case 'agent_message':
                case 'agent_action':
                    // 兼容旧类型和新类型
                    result = await this.executeAgentActionNode(node, context);
                    break;
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

            // 将结果存储到变量中
            if (result) {
                context.variables[`node_${node.nid}_result`] = result;
            }

            // 执行后续节点
            if (node.connections && node.connections.length > 0) {
                for (const connection of node.connections) {
                    const targetNode = await WorkflowNodeModel.getByNodeId(context.domainId, connection.targetNodeId);
                    if (targetNode) {
                        // 如果是条件节点，检查条件
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

    /**
     * 执行开始节点
     */
    private async executeStartNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        return { success: true, message: 'Workflow started' };
    }

    /**
     * 执行对象操作节点（设备控制等）
     */
    private async executeObjectActionNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        
        // 新类型 object_action 需要从配置中获取 nodeId
        const nodeId = config.nodeId ? parseInt(String(config.nodeId), 10) : null;
        const deviceId = this.resolveVariable(config.deviceId, context);
        const action = config.action || 'off'; // 'on' | 'off' | 'toggle' | 'set'
        const property = config.property || 'on'; // 要控制的属性
        const value = config.value !== undefined ? this.resolveVariable(config.value, context) : undefined;

        if (!deviceId) {
            throw new Error('Device ID is required for object action node');
        }

        let device = null;
        const NodeModel = global.Ejunz.model.node;
        
        if (nodeId) {
            // 新类型：从配置的 nodeId 查找设备
            const targetNode = await NodeModel.getByNodeId(context.domainId, nodeId);
            if (!targetNode) {
                throw new Error(`Node ${nodeId} not found`);
            }
            const devices = await NodeDeviceModel.getByNode(targetNode._id);
            device = devices.find(d => d.deviceId === deviceId);
        } else {
            // 旧类型兼容：直接通过 deviceId 查找
            device = await NodeDeviceModel.getByDeviceIdString(deviceId);
        }

        if (!device) {
            throw new Error(`Device ${deviceId} not found`);
        }

        // 计算新的设备状态
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

        // 构建控制命令（只包含要改变的属性）
        const command: Record<string, any> = {};
        command[property] = newState[property];

        // 获取设备所属的节点
        const targetNode = await NodeModel.get(device.nodeId);
        if (!targetNode) {
            throw new Error(`Node not found for device ${deviceId}`);
        }

        // 通过 MQTT 发送控制命令到实际设备
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
            // 即使 MQTT 发送失败，也更新数据库状态
        }

        // 更新数据库中的设备状态
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

    /**
     * 执行设备控制节点（兼容旧类型）
     */
    private async executeDeviceControlNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const deviceId = this.resolveVariable(config.deviceId, context);
        const action = config.action || 'off'; // 'on' | 'off' | 'toggle'
        const property = config.property || 'on'; // 要控制的属性

        if (!deviceId) {
            throw new Error('Device ID is required for device control node');
        }

        // 查找设备
        const device = await NodeDeviceModel.getByDeviceIdString(deviceId);
        if (!device) {
            throw new Error(`Device ${deviceId} not found`);
        }

        // 更新设备状态
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

    /**
     * 执行 Agent 操作节点
     */
    private async executeAgentActionNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const agentId = this.resolveVariable(config.agentId, context);
        const action = config.action || 'message';
        const prompt = this.resolveVariable(config.prompt || config.message || '', context);
        const userId = config.userId ? parseInt(String(this.resolveVariable(config.userId, context)), 10) : null;

        if (!agentId) {
            throw new Error('Agent ID is required for agent action node');
        }

        // 查找 Agent
        const agent = await AgentModel.get(context.domainId, agentId);
        if (!agent) {
            throw new Error(`Agent ${agentId} not found`);
        }

        let result: any = { success: true, agentId, action };

        if (action === 'message') {
            // 发送私信
            if (!userId) {
                throw new Error('User ID is required for message action');
            }
            if (!prompt) {
                throw new Error('Prompt is required for agent message');
            }
            
            // TODO: 调用 Agent API 生成消息
            logger.info(`Using agent to generate message from prompt: ${prompt}`);
            // 这里应该调用 Agent 的生成API，使用 prompt 作为提示词
            let finalMessage = prompt; // 占位，实际应该调用 Agent API
            
            if (config.useAgentGeneration === true) {
                try {
                // 简化：直接使用消息内容，如果需要更复杂的 Agent 生成，可以后续扩展
                // 这里可以调用 Agent API 来生成消息
                logger.info(`Using agent ${agentId} to generate message for user ${userId}`);
                // 暂时直接使用原始消息，后续可以集成 Agent 生成功能
            } catch (error) {
                logger.warn('Failed to generate message with agent, using original message:', error);
            }
        }

            // 发送私信（使用系统用户 ID 1 作为发送者）
            await message.send(1, Number(userId), finalMessage, message.FLAG_UNREAD);

            logger.info(`Message sent to user ${userId} via agent ${agentId}`);
            result.message = finalMessage;
            result.userId = Number(userId);
        } else if (action === 'generate') {
            // 生成内容
            if (!prompt) {
                throw new Error('Prompt is required for generate action');
            }
            
            // TODO: 调用 Agent API 生成内容
            logger.info(`Using agent to generate content from prompt: ${prompt}`);
            const generatedContent = prompt; // 占位，实际应该调用 Agent API
            result.content = generatedContent;
        }

        return result;
    }

    /**
     * 执行 Agent 消息节点（兼容旧类型）
     */
    private async executeAgentMessageNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        // 将旧配置转换为新格式
        const newConfig = {
            ...config,
            action: 'message',
            prompt: config.message || '',
        };
        const newNode = { ...node, config: newConfig };
        return this.executeAgentActionNode(newNode, context);
    }

    /**
     * 执行条件节点
     */
    private async executeConditionNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const condition = config.condition || 'true';
        const result = this.evaluateCondition(condition, context);
        return { success: true, conditionMet: result };
    }

    /**
     * 执行延迟节点
     */
    private async executeDelayNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        const config = node.config || {};
        const delayMs = this.resolveVariable(config.delayMs, context) || 0;
        
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        return { success: true, delayMs };
    }

    /**
     * 解析变量（支持 ${variable} 语法）
     */
    private resolveVariable(value: any, context: WorkflowExecutionContext): any {
        if (typeof value === 'string') {
            // 支持 ${variable} 语法
            return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
                const varValue = context.variables[varName.trim()];
                return varValue !== undefined ? String(varValue) : match;
            });
        }
        return value;
    }

    /**
     * 评估条件表达式
     */
    private evaluateCondition(condition: string, context: WorkflowExecutionContext): boolean {
        try {
            // 简单的条件评估，支持变量替换
            let evalCondition = condition;
            for (const [key, value] of Object.entries(context.variables)) {
                const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
                evalCondition = evalCondition.replace(regex, JSON.stringify(value));
            }
            // 使用 Function 构造器安全评估（仅支持简单的比较表达式）
            // 注意：在生产环境中应该使用更安全的表达式解析器
            const result = new Function('return ' + evalCondition)();
            return Boolean(result);
        } catch (error) {
            logger.error('Error evaluating condition:', error);
            return false;
        }
    }
}

export default WorkflowExecutor;


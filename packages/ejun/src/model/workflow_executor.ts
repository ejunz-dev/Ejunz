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
import { processAgentChatInternal, getAssignedTools } from '../handler/agent';

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
                    logger.info(`Executing agent action node ${node.nid} in workflow ${context.workflowId}`);
                    try {
                        result = await this.executeAgentActionNode(node, context);
                        logger.info(`Agent action node ${node.nid} completed with result:`, result);
                    } catch (error: any) {
                        logger.error(`Agent action node ${node.nid} failed:`, error);
                        throw error;
                    }
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
        logger.info(`executeAgentActionNode called for node ${node.nid}, config:`, JSON.stringify(node.config || {}));
        
        const config = node.config || {};
        const agentId = this.resolveVariable(config.agentId, context);
        const prompt = this.resolveVariable(config.prompt || '', context);
        const returnType = this.resolveVariable(config.returnType || 'text', context); // 'text' 或 'tts'
        const clientId = config.clientId ? parseInt(String(this.resolveVariable(config.clientId, context)), 10) : null;

        logger.info(`Resolved config: agentId=${agentId}, prompt=${prompt?.substring(0, 50)}..., returnType=${returnType}, clientId=${clientId}`);

        if (!agentId) {
            logger.error(`Agent ID is missing for node ${node.nid}`);
            throw new Error('Agent ID is required for agent action node');
        }

        if (!prompt) {
            logger.error(`Prompt is missing for node ${node.nid}`);
            throw new Error('Prompt is required for agent action node');
        }

        const agent = await AgentModel.get(context.domainId, agentId);
        if (!agent) {
            throw new Error(`Agent ${agentId} not found`);
        }

        logger.info(`Using agent ${agentId} to generate content from prompt: ${prompt}, returnType: ${returnType}, clientId: ${clientId}`);

        // 获取 domain 信息
        const domainModel = require('./domain').default;
        const domainInfo = await domainModel.get(context.domainId);
        if (!domainInfo) {
            throw new Error('Domain not found');
        }

        // 获取工具列表
        const tools = await getAssignedTools(context.domainId, agent.mcpToolIds, agent.repoIds);

        // 构建系统消息
        const agentPrompt = agent.content || '';
        let systemMessage = agentPrompt;

        const truncateMemory = (memory: string, maxLength: number = 2000): string => {
            if (!memory || memory.length <= maxLength) {
                return memory;
            }
            return memory.substring(0, maxLength) + '\n\n[... Memory truncated, keeping most important rules ...]';
        };
        if (agent.memory) {
            const truncatedMemory = truncateMemory(agent.memory);
            systemMessage += `\n\n---\n【Work Rules Memory - Supplementary Guidelines】\n${truncatedMemory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. For example, if the memory says "When user asks xxx, should xxx", you must follow that exactly when the user asks that question.\n\nNote: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
        }

        if (systemMessage && !systemMessage.includes('do not use emoji')) {
            systemMessage += '\n\nNote: Do not use any emoji in your responses.';
        } else if (!systemMessage) {
            systemMessage = 'Note: Do not use any emoji in your responses.';
        }

        if (tools.length > 0) {
            const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
              tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
              `\n\n【CRITICAL - YOU MUST READ THIS FIRST】\n**MANDATORY: SPEAK BEFORE TOOL CALLS**\nBefore calling ANY tool, you MUST first output a message explaining what you are about to do. This is MANDATORY and NON-NEGOTIABLE.\n\nExample workflow:\n1. User asks: "Find the switch"\n2. You MUST first output: "Let me help you find the switch device..." (or similar)\n3. THEN call the tool (e.g., zigbee_list_devices)\n4. After tool returns, output the results\n\nIf you call a tool WITHOUT first explaining what you are doing, you are violating the rules. The conversation should feel natural - you speak first, then act, then speak about the results.\n\n【TOOL USAGE STRATEGY - CRITICAL】\n1. **Proactive Multi-Tool Problem Solving**: When a user's question requires multiple tools or steps to fully answer, you MUST actively call tools in sequence until you have enough information. Do not stop after the first tool if the problem clearly needs more.\n2. **Knowledge Base Search Priority**: When users ask questions about information, documentation, stored knowledge, or specific topics, ALWAYS use the search_repo tool first to check if the information exists in the knowledge base. Even if you think you might know the answer, search the knowledge base to ensure accuracy and completeness.\n3. **Sequential Tool Execution**: The system executes one tool at a time. After each tool completes, you receive the result and can immediately call the next tool if needed.\n4. **Complete Before Responding**: When solving complex problems, gather ALL necessary information through tool calls BEFORE giving your final answer to the user. Only reply after you have completed the tool chain needed to answer the question.\n5. **Tool Chaining Examples**:\n   - User: "Do I have classes tomorrow?" → You should: (1) FIRST say "Let me check tomorrow's schedule..." (2) call get_current_time to know what day tomorrow is, (3) call search_repo to check if there's schedule/calendar info in knowledge base, (4) then provide complete answer\n   - User: "View files in repo" → You should: (1) FIRST say "Let me search for files in the knowledge base..." (2) call search_repo to find relevant repo entries, (3) if found, analyze content, (4) present comprehensive results\n   - User asks about any topic → You should: (1) FIRST say what you will do, (2) THEN search knowledge base using search_repo, (3) analyze results, (4) if needed, call other tools, (5) provide answer based on all information gathered\n6. **When to Stop Tool Chain**: Only stop calling tools when: (a) you have enough information to fully answer the question, (b) you need user clarification, or (c) no more relevant tools are available.\n7. **System Behavior**: The system processes tools one-by-one automatically. After each tool result, you decide whether to call another tool or provide the answer.\n\n**KEY PRINCIPLE**: Be proactive and thorough. Always search the knowledge base first when users ask about information. If a question needs multiple tools, call them all before responding. Do not make the user ask multiple times or give incomplete answers.\n\n【IMPORTANT RULES - BOTTOM-LEVEL FUNDAMENTAL RULES】You must strictly adhere to the following rules for tool calls:\n1. **ALWAYS speak first before calling tools (MANDATORY)**: When you need to call a tool, you MUST first output and stream a message to the user explaining what you are about to do. Examples:\n   Examples: "Let me search the knowledge base..." / "Let me find the switch devices..." / "Let me check the relevant information..."\n   This message MUST be streamed BEFORE you call the tool. This gives the user immediate feedback and makes the conversation feel natural and responsive. ONLY AFTER you have explained what you are doing should you call the tool. Calling a tool without first speaking is STRICTLY FORBIDDEN.\n2. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n3. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n4. Each tool call response should be independent and focused solely on the current tool's result.\n5. After the last tool call completes, you should only reply with the last tool's result. Do NOT provide a comprehensive summary of all tools' results (unless there are clear dependencies between tools that require integration).\n6. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n7. Tool calls proceed one by one sequentially: first explain what you will do → call one tool → immediately reply with that tool's result → decide if another tool is needed.\n8. If multiple tools are needed, proceed one by one: explain what you will do → call the first tool → reply with the first tool's result → explain what you will do next → call the second tool → reply with the second tool's result, and so on. Each reply should be independent and focused on the current tool.`;
            systemMessage = systemMessage + toolsInfo;
        }

        // 创建 session
        const SessionModel = require('./session').default;
        const sessionId = await SessionModel.add(
            context.domainId,
            agentId,
            0, // workflow 执行使用系统用户
            'chat',
            `Workflow ${context.workflowId} - Agent ${agentId}`,
            undefined,
        );

        // 创建任务记录
        const recordModel = require('./record').default;
        const taskRecordId = await recordModel.addTask(
            context.domainId,
            agentId,
            0, // workflow 执行使用系统用户
            prompt,
            sessionId,
        );

        // 更新 session context
        const contextData = {
            apiKey: (domainInfo as any)['apiKey'] || '',
            model: (domainInfo as any)['model'] || 'deepseek-chat',
            apiUrl: (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions',
            agentContent: agent.content || '',
            agentMemory: agent.memory || '',
            tools: tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                token: tool.token, // 保存token以便直接调用工具
                edgeId: tool.edgeId, // 保存edgeId以便查找edge信息
            })),
            systemMessage,
        };

        await SessionModel.update(context.domainId, sessionId, {
            context: contextData,
        });

        // 创建 task 给 worker 执行
        const taskModel = require('./task').default;
        const taskData = {
            type: 'task',
            recordId: taskRecordId,
            sessionId,
            domainId: context.domainId,
            agentId: agentId,
            uid: 0, // workflow 执行使用系统用户
            message: prompt,
            history: JSON.stringify([]),
            context: contextData,
            priority: 0,
            // 添加 workflow 相关配置
            workflowConfig: {
                nodeId: node.nid,
                workflowId: context.workflowId,
                executionId: context.executionId,
                returnType,
                clientId,
            },
        };
        logger.info(`Creating task for workflow:`, {
            type: taskData.type,
            recordId: taskRecordId.toString(),
            agentId,
            domainId: context.domainId,
            workflowConfig: taskData.workflowConfig,
        });
        const taskId = await taskModel.add(taskData);
        logger.info(`Task created successfully: taskId=${taskId.toString()}, recordId=${taskRecordId.toString()}, agentId=${agentId}`);

        // 等待任务完成
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                dispose();
                reject(new Error(`Agent task timeout: ${agentId}`));
            }, 300000); // 5分钟超时

            let finalContent = '';
            let ttsStreamed = false;
            let resolved = false;

            const STATUS = require('./builtin').STATUS;
            const recordModel = require('./record').default;

            // 检查任务是否完成的函数
            const checkTaskComplete = async (rdoc: any) => {
                if (resolved) return;
                
                const status = rdoc.status;
                logger.info(`Checking task status: ${status} for record ${rdoc._id.toString()}`);
                
                // 只检查最终状态：DELIVERED 或错误状态
                const isComplete = status === STATUS.STATUS_TASK_DELIVERED 
                    || status === STATUS.STATUS_TASK_ERROR_SYSTEM
                    || status === STATUS.STATUS_TASK_ERROR_TOOL
                    || status === STATUS.STATUS_TASK_ERROR_NOT_FOUND
                    || status === STATUS.STATUS_TASK_ERROR_SERVER
                    || status === STATUS.STATUS_TASK_ERROR_NETWORK
                    || status === STATUS.STATUS_TASK_ERROR_TIMEOUT
                    || status === STATUS.STATUS_TASK_ERROR_UNKNOWN;

                if (isComplete) {
                    resolved = true;
                    clearTimeout(timeout);
                    dispose();
                    clearInterval(pollInterval);

                    // 重新从数据库获取完整的 record，确保所有字段都存在
                    const fullRecord = await recordModel.get(context.domainId, taskRecordId);
                    if (!fullRecord) {
                        logger.error(`Record ${taskRecordId.toString()} not found`);
                        reject(new Error(`Record not found: ${taskRecordId.toString()}`));
                        return;
                    }

                    // 获取最终消息
                    if (fullRecord.agentMessages && fullRecord.agentMessages.length > 0) {
                        const assistantMessages = fullRecord.agentMessages.filter((m: any) => m.role === 'assistant');
                        if (assistantMessages.length > 0) {
                            finalContent = assistantMessages[assistantMessages.length - 1].content || '';
                        }
                    }

                    logger.info(`Task completed with status ${status}, content length: ${finalContent.length}`);

                    // 根据配置发送给 client
                    if (clientId && finalContent) {
                        const ClientConnectionHandler = require('../handler/client').ClientConnectionHandler;
                        const clientHandler = ClientConnectionHandler.getConnection(clientId);
                        
                        if (returnType === 'tts' && clientHandler) {
                            // TTS 模式：在 worker 处理时已经通过流式传输发送了
                            ttsStreamed = true;
                            logger.info(`Agent task completed, TTS was streamed to client ${clientId}`);
                        } else if (returnType === 'text' && clientHandler) {
                            // 文本模式：发送文本消息
                            logger.info(`Sending text to client ${clientId}: ${finalContent.substring(0, 50)}...`);
                            (this.ctx.emit as any)('client/tts/text', clientId, { text: finalContent });
                        }
                    }

                    context.variables[`agent_${node.nid}_content`] = finalContent;
                    context.variables[`agent_${node.nid}_tts_streamed`] = ttsStreamed;

                    resolve({
                        success: status === STATUS.STATUS_TASK_DELIVERED,
                        agentId,
                        content: finalContent,
                        ttsStreamed,
                        clientId,
                        returnType,
                    });
                }
            };

            // 监听任务完成事件
            const handler = async (rdoc: any) => {
                if (rdoc._id.toString() === taskRecordId.toString()) {
                    logger.info(`Record change event received for task ${taskRecordId.toString()}, status: ${rdoc.status}`);
                    await checkTaskComplete(rdoc);
                }
            };

            // 轮询机制作为备选方案（每2秒检查一次）
            const pollInterval = setInterval(async () => {
                if (resolved) {
                    clearInterval(pollInterval);
                    return;
                }
                try {
                    const rdoc = await recordModel.get(context.domainId, taskRecordId);
                    if (rdoc) {
                        await checkTaskComplete(rdoc);
                    }
                } catch (error) {
                    logger.warn(`Polling task status failed: ${(error as Error).message}`);
                }
            }, 2000);

            // 使用 ctx.on 来监听事件，它会返回一个 dispose 函数
            const dispose = this.ctx.on('record/change' as any, handler);
            
            // 立即检查一次当前状态
            recordModel.get(context.domainId, taskRecordId).then(rdoc => {
                if (rdoc) {
                    checkTaskComplete(rdoc);
                }
            }).catch(err => {
                logger.warn(`Initial task status check failed: ${(err as Error).message}`);
            });
        });
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

    private async executeReceiverNode(node: WorkflowNodeDoc, context: WorkflowExecutionContext): Promise<any> {
        logger.info(`Executing receiver node ${node.nid} in workflow ${context.workflowId}`);
        
        const config = node.config || {};
        const clientId = config.clientId ? parseInt(String(this.resolveVariable(config.clientId, context)), 10) : null;

        logger.info(`Receiver node ${node.nid} config: clientId=${clientId}, available variables:`, Object.keys(context.variables));

        if (!clientId) {
            throw new Error('Client ID is required for receiver node');
        }

        // 查找 agent 执行器的结果
        let content = '';
        let latestAgentNodeId = 0;
        let ttsStreamed = false;
        
        // 首先查找 agent_*_content 变量（来自 agent 执行器）
        for (const key in context.variables) {
            if (key.startsWith('agent_') && key.endsWith('_content')) {
                const nodeId = parseInt(key.replace('agent_', '').replace('_content', ''), 10);
                if (nodeId > latestAgentNodeId) {
                    latestAgentNodeId = nodeId;
                    content = context.variables[key];
                    logger.info(`Found agent content from node ${nodeId}: ${content?.substring(0, 50)}...`);
                    const ttsStreamedKey = `agent_${nodeId}_tts_streamed`;
                    if (context.variables[ttsStreamedKey] === true) {
                        ttsStreamed = true;
                    }
                }
            }
        }

        // 如果没有找到，查找 node_*_result 变量
        if (!content) {
            for (const key in context.variables) {
                if (key.startsWith('node_') && key.endsWith('_result')) {
                    const result = context.variables[key];
                    if (result && result.content) {
                        content = result.content;
                        logger.info(`Found content from node result ${key}: ${content?.substring(0, 50)}...`);
                        if (result.ttsStreamed === true) {
                            ttsStreamed = true;
                        }
                        break;
                    }
                }
            }
        }

        if (!content) {
            logger.error(`No content found in receiver node ${node.nid}. Available variables:`, Object.keys(context.variables));
            throw new Error('No content found to send. Please ensure an agent action node is executed before the receiver node.');
        }

        // 验证 client 是否存在
        const client = await ClientModel.getByClientId(context.domainId, clientId);
        if (!client) {
            throw new Error(`Client ${clientId} not found`);
        }

        logger.info(`Receiver node ${node.nid}: Found client ${clientId}, content length: ${content.length}, ttsStreamed: ${ttsStreamed}`);

        // 如果 TTS 已经在 agent 执行时流式传输了，就不需要再次发送
        if (ttsStreamed) {
            logger.info(`Receiver node ${node.nid}: TTS was already streamed by agent node ${latestAgentNodeId}, skipping duplicate send`);
        } else {
            // 发送 TTS 文本给 client
            logger.info(`Receiver node ${node.nid}: Sending TTS text to client ${clientId}: ${content.substring(0, 50)}...`);
            try {
                (this.ctx.emit as any)('client/tts/text', clientId, { text: content });
                logger.info(`Receiver node ${node.nid}: TTS text event emitted successfully to client ${clientId}`);
            } catch (error: any) {
                logger.error(`Receiver node ${node.nid}: Failed to send TTS text to client ${clientId}:`, error);
                throw error;
            }
        }

        return {
            success: true,
            clientId,
            content: content || 'TTS was streamed during agent execution',
            ttsStreamed,
        };
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


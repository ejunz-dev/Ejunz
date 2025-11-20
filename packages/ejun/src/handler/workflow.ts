import { ObjectId } from 'mongodb';
import { Handler, ConnectionHandler, param, subscribe, Types } from '@ejunz/framework';
import { Context } from '../context';
import { ValidationError, PermissionError, NotFoundError } from '../error';
import { Logger } from '../logger';
import WorkflowModel from '../model/workflow';
import WorkflowNodeModel from '../model/workflow_node';
import WorkflowTimerModel from '../model/workflow_timer';
import WorkflowExecutor from '../model/workflow_executor';
import { PRIV } from '../model/builtin';

const logger = new Logger('handler/workflow');

// 获取工作流列表
export class WorkflowDomainHandler extends Handler<Context> {
    async get() {
        const { page = 1 } = this.request.query;
        const workflows = await WorkflowModel.getByDomain(this.domain._id);
        // 按 wid 排序
        workflows.sort((a, b) => (a.wid || 0) - (b.wid || 0));
        this.response.template = 'workflow_domain.html';
        this.response.body = { workflows, domainId: this.domain._id };
    }
}

// 创建/编辑工作流基本信息（只处理 name 和 description）
export class WorkflowEditHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { wid } = this.request.params;
        
        let workflow = null;
        if (wid) {
            const widNum = parseInt(wid, 10);
            if (!isNaN(widNum) && widNum >= 1) {
                workflow = await WorkflowModel.getByWorkflowId(this.domain._id, widNum);
                if (workflow) {
                    // 检查权限
                    if (workflow.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
                        throw new PermissionError(PRIV.PRIV_USER_PROFILE);
                    }
                }
            }
        }

        this.response.template = 'workflow_edit.html';
        this.response.body = { workflow };
    }

    async postCreate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { name, description } = this.request.body;
        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }

        const workflow = await WorkflowModel.add({
            domainId: this.domain._id,
            name,
            description,
            owner: this.user._id,
        });

        this.response.redirect = `/workflow/${workflow.wid}`;
    }

    async postUpdate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { wid } = this.request.params;
        const { name, description, enabled, status } = this.request.body;
        
        const widNum = parseInt(wid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }

        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }

        const workflow = await WorkflowModel.getByWorkflowId(this.domain._id, widNum);
        if (!workflow) {
            throw new ValidationError('wid');
        }

        // 检查权限
        if (workflow.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const update: any = { name, description };
        if (enabled !== undefined) update.enabled = enabled === true || enabled === 'true';
        if (status) update.status = status;

        await WorkflowModel.update(this.domain._id, widNum, update);
        
        // 如果启用了工作流，注册定时器
        if (update.enabled === true) {
            if (WorkflowModel.registerTimers) {
                await WorkflowModel.registerTimers(this.domain._id, widNum);
            }
        }
        
        this.response.redirect = `/workflow/${widNum}`;
    }
}

// 编辑工作流节点流程图
export class WorkflowEditFlowHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { wid } = this.request.params;
        
        const widNum = parseInt(wid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }

        const workflow = await WorkflowModel.getByWorkflowId(this.domain._id, widNum);
        if (!workflow) {
            throw new ValidationError('wid');
        }

        // 检查权限
        if (workflow.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // 获取节点
        const nodes = await WorkflowNodeModel.getByWorkflow(this.domain._id, workflow.docId);
        logger.debug(`Found ${nodes.length} nodes for workflow ${widNum}`);
        
        // 清理节点数据，将 ObjectId 转换为字符串，以便 JSON 序列化
        const cleanedNodes = nodes.map(node => {
            // 确保 position 是有效的对象
            let position = { x: 0, y: 0 };
            if (node.position && typeof node.position === 'object' && !Array.isArray(node.position)) {
                position = {
                    x: typeof node.position.x === 'number' ? node.position.x : 0,
                    y: typeof node.position.y === 'number' ? node.position.y : 0,
                };
            }
            
            // 清理 config，确保所有值都是可序列化的
            let config: Record<string, any> = {};
            if (node.config && typeof node.config === 'object' && !Array.isArray(node.config)) {
                try {
                    // 深度清理 config，移除不可序列化的值
                    config = JSON.parse(JSON.stringify(node.config, (key, value) => {
                        // 移除 ObjectId、Date 等不可序列化的对象
                        if (value && typeof value === 'object') {
                            if (value.constructor && value.constructor.name === 'ObjectId') {
                                return value.toString();
                            }
                            if (value instanceof Date) {
                                return value.toISOString();
                            }
                            // 如果是普通对象或数组，继续处理
                            if (Array.isArray(value) || value.constructor === Object) {
                                return value;
                            }
                            // 其他对象类型，尝试转换为字符串
                            return String(value);
                        }
                        return value;
                    }));
                } catch (e) {
                    logger.warn(`Failed to clean config for node ${node.nid}:`, e);
                    config = {};
                }
            }
            
            // 清理 connections，确保所有值都是可序列化的
            let connections: Array<{ targetNodeId: number; condition?: string }> = [];
            if (Array.isArray(node.connections)) {
                connections = node.connections.map(conn => {
                    if (conn && typeof conn === 'object') {
                        return {
                            targetNodeId: typeof conn.targetNodeId === 'number' ? conn.targetNodeId : 0,
                            condition: typeof conn.condition === 'string' ? conn.condition : undefined,
                        };
                    }
                    return { targetNodeId: 0 };
                }).filter(conn => conn.targetNodeId > 0);
            }
            
            const cleaned = {
                nid: Number(node.nid) || 0,
                name: String(node.name || ''),
                nodeType: String(node.nodeType || 'unknown'),
                type: String(node.type || 'action'),
                position,
                config,
                connections,
            };
            return cleaned;
        });
        
        // 测试序列化
        try {
            const testJson = JSON.stringify(cleanedNodes);
            logger.debug(`Successfully serialized ${cleanedNodes.length} nodes, JSON length: ${testJson.length}`);
        } catch (serializeError: any) {
            logger.error(`Failed to serialize nodes: ${serializeError.message}`);
            (workflow as any).nodes = [];
            (workflow as any).nodesJson = '[]';
        }
        
        // 直接在 handler 中序列化为 JSON 字符串，避免模板 filter 的问题
        try {
            const nodesJson = JSON.stringify(cleanedNodes);
            (workflow as any).nodes = cleanedNodes;
            (workflow as any).nodesJson = nodesJson; // 预序列化的 JSON 字符串
            logger.debug(`Set workflow.nodes to ${cleanedNodes.length} nodes`);
            
            // 验证 JSON 是否可以重新解析
            try {
                const testParse = JSON.parse(nodesJson);
                logger.debug(`Successfully verified JSON can be parsed, parsed ${testParse.length} nodes`);
            } catch (parseError: any) {
                logger.error(`Failed to verify JSON: ${parseError.message}`);
                (workflow as any).nodesJson = '[]';
            }
        } catch (e: any) {
            logger.error(`Failed to pre-serialize nodes: ${e.message}`);
            (workflow as any).nodes = [];
            (workflow as any).nodesJson = '[]';
        }

        this.response.template = 'workflow_editFlow.html';
        this.response.body = { workflow };
    }
}

// 获取工作流详情
export class WorkflowDetailHandler extends Handler<Context> {
    async get() {
        const { wid } = this.request.params;
        
        // 如果 wid 包含点号（如 .css.map），说明是静态资源，不应该匹配这个路由
        if (wid && (wid.includes('.') || !/^\d+$/.test(wid))) {
            // 返回 404，让静态资源处理器处理
            throw new NotFoundError(wid);
        }
        
        const widNum = parseInt(wid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }

        const workflow = await WorkflowModel.getByWorkflowId(this.domain._id, widNum);
        if (!workflow) {
            throw new NotFoundError('workflow');
        }

        // 获取所有节点
        const nodes = await WorkflowNodeModel.getByWorkflow(this.domain._id, workflow.docId);
        
        // 清理节点数据，将 ObjectId 转换为字符串，以便 JSON 序列化
        const cleanedNodes = nodes.map(node => {
            // 确保 position 是有效的对象
            let position = { x: 0, y: 0 };
            if (node.position && typeof node.position === 'object' && !Array.isArray(node.position)) {
                position = {
                    x: typeof node.position.x === 'number' ? node.position.x : 0,
                    y: typeof node.position.y === 'number' ? node.position.y : 0,
                };
            }
            
            // 清理 config
            let config: Record<string, any> = {};
            if (node.config && typeof node.config === 'object' && !Array.isArray(node.config)) {
                try {
                    config = JSON.parse(JSON.stringify(node.config, (key, value) => {
                        if (value && typeof value === 'object') {
                            if (value.constructor && value.constructor.name === 'ObjectId') {
                                return value.toString();
                            }
                            if (value instanceof Date) {
                                return value.toISOString();
                            }
                            if (Array.isArray(value) || value.constructor === Object) {
                                return value;
                            }
                            return String(value);
                        }
                        return value;
                    }));
                } catch (e) {
                    config = {};
                }
            }
            
            // 清理 connections
            let connections: Array<{ targetNodeId: number; condition?: string }> = [];
            if (Array.isArray(node.connections)) {
                connections = node.connections.map(conn => {
                    if (conn && typeof conn === 'object') {
                        return {
                            targetNodeId: typeof conn.targetNodeId === 'number' ? conn.targetNodeId : 0,
                            condition: typeof conn.condition === 'string' ? conn.condition : undefined,
                        };
                    }
                    return { targetNodeId: 0 };
                }).filter(conn => conn.targetNodeId > 0);
            }
            
            return {
                nid: Number(node.nid) || 0,
                name: String(node.name || ''),
                nodeType: String(node.nodeType || 'unknown'),
                type: String(node.type || 'action'),
                position,
                config,
                connections,
            };
        });
        
        // 直接在 handler 中序列化为 JSON 字符串
        let nodesJson = '[]';
        try {
            nodesJson = JSON.stringify(cleanedNodes);
        } catch (e: any) {
            logger.error(`Failed to serialize nodes for detail page: ${e.message}`);
        }
        
        // 过滤出按钮触发器节点
        const buttonNodes = cleanedNodes.filter(n => n.nodeType === 'button');

        // 设置 WebSocket 连接 URL
        // 框架会自动添加 domainId，所以只需要相对路径
        const socketUrl = `/d/${this.domain._id}/workflow/${widNum}/ws`;

        this.response.template = 'workflow_detail.html';
        this.response.body = { workflow, nodes: cleanedNodes, nodesJson, buttonNodes, socketUrl };
    }
}

// 工作流详情 WebSocket 连接处理器
class WorkflowDetailConnectionHandler extends ConnectionHandler<Context> {
    wid: number = 0;
    domainId: string = '';
    throttleSend: any;
    private updateInterval: NodeJS.Timeout | null = null;

    @param('wid', Types.PositiveInt)
    async prepare(domainId: string, wid: number) {
        this.wid = wid;
        this.domainId = domainId;
        
        // 使用 throttle 限制发送频率（每秒最多一次）
        const { throttle } = await import('lodash');
        this.throttleSend = throttle(() => this.sendTimerStatus(), 1000, { trailing: true });
        
        // 立即发送一次定时器状态
        await this.sendTimerStatus();
        
        // 定期发送定时器状态更新（每5秒）
        this.updateInterval = setInterval(() => {
            this.throttleSend();
        }, 5000);
    }

    async sendTimerStatus() {
        try {
            // 获取该工作流的所有定时器
            const timers = await WorkflowTimerModel.getByWorkflow(this.domainId, this.wid);
            
            // 构建定时器状态：nodeId -> { executeAfter, interval }
            const timerStatus: Record<number, { executeAfter: string; interval?: [number, string] }> = {};
            timers.forEach(timer => {
                timerStatus[timer.nodeId] = {
                    executeAfter: timer.executeAfter.toISOString(),
                    interval: timer.interval,
                };
            });
            
            this.send({ type: 'timer_status', timers: timerStatus });
        } catch (error) {
            logger.error('Failed to send timer status:', error);
        }
    }

    @subscribe('workflow/timer')
    async onTimerTrigger(domainId: string, workflowId: number, nodeId: number, triggerData: any) {
        // 只处理当前工作流的定时器触发
        if (domainId === this.domainId && workflowId === this.wid) {
            // 定时器触发后，立即更新状态
            await this.sendTimerStatus();
        }
    }
    
    @subscribe('workflow/timer/registered' as any)
    async onTimerRegistered(domainId: string, workflowId: number) {
        // 定时器注册后，立即更新状态
        if (domainId === this.domainId && workflowId === this.wid) {
            logger.info(`Timer registered for workflow ${workflowId}, sending status update`);
            await this.sendTimerStatus();
        }
    }

    async cleanup() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
}

// 工作流节点 API
export class WorkflowNodeHandler extends Handler<Context> {
    async postCreate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const domainId = this.domain._id;
        
        // 从路由参数中获取 wid
        const { wid } = this.request.params;
        const widNum = parseInt(wid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }
        
        logger.debug(`Creating node for workflow ${widNum} in domain ${domainId}`);
        const workflow = await WorkflowModel.getByWorkflowId(domainId, widNum);
        if (!workflow) {
            logger.error(`Workflow ${widNum} not found in domain ${domainId}`);
            throw new NotFoundError('workflow');
        }

        // 检查权限
        if (workflow.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const { name, nodeType, type, position, config, connections } = this.request.body;
        
        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }
        if (!nodeType || typeof nodeType !== 'string') {
            throw new ValidationError('nodeType');
        }

        const validNodeTypes = ['timer', 'button', 'device_control', 'agent_message', 'object_action', 'agent_action', 'condition', 'delay', 'start', 'end'];
        if (!validNodeTypes.includes(nodeType)) {
            throw new ValidationError(`Invalid nodeType: ${nodeType}`);
        }

        const node = await WorkflowNodeModel.add({
            domainId,
            workflowId: widNum,
            workflowDocId: workflow.docId,
            name,
            nodeType: nodeType as 'timer' | 'button' | 'device_control' | 'agent_message' | 'object_action' | 'agent_action' | 'condition' | 'delay' | 'start' | 'end',
            type: type || 'action',
            position: position || { x: 0, y: 0 },
            config: config || {},
            connections: connections || [],
            owner: this.user._id,
        });

        this.response.body = { node };
    }

    async postUpdate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const domainId = this.domain._id;
        
        // 从路由参数中获取 wid 和 nid
        const { wid, nid } = this.request.params;
        const widNum = parseInt(wid, 10);
        const nidNum = parseInt(nid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }
        if (isNaN(nidNum) || nidNum < 1) {
            throw new ValidationError('nid');
        }
        
        const workflow = await WorkflowModel.getByWorkflowId(domainId, widNum);
        if (!workflow) {
            throw new NotFoundError('workflow');
        }

        // 检查权限
        if (workflow.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const node = await WorkflowNodeModel.getByNodeId(domainId, nidNum);
        if (!node || node.workflowId !== widNum) {
            throw new NotFoundError('node');
        }

        const { name, position, config, connections } = this.request.body;
        const update: any = {};
        if (name !== undefined) update.name = name;
        if (position !== undefined) update.position = position;
        if (config !== undefined) update.config = config;
        if (connections !== undefined) update.connections = connections;

        const updatedNode = await WorkflowNodeModel.update(domainId, nidNum, update);
        
        // 如果更新的是定时器节点，且工作流已启用，则注册定时器
        if (updatedNode && updatedNode.nodeType === 'timer') {
            const workflow = await WorkflowModel.getByWorkflowId(domainId, widNum);
            if (workflow && workflow.enabled) {
                logger.info(`Timer node updated, registering timers for workflow ${widNum}`);
                if (WorkflowModel.registerTimers) {
                    await WorkflowModel.registerTimers(domainId, widNum);
                }
            }
        }
        
        this.response.body = { node: updatedNode };
    }

    async postDelete() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const domainId = this.domain._id;
        
        // 从路由参数中获取 wid 和 nid
        const { wid, nid } = this.request.params;
        const widNum = parseInt(wid, 10);
        const nidNum = parseInt(nid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }
        if (isNaN(nidNum) || nidNum < 1) {
            throw new ValidationError('nid');
        }
        
        const workflow = await WorkflowModel.getByWorkflowId(domainId, widNum);
        if (!workflow) {
            throw new NotFoundError('workflow');
        }

        // 检查权限
        if (workflow.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const node = await WorkflowNodeModel.getByNodeId(domainId, nidNum);
        if (!node || node.workflowId !== widNum) {
            throw new NotFoundError('node');
        }

        await WorkflowNodeModel.del(domainId, nidNum);
        this.response.body = { success: true };
    }
}

// 执行工作流
export class WorkflowExecuteHandler extends Handler<Context> {
    async postExecute() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const domainId = this.domain._id;
        
        // 从路由参数中获取 wid
        const { wid } = this.request.params;
        const widNum = parseInt(wid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }
        
        const workflow = await WorkflowModel.getByWorkflowId(domainId, widNum);
        if (!workflow) {
            throw new NotFoundError('workflow');
        }

        // 检查权限
        if (workflow.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const triggerData = this.request.body.triggerData || {};

        const executor = new WorkflowExecutor(this.ctx);
        try {
            await executor.execute(domainId, widNum, triggerData);
            this.response.body = { success: true, message: 'Workflow executed successfully' };
        } catch (error) {
            logger.error('Error executing workflow:', error);
            this.response.body = { success: false, error: error.message || 'Unknown error' };
        }
    }
}

// 触发工作流（用于按钮触发器）
export class WorkflowTriggerHandler extends Handler<Context> {
    async postTrigger() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const domainId = this.domain._id;
        
        // 从路由参数中获取 wid
        const { wid } = this.request.params;
        const widNum = parseInt(wid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }
        
        const workflow = await WorkflowModel.getByWorkflowId(domainId, widNum);
        if (!workflow) {
            throw new NotFoundError('workflow');
        }

        // 编辑模式下允许测试，不检查工作流的启用状态和状态
        // 注释掉启用状态检查，允许在编辑模式下随时测试工作流
        // if (!workflow.enabled) {
        //     throw new ValidationError('Workflow is not enabled');
        // }
        // 
        // if (workflow.status !== 'active') {
        //     throw new ValidationError(`Workflow status is ${workflow.status}, must be active`);
        // }

        // 获取请求体中的 nodeId、triggerType 和 triggerData
        const { nodeId, triggerType, triggerData } = this.request.body || {};
        
        // 检查是否有触发器节点
        const nodes = await WorkflowNodeModel.getByWorkflow(domainId, workflow.docId);
        const triggerNodes = nodes.filter(n => n.nodeType === 'button' || n.nodeType === 'timer');

        if (triggerNodes.length === 0) {
            throw new ValidationError('Workflow does not have a trigger node (button or timer)');
        }

        // 如果指定了 nodeId，验证该节点是否存在且是触发器类型
        let targetNode = null;
        if (nodeId) {
            targetNode = triggerNodes.find(n => n.nid === nodeId);
            if (!targetNode) {
                throw new ValidationError(`Trigger node ${nodeId} not found in workflow ${widNum}`);
            }
        }

        // 确定触发类型
        const actualTriggerType = triggerType || (targetNode ? targetNode.nodeType : 'button');
        
        // 如果是定时器触发，使用定时器事件系统
        if (actualTriggerType === 'timer' && nodeId) {
            logger.info(`Triggering workflow ${widNum} in domain ${domainId} via timer trigger (node ${nodeId})`);
            // 使用定时器事件系统触发工作流
            this.ctx.emit('workflow/timer', domainId, widNum, nodeId, {
                triggerType: 'timer',
                nodeId: nodeId,
                triggeredBy: this.user._id,
                triggeredAt: new Date(),
                ...(triggerData || {}),
            });
        } else {
            // 按钮触发或其他触发
            logger.info(`Triggering workflow ${widNum} in domain ${domainId} via ${actualTriggerType} trigger`);
            // 使用事件系统触发工作流
            this.ctx.emit('workflow/trigger', domainId, widNum, {
                triggerType: actualTriggerType,
                nodeId: nodeId,
                triggeredBy: this.user._id,
                triggeredAt: new Date(),
                ...(triggerData || {}),
            });
        }

        this.response.body = { success: true, message: 'Workflow triggered successfully' };
    }
}

// 切换工作流启用状态
export class WorkflowToggleHandler extends Handler<Context> {
    async postToggle() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const domainId = this.domain._id;
        const { wid } = this.request.params;
        const widNum = parseInt(wid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }
        
        const workflow = await WorkflowModel.getByWorkflowId(domainId, widNum);
        if (!workflow) {
            throw new NotFoundError('workflow');
        }
        
        // 检查权限
        if (workflow.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }
        
        // 切换 enabled 状态
        const newEnabled = !workflow.enabled;
        await WorkflowModel.update(domainId, widNum, { enabled: newEnabled });
        
        // 如果启用了工作流，注册定时器
        if (newEnabled) {
            logger.info(`Workflow toggled to enabled, registering timers for workflow ${widNum}`);
            if (WorkflowModel.registerTimers) {
                await WorkflowModel.registerTimers(domainId, widNum);
            }
        }
        
        this.response.body = { success: true, enabled: newEnabled };
    }
}

// 获取可用节点类型列表
export class WorkflowNodeTypesHandler extends Handler<Context> {
    async get() {
        // 节点类型分为两大类：触发器(trigger)和执行(action)
        const nodeTypes = {
            trigger: [
                {
                    nodeType: 'timer',
                    name: '定时器',
                    description: '在指定时间触发工作流，支持循环执行',
                    configSchema: {
                        time: { type: 'string', description: '时间格式（可选）：按分钟循环时使用 :ss (如 :30 表示每分钟的第30秒)，不填写则从当前时间开始每N分钟执行；按小时循环时使用 mm:ss (如 30:00 表示每小时的30分0秒)；按天/周/月循环时使用 HH:mm (如 22:00)' },
                        interval: { 
                            type: 'string', 
                            enum: ['minute', 'hour', 'day', 'week', 'month'],
                            description: '循环间隔：minute(每分钟), hour(每小时), day(每天), week(每周), month(每月)',
                            default: 'day'
                        },
                        intervalValue: { 
                            type: 'number', 
                            description: '间隔数值（如每2小时、每3天等，默认为1）',
                            default: 1
                        },
                        triggerData: { type: 'object', description: '触发时传递的数据' },
                    },
                },
                {
                    nodeType: 'button',
                    name: '按钮',
                    description: '用户点击按钮触发工作流',
                    configSchema: {
                        buttonText: { type: 'string', description: '按钮文本', default: '触发工作流' },
                        buttonStyle: { 
                            type: 'string', 
                            enum: ['primary', 'secondary', 'success', 'warning', 'danger'],
                            description: '按钮样式',
                            default: 'primary'
                        },
                        requireConfirmation: { type: 'boolean', description: '是否需要确认', default: false },
                        confirmationMessage: { type: 'string', description: '确认消息（当需要确认时）', default: '确定要触发此工作流吗？' },
                    },
                },
            ],
            action: [
                {
                    nodeType: 'object_action',
                    name: '对象操作',
                    description: '对指定对象执行操作（如设备控制）',
                    configSchema: {
                        objectType: { 
                            type: 'string', 
                            enum: ['device'],
                            description: '对象类型',
                            default: 'device'
                        },
                        nodeId: { type: 'number', description: '节点ID（用于设备操作）' },
                        deviceId: { type: 'string', description: '设备ID' },
                        action: { type: 'string', enum: ['on', 'off', 'toggle', 'set'], description: '操作类型' },
                        property: { type: 'string', description: '要控制的属性（如 on, brightness）' },
                        value: { type: 'any', description: '设置值（当 action=set 时）' },
                    },
                },
                {
                    nodeType: 'agent_action',
                    name: 'Agent 操作',
                    description: '使用 Agent 执行操作（生成消息、发送私信等）',
                    configSchema: {
                        agentId: { type: 'string', description: 'Agent ID' },
                        prompt: { type: 'string', description: '提示词（支持 ${variable} 变量）' },
                        action: { 
                            type: 'string', 
                            enum: ['message', 'generate'],
                            description: '操作类型：message(发送私信), generate(生成内容)',
                            default: 'message'
                        },
                        userId: { type: 'number', description: '目标用户ID（当 action=message 时）' },
                    },
                },
                {
                    nodeType: 'delay',
                    name: '延迟',
                    description: '延迟执行',
                    configSchema: {
                        delayMs: { type: 'number', description: '延迟时间（毫秒）' },
                    },
                },
            ],
        };

        this.response.body = { nodeTypes };
    }
}

// 获取节点列表（用于对象操作选择）
export class WorkflowNodesListHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const NodeModel = global.Ejunz.model.node;
        const nodes = await NodeModel.getByDomain(this.domain._id);
        this.response.body = { nodes: nodes.map(n => ({ nid: n.nid, name: n.name })) };
    }
}

// 获取设备列表（用于设备操作选择）
export class WorkflowDevicesListHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { nodeId } = this.request.query;
        if (!nodeId) {
            throw new ValidationError('nodeId is required');
        }
        const nodeIdNum = parseInt(nodeId as string, 10);
        if (isNaN(nodeIdNum) || nodeIdNum < 1) {
            throw new ValidationError('nodeId');
        }
        const NodeModel = global.Ejunz.model.node;
        const NodeDeviceModel = global.Ejunz.model.nodeDevice;
        const node = await NodeModel.getByNodeId(this.domain._id, nodeIdNum);
        if (!node) {
            throw new NotFoundError('node');
        }
        const devices = await NodeDeviceModel.getByNode(node._id);
        this.response.body = { devices: devices.map(d => ({ deviceId: d.deviceId, name: d.name, type: d.type })) };
    }
}

// 获取Agent列表（用于Agent操作选择）
export class WorkflowAgentsListHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const Agent = global.Ejunz.model.agent;
        const [agents] = await Agent.list(this.domain._id, {}, 1, 100);
        this.response.body = { agents: agents.map(a => ({ aid: a.aid || a.docId, name: a.title || `Agent ${a.aid || a.docId}` })) };
    }
}

// 获取工作流定时器状态
export class WorkflowTimerStatusHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const domainId = this.domain._id;
        const { wid } = this.request.params;
        const widNum = parseInt(wid, 10);
        if (isNaN(widNum) || widNum < 1) {
            throw new ValidationError('wid');
        }
        
        const workflow = await WorkflowModel.getByWorkflowId(domainId, widNum);
        if (!workflow) {
            throw new NotFoundError('workflow');
        }
        
        // 获取该工作流的所有定时器
        const timers = await WorkflowTimerModel.getByWorkflow(domainId, widNum);
        
        // 返回定时器状态：nodeId -> { executeAfter, interval }
        const timerStatus: Record<number, { executeAfter: string; interval?: [number, string] }> = {};
        timers.forEach(timer => {
            timerStatus[timer.nodeId] = {
                executeAfter: timer.executeAfter.toISOString(),
                interval: timer.interval,
            };
        });
        
        
        this.response.body = { timers: timerStatus };
    }
}

export async function apply(ctx: Context) {
    // 先注册没有参数的路由，避免被 :wid 路由匹配
    ctx.Route('workflow_node_types', '/workflow/node-types', WorkflowNodeTypesHandler);
    ctx.Route('workflow_nodes_list', '/workflow/nodes', WorkflowNodesListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_devices_list', '/workflow/devices', WorkflowDevicesListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_agents_list', '/workflow/agents', WorkflowAgentsListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_domain', '/workflow', WorkflowDomainHandler);
    ctx.Route('workflow_create', '/workflow/create', WorkflowEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_edit', '/workflow/:wid/edit', WorkflowEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_editFlow', '/workflow/:wid/editFlow', WorkflowEditFlowHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_node', '/workflow/:wid/node', WorkflowNodeHandler, PRIV.PRIV_USER_PROFILE);
    // 先注册更具体的删除路由，避免被更新路由匹配
    ctx.Route('workflow_node_delete', '/workflow/:wid/node/:nid/delete', WorkflowNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_node_update', '/workflow/:wid/node/:nid', WorkflowNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_execute', '/workflow/:wid/execute', WorkflowExecuteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_trigger', '/workflow/:wid/trigger', WorkflowTriggerHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('workflow_timer_status', '/workflow/:wid/timer-status', WorkflowTimerStatusHandler, PRIV.PRIV_USER_PROFILE);
    // 先注册更具体的 toggle 路由，避免被 detail 路由匹配
    ctx.Route('workflow_toggle', '/workflow/:wid/toggle', WorkflowToggleHandler, PRIV.PRIV_USER_PROFILE);
    // 最后注册 :wid 路由，作为兜底
    ctx.Route('workflow_detail', '/workflow/:wid', WorkflowDetailHandler);
    // WebSocket 连接
    ctx.Connection('workflow_detail_conn', '/workflow/:wid/ws', WorkflowDetailConnectionHandler);
}


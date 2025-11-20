import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import db from '../service/db';
import * as document from './document';
import type { WorkflowDoc } from '../interface';
import WorkflowNodeModel from './workflow_node';
import WorkflowTimerModel from './workflow_timer';
import WorkflowExecutor from './workflow_executor';

const logger = new Logger('model/workflow');

class WorkflowModel {
    static async generateNextWorkflowId(domainId: string): Promise<number> {
        const lastWorkflow = await document.getMulti(domainId, document.TYPE_WORKFLOW, {})
            .sort({ wid: -1 })
            .limit(1)
            .project({ wid: 1 })
            .toArray();
        return (lastWorkflow[0]?.wid || 0) + 1;
    }

    static async add(workflow: Partial<WorkflowDoc> & { domainId: string; name: string; owner: number }): Promise<WorkflowDoc> {
        const wid = await this.generateNextWorkflowId(workflow.domainId);
        const now = new Date();
        
        const payload: Partial<WorkflowDoc> = {
            domainId: workflow.domainId,
            wid,
            name: workflow.name,
            description: workflow.description,
            status: workflow.status || 'inactive',
            enabled: workflow.enabled !== undefined ? workflow.enabled : false,
            createdAt: now,
            updatedAt: now,
            owner: workflow.owner,
        };

        await document.add(
            workflow.domainId,
            workflow.name, // content
            workflow.owner,
            document.TYPE_WORKFLOW,
            null, // 让系统自动生成 docId
            null,
            null,
            payload,
        );

        return await this.getByWorkflowId(workflow.domainId, wid) as WorkflowDoc;
    }

    static async get(_id: ObjectId): Promise<WorkflowDoc | null> {
        const doc = await document.coll.findOne({ _id });
        if (!doc) return null;
        return await this.getByWorkflowId(doc.domainId, doc.wid);
    }

    static async getByWorkflowId(domainId: string, wid: number): Promise<WorkflowDoc | null> {
        const workflows = await document.getMulti(domainId, document.TYPE_WORKFLOW, { wid })
            .limit(1)
            .toArray();
        return (workflows[0] as WorkflowDoc) || null;
    }

    static async getByDomain(domainId: string): Promise<WorkflowDoc[]> {
        return await document.getMulti(domainId, document.TYPE_WORKFLOW, {}).toArray() as WorkflowDoc[];
    }

    static async getByOwner(domainId: string, owner: number): Promise<WorkflowDoc[]> {
        return await document.getMulti(domainId, document.TYPE_WORKFLOW, { owner }).toArray() as WorkflowDoc[];
    }

    static async getActive(domainId: string): Promise<WorkflowDoc[]> {
        return await document.getMulti(domainId, document.TYPE_WORKFLOW, { 
            enabled: true, 
            status: 'active' 
        }).toArray() as WorkflowDoc[];
    }

    static async update(domainId: string, wid: number, update: Partial<WorkflowDoc>): Promise<WorkflowDoc> {
        const workflow = await this.getByWorkflowId(domainId, wid);
        if (!workflow) throw new Error('Workflow not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_WORKFLOW, workflow.docId, $set) as WorkflowDoc;
    }

    static async del(domainId: string, wid: number) {
        const workflow = await this.getByWorkflowId(domainId, wid);
        if (!workflow) return;
        // 删除工作流时同时删除所有节点
        const nodes = await WorkflowNodeModel.getByWorkflow(domainId, workflow.docId);
        for (const node of nodes) {
            await WorkflowNodeModel.del(domainId, node.nid);
        }
        return await document.deleteOne(domainId, document.TYPE_WORKFLOW, workflow.docId);
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', async (domainId) => {
        const workflows = await document.getMulti(domainId, document.TYPE_WORKFLOW, {}).toArray();
        for (const workflow of workflows) {
            const nodes = await WorkflowNodeModel.getByWorkflow(domainId, workflow.docId);
            for (const node of nodes) {
                await WorkflowNodeModel.del(domainId, node.nid);
            }
        }
        // 删除相关的定时任务
        await WorkflowTimerModel.deleteMany({ domainId });
    });

    const executor = new WorkflowExecutor(ctx);

    // 监听工作流触发事件（使用 Cordis 事件系统）
    // 注意：事件处理函数会自动检查 domainId，因为事件参数中包含了 domainId
    ctx.on('workflow/trigger', async (domainId: string, workflowId: number, triggerData?: Record<string, any>) => {
        logger.info(`Workflow trigger event received: workflow ${workflowId} in domain ${domainId}`);
        try {
            // 验证 domainId 和工作流是否存在且属于该 domain
            const workflow = await WorkflowModel.getByWorkflowId(domainId, workflowId);
            if (!workflow || workflow.domainId !== domainId) {
                logger.warn(`Workflow ${workflowId} not found or domain mismatch in domain ${domainId}`);
                return;
            }
            await executor.execute(domainId, workflowId, triggerData || {});
        } catch (error) {
            logger.error(`Error executing workflow ${workflowId} in domain ${domainId}:`, error);
        }
    });

    // 监听定时器触发事件
    ctx.on('workflow/timer', async (domainId: string, workflowId: number, nodeId: number, triggerData?: Record<string, any>) => {
        logger.info(`Workflow timer event received: workflow ${workflowId}, node ${nodeId} in domain ${domainId}`);
        // 验证 domainId
        const workflow = await WorkflowModel.getByWorkflowId(domainId, workflowId);
        if (!workflow || workflow.domainId !== domainId) {
            logger.warn(`Workflow ${workflowId} not found or domain mismatch in domain ${domainId}`);
            return;
        }
        // 触发工作流执行
        ctx.emit('workflow/trigger', domainId, workflowId, triggerData);
    });

    // 监听设备状态更新事件，用于触发基于设备状态的工作流
    // 注意：这个事件在 mqtt.ts 中发出，格式为 'node/device/update': (nodeId, deviceId, state)
    // 使用类型断言绕过类型检查，因为这个事件不在 EventMap 中定义
    (ctx.on as any)('node/device/update', async (nodeId: ObjectId, deviceId: string, state: Record<string, any>) => {
        try {
            // 获取节点信息以获取 domainId
            const NodeModel = global.Ejunz.model.node;
            const node = await NodeModel.get(nodeId);
            if (!node) return;

            const domainId = node.domainId;
            
            // 查找该 domain 下所有活跃的工作流，检查是否有基于设备状态的触发器
            // 这里可以扩展为支持设备状态触发器节点
            // 目前先记录日志，后续可以添加设备状态触发器
            logger.debug(`Device ${deviceId} updated in node ${nodeId}, domain ${domainId}, state:`, state);
            
            // TODO: 查找匹配的设备状态触发器节点并触发工作流
            // const workflows = await WorkflowModel.getActive(domainId);
            // for (const workflow of workflows) {
            //     const deviceTriggerNodes = await document.getMulti(domainId, document.TYPE_WORKFLOW_NODE, {
            //         workflowDocId: workflow.docId,
            //         nodeType: 'device_trigger',
            //         'config.deviceId': deviceId,
            //     }).toArray();
            //     for (const triggerNode of deviceTriggerNodes) {
            //         ctx.emit('workflow/trigger', domainId, workflow.wid, {
            //             deviceId,
            //             state,
            //             triggerNode: triggerNode.nid,
            //         });
            //     }
            // }
        } catch (error) {
            logger.error('Error handling device update event for workflow trigger:', error);
        }
    });

    // 定时器轮询机制（仅在主进程，用于检查定时器并发出事件）
    ctx.inject(['worker'], async (c) => {
        // 轮询工作流定时器任务，触发事件而不是直接执行
        const consumeWorkflowTimers = async () => {
            while (true) {
                try {
                    const timer = await WorkflowTimerModel.getFirst({});
                    if (timer) {
                        // 发出定时器事件，事件系统会处理 domainId 检查
                        logger.info(`Timer triggered for workflow ${timer.workflowId} in domain ${timer.domainId}`);
                        ctx.emit('workflow/timer', timer.domainId, timer.workflowId, timer.nodeId, timer.triggerData || {});
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待1秒
                    }
                } catch (error) {
                    logger.error('Error consuming workflow timers:', error);
                    await new Promise(resolve => setTimeout(resolve, 5000)); // 出错后等待5秒
                }
            }
        };

        // 启动定时器消费者（仅在主进程）
        if (process.env.NODE_APP_INSTANCE === '0') {
            setTimeout(() => {
                consumeWorkflowTimers().catch(err => {
                    logger.error('Failed to start workflow timer consumer:', err);
                });
            }, 2000);
        }

        // 检查并注册所有活跃工作流的定时器节点
        const checkAndRegisterTimers = async () => {
            // 使用全局模型对象访问 domain
            const DomainModel = global.Ejunz.model.domain;
            const domains = await DomainModel.getMulti({}).toArray();
            for (const domain of domains) {
                const workflows = await WorkflowModel.getActive(domain._id);
                for (const workflow of workflows) {
                    const timerNodes = await document.getMulti(domain._id, document.TYPE_WORKFLOW_NODE, {
                        workflowDocId: workflow.docId,
                        nodeType: 'timer',
                    }).toArray();
                    
                    for (const timerNode of timerNodes) {
                        const config = timerNode.config || {};
                        const scheduleId = `workflow_${workflow.wid}_timer_${timerNode.nid}`;
                        
                        // 检查是否已存在定时任务
                        const existing = await WorkflowTimerModel.getByNode(domain._id, workflow.wid, timerNode.nid);
                        
                        if (!existing && config.time) {
                            const moment = (await import('moment-timezone')).default;
                            const interval = config.interval || 'day';
                            const intervalValue = config.intervalValue || 1;
                            
                            let executeAfter: Date;
                            
                            if (interval === 'hour') {
                                // 每小时执行：解析分钟和秒
                                const timeParts = config.time.split(':');
                                const minute = parseInt(timeParts[1] || '0', 10);
                                const second = parseInt(timeParts[2] || '0', 10);
                                
                                executeAfter = moment().minute(minute).second(second).millisecond(0).toDate();
                                
                                // 如果时间已过，设置为下一个间隔
                                if (executeAfter < new Date()) {
                                    executeAfter = moment().add(intervalValue, 'hour').minute(minute).second(second).millisecond(0).toDate();
                                }
                            } else {
                                // 每天/每周/每月执行：解析小时和分钟
                                const [hour, minute] = config.time.split(':').map(Number);
                                executeAfter = moment().hour(hour).minute(minute || 0).second(0).millisecond(0).toDate();
                                
                                // 如果时间已过，设置为下一个间隔
                                if (executeAfter < new Date()) {
                                    if (interval === 'day') {
                                        executeAfter = moment().add(intervalValue, 'day').hour(hour).minute(minute || 0).second(0).millisecond(0).toDate();
                                    } else if (interval === 'week') {
                                        executeAfter = moment().add(intervalValue, 'week').hour(hour).minute(minute || 0).second(0).millisecond(0).toDate();
                                    } else if (interval === 'month') {
                                        executeAfter = moment().add(intervalValue, 'month').hour(hour).minute(minute || 0).second(0).millisecond(0).toDate();
                                    }
                                }
                            }
                            
                            // 构建 interval 数组
                            let intervalArray: [number, string];
                            if (interval === 'hour') {
                                intervalArray = [intervalValue, 'hour'];
                            } else if (interval === 'day') {
                                intervalArray = [intervalValue, 'day'];
                            } else if (interval === 'week') {
                                intervalArray = [intervalValue, 'week'];
                            } else if (interval === 'month') {
                                intervalArray = [intervalValue, 'month'];
                            } else {
                                intervalArray = [1, 'day']; // 默认每天
                            }
                            
                            await WorkflowTimerModel.add({
                                domainId: domain._id,
                                workflowId: workflow.wid,
                                nodeId: timerNode.nid,
                                executeAfter,
                                interval: intervalArray,
                                triggerData: config.triggerData || {},
                            });
                            logger.info(`Registered timer for workflow ${workflow.wid}, node ${timerNode.nid} at ${config.time}, interval: ${intervalValue} ${interval}`);
                        }
                    }
                }
            }
        };

        // 启动时检查一次
        if (process.env.NODE_APP_INSTANCE === '0') {
            setTimeout(checkAndRegisterTimers, 5000); // 延迟5秒执行，确保其他模块已加载
        }
    });

    if (process.env.NODE_APP_INSTANCE !== '0') return;
    // document 集合的索引由 document 模块管理
}

export default WorkflowModel;

// 导出到全局类型系统
global.Ejunz.model.workflow = WorkflowModel;


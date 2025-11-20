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
    static registerTimers: ((domainId: string, workflowId: number) => Promise<void>) | undefined;
    
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
            null, // Let system auto-generate docId
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
        // Delete all nodes when deleting workflow
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
        // Delete related timer tasks
        await WorkflowTimerModel.deleteMany({ domainId });
    });

    const executor = new WorkflowExecutor(ctx);

    // Listen to workflow trigger events (using Cordis event system)
    // Note: Event handlers automatically check domainId as it's included in event parameters
    ctx.on('workflow/trigger', async (domainId: string, workflowId: number, triggerData?: Record<string, any>) => {
        logger.info(`Workflow trigger event received: workflow ${workflowId} in domain ${domainId}`);
        try {
            // Verify domainId and check if workflow exists and belongs to the domain
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

    // Listen to timer trigger events
    ctx.on('workflow/timer', async (domainId: string, workflowId: number, nodeId: number, triggerData?: Record<string, any>) => {
        logger.info(`Workflow timer event received: workflow ${workflowId}, node ${nodeId} in domain ${domainId}`);
        // Verify domainId
        const workflow = await WorkflowModel.getByWorkflowId(domainId, workflowId);
        if (!workflow || workflow.domainId !== domainId) {
            logger.warn(`Workflow ${workflowId} not found or domain mismatch in domain ${domainId}`);
            return;
        }
        // Trigger workflow execution, ensuring nodeId is passed
        ctx.emit('workflow/trigger', domainId, workflowId, {
            nodeId: nodeId,
            triggerType: 'timer',
            ...(triggerData || {}),
        });
    });

    // Listen to device state update events for triggering device-state-based workflows
    // Note: This event is emitted in mqtt.ts with format 'node/device/update': (nodeId, deviceId, state)
    // Use type assertion to bypass type checking as this event is not defined in EventMap
    (ctx.on as any)('node/device/update', async (nodeId: ObjectId, deviceId: string, state: Record<string, any>) => {
        try {
            // Get node information to retrieve domainId
            const NodeModel = global.Ejunz.model.node;
            const node = await NodeModel.get(nodeId);
            if (!node) return;

            const domainId = node.domainId;
            
            // Find all active workflows in the domain and check for device-state-based triggers
            // This can be extended to support device state trigger nodes
            // TODO: Find matching device state trigger nodes and trigger workflows
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

    // Timer polling mechanism (only in main process, for checking timers and emitting events)
    ctx.inject(['worker'], async (c) => {
        // Poll workflow timer tasks, emit events instead of executing directly
        const consumeWorkflowTimers = async () => {
            let iterationCount = 0;
            while (true) {
                try {
                    iterationCount++;
                    const timer = await WorkflowTimerModel.getFirst({});
                    if (timer) {
                        // Emit timer event, event system will handle domainId check
                        try {
                            ctx.emit('workflow/timer', timer.domainId, timer.workflowId, timer.nodeId, timer.triggerData || {});
                        } catch (emitError) {
                            logger.error(`Error emitting workflow/timer event:`, emitError);
                        }
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
                    }
                } catch (error) {
                    logger.error('Error consuming workflow timers:', error);
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds after error
                }
            }
        };

        // Start timer consumer (only in main process)
        if (process.env.NODE_APP_INSTANCE === '0') {
            setTimeout(() => {
                consumeWorkflowTimers().catch(err => {
                    logger.error('Failed to start workflow timer consumer:', err);
                });
            }, 2000);
        }

        // Register timer nodes for a single workflow
        const registerWorkflowTimers = async (domainId: string, workflowId: number) => {
            const workflow = await WorkflowModel.getByWorkflowId(domainId, workflowId);
            
            if (!workflow || !workflow.enabled) {
                return; // Only register enabled workflows
            }
            
            const timerNodes = await document.getMulti(domainId, document.TYPE_WORKFLOW_NODE, {
                workflowDocId: workflow.docId,
                nodeType: 'timer',
            }).toArray();
            
            for (const timerNode of timerNodes) {
                const config = timerNode.config || {};
                
                // Check if timer task already exists
                const existing = await WorkflowTimerModel.getByNode(domainId, workflowId, timerNode.nid);
                
                // If timer exists, check if re-registration is needed
                if (existing) {
                    const now = new Date();
                    const isExpired = existing.executeAfter < now;
                    
                    // Compare configuration: interval, intervalValue, triggerData
                    const currentInterval = config.interval || 'day';
                    const currentIntervalValue = config.intervalValue || 1;
                    const currentTriggerData = JSON.stringify(config.triggerData || {});
                    
                    // Get interval from existing (stored in interval field as [value, unit])
                    const existingInterval = existing.interval ? existing.interval[1] : 'day';
                    const existingIntervalValue = existing.interval ? existing.interval[0] : 1;
                    // Note: time is not stored in existing, so cannot compare time
                    const existingTriggerData = JSON.stringify(existing.triggerData || {});
                    
                    // Skip re-registration if timer is not expired and configuration is unchanged
                    if (!isExpired && 
                        currentInterval === existingInterval && 
                        currentIntervalValue === existingIntervalValue &&
                        currentTriggerData === existingTriggerData) {
                        continue;
                    }
                    
                    // Need to re-register: delete old timer
                    await WorkflowTimerModel.del(existing._id);
                }
                
                // Get configuration
                const interval = config.interval || 'day';
                const intervalValue = config.intervalValue || 1;
                const timeStr = (config.time || '').trim();
                
                // For minute interval, can register without time (execute every intervalValue minutes from now)
                // For other intervals, time configuration is required
                if (interval === 'minute' || timeStr) {
                    const moment = (await import('moment-timezone')).default;
                    
                    // Use server local time (no timezone conversion, use server system time directly)
                    let executeAfter: Date;
                    
                    if (interval === 'minute') {
                        // Execute every minute: execute every intervalValue minutes from current time
                        // If time is specified (e.g., :30), execute at that second of each minute
                        // Otherwise execute every intervalValue minutes from current time
                        if (timeStr && timeStr !== ':0' && timeStr !== ':00') {
                            // Parse seconds
                            // Support formats: :ss or :mm:ss or mm:ss
                            let second = 0;
                            const timeParts = timeStr.split(':');
                            if (timeParts.length === 2 && timeParts[0] === '') {
                                // Format: :ss
                                second = parseInt(timeParts[1] || '0', 10);
                            } else if (timeParts.length >= 2) {
                                // Format mm:ss or HH:mm:ss, take last part as seconds
                                second = parseInt(timeParts[timeParts.length - 1] || '0', 10);
                            }
                            
                            // If seconds specified, execute at that second of each minute (using server local time)
                            const serverNow = new Date();
                            const now = moment(serverNow);
                            const localExecuteAfter = now.clone().second(second).millisecond(0);
                            executeAfter = localExecuteAfter.toDate();
                            
                            // If time has passed, set to next interval
                            if (executeAfter < serverNow) {
                                const nextExecuteAfter = now.clone().add(intervalValue, 'minute').second(second).millisecond(0);
                                executeAfter = nextExecuteAfter.toDate();
                            }
                        } else {
                            // No time specified or time is :0/:00, execute every intervalValue minutes from now
                            const serverNow = new Date();
                            const now = moment(serverNow);
                            const localExecuteAfter = now.clone().add(intervalValue, 'minute').second(0).millisecond(0);
                            executeAfter = localExecuteAfter.toDate();
                        }
                    } else if (interval === 'hour') {
                        // Execute every hour: parse minute and second (using server local time)
                        const timeParts = timeStr.split(':');
                        const minute = parseInt(timeParts[1] || '0', 10);
                        const second = parseInt(timeParts[2] || '0', 10);
                        
                        const serverNow = new Date();
                        const now = moment(serverNow);
                        const localExecuteAfter = now.clone().minute(minute).second(second).millisecond(0);
                        executeAfter = localExecuteAfter.toDate();
                        
                        // If time has passed, set to next interval
                        if (executeAfter < serverNow) {
                            const nextExecuteAfter = now.clone().add(intervalValue, 'hour').minute(minute).second(second).millisecond(0);
                            executeAfter = nextExecuteAfter.toDate();
                        }
                    } else {
                        // Execute daily/weekly/monthly: parse hour and minute (using server local time)
                        const [hour, minute] = timeStr.split(':').map(Number);
                        const serverNow = new Date();
                        const now = moment(serverNow);
                        const localExecuteAfter = now.clone().hour(hour).minute(minute || 0).second(0).millisecond(0);
                        executeAfter = localExecuteAfter.toDate();
                        
                        // If time has passed, set to next interval
                        if (executeAfter < serverNow) {
                            if (interval === 'day') {
                                const nextExecuteAfter = now.clone().add(intervalValue, 'day').hour(hour).minute(minute || 0).second(0).millisecond(0);
                                executeAfter = nextExecuteAfter.toDate();
                            } else if (interval === 'week') {
                                const nextExecuteAfter = now.clone().add(intervalValue, 'week').hour(hour).minute(minute || 0).second(0).millisecond(0);
                                executeAfter = nextExecuteAfter.toDate();
                            } else if (interval === 'month') {
                                const nextExecuteAfter = now.clone().add(intervalValue, 'month').hour(hour).minute(minute || 0).second(0).millisecond(0);
                                executeAfter = nextExecuteAfter.toDate();
                            }
                        }
                    }
                    
                    // Build interval array
                    let intervalArray: [number, string];
                    if (interval === 'minute') {
                        intervalArray = [intervalValue, 'minute'];
                    } else if (interval === 'hour') {
                        intervalArray = [intervalValue, 'hour'];
                    } else if (interval === 'day') {
                        intervalArray = [intervalValue, 'day'];
                    } else if (interval === 'week') {
                        intervalArray = [intervalValue, 'week'];
                    } else if (interval === 'month') {
                        intervalArray = [intervalValue, 'month'];
                    } else {
                        intervalArray = [1, 'day']; // Default: daily
                    }
                    
                    try {
                        await WorkflowTimerModel.add({
                            domainId: domainId,
                            workflowId: workflowId,
                            nodeId: timerNode.nid,
                            executeAfter,
                            interval: intervalArray,
                            triggerData: config.triggerData || {},
                        });
                    } catch (error: any) {
                        logger.error(`Failed to add timer for workflow ${workflowId}, node ${timerNode.nid}:`, error);
                        throw error;
                    }
                } else {
                    // For non-minute intervals, time configuration is required
                    if (interval !== 'minute') {
                        logger.warn(`Timer node ${timerNode.nid} has no time configuration, skipping registration`);
                    }
                }
            }
            
            // Notify WebSocket connections to update timer status
            (ctx.emit as any)('workflow/timer/registered', domainId, workflowId);
        };
        
        // Check and register timer nodes for all active workflows
        const checkAndRegisterTimers = async () => {
            // Use global model object to access domain
            const DomainModel = global.Ejunz.model.domain;
            const domains = await DomainModel.getMulti({}).toArray();
            for (const domain of domains) {
                const workflows = await WorkflowModel.getActive(domain._id);
                for (const workflow of workflows) {
                    await registerWorkflowTimers(domain._id, workflow.wid);
                }
            }
        };
        
        // Export registerWorkflowTimers for external calls
        WorkflowModel.registerTimers = registerWorkflowTimers;

        // Check once on startup
        if (process.env.NODE_APP_INSTANCE === '0') {
            setTimeout(checkAndRegisterTimers, 5000); // Delay 5 seconds to ensure other modules are loaded
        }
    });

    if (process.env.NODE_APP_INSTANCE !== '0') return;
    // Indexes for document collection are managed by document module
}

export default WorkflowModel;

// Export to global type system
global.Ejunz.model.workflow = WorkflowModel;


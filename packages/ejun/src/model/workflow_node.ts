import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import db from '../service/db';
import * as document from './document';
import type { WorkflowNodeDoc } from '../interface';

const logger = new Logger('model/workflow_node');

class WorkflowNodeModel {
    static async generateNextNodeId(domainId: string, workflowDocId: ObjectId): Promise<number> {
        const lastNode = await document.getMulti(domainId, document.TYPE_WORKFLOW_NODE, { workflowDocId })
            .sort({ nid: -1 })
            .limit(1)
            .project({ nid: 1 })
            .toArray();
        return (lastNode[0]?.nid || 0) + 1;
    }

    static async add(node: Partial<WorkflowNodeDoc> & { 
        domainId: string; 
        workflowId: number; 
        workflowDocId: ObjectId; 
        name: string; 
        nodeType: string;
        owner: number;
    }): Promise<WorkflowNodeDoc> {
        const nid = await this.generateNextNodeId(node.domainId, node.workflowDocId);
        const now = new Date();
        
        const payload: Partial<WorkflowNodeDoc> = {
            domainId: node.domainId,
            workflowId: node.workflowId,
            workflowDocId: node.workflowDocId,
            nid,
            type: node.type || 'action',
            nodeType: node.nodeType,
            name: node.name,
            position: node.position || { x: 0, y: 0 },
            config: node.config || {},
            connections: node.connections || [],
            createdAt: now,
            updatedAt: now,
            owner: node.owner,
        };

        await document.add(
            node.domainId,
            node.name, // content
            node.owner,
            document.TYPE_WORKFLOW_NODE,
            null, // 让系统自动生成 docId
            null,
            null,
            payload,
        );

        return await this.getByNodeId(node.domainId, nid) as WorkflowNodeDoc;
    }

    static async get(_id: ObjectId): Promise<WorkflowNodeDoc | null> {
        const doc = await document.coll.findOne({ _id });
        if (!doc) return null;
        return await this.getByNodeId(doc.domainId, doc.nid);
    }

    static async getByNodeId(domainId: string, nid: number): Promise<WorkflowNodeDoc | null> {
        const nodes = await document.getMulti(domainId, document.TYPE_WORKFLOW_NODE, { nid })
            .limit(1)
            .toArray();
        return (nodes[0] as WorkflowNodeDoc) || null;
    }

    static async getByWorkflow(domainId: string, workflowDocId: ObjectId): Promise<WorkflowNodeDoc[]> {
        return await document.getMulti(domainId, document.TYPE_WORKFLOW_NODE, { workflowDocId })
            .toArray() as WorkflowNodeDoc[];
    }

    static async getByWorkflowId(domainId: string, workflowId: number): Promise<WorkflowNodeDoc[]> {
        return await document.getMulti(domainId, document.TYPE_WORKFLOW_NODE, { workflowId })
            .toArray() as WorkflowNodeDoc[];
    }

    static async getStartNode(domainId: string, workflowDocId: ObjectId): Promise<WorkflowNodeDoc | null> {
        const nodes = await document.getMulti(domainId, document.TYPE_WORKFLOW_NODE, { 
            workflowDocId,
            nodeType: 'start'
        })
            .limit(1)
            .toArray();
        return (nodes[0] as WorkflowNodeDoc) || null;
    }

    static async update(domainId: string, nid: number, update: Partial<WorkflowNodeDoc>): Promise<WorkflowNodeDoc> {
        const node = await this.getByNodeId(domainId, nid);
        if (!node) throw new Error('Workflow node not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_WORKFLOW_NODE, node.docId, $set) as WorkflowNodeDoc;
    }

    static async del(domainId: string, nid: number) {
        const node = await this.getByNodeId(domainId, nid);
        if (!node) return;
        return await document.deleteOne(domainId, document.TYPE_WORKFLOW_NODE, node.docId);
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', async (domainId) => {
        // 工作流节点会在工作流删除时一起删除
    });

    if (process.env.NODE_APP_INSTANCE !== '0') return;
    // document 集合的索引由 document 模块管理
}

export default WorkflowNodeModel;

// 导出到全局类型系统
global.Ejunz.model.workflowNode = WorkflowNodeModel;


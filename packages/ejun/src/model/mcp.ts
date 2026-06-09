import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import type { McpDoc } from '../interface';

const logger = new Logger('model/mcp');

class McpModel {
    static async generateNextMcpId(domainId: string): Promise<number> {
        const last = await document.getMulti(domainId, document.TYPE_MCP, {})
            .sort({ mid: -1 })
            .limit(1)
            .project({ mid: 1 })
            .toArray();
        return (last[0]?.mid || 0) + 1;
    }

    static async add(mcp: Partial<McpDoc> & { domainId: string; owner: number }): Promise<McpDoc> {
        const mid = await this.generateNextMcpId(mcp.domainId);
        const now = new Date();
        const payload: Partial<McpDoc> = {
            domainId: mcp.domainId,
            mid,
            owner: mcp.owner,
            token: mcp.token,
            edgeId: mcp.edgeId,
            baseDocId: mcp.baseDocId,
            branch: mcp.branch,
            name: mcp.name,
            description: mcp.description,
            instructions: mcp.instructions,
            tools: mcp.tools,
            status: mcp.status || 'offline',
            createdAt: now,
            updatedAt: now,
        };
        await document.add(
            mcp.domainId,
            mcp.name || `MCP-${mid}`,
            mcp.owner,
            document.TYPE_MCP,
            null,
            null,
            null,
            payload,
        );
        return await this.getByMcpId(mcp.domainId, mid) as McpDoc;
    }

    static async get(_id: ObjectId): Promise<McpDoc | null> {
        const doc = await document.coll.findOne({ _id });
        if (!doc) return null;
        return await this.getByMcpId(doc.domainId, doc.mid);
    }

    static async getByMcpId(domainId: string, mid: number): Promise<McpDoc | null> {
        const list = await document.getMulti(domainId, document.TYPE_MCP, { mid })
            .limit(1)
            .toArray();
        return (list[0] as McpDoc) || null;
    }

    static async getByToken(domainId: string, token: string): Promise<McpDoc | null> {
        const list = await document.getMulti(domainId, document.TYPE_MCP, { token })
            .limit(1)
            .toArray();
        return (list[0] as McpDoc) || null;
    }

    static async getByEdgeId(domainId: string, edgeId: number): Promise<McpDoc | null> {
        const list = await document.getMulti(domainId, document.TYPE_MCP, { edgeId })
            .limit(1)
            .toArray();
        return (list[0] as McpDoc) || null;
    }

    static async getByDomain(domainId: string): Promise<McpDoc[]> {
        return await document.getMulti(domainId, document.TYPE_MCP, {}).toArray() as McpDoc[];
    }

    static async update(domainId: string, mid: number, update: Partial<McpDoc>): Promise<McpDoc> {
        const mcp = await this.getByMcpId(domainId, mid);
        if (!mcp) throw new Error('Mcp not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_MCP, mcp.docId, $set) as McpDoc;
    }

    static async del(domainId: string, mid: number) {
        const mcp = await this.getByMcpId(domainId, mid);
        if (!mcp) return;
        return await document.deleteOne(domainId, document.TYPE_MCP, mcp.docId);
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', async (domainId) => {
        // Mcp docs are removed together with the domain's documents.
    });
    if (process.env.NODE_APP_INSTANCE !== '0') return;
}

export default McpModel;

(global.Ejunz.model as any).mcp = McpModel;

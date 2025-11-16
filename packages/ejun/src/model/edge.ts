import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import type { EdgeDoc } from '../interface';
import { randomstring } from '../utils';

const logger = new Logger('model/edge');

class EdgeModel {
    static async generateNextEdgeId(domainId: string): Promise<number> {
        const lastEdge = await document.getMulti(domainId, document.TYPE_EDGE, {})
            .sort({ eid: -1 })
            .limit(1)
            .project({ eid: 1 })
            .toArray();
        return (lastEdge[0]?.eid || 0) + 1;
    }

    static async generateToken(): Promise<string> {
        return randomstring(32);
    }

    static async add(edge: Partial<EdgeDoc> & { domainId: string; owner: number; type: 'provider' | 'repo' | 'node' }): Promise<EdgeDoc> {
        const eid = await this.generateNextEdgeId(edge.domainId);
        const token = await this.generateToken();
        const now = new Date();
        
        const payload: Partial<EdgeDoc> = {
            domainId: edge.domainId,
            eid,
            token,
            type: edge.type,
            status: 'offline',
            tokenCreatedAt: now,
            tokenUsedAt: undefined,
            createdAt: now,
            updatedAt: now,
            owner: edge.owner,
        };

        await document.add(
            edge.domainId,
            token, // content
            edge.owner,
            document.TYPE_EDGE,
            null,
            null,
            null,
            payload,
        );

        // 设置30分钟后自动删除未使用的token
        setTimeout(async () => {
            try {
                const edgeDoc = await this.getByToken(edge.domainId, token);
                if (edgeDoc && !edgeDoc.tokenUsedAt) {
                    // token未使用，删除
                    await this.del(edge.domainId, eid);
                    logger.info('Auto-deleted unused edge token: eid=%d, token=%s', eid, token);
                }
            } catch (error) {
                logger.error('Failed to auto-delete unused edge token: %s', (error as Error).message);
            }
        }, 30 * 60 * 1000); // 30分钟

        return await this.getByEdgeId(edge.domainId, eid) as EdgeDoc;
    }

    static async get(_id: ObjectId): Promise<EdgeDoc | null> {
        const doc = await document.coll.findOne({ _id });
        if (!doc) return null;
        return await this.getByEdgeId(doc.domainId, doc.eid);
    }

    static async getByDomain(domainId: string): Promise<EdgeDoc[]> {
        return await document.getMulti(domainId, document.TYPE_EDGE, {}).toArray() as EdgeDoc[];
    }

    static async getByOwner(domainId: string, owner: number): Promise<EdgeDoc[]> {
        return await document.getMulti(domainId, document.TYPE_EDGE, { owner }).toArray() as EdgeDoc[];
    }

    static async getByToken(domainId: string, token: string): Promise<EdgeDoc | null> {
        const edges = await document.getMulti(domainId, document.TYPE_EDGE, { token })
            .limit(1)
            .toArray();
        return (edges[0] as EdgeDoc) || null;
    }

    static async update(domainId: string, eid: number, update: Partial<EdgeDoc>): Promise<EdgeDoc> {
        const edge = await this.getByEdgeId(domainId, eid);
        if (!edge) throw new Error('Edge not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_EDGE, edge.docId, $set) as EdgeDoc;
    }

    static async updateStatus(
        domainId: string,
        eid: number,
        status: 'online' | 'offline' | 'working',
    ): Promise<EdgeDoc> {
        return await this.update(domainId, eid, { status });
    }

    static async del(domainId: string, eid: number) {
        const edge = await this.getByEdgeId(domainId, eid);
        if (!edge) return;
        return await document.deleteOne(domainId, document.TYPE_EDGE, edge.docId);
    }

    static async getByEdgeId(domainId: string, eid: number): Promise<EdgeDoc | null> {
        const edges = await document.getMulti(domainId, document.TYPE_EDGE, { eid })
            .limit(1)
            .toArray();
        return (edges[0] as EdgeDoc) || null;
    }

    // 以下方法来自原 McpServerModel
    static async getByName(domainId: string, name: string): Promise<EdgeDoc | null> {
        const edges = await document.getMulti(domainId, document.TYPE_EDGE, { name })
            .limit(1)
            .toArray();
        return (edges[0] as EdgeDoc) || null;
    }

    static async getByWsEndpoint(domainId: string, wsEndpoint: string): Promise<EdgeDoc | null> {
        const edges = await document.getMulti(domainId, document.TYPE_EDGE, { wsEndpoint })
            .limit(1)
            .toArray();
        return (edges[0] as EdgeDoc) || null;
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', async (domainId) => {
        // Edges are automatically deleted when domain is deleted
    });

    if (process.env.NODE_APP_INSTANCE !== '0') return;
}

export default EdgeModel;

(global.Ejunz.model as any).edge = EdgeModel;


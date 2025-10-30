import child from 'child_process';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import { pick } from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import type { Readable } from 'stream';
import { Logger, size, streamToBuffer } from '@ejunz/utils/lib/utils';
import { Logger as AppLogger } from '../logger';
import { randomstring } from '@ejunz/utils';
import { Context } from '../context';
import { FileUploadError, ProblemNotFoundError } from '../error';
import type {
    Document, User, DocsDict, AgentDoc
} from '../interface';
import { parseConfig } from '../lib/testdataConfig';
import * as bus from '../service/bus';
import {
    ArrayKeys, MaybeArray, NumberKeys, Projection,
} from '../typeutils';
import { buildProjection } from '../utils';
import { PERM, STATUS } from './builtin';
import DomainModel from './domain';
import storage from './storage';
import * as SystemModel from './system';
import user from './user';
import * as document from './document';
import db from '../service/db';
import _ from 'lodash';

export type Field = keyof AgentDoc;

export class AgentModel {
    static PROJECTION_LIST: Field[] = [
        'domainId', 'docId', 'aid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static PROJECTION_DETAIL: Field[] = [
        ...AgentModel.PROJECTION_LIST,
       'docId', 'aid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply', 'apiKey'
    ];

    static PROJECTION_PUBLIC: Field[] = [
        ...AgentModel.PROJECTION_DETAIL,
        'docId', 'aid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static async generateNextDocId(domainId: string): Promise<number> {
        const lastAgent = await document.getMulti(domainId, document.TYPE_AGENT, {})
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();

        const lastDocId = Number(lastAgent[0]?.docId) || 0;
        return lastDocId + 1;
    }

    static async generateNextAid(domainId: string): Promise<string> {
        const lastAgent = await document.getMulti(domainId, document.TYPE_AGENT, {})
            .sort({ aid: -1 })
            .limit(1)
            .project({ aid: 1 })
            .toArray();

        if (!lastAgent.length || !lastAgent[0]?.aid) {
            return "A1";
        }

        const lastAid = String(lastAgent[0].aid);
        const lastAidNumber = parseInt(lastAid.match(/\d+/)?.[0] || "0", 10);

        return `A${lastAidNumber + 1}`;
    }

    static async addWithId(
        domainId: string,
        docId: number,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<AgentDoc> = {},
    ): Promise<string> {
        const aid = await AgentModel.generateNextAid(domainId);
        const payload: Partial<AgentDoc> = {
            domainId,
            docId,
            aid,
            content,
            owner,
            title: String(title),
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            ...meta, 
        };

        await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            document.TYPE_AGENT,
            docId,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        return aid;
    }

    static async add(
        domainId: string, 
        owner: number, 
        title: string, 
        content: string, 
        ip?: string, 
    ): Promise<string> {
        const docId = await AgentModel.generateNextDocId(domainId);
        return AgentModel.addWithId(domainId, docId, owner, title, content, ip);
    }

    static async getByAid(domainId: string, aid: string): Promise<AgentDoc | null> {
        const query = /^\d+$/.test(aid) ? { docId: Number(aid) } : { aid };
    
    
        const doc = await document.getMulti(domainId, document.TYPE_AGENT, query)
            .project<AgentDoc>(buildProjection(AgentModel.PROJECTION_DETAIL)) 
            .limit(1)
            .next();
    
        if (!doc) {
            console.warn(`[AgentModel.getByAid] No document found for query=`, query);
        } else {
            console.log(`[AgentModel.getByAid] Retrieved document:`, JSON.stringify(doc, null, 2));
        }
    
        return doc || null;
    }

    static async getByApiKey(apiKey: string): Promise<AgentDoc | null> {
        const coll = db.collection('document');
        const doc = await coll.findOne<AgentDoc>(
            { docType: document.TYPE_AGENT, apiKey },
            { projection: buildProjection(AgentModel.PROJECTION_DETAIL) }
        );
        return doc || null;
    }
    

    static async get(
        domainId: string, 
        aid: string | number,
        projection: Projection<AgentDoc> = AgentModel.PROJECTION_PUBLIC
    ): Promise<AgentDoc | null> {
        if (Number.isSafeInteger(+aid)) aid = +aid;
        const res = typeof aid === 'number'
            ? await document.get(domainId, document.TYPE_AGENT, aid, projection)
            : (await document.getMulti(domainId, document.TYPE_AGENT, { aid })
                .project(buildProjection(projection)).limit(1).toArray())[0];
        if (!res) return null;
        return res;
    }

    static getMulti(domainId: string, query: Filter<AgentDoc> = {}, projection = AgentModel.PROJECTION_LIST) {
        return document.getMulti(domainId, document.TYPE_AGENT, query, projection).sort({ docId: -1 });
    }

    static async listFiles(
        domainId: string, 
        query: Filter<AgentDoc>,
        page: number, pageSize: number,
        projection = AgentModel.PROJECTION_LIST, uid?: number,
    ): Promise<[AgentDoc[], number, number]> {
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union.union || [])];
        let count = 0;
        const files = [];
        for (const id of domainIds) {
            // TODO enhance performance
            if (typeof uid === 'number') {
                // eslint-disable-next-line no-await-in-loop
                const udoc = await user.getById(id, uid);
                if (!udoc.hasPerm(PERM.PERM_VIEW)) continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const ccount = await document.count(id, document.TYPE_AGENT, query);
            if (files.length < pageSize && (page - 1) * pageSize - count <= ccount) {
                // eslint-disable-next-line no-await-in-loop
                files.push(...await document.getMulti(id, document.TYPE_AGENT, query, projection)
                    .sort({ sort: 1, docId: 1 })
                    .skip(Math.max((page - 1) * pageSize - count, 0)).limit(pageSize - files.length).toArray());
            }
            count += ccount;
        }
        return [files, Math.ceil(count / pageSize), count];
    }


    static async list(
        domainId: string, query: Filter<AgentDoc>,
        page: number, pageSize: number,
        projection = AgentModel.PROJECTION_LIST, uid?: number,
    ): Promise<[AgentDoc[], number, number]> {
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union.union || [])];
        let count = 0;
        const rdocs = [];
        for (const id of domainIds) {
            // TODO enhance performance
            if (typeof uid === 'number') {
                // eslint-disable-next-line no-await-in-loop
                const udoc = await user.getById(id, uid);
                if (!udoc.hasPerm(PERM.PERM_VIEW)) continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const ccount = await document.count(id, document.TYPE_AGENT, query);
            if (rdocs.length < pageSize && (page - 1) * pageSize - count <= ccount) {
                // eslint-disable-next-line no-await-in-loop
                rdocs.push(...await document.getMulti(id, document.TYPE_AGENT, query, projection)
                    .sort({ sort: 1, docId: 1 })
                    .skip(Math.max((page - 1) * pageSize - count, 0)).limit(pageSize - rdocs.length).toArray());
            }
            count += ccount;
        }
        return [rdocs, Math.ceil(count / pageSize), count];
    }
    static async getList(
        domainId: string, 
        docIds: number[],
        projection = AgentModel.PROJECTION_PUBLIC, 
        indexByDocIdOnly = false,
    ): Promise<Record<number | string, AgentDoc>> {
        if (!docIds?.length) {
            return {};
        }
    
        const r: Record<number, AgentDoc> = {};
        const l: Record<string, AgentDoc> = {};
    
        const q: any = { docId: { $in: docIds } };
    
        let agents = await document.getMulti(domainId, document.TYPE_AGENT, q)
            .project<AgentDoc>(buildProjection(projection))
            .toArray();
    
        for (const agent of agents) {
            r[agent.docId] = agent;
            if (agent.aid) l[agent.aid] = agent;
        }
    
        return indexByDocIdOnly ? r : Object.assign(r, l);
    }

    
    static async edit(domainId: string, aid: string, updates: Partial<AgentDoc>): Promise<AgentDoc> {
        const agent = await document.getMulti(domainId, document.TYPE_AGENT, { aid }).next();
        if (!agent) throw new Error(`Document with aid=${aid} not found`);

        if (updates.tag) {
            updates.tag = Array.isArray(updates.tag) ? updates.tag : [updates.tag];
        }

        return document.set(domainId, document.TYPE_AGENT, agent.docId, updates);
    }
static async addVersion(
        domainId: string,
        docId: number,
        filename: string,
        version: string,
        path: string,
        size: number,
        lastModified: Date,
        etag: string,
        tag: string[] = [],
    ): Promise<AgentDoc> {
        const agentDoc = await AgentModel.get(domainId, docId);
        if (!agentDoc) throw new Error(`Agent with docId=${docId} not found`);

        const payload = {
            filename,
            version,
            path,
            size,
            lastModified,
            etag,
            tag,
        };

        const [updatedAgent] = await document.push(domainId, document.TYPE_AGENT, docId, 'files', payload);

        return updatedAgent;
    }
    static async addFile(
        domainId: string,
        docId: number,
        filename: string,
        path: string,
        size: number,
        lastModified: Date,
        etag: string,
        tag: string[] = [],
    ): Promise<AgentDoc> {
        const agentDoc = await AgentModel.get(domainId, docId);
        if (!agentDoc) throw new Error(`Agent with docId=${docId} not found`);


        const payload = {
            filename,
            path,
            size,
            lastModified,
            etag,
            tag,
        };

        const [updatedAgent] = await document.push(domainId, document.TYPE_AGENT, docId, 'files', payload);

        return updatedAgent;
    }


    static async inc(domainId: string, aid: string, key: NumberKeys<AgentDoc>, value: number): Promise<AgentDoc | null> {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        return document.inc(domainId, document.TYPE_AGENT, doc.docId, key, value);
    }

    static async del(domainId: string, aid: string): Promise<boolean> {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        await Promise.all([
            document.deleteOne(domainId, document.TYPE_AGENT, doc.docId),
            document.deleteMultiStatus(domainId, document.TYPE_AGENT, { docId: doc.docId }),
        ]);
        return true;
    }

    static async count(domainId: string, query: Filter<AgentDoc>) {
        return document.count(domainId, document.TYPE_AGENT, query);
    }

    static async setStar(domainId: string, aid: string, uid: number, star: boolean) {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        return document.setStatus(domainId, document.TYPE_AGENT, doc.docId, uid, { star });
    }

    static async getStatus(domainId: string, aid: string, uid: number) {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        return document.getStatus(domainId, document.TYPE_AGENT, doc.docId, uid);
    }

    static async setStatus(domainId: string, aid: string, uid: number, updates) {
        const doc = await AgentModel.getByAid(domainId, aid);
        if (!doc) throw new Error(`Agent with aid=${aid} not found`);

        return document.setStatus(domainId, document.TYPE_AGENT, doc.docId, uid, updates);
    }
}

export function apply(ctx: Context) {}

global.Ejunz.model.agent = AgentModel;
export default AgentModel;

// --- MCP 客户端逻辑迁移自 client.ts ---

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
}

export interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, any>;
    };
}

const ClientLogger = new AppLogger('mcp');

export class McpClient {
    async getTools(): Promise<McpTool[]> {
        try {
            const ctx = (global as any).app || (global as any).Ejunz;
            const edgeP = (async () => {
                try { return ctx ? await ctx.serial('mcp/tools/list/edge') : []; } catch { return []; }
            })();
            const localP = (async () => {
                try { return ctx ? await ctx.serial('mcp/tools/list/local') : []; } catch { return []; }
            })();
            const [edgeTools, localTools] = await Promise.all([edgeP, localP]);
            ClientLogger.info('Tool sources:', { edgeCount: (edgeTools || []).length, localCount: (localTools || []).length });
            const merged: Record<string, McpTool> = Object.create(null);
            for (const t of ([] as McpTool[]).concat(edgeTools || [], localTools || [])) merged[t.name] = t;
            const list = Object.values(merged);
            ClientLogger.info('Got tool list (merged):', { toolCount: list.length });
            return list;
        } catch (e) {
            ClientLogger.error('Failed to get tool list', e);
            return [];
        }
    }

    async callTool(name: string, args: any): Promise<any> {
        try {
            const ctx = (global as any).app || (global as any).Ejunz;
            // discover availability from both sides
            const [edgeTools, localTools] = await Promise.all([
                (async () => { try { return ctx ? await ctx.serial('mcp/tools/list/edge') : []; } catch (e) { ClientLogger.warn?.('edge tools discovery failed', e); return []; } })(),
                (async () => { try { return ctx ? await ctx.serial('mcp/tools/list/local') : []; } catch (e) { ClientLogger.warn?.('local tools discovery failed', e); return []; } })(),
            ]);
            ClientLogger.info('Tool sources (callTool):', { edgeCount: (edgeTools || []).length, localCount: (localTools || []).length });
            const inEdge = (edgeTools || []).some((t: McpTool) => t.name === name);
            const inLocal = (localTools || []).some((t: McpTool) => t.name === name);
            // call both equally: choose edge if available; else local; else error
            if (inEdge && ctx) {
                try { return await ctx.serial('mcp/tool/call/edge', { name, args }); }
                catch (e) { if (inLocal && ctx) return await ctx.serial('mcp/tool/call/local', { name, args }); throw e; }
            }
            if (inLocal && ctx) return await ctx.serial('mcp/tool/call/local', { name, args });
            throw new Error(`Tool not found: ${name}`);
        } catch (e) {
            ClientLogger.error(`Failed to call tool: ${name}`, e);
            throw e;
        }
    }
}

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
import type { Document, User, AgentDoc
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
import SystemModel from './system';
import user from './user';
import * as document from './document';
import db from '../service/db';
import EdgeModel from '../../../../plugins/edge/model/edge';
import ToolModel from '../../../../plugins/edge/model/tool';
import { EdgeServerConnectionHandler } from '../../../../plugins/edge/handler/edge';
import _ from 'lodash';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type Field = keyof AgentDoc;

export class AgentModel {

    static PROJECTION_LIST: Field[] = [
        'domainId', 'docId', 'aid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static PROJECTION_DETAIL: Field[] = [
        ...AgentModel.PROJECTION_LIST,
       'docId', 'aid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply', 'apiKey', 'memory', 'baseLibraryBindings', 'pluginBindings'
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
        const agents = await document.getMulti(domainId, document.TYPE_AGENT, {})
            .project<{ aid?: string }>({ aid: 1 })
            .toArray();
        const lastAidNumber = agents.reduce((last, agent) => {
            const number = Number(String(agent.aid || '').match(/\d+/)?.[0] || 0);
            return Number.isSafeInteger(number) ? Math.max(last, number) : last;
        }, 0);

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


    static async edit(domainId: string, id: string | number, updates: Partial<AgentDoc>): Promise<AgentDoc> {
        const agent = typeof id === 'number' || /^\d+$/.test(String(id))
            ? await AgentModel.get(domainId, Number(id))
            : await document.getMulti(domainId, document.TYPE_AGENT, { aid: String(id) }).next();
        if (!agent) throw new Error(`Agent with id=${id} not found`);

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

    static async del(domainId: string, id: string | number): Promise<boolean> {
        const doc = typeof id === 'number' || /^\d+$/.test(String(id))
            ? await AgentModel.get(domainId, Number(id))
            : await AgentModel.getByAid(domainId, id);
        if (!doc) throw new Error(`Agent with id=${id} not found`);

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

export async function apply(ctx: Context): Promise<void> {
    ctx.on('domain/delete', (domainId: string) => AgentSessionModel.deleteDomain(domainId));
}

global.Ejunz.model.agent = AgentModel;
export default AgentModel;

// --- MCP client logic migrated from client.ts ---

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
}

export interface EdgeTool {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, any>;
    };
}

const ClientLogger = new AppLogger('mcp');

export class McpClient {
    /** domainId for listing domain market tools per domain */
    async getTools(domainId?: string): Promise<EdgeTool[]> {
        try {
            const ctx = (global as any).app || (global as any).Ejunz;
            // [Edge disabled] const edgeP = (async () => { try { return ctx ? await ctx.serial('mcp/tools/list/edge') : []; } catch { return []; } })();
            const localP = (async () => {
                try { return ctx && domainId ? await ctx.serial('mcp/tools/list/local', { domainId }) : []; } catch { return []; }
            })();
            // [Edge disabled] const [edgeTools, localTools] = await Promise.all([edgeP, localP]);
            const localTools = await localP;
            ClientLogger.info('Tool sources: local only (Edge disabled)', { localCount: (localTools || []).length });
            const merged: Record<string, EdgeTool> = Object.create(null);
            for (const t of ([] as EdgeTool[]).concat(/* edgeTools || [], */ localTools || [])) merged[t.name] = t;
            const list = Object.values(merged);
            ClientLogger.info('Got tool list (merged):', { toolCount: list.length });
            return list;
        } catch (e) {
            ClientLogger.error('Failed to get tool list', e);
            return [];
        }
    }

    async callTool(
        name: string,
        args: any,
        domainId?: string,
        serverId?: number,
        token?: string,
        toolType?: string,
        baseDocId?: number,
        toolCallerUid?: number,
    ): Promise<any> {
        try {
            ClientLogger.info('[tool] callTool: name=%s toolType=%s', name, toolType ?? 'undefined');
            const ctx = (global as any).app || (global as any).Ejunz;
            if (!ctx) {
                throw new Error('Context not available');
            }

            // Check if it's a repo internal MCP tool (format: repo_{rpid}_{operation}...)

            // Supported operations:
            // - Single operation words: commit, push, ask, pull
            // - Operation + underscore + type: query_doc, create_doc, edit_block, delete_block, create_branch, search_doc, search_block, sync_branch
            // - Others: update_structure, query_structure, query_branches
            if (name.match(/^repo_\d+_(query|create|edit|delete|update|pull|push|commit|search|ask|create_branch|sync_branch)/)) {
                try {
                    ClientLogger.info('[tool] callTool: name=%s -> branch=repo', name);
                    // Try to get agentId and agentName from context (if called from agent)
                    const agentId = (args as any).__agentId;
                    const agentName = (args as any).__agentName;
                    const cleanArgs = { ...args };
                    delete (cleanArgs as any).__agentId;
                    delete (cleanArgs as any).__agentName;

                    const result = await ctx.serial('mcp/tool/call/repo', {
                        name,
                        args: cleanArgs,
                        domainId,
                        agentId,
                        agentName,
                    });
                    return result;
                } catch (e) {
                    ClientLogger.error('Repo internal MCP tool call failed: %s', (e as Error).message);
                    throw e;
                }
            }

            if (token) {
                const connection = EdgeServerConnectionHandler.getConnection(token);
                if (!connection) {
                    const err = new Error(`Assigned inbound MCP is offline for tool: ${name}`);
                    (err as any).code = 'MCP_OFFLINE';
                    throw err;
                }
                ClientLogger.info('[tool] callTool: name=%s -> branch=edge token=%s', name, token);
                return await connection.callTool(name, args || {});
            }

            // [Edge adapter disabled] First try to call via edge (if available)
            // try {
            //     const edgeTools = await ctx.serial('mcp/tools/list/edge').catch(() => []);
            //     ...
            // } catch (e) { ... }

            // [Edge adapter disabled] Search for tool in Edge/Tool model
            // if (domainId) {
            //     const edges = await EdgeModel.getByDomain(domainId);
            //     for (const edge of connectedEdges) { ... }
            // }

            // Local MCP tools (default system + market MCP)
            try {
                if (domainId) {
                    const localTools = await ctx.serial('mcp/tools/list/local', { domainId }).catch(() => []);
                    const inLocal = (localTools || []).some((t: EdgeTool) => t.name === name);
                    if (inLocal) {
                        ClientLogger.info('[tool] callTool: name=%s -> branch=local', name);
                        return await ctx.serial('mcp/tool/call/local', {
                            name,
                            args,
                            domainId,
                            baseDocId,
                            owner: toolCallerUid,
                        });
                    }
                }
            } catch (e) {
                if ((e as Error).message?.startsWith('Tool not found:')) throw e;
                ClientLogger.debug('Local tools not available: %s', (e as Error).message);
            }

            // No catalog-only execution: must be on domain market (or built-in loaders); otherwise error
            ClientLogger.warn('[tool] callTool: name=%s -> not in assigned tools (market/local)', name);
            const err = new Error(`Tool not added: ${name}. Please add it from the tool market for this domain.`);
            (err as any).code = 'TOOL_NOT_ADDED';
            throw err;
        } catch (e) {
            ClientLogger.error(`Failed to call tool: ${name}`, e);
            throw e;
        }
    }
}


/** Resolve agent collections lazily after the database service is ready. */
function agentCollection(name: string): any {
    return new Proxy(Object.create(null), {
        get(_target, property) {
            const collection = db.collection(name as any);
            const value = (collection as any)[property];
            return typeof value === 'function' ? value.bind(collection) : value;
        },
    });
}


export type AgentSessionType = 'generic' | 'base_detail';

export interface AgentSessionSummary {
    sessionId: string;
    createdAt?: number;
    updatedAt: number;
    running: boolean;
    blank: boolean;
    creatorUserId?: number;
    type?: AgentSessionType;
    agentId?: number;
    baseDocId?: string;
    nodeId?: string;
    cwd?: string;
    agentPreset?: string;
    /** The host that serves this session; absent until one was chosen. */
    runtimeId?: string;
    model?: { provider: string; model: string };
    projections?: { values?: Record<string, unknown> };
}
export interface AgentSessionDoc extends Omit<AgentSessionSummary, 'createdAt'> {
    _id: ObjectId;
    domainId: string;
    userId: number;
    archived: boolean;
    header?: Record<string, unknown>;
    createdAt: Date;
}

export interface AgentEventDoc {
    _id: ObjectId;
    domainId: string;
    userId: number;
    sessionId: string;
    seq: number;
    event: Record<string, unknown>;
    createdAt: Date;
}

export interface AgentWorkspaceDoc {
    _id: ObjectId;
    domainId: string;
    userId: number;
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
    order: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface AgentNodeDoc {
    _id: ObjectId;
    domainId: string;
    userId: number;
    agentId?: number;
    nodeId: string;
    parentId?: string;
    isRoot?: boolean;
    text: string;
    order: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface AgentDisplayPrefs {
    showPermission: boolean;
    showModel: boolean;
    showBase: boolean;
    showWorkspace: boolean;
    showTimestamps: boolean;
    showStatus: boolean;
}

interface AgentUiPrefsDoc {
    _id: ObjectId;
    domainId: string;
    userId: number;
    display: AgentDisplayPrefs;
    createdAt: Date;
    updatedAt: Date;
}

export interface AgentDomainSettings {
    sections: Record<string, Record<string, unknown>>;
    revision: number;
}

export interface AgentCredentialDoc {
    _id: ObjectId;
    domainId: string;
    ref: string;
    ciphertext: string;
    iv: string;
    authTag: string;
    createdAt: Date;
    updatedAt: Date;
}

const defaultAgentDisplayPrefs: AgentDisplayPrefs = {
    showPermission: true,
    showModel: true,
    showBase: true,
    showWorkspace: true,
    showTimestamps: true,
    showStatus: true,
};

function normalizeAgentDisplayPrefs(raw: unknown): AgentDisplayPrefs {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaultAgentDisplayPrefs };
    const value = raw as Record<string, unknown>;
    return {
        showPermission: value.showPermission !== false,
        showModel: value.showModel !== false,
        showBase: value.showBase !== false,
        showWorkspace: value.showWorkspace !== false,
        showTimestamps: value.showTimestamps !== false,
        showStatus: value.showStatus as boolean,
    };
}

const sessions = agentCollection('agent.session');
const events = agentCollection('agent.session_event');
const workspaces = agentCollection('agent.workspace');
const nodes = agentCollection('agent.node');
const uiPrefs = agentCollection('agent.ui_prefs');
const domains = agentCollection('domain');
const credentials = agentCollection('agent.credential');
const appendChains = new Map<string, Promise<void>>();

function credentialEncryptionKey(): Buffer {
    const configured = process.env.EJUNZ_AGENT_CREDENTIAL_SECRET || process.env.EA_AGENT_CREDENTIAL_SECRET;
    const systemKeys = (global as any).Ejunz?.model?.system?.get?.('session.keys');
    const fallback = Array.isArray(systemKeys) ? systemKeys.join('\\0') : String(systemKeys || '');
    const source = configured || fallback;
    if (!source) throw new Error('agent credentials encryption key is not configured');
    return createHash('sha256').update(source).digest();
}

function encryptCredential(value: string): Pick<AgentCredentialDoc, 'ciphertext' | 'iv' | 'authTag'> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', credentialEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
    };
}

function decryptCredential(doc: Pick<AgentCredentialDoc, 'ciphertext' | 'iv' | 'authTag'>): string {
    const decipher = createDecipheriv('aes-256-gcm', credentialEncryptionKey(), Buffer.from(doc.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(doc.authTag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(doc.ciphertext, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}

function domainSettingsOf(value: unknown): AgentDomainSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { sections: {}, revision: 0 };
    const row = value as Record<string, unknown>;
    const rawSections = row.agentSettings;
    const sections = rawSections && typeof rawSections === 'object' && !Array.isArray(rawSections)
        ? Object.fromEntries(Object.entries(rawSections).filter(([, section]) => section && typeof section === 'object' && !Array.isArray(section))) as Record<string, Record<string, unknown>>
        : {};
    const revision = Number(row.agentSettingsRevision);
    return { sections, revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0 };
}

function cloneSections(sections: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
    return structuredClone(sections);
}

function sessionFilter(domainId: string, userId: number, sessionId?: string, agentId?: number | null) {
    return {
        domainId,
        userId,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(agentId === undefined ? {} : agentId === null ? { agentId: { $in: [null] } } : { agentId }),
    };
}

function agentNodeFilter(domainId: string, userId: number, agentId?: number | null, nodeId?: string) {
    return {
        domainId,
        userId,
        ...(agentId === undefined ? {} : agentId === null ? { agentId: { $in: [null] } } : { agentId }),
        ...(nodeId === undefined ? {} : { nodeId }),
    };
}

function workspaceFilter(domainId: string, userId: number, workspaceId?: string) {
    return { domainId, userId, ...(workspaceId === undefined ? {} : { workspaceId }) };
}

function sessionToSummary(doc: AgentSessionDoc): AgentSessionSummary {
    return {
        sessionId: doc.sessionId,
        ...(doc.createdAt instanceof Date ? { createdAt: doc.createdAt.getTime() } : {}),
        updatedAt: doc.updatedAt,
        running: doc.running === true,
        blank: doc.blank === true,
        creatorUserId: doc.creatorUserId ?? doc.userId,
        type: doc.type ?? 'generic',
        ...(doc.agentId === undefined ? {} : { agentId: doc.agentId }),
        ...(doc.baseDocId === undefined ? {} : { baseDocId: doc.baseDocId }),
        ...(doc.nodeId === undefined ? {} : { nodeId: doc.nodeId }),
        ...(doc.cwd === undefined ? {} : { cwd: doc.cwd }),
        ...(doc.agentPreset === undefined ? {} : { agentPreset: doc.agentPreset }),
        ...(doc.runtimeId === undefined ? {} : { runtimeId: doc.runtimeId }),
        ...(doc.model === undefined ? {} : { model: doc.model }),
        ...(doc.projections === undefined ? {} : { projections: doc.projections }),
    };
}

export class AgentSessionModel {
    static async ensureIndexes(): Promise<void> {
        await Promise.all([
            sessions.createIndex({ domainId: 1, userId: 1, sessionId: 1 }, { unique: true, background: true, name: 'agent_session_domain_user_id_unique' }),
            sessions.createIndex({ domainId: 1, userId: 1, updatedAt: -1 }, { background: true, name: 'agent_session_domain_user_updated' }),
            sessions.createIndex({ domainId: 1, userId: 1, agentId: 1, updatedAt: -1 }, { background: true, name: 'agent_session_agent_updated' }),
            sessions.createIndex({ domainId: 1, userId: 1, type: 1, baseDocId: 1, updatedAt: -1 }, { background: true, name: 'agent_session_base_detail_lookup' }),
            sessions.createIndex({ domainId: 1, userId: 1, agentId: 1, type: 1, baseDocId: 1, updatedAt: -1 }, { background: true, name: 'agent_session_agent_base_detail_lookup' }),
            nodes.createIndex({ domainId: 1, userId: 1, agentId: 1, order: 1 }, { background: true, name: 'agent_node_agent_order' }),
            events.createIndex({ domainId: 1, userId: 1, sessionId: 1, seq: 1 }, { unique: true, background: true, name: 'agent_event_session_seq_unique' }),
            events.createIndex({ domainId: 1, userId: 1, sessionId: 1, 'event.type': 1 }, { background: true, name: 'agent_event_session_type' }),
            workspaces.createIndex({ domainId: 1, userId: 1, workspaceId: 1 }, { unique: true, background: true, name: 'agent_workspace_domain_user_id_unique' }),
            workspaces.createIndex({ domainId: 1, userId: 1, order: 1 }, { background: true, name: 'agent_workspace_domain_user_order' }),
            nodes.createIndex({ domainId: 1, userId: 1, nodeId: 1 }, { unique: true, background: true, name: 'agent_node_domain_user_id_unique' }),
            nodes.createIndex({ domainId: 1, userId: 1, order: 1 }, { background: true, name: 'agent_node_domain_user_order' }),
            uiPrefs.createIndex({ domainId: 1, userId: 1 }, { unique: true, background: true, name: 'agent_ui_prefs_domain_user_unique' }),
            credentials.createIndex({ domainId: 1, ref: 1 }, { unique: true, background: true, name: 'agent_credential_domain_ref_unique' }),
        ]);
    }

    static async resetRunningSessions(): Promise<void> {
        await sessions.updateMany({ running: true }, { $set: { running: false } });
    }

    static async listSessions(domainId: string, userId: number, agentId?: number | null): Promise<AgentSessionSummary[]> {
        const docs = await sessions.find(sessionFilter(domainId, userId, undefined, agentId)).sort({ updatedAt: -1 }).toArray() as AgentSessionDoc[];
        return docs.map(sessionToSummary);
    }

    static async getSession(domainId: string, userId: number, sessionId: string, agentId?: number | null): Promise<AgentSessionDoc | null> {
        return await sessions.findOne(sessionFilter(domainId, userId, sessionId, agentId)) as AgentSessionDoc | null;
    }

    static async getSessionByContext(domainId: string, userId: number, type: AgentSessionType, baseDocId: string, agentId?: number | null): Promise<AgentSessionDoc | null> {
        return await sessions.find({ ...sessionFilter(domainId, userId, undefined, agentId), type, baseDocId, archived: { $ne: true } }).sort({ updatedAt: -1 }).limit(1).next() as AgentSessionDoc | null;
    }

    static async listSessionsByContext(domainId: string, userId: number, type: AgentSessionType, baseDocId: string, agentId?: number | null): Promise<AgentSessionSummary[]> {
        const docs = await sessions.find({ ...sessionFilter(domainId, userId, undefined, agentId), type, baseDocId, archived: { $ne: true } }).sort({ updatedAt: -1 }).toArray() as AgentSessionDoc[];
        return docs.map(sessionToSummary);
    }

    static async getSessionAny(sessionId: string): Promise<AgentSessionDoc | null> {
        return await sessions.findOne({ sessionId }) as AgentSessionDoc | null;
    }

    static async listAllSessions(): Promise<AgentSessionDoc[]> {
        return await sessions.find({}).sort({ updatedAt: -1 }).toArray() as AgentSessionDoc[];
    }

    static async setSessionHeader(sessionId: string, header: Record<string, unknown>): Promise<void> {
        await sessions.updateOne({ sessionId }, { $set: { header } });
    }

    static async upsertSession(domainId: string, userId: number, summary: AgentSessionSummary, archived?: boolean): Promise<void> {
        const now = new Date();
        const { createdAt, ...summaryFields } = summary;
        const createdAtDate = typeof createdAt === 'number' && Number.isFinite(createdAt) ? new Date(createdAt) : now;
        await sessions.updateOne(
            sessionFilter(domainId, userId, summary.sessionId),
            {
                $set: {
                    domainId,
                    userId,
                    ...summaryFields,
                    ...(archived === undefined ? {} : { archived }),
                    updatedAt: summary.updatedAt || now.getTime(),
                },
                $setOnInsert: { _id: new ObjectId(), createdAt: createdAtDate, archived: archived === true },
            },
            { upsert: true },
        );
    }

    static async updateSession(domainId: string, userId: number, sessionId: string, patch: Partial<AgentSessionSummary> & { archived?: boolean }, agentId?: number | null): Promise<void> {
        await sessions.updateOne(sessionFilter(domainId, userId, sessionId, agentId), { $set: { ...patch, updatedAt: patch.updatedAt ?? Date.now() } });
    }

    static async updateSessionContext(domainId: string, userId: number, sessionId: string, baseDocId?: string, cwd?: string, agentId?: number | null): Promise<void> {
        const set: Record<string, unknown> = { updatedAt: Date.now() };
        const unset: Record<string, 1> = {};
        if (baseDocId === undefined) unset.baseDocId = 1;
        else set.baseDocId = baseDocId;
        if (cwd !== undefined) set.cwd = cwd;
        await sessions.updateOne(sessionFilter(domainId, userId, sessionId, agentId), {
            $set: set,
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
        });
    }

    static async appendEvent(domainId: string, userId: number, sessionId: string, event: Record<string, unknown>): Promise<void> {
        await AgentSessionModel.appendEvents(domainId, userId, sessionId, [event]);
    }

    static async appendEvents(domainId: string, userId: number, sessionId: string, items: readonly Record<string, unknown>[]): Promise<void> {
        if (items.length === 0) return;
        const previous = appendChains.get(sessionId) ?? Promise.resolve();
        const operation = previous.then(async () => {
            const stats = await events.aggregate([
                { $match: { domainId, userId, sessionId } },
                { $group: { _id: null, count: { $sum: 1 }, min: { $min: '$seq' }, max: { $max: '$seq' } } },
            ]).next() as { count: number; min: number; max: number } | null;
            const count = stats === null ? 0 : Number(stats.count);
            const min = stats === null ? 0 : Number(stats.min);
            const max = stats === null ? -1 : Number(stats.max);
            if (stats !== null && (min !== 0 || count !== max + 1)) {
                throw new Error(`session event log is already non-contiguous for "${sessionId}": seq range ${min}..${max} contains ${count} events`);
            }
            let expected = stats === null ? 0 : max + 1;
            const writes: Record<string, unknown>[] = [];
            for (const event of items) {
                const seq = Number(event.seq);
                if (!Number.isSafeInteger(seq) || seq < 0) continue;
                if (seq < expected) {
                    const existing = await events.findOne({ domainId, userId, sessionId, seq }, { projection: { event: 1 } });
                    if (existing === null) throw new Error(`session event sequence gap for "${sessionId}": expected ${expected}, got ${seq}`);
                    if (JSON.stringify(existing.event) !== JSON.stringify(event)) {
                        throw new Error(`session event payload conflict for "${sessionId}" at seq ${seq}`);
                    }
                    continue;
                }
                if (seq !== expected) throw new Error(`session event sequence gap for "${sessionId}": expected ${expected}, got ${seq}`);
                writes.push({ seq, event });
                expected += 1;
            }
            if (writes.length === 0) return;
            await events.bulkWrite(writes.map(({ seq, event }) => ({
                updateOne: {
                    filter: { domainId, userId, sessionId, seq },
                    update: { $setOnInsert: { _id: new ObjectId(), domainId, userId, sessionId, seq, event, createdAt: new Date() } },
                    upsert: true,
                },
            })), { ordered: true });
            await sessions.updateOne(sessionFilter(domainId, userId, sessionId), { $set: { blank: false, updatedAt: Date.now() } });
        });
        const settled = operation.then(() => undefined, () => undefined);
        appendChains.set(sessionId, settled);
        try {
            await operation;
        } finally {
            if (appendChains.get(sessionId) === settled) appendChains.delete(sessionId);
        }
    }

    static async countEvents(domainId: string, userId: number, sessionId: string, agentId?: number | null): Promise<number> {
        const owner = await AgentSessionModel.getSession(domainId, userId, sessionId, agentId);
        if (!owner) return 0;
        return await events.countDocuments({ domainId, userId, sessionId });
    }

    static async countMessages(domainId: string, userId: number, sessionId: string, agentId?: number | null): Promise<number> {
        const owner = await AgentSessionModel.getSession(domainId, userId, sessionId, agentId);
        if (!owner) return 0;
        return await events.countDocuments({
            domainId,
            userId,
            sessionId,
            'event.type': { $in: ['user/message', 'assistant/message'] },
        });
    }

    static async listEventsAny(sessionId: string, beforeSeq?: number, limit = 50): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }> {
        const filter = { sessionId, ...(beforeSeq === undefined ? {} : { seq: { $lt: beforeSeq } }) };
        const rows = await events.find(filter).sort({ seq: -1 }).limit(limit + 1).toArray() as AgentEventDoc[];
        const hasMore = rows.length > limit;
        return { events: rows.slice(0, limit).reverse().map((row) => row.event), hasMore };
    }

    static async listEventsTailAny(sessionId: string, beforeSeq?: number, limit = 100): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }> {
        return await AgentSessionModel.listEventsAny(sessionId, beforeSeq, limit);
    }

    static async listAllEventsAny(sessionId: string): Promise<Record<string, unknown>[]> {
        const rows = await events.find({ sessionId }).sort({ seq: 1 }).toArray() as AgentEventDoc[];
        return rows.map((row) => row.event);
    }

    static async listEvents(domainId: string, userId: number, sessionId: string, beforeSeq?: number, limit = 50, agentId?: number | null): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }> {
        const owner = await AgentSessionModel.getSession(domainId, userId, sessionId, agentId);
        if (!owner) return { events: [], hasMore: false };
        const filter = {
            domainId,
            userId,
            sessionId,
            ...(beforeSeq === undefined ? {} : { seq: { $lt: beforeSeq } }),
        };
        const rows = await events.find(filter).sort({ seq: -1 }).limit(limit + 1).toArray() as AgentEventDoc[];
        const hasMore = rows.length > limit;
        return { events: rows.slice(0, limit).reverse().map((row) => row.event), hasMore };
    }

    static async upsertWorkspace(domainId: string, userId: number, workspace: Omit<AgentWorkspaceDoc, '_id' | 'createdAt' | 'updatedAt'>): Promise<AgentWorkspaceDoc> {
        const now = new Date();
        await workspaces.updateOne(
            workspaceFilter(domainId, userId, workspace.workspaceId),
            {
                $set: { ...workspace, updatedAt: now },
                $setOnInsert: { _id: new ObjectId(), createdAt: now },
            },
            { upsert: true },
        );
        return await workspaces.findOne(workspaceFilter(domainId, userId, workspace.workspaceId)) as AgentWorkspaceDoc;
    }

    static async listWorkspaces(domainId: string, userId: number): Promise<AgentWorkspaceDoc[]> {
        return await workspaces.find(workspaceFilter(domainId, userId)).sort({ order: 1, createdAt: 1 }).toArray() as AgentWorkspaceDoc[];
    }

    static async getWorkspace(domainId: string, userId: number, workspaceId: string): Promise<AgentWorkspaceDoc | null> {
        return await workspaces.findOne(workspaceFilter(domainId, userId, workspaceId)) as AgentWorkspaceDoc | null;
    }

    static async getWorkspaceByPath(domainId: string, userId: number, path: string): Promise<AgentWorkspaceDoc | null> {
        return await workspaces.findOne({ domainId, userId, path }) as AgentWorkspaceDoc | null;
    }

    static agentRootNodeId(agentId: number): string {
        return `agent-root-${agentId}`;
    }

    static async ensureAgentRoot(domainId: string, userId: number, agentId: number, title: string): Promise<AgentNodeDoc> {
        const nodeId = AgentSessionModel.agentRootNodeId(agentId);
        const filter = agentNodeFilter(domainId, userId, agentId, nodeId);
        const existing = await nodes.findOne(agentNodeFilter(domainId, userId, undefined, nodeId)) as AgentNodeDoc | null;
        if (existing && (existing.agentId !== agentId || existing.isRoot !== true)) {
            throw new Error(`Agent root node id collision for ${nodeId}`);
        }
        const now = new Date();
        await nodes.updateOne(
            filter,
            {
                $set: { agentId, isRoot: true, text: title, order: -1, updatedAt: now },
                $unset: { parentId: 1 },
                $setOnInsert: { _id: new ObjectId(), domainId, userId, nodeId, createdAt: now },
            },
            { upsert: true },
        );
        return await nodes.findOne(filter) as AgentNodeDoc;
    }

    static async syncAgentRootTitle(domainId: string, agentId: number, title: string): Promise<void> {
        await nodes.updateMany(
            { domainId, agentId, isRoot: true },
            { $set: { text: title, updatedAt: new Date() } },
        );
    }

    static async detachAgent(domainId: string, agentId: number): Promise<void> {
        await Promise.all([
            sessions.updateMany({ domainId, agentId }, { $unset: { agentId: 1 }, $set: { updatedAt: Date.now() } }),
            nodes.updateMany({ domainId, agentId }, { $unset: { agentId: 1, isRoot: 1 }, $set: { updatedAt: new Date() } }),
        ]);
    }

    static async createNode(domainId: string, userId: number, text: string, agentId?: number | null, parentId?: string): Promise<AgentNodeDoc> {
        const now = new Date();
        const scope = agentNodeFilter(domainId, userId, agentId);
        const actualParentId = agentId === null || agentId === undefined
            ? parentId
            : parentId || AgentSessionModel.agentRootNodeId(agentId);
        if (actualParentId && !await AgentSessionModel.getNode(domainId, userId, actualParentId, agentId)) {
            throw new Error('Parent node not found in this Agent');
        }
        const current = await nodes.countDocuments(scope);
        const node: AgentNodeDoc = {
            _id: new ObjectId(),
            domainId,
            userId,
            ...(agentId === undefined || agentId === null ? {} : { agentId }),
            nodeId: new ObjectId().toHexString(),
            ...(actualParentId === undefined ? {} : { parentId: actualParentId }),
            text: text.trim(),
            order: current,
            createdAt: now,
            updatedAt: now,
        };
        await nodes.insertOne(node);
        return node;
    }

    static async listNodes(domainId: string, userId: number, agentId?: number | null): Promise<AgentNodeDoc[]> {
        return await nodes.find(agentNodeFilter(domainId, userId, agentId)).sort({ order: 1, createdAt: 1 }).toArray() as AgentNodeDoc[];
    }

    static async getNode(domainId: string, userId: number, nodeId: string, agentId?: number | null): Promise<AgentNodeDoc | null> {
        return await nodes.findOne(agentNodeFilter(domainId, userId, agentId, nodeId)) as AgentNodeDoc | null;
    }

    static async updateNode(domainId: string, userId: number, nodeId: string, text: string, agentId?: number | null): Promise<AgentNodeDoc | null> {
        const filter = agentNodeFilter(domainId, userId, agentId, nodeId);
        const node = await nodes.findOne(filter) as AgentNodeDoc | null;
        if (!node) return null;
        if (node.isRoot) throw new Error('Agent root node cannot be renamed');
        await nodes.updateOne(filter, { $set: { text: text.trim(), updatedAt: new Date() } });
        return await nodes.findOne(filter) as AgentNodeDoc | null;
    }

    static async deleteNode(domainId: string, userId: number, nodeId: string, agentId?: number | null): Promise<void> {
        const filter = agentNodeFilter(domainId, userId, agentId, nodeId);
        const node = await nodes.findOne(filter) as AgentNodeDoc | null;
        if (!node) return;
        if (node.isRoot) throw new Error('Agent root node cannot be deleted');
        const parentId = node.parentId || (typeof agentId === 'number' ? AgentSessionModel.agentRootNodeId(agentId) : undefined);
        const childrenFilter = agentNodeFilter(domainId, userId, agentId);
        const sessionTargetFilter = sessionFilter(domainId, userId, undefined, agentId);
        const sessionUpdate = parentId
            ? { $set: { nodeId: parentId, updatedAt: Date.now() } }
            : { $unset: { nodeId: 1 }, $set: { updatedAt: Date.now() } };
        const childUpdate = parentId
            ? { $set: { parentId, updatedAt: new Date() } }
            : { $unset: { parentId: 1 }, $set: { updatedAt: new Date() } };
        await Promise.all([
            nodes.updateMany({ ...childrenFilter, parentId: nodeId }, childUpdate),
            sessions.updateMany({ ...sessionTargetFilter, nodeId }, sessionUpdate),
            nodes.deleteOne(filter),
        ]);
    }

    static async getDisplayPrefs(domainId: string, userId: number): Promise<AgentDisplayPrefs> {
        const doc = await uiPrefs.findOne({ domainId, userId }) as AgentUiPrefsDoc | null;
        return normalizeAgentDisplayPrefs(doc?.display);
    }

    static async saveDisplayPrefs(domainId: string, userId: number, raw: unknown): Promise<AgentDisplayPrefs> {
        const display = normalizeAgentDisplayPrefs(raw);
        const now = new Date();
        await uiPrefs.updateOne(
            { domainId, userId },
            {
                $set: { display, updatedAt: now },
                $setOnInsert: { _id: new ObjectId(), domainId, userId, createdAt: now },
            },
            { upsert: true },
        );
        return display;
    }

    static async reorderWorkspaces(domainId: string, userId: number, workspaceIds: string[]): Promise<void> {
        await Promise.all(workspaceIds.map((workspaceId, order) => workspaces.updateOne(
            workspaceFilter(domainId, userId, workspaceId),
            { $set: { order, updatedAt: new Date() } },
        )));
    }

    static async reorderWorkspaceSessions(domainId: string, userId: number, workspaceId: string, sessionIds: string[]): Promise<AgentWorkspaceDoc | null> {
        return await AgentSessionModel.updateWorkspace(domainId, userId, workspaceId, { sessionIds });
    }

    static async search(domainId: string, userId: number, query: string, agentId?: number | null): Promise<{ sessionId: string; snippet: string }[]> {
        const needle = query.trim().toLocaleLowerCase();
        if (!needle) return [];
        let sessionIds: string[] | undefined;
        if (agentId !== undefined) {
            const matches = await sessions.find(sessionFilter(domainId, userId, undefined, agentId)).project({ sessionId: 1 }).toArray() as { sessionId: string }[];
            sessionIds = matches.map((session) => session.sessionId);
        }
        if (sessionIds?.length === 0) return [];
        const rows = await events.find({ domainId, userId, ...(sessionIds === undefined ? {} : { sessionId: { $in: sessionIds } }) }).sort({ createdAt: -1 }).toArray() as AgentEventDoc[];
        const seen = new Set<string>();
        const result: { sessionId: string; snippet: string }[] = [];
        for (const row of rows) {
            if (seen.has(row.sessionId)) continue;
            const text = JSON.stringify(row.event);
            const index = text.toLocaleLowerCase().indexOf(needle);
            if (index < 0) continue;
            seen.add(row.sessionId);
            result.push({ sessionId: row.sessionId, snippet: text.slice(Math.max(0, index - 80), index + needle.length + 160) });
            if (result.length >= 100) break;
        }
        return result;
    }

    static async deleteSession(domainId: string, userId: number, sessionId: string, agentId?: number | null): Promise<void> {
        await AgentSessionModel.deleteSessions(domainId, userId, [sessionId], agentId);
    }

    static async deleteSessions(domainId: string, userId: number, sessionIds: readonly string[], agentId?: number | null): Promise<void> {
        const requestedIds = [...new Set(sessionIds)].filter(Boolean);
        if (requestedIds.length === 0) return;
        const filter = { ...sessionFilter(domainId, userId, undefined, agentId), sessionId: { $in: requestedIds } };
        const matched = await sessions.find(filter).project({ sessionId: 1 }).toArray() as { sessionId: string }[];
        const ids = matched.map((session) => session.sessionId);
        if (ids.length === 0) return;
        await Promise.all([
            sessions.deleteMany(filter),
            events.deleteMany({ domainId, userId, sessionId: { $in: ids } }),
            workspaces.updateMany(workspaceFilter(domainId, userId), { $pull: { sessionIds: { $in: ids } } as any, $set: { updatedAt: new Date() } }),
        ]);
    }

    static async updateWorkspace(domainId: string, userId: number, workspaceId: string, patch: Partial<AgentWorkspaceDoc>): Promise<AgentWorkspaceDoc | null> {
        await workspaces.updateOne(workspaceFilter(domainId, userId, workspaceId), { $set: { ...patch, updatedAt: new Date() } });
        return await AgentSessionModel.getWorkspace(domainId, userId, workspaceId);
    }

    static async deleteWorkspace(domainId: string, userId: number, workspaceId: string): Promise<void> {
        const workspace = await AgentSessionModel.getWorkspace(domainId, userId, workspaceId);
        if (!workspace) return;
        await AgentSessionModel.deleteSessions(domainId, userId, workspace.sessionIds);
        await workspaces.deleteOne(workspaceFilter(domainId, userId, workspaceId));
    }

    static async archivedSessionIds(domainId: string, userId: number, agentId?: number | null): Promise<string[]> {
        const rows = await sessions.find({ ...sessionFilter(domainId, userId, undefined, agentId), archived: true }, { projection: { sessionId: 1 } }).toArray() as Pick<AgentSessionDoc, 'sessionId'>[];
        return rows.map((row) => row.sessionId);
    }

    static async getDomainSettings(domainId: string): Promise<AgentDomainSettings> {
        const domain = await domains.findOne({ _id: domainId }) as Record<string, unknown> | null;
        return domainSettingsOf(domain);
    }

    static async updateDomainSettings(
        domainId: string,
        sections: Record<string, Record<string, unknown>>,
        expectedRevision?: number,
    ): Promise<AgentDomainSettings | null> {
        const current = await AgentSessionModel.getDomainSettings(domainId);
        const revision = current.revision;
        const nextRevision = revision + 1;
        const filter: Record<string, unknown> = { _id: domainId };
        if (expectedRevision !== undefined) {
            filter.$or = [
                { agentSettingsRevision: expectedRevision },
                ...(expectedRevision === 0 ? [{ agentSettingsRevision: { $exists: false } }] : []),
            ];
        } else if (revision === 0) {
            filter.$or = [{ agentSettingsRevision: 0 }, { agentSettingsRevision: { $exists: false } }];
        } else {
            filter.agentSettingsRevision = revision;
        }
        const result = await domains.updateOne(filter, {
            $set: { agentSettings: cloneSections(sections), agentSettingsRevision: nextRevision },
        });
        if (result.matchedCount !== 1) return null;
        return { sections: cloneSections(sections), revision: nextRevision };
    }

    static async resolveCredential(domainId: string, ref: string): Promise<string | undefined> {
        const doc = await credentials.findOne({ domainId, ref }) as AgentCredentialDoc | null;
        return doc === null ? undefined : decryptCredential(doc);
    }

    static async describeCredential(domainId: string, ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }> {
        const configured = await credentials.findOne({ domainId, ref }, { projection: { _id: 1 } }) !== null;
        return { configured, ...(configured ? { source: 'domain' } : {}), writable: true };
    }

    static async setCredential(domainId: string, ref: string, value: string): Promise<void> {
        if (value.length === 0) throw new Error(`credential value for "${ref}" cannot be empty`);
        const now = new Date();
        const encrypted = encryptCredential(value);
        await credentials.updateOne(
            { domainId, ref },
            {
                $set: { ...encrypted, updatedAt: now },
                $setOnInsert: { _id: new ObjectId(), domainId, ref, createdAt: now },
            },
            { upsert: true },
        );
    }

    static async unsetCredential(domainId: string, ref: string): Promise<void> {
        await credentials.deleteOne({ domainId, ref });
    }

    static async domainRuntime(sessionId: string): Promise<{ domainId: string; settings: Record<string, Record<string, unknown>>; credentials: Record<string, string> } | undefined> {
        const session = await AgentSessionModel.getSessionAny(sessionId);
        if (!session) return undefined;
        const settings = await AgentSessionModel.getDomainSettings(session.domainId);
        const stored = await credentials.find({ domainId: session.domainId }).toArray() as AgentCredentialDoc[];
        const values = await Promise.all(stored.map(async (doc) => [doc.ref, await AgentSessionModel.resolveCredential(session.domainId, doc.ref)] as const));
        return {
            domainId: session.domainId,
            settings: settings.sections,
            credentials: Object.fromEntries(values.filter(([, value]) => value !== undefined)),
        };
    }

    static async deleteDomain(domainId: string): Promise<void> {
        await Promise.all([
            sessions.deleteMany({ domainId }),
            events.deleteMany({ domainId }),
            workspaces.deleteMany({ domainId }),
            nodes.deleteMany({ domainId }),
            uiPrefs.deleteMany({ domainId }),
            credentials.deleteMany({ domainId }),
        ]);
    }
}

global.Ejunz.model.agentSession = AgentSessionModel;

/**
 * The agent runtime registry: one row per runtime that serves this server's
 * sessions.
 *
 * A runtime is a whole Ejunz-Agent application instance, not a session and not
 * a domain: the embedded surface runs inside this process, and a runtime that
 * connects from elsewhere reports itself over its own transport. The registry
 * is therefore deployment-global — it is the one place a status surface can see
 * which runtimes exist, whether each still reports, and how much work each
 * holds.
 */

/** How one agent runtime reaches this server. */
export type AgentRuntimeKind = 'builtin' | 'websocket';

/** One runtime's reported state, as the registry stores and a page reads it. */
export interface AgentRuntimeSummary {
    /** Stable identity of one process: `host#pid`. */
    runtimeId: string;
    /** Display label, editable from the status page. */
    label: string;
    kind: AgentRuntimeKind;
    /** Host name the runtime reports. */
    host: string;
    pid: number;
    /** Runtime version, as the runtime itself reports it. */
    version: string;
    /** Working directory the runtime resolves relative paths against. */
    cwd: string;
    /** Sessions this runtime currently holds live agents for. */
    attachedSessions: number;
    /**
     * Whether the runtime reported itself live at its last heartbeat. Liveness
     * as a viewer reads it also needs {@link AgentRuntimeSummary.updatedAt}: a
     * runtime that died silently keeps its last report.
     */
    online: boolean;
    /** When this process started, from the runtime's own clock report. */
    startedAt: number;
    /** Last heartbeat that reached this server. */
    updatedAt: number;
}

export interface AgentRuntimeDoc extends Omit<AgentRuntimeSummary, 'startedAt'> {
    _id: ObjectId;
    startedAt: Date;
}

const runtimes = agentCollection('agent.runtime');

function runtimeToSummary(doc: AgentRuntimeDoc): AgentRuntimeSummary {
    return {
        runtimeId: doc.runtimeId,
        label: doc.label,
        kind: doc.kind,
        host: doc.host,
        pid: doc.pid,
        version: doc.version,
        cwd: doc.cwd,
        attachedSessions: doc.attachedSessions,
        online: doc.online === true,
        startedAt: doc.startedAt instanceof Date ? doc.startedAt.getTime() : Number(doc.startedAt) || 0,
        updatedAt: doc.updatedAt,
    };
}

export class AgentRuntimeModel {
    static async ensureIndexes(): Promise<void> {
        await runtimes.createIndex({ runtimeId: 1 }, { unique: true, background: true, name: 'agent_runtime_id_unique' });
    }

    /**
     * Record one runtime's current state, or update the row it already has.
     *
     * The runtime owns every fact here, so a report replaces the whole row: a
     * stale value must never outlive the report that carried it. The label is
     * the exception — it is the one fact a person owns, so a report only
     * defaults it when the row is created.
     * @param summary - the runtime's reported state.
     */
    static async upsert(summary: AgentRuntimeSummary): Promise<void> {
        const { startedAt, label, ...reported } = summary;
        await runtimes.updateOne(
            { runtimeId: summary.runtimeId },
            {
                $set: { ...reported, startedAt: new Date(startedAt), updatedAt: summary.updatedAt },
                $setOnInsert: { _id: new ObjectId(), label },
            },
            { upsert: true },
        );
    }

    static async list(): Promise<AgentRuntimeSummary[]> {
        const docs = await runtimes.find({}).sort({ updatedAt: -1 }).toArray() as AgentRuntimeDoc[];
        return docs.map(runtimeToSummary);
    }

    /**
     * Set one runtime's display label.
     * @param runtimeId - runtime to relabel.
     * @param label - the new label.
     * @returns whether a row carried that id.
     */
    static async setLabel(runtimeId: string, label: string): Promise<boolean> {
        const result = await runtimes.updateOne({ runtimeId }, { $set: { label } });
        return result.matchedCount === 1;
    }

    /**
     * Record one heartbeat from a runtime that keeps its own row current.
     *
     * A connected runtime reports how much work it holds; its other facts are
     * whatever its last full report said, so a heartbeat updates only what the
     * heartbeat carries.
     * @param runtimeId - runtime that reported.
     * @param attachedSessions - sessions it currently holds live agents for.
     * @returns whether a row carried that id.
     */
    static async touch(runtimeId: string, attachedSessions: number): Promise<boolean> {
        const result = await runtimes.updateOne(
            { runtimeId },
            { $set: { attachedSessions, online: true, updatedAt: Date.now() } },
        );
        return result.matchedCount === 1;
    }

    /**
     * Record that one runtime stopped reporting, without touching the facts its
     * last heartbeat carried.
     * @param runtimeId - runtime that stopped.
     * @returns whether a row carried that id.
     */
    static async markOffline(runtimeId: string): Promise<boolean> {
        const result = await runtimes.updateOne({ runtimeId }, { $set: { online: false } });
        return result.matchedCount === 1;
    }

    /**
     * Drop one runtime's row.
     * @param runtimeId - runtime to forget.
     * @returns whether a row carried that id.
     */
    static async remove(runtimeId: string): Promise<boolean> {
        const result = await runtimes.deleteOne({ runtimeId });
        return result.deletedCount === 1;
    }
}


/**
 * Pairing between an operator and an agent runtime that has no credential yet.
 *
 * A runtime that was never bound cannot authenticate, so it asks to be bound:
 * this store holds that request — the short code the operator sees, the secret
 * only the asking socket holds, and, once an operator approves it, the token the
 * runtime keeps. The secret is what keeps the URL from being enough on its own:
 * a code pasted into a chat hands nothing to a socket that cannot present the
 * secret that asked for it.
 */

/** How long an unapproved request stays open. */
const LINK_TTL_MS = 15 * 60 * 1000;

/** Human-copyable code alphabet: no characters that read as each other. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type AgentLinkStatus = 'pending' | 'approved';

export interface AgentLinkSummary {
    code: string;
    label: string;
    host: string;
    pid: number;
    status: AgentLinkStatus;
    /** The operator who approved it, when one did. */
    approvedBy?: number;
    createdAt: number;
    expiresAt: number;
}

interface AgentLinkDoc {
    _id: ObjectId;
    code: string;
    /** Hash of the secret the asking socket generated; never the secret itself. */
    pairSecretHash: string;
    label: string;
    host: string;
    pid: number;
    status: AgentLinkStatus;
    approvedBy?: number;
    /**
     * The credential the runtime keeps, once an operator approved. Stored as
     * issued, the way this server stores a session id: the socket that asked
     * collects it on its next poll, which is also what lets a request outlive
     * the connection that opened it.
     */
    token?: string;
    createdAt: Date;
    /**
     * When a still-pending request stops being bindable. Cleared on approval so
     * the TTL index does not delete the credential the runtime keeps.
     */
    expiresAt?: Date;
}

const links = agentCollection('agent.link');

/** A pairing secret is stored as its hash: the store never holds it. */
function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function randomCode(): string {
    const bytes = randomBytes(8);
    let code = '';
    for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    return code;
}

function linkToSummary(doc: AgentLinkDoc): AgentLinkSummary {
    return {
        code: doc.code,
        label: doc.label,
        host: doc.host,
        pid: doc.pid,
        status: doc.status,
        ...(doc.approvedBy === undefined ? {} : { approvedBy: doc.approvedBy }),
        createdAt: doc.createdAt instanceof Date ? doc.createdAt.getTime() : Number(doc.createdAt) || 0,
        expiresAt: doc.expiresAt instanceof Date ? doc.expiresAt.getTime() : Number(doc.expiresAt) || 0,
    };
}

export class AgentLinkModel {
    static async ensureIndexes(): Promise<void> {
        await Promise.all([
            links.createIndex({ code: 1 }, { unique: true, background: true, name: 'agent_link_code_unique' }),
            links.createIndex({ token: 1 }, { background: true, name: 'agent_link_token' }),
            // Pending requests expire on their own: an unanswered code must not
            // stay bindable. Approved rows unset expiresAt so this index never
            // deletes a live credential.
            links.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'agent_link_expiry' }),
        ]);
    }

    /**
     * Open one pairing request for a runtime that cannot authenticate.
     * @param input - the runtime's self-description and the secret its socket holds.
     * @returns the code the operator sees, and when the request expires.
     */
    static async request(input: { label: string; host: string; pid: number; pairSecret: string }): Promise<{ code: string; expiresAt: number }> {
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + LINK_TTL_MS);
        for (let attempt = 0; ; attempt += 1) {
            const code = randomCode();
            try {
                await links.insertOne({
                    _id: new ObjectId(),
                    code,
                    pairSecretHash: digest(input.pairSecret),
                    label: input.label,
                    host: input.host,
                    pid: input.pid,
                    status: 'pending',
                    createdAt,
                    expiresAt,
                } as AgentLinkDoc);
                return { code, expiresAt: expiresAt.getTime() };
            } catch (error) {
                // A code collision is the only insert failure worth retrying.
                if (attempt >= 4) throw error;
            }
        }
    }

    /**
     * Read one request, for the page that shows it.
     * @param code - the request's code.
     */
    static async get(code: string): Promise<AgentLinkSummary | undefined> {
        const doc = await links.findOne({ code }) as AgentLinkDoc | null;
        return doc === null ? undefined : linkToSummary(doc);
    }

    /**
     * Answer one request: approve it, and issue the credential the runtime keeps.
     *
     * Approval also lifts the pending-request expiry: `expiresAt` only bounds the
     * window an operator has to answer, and the TTL index would otherwise delete
     * the approved row (and its token) fifteen minutes after the request was
     * opened. Unsetting it is what makes an approved binding permanent.
     * @param code - the request to approve.
     * @param approvedBy - the approving operator's user id.
     * @returns the issued token, or why the request cannot be approved.
     */
    static async approve(code: string, approvedBy: number): Promise<{ token: string } | { error: string }> {
        const doc = await links.findOne({ code }) as AgentLinkDoc | null;
        if (doc === null) return { error: 'link request not found' };
        if (doc.status === 'approved') return { error: 'link request was already approved' };
        if (doc.expiresAt !== undefined && doc.expiresAt.getTime() < Date.now()) return { error: 'link request expired' };
        const token = randomBytes(24).toString('base64url');
        const result = await links.updateOne(
            { code, status: 'pending' },
            {
                $set: { status: 'approved', token, approvedBy },
                $unset: { expiresAt: 1 },
            },
        );
        // The update's own filter is what makes approval single-shot: two
        // operators answering at once cannot issue two credentials.
        if (result.matchedCount !== 1) return { error: 'link request was already approved' };
        return { token };
    }

    /**
     * Collect one approved request's credential, from the socket that opened it.
     * @param code - the request's code.
     * @param pairSecret - the secret the asking socket holds.
     * @returns the request's state, with its token once approved.
     */
    static async poll(code: string, pairSecret: string): Promise<{ status: AgentLinkStatus; token?: string } | { error: string }> {
        const doc = await links.findOne({ code }) as AgentLinkDoc | null;
        if (doc === null) return { error: 'link request not found' };
        if (doc.pairSecretHash !== digest(pairSecret)) return { error: 'link request belongs to another connection' };
        return { status: doc.status, ...(doc.token === undefined ? {} : { token: doc.token }) };
    }

    /**
     * Resolve a runtime's credential to the binding it stands for.
     * @param token - the credential a runtime presented.
     * @returns the request it was issued for, when the token is valid.
     */
    static async findByToken(token: string): Promise<AgentLinkSummary | undefined> {
        const doc = await links.findOne({ token }) as AgentLinkDoc | null;
        return doc === null ? undefined : linkToSummary(doc);
    }
}


export interface AgentStorageDescriptor {
    name: string;
    version: number;
    tables: string[];
    hasGlobal: boolean;
}

export interface AgentStorageSnapshot {
    tables: Record<string, Record<string, unknown>>;
    global: unknown;
}

interface AgentStorageDoc extends AgentStorageDescriptor {
    _id: ObjectId;
    global: unknown;
    updatedAt: Date;
}

interface AgentStorageRecordDoc {
    _id: ObjectId;
    unit: string;
    table: string;
    key: string;
    value: unknown;
    updatedAt: Date;
}

const units = agentCollection('agent.storage');
const records = agentCollection('agent.storage_record');

export class AgentStorageModel {
    static async ensureIndexes(): Promise<void> {
        await Promise.all([
            units.createIndex({ name: 1 }, { unique: true, background: true, name: 'agent_storage_name_unique' }),
            records.createIndex({ unit: 1, table: 1, key: 1 }, { unique: true, background: true, name: 'agent_storage_record_key_unique' }),
            records.createIndex({ unit: 1, table: 1 }, { background: true, name: 'agent_storage_record_table' }),
        ]);
    }

    static async open(descriptor: AgentStorageDescriptor): Promise<void> {
        const existing = await units.findOne({ name: descriptor.name }) as AgentStorageDoc | null;
        if (existing && (existing.version !== descriptor.version || existing.hasGlobal !== descriptor.hasGlobal || existing.tables.join('\0') !== descriptor.tables.join('\0'))) {
            throw new Error(`storage unit '${descriptor.name}' descriptor mismatch`);
        }
        if (!existing) {
            await units.insertOne({ _id: new ObjectId(), ...descriptor, global: null, updatedAt: new Date() } as AgentStorageDoc);
        }
    }

    static async load(name: string): Promise<AgentStorageSnapshot> {
        const doc = await units.findOne({ name }) as AgentStorageDoc | null;
        if (!doc) throw new Error(`storage unit '${name}' not found`);
        const rows = await records.find({ unit: name }).toArray() as AgentStorageRecordDoc[];
        const tables: Record<string, Record<string, unknown>> = Object.fromEntries(doc.tables.map((table) => [table, {}]));
        for (const row of rows) {
            if (tables[row.table] !== undefined) tables[row.table][row.key] = row.value;
        }
        return { tables, global: doc.global };
    }

    static async put(name: string, table: string, key: string, value: unknown): Promise<void> {
        await records.updateOne(
            { unit: name, table, key },
            { $set: { value, updatedAt: new Date() }, $setOnInsert: { _id: new ObjectId(), unit: name, table, key } },
            { upsert: true },
        );
        await units.updateOne({ name }, { $set: { updatedAt: new Date() } });
    }

    static async delete(name: string, table: string, key: string): Promise<void> {
        await records.deleteOne({ unit: name, table, key });
        await units.updateOne({ name }, { $set: { updatedAt: new Date() } });
    }

    static async setGlobal(name: string, value: unknown): Promise<void> {
        await units.updateOne({ name }, { $set: { global: value, updatedAt: new Date() } });
    }
}

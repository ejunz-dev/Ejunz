import { createHash } from 'crypto';
import { ObjectId } from 'mongodb';
import request from 'superagent';
import type { BaseNode, CardDoc, McpDoc, PluginDoc, PluginMcpStatus, ToolDoc } from '../interface';
import { getBranchData } from '../model/base';
import * as document from '../model/document';
import McpModel from '../model/mcp';
import PluginModel from '../model/plugin';
import ToolModel from '../model/tool';
import { Logger } from '../logger';
import {
    loadPluginCardDefinitions,
    parsePluginDefinitionsFromSnapshot,
    type PluginCardDefinition,
    type PluginMcpConfig,
} from './pluginRuntime';

const logger = new Logger('plugin-mcp');
const DEFAULT_TIMEOUT_MS = 8000;

export type PluginMcpServerTestResult = {
    ok: boolean;
    serverKey: string;
    transport: 'http' | 'sse';
    url: string;
    tools: Array<{ name: string; description?: string; inputSchema?: any }>;
    error?: string;
    checkedAt: Date;
    configHash: string;
};

export type PluginMcpTestSummary = {
    ok: boolean;
    hasMcpConfig: boolean;
    checkedAt: Date;
    results: PluginMcpServerTestResult[];
    errors: string[];
};

export type BuiltinPluginMcpRuntime = {
    localKey: string;
    packageName?: string;
    version?: string;
    name?: string;
    description?: string;
    domainInstallable?: boolean;
    ensureDomainMcp?(input: { domainId: string; owner: number }): Promise<any>;
    removeDomainMcp?(input: { domainId: string }): Promise<any>;
    tools: Array<{ name: string; description?: string; inputSchema?: any }>;
    callTool(input: {
        domainId: string;
        mcpId: number;
        name: string;
        args: any;
        timeoutMs?: number;
    }): Promise<any>;
};

function builtinPluginRuntimeMap(): Map<string, BuiltinPluginMcpRuntime> {
    const g = globalThis as any;
    if (!g.__ejunzBuiltinPluginMcpRuntimes) g.__ejunzBuiltinPluginMcpRuntimes = new Map<string, BuiltinPluginMcpRuntime>();
    return g.__ejunzBuiltinPluginMcpRuntimes;
}

export function registerBuiltinPluginMcpRuntime(runtime: BuiltinPluginMcpRuntime) {
    if (!runtime?.localKey) throw new Error('Builtin plugin MCP runtime localKey is required');
    builtinPluginRuntimeMap().set(runtime.localKey, runtime);
}

export function getBuiltinPluginMcpRuntime(localKey: string): BuiltinPluginMcpRuntime | null {
    return builtinPluginRuntimeMap().get(localKey) || null;
}

export function listBuiltinPluginMcpRuntimes(): BuiltinPluginMcpRuntime[] {
    return Array.from(builtinPluginRuntimeMap().values());
}

function cleanupSourceQuery(input: {
    pluginDocId?: number;
    localKey?: string;
    packageName?: string;
    runtimeMode?: string;
}, prefix: 'source') {
    const query: Record<string, unknown> = {};
    if (input.pluginDocId !== undefined) query[`${prefix}.pluginDocId`] = input.pluginDocId;
    if (input.localKey) query[`${prefix}.localKey`] = input.localKey;
    if (input.packageName) query[`${prefix}.packageName`] = input.packageName;
    if (input.runtimeMode) query[`${prefix}.runtimeMode`] = input.runtimeMode;
    return query;
}

export async function cleanupPluginMcpArtifacts(input: {
    domainId?: string;
    pluginDocId?: number;
    localKey?: string;
    packageName?: string;
    runtimeMode?: 'builtin' | 'ws' | string;
}): Promise<{ mcpsDeleted: number; toolsDeleted: number }> {
    if (!input.pluginDocId && !input.localKey && !input.packageName) {
        throw new Error('cleanupPluginMcpArtifacts requires pluginDocId, localKey, or packageName');
    }

    const sourceQuery = cleanupSourceQuery(input, 'source');
    const mcpQuery = {
        docType: document.TYPE_MCP,
        kind: 'plugin',
        'source.type': 'plugin',
        ...sourceQuery,
        ...(input.domainId ? { domainId: input.domainId } : {}),
    } as any;
    const mcps = await document.coll.find(mcpQuery).toArray() as McpDoc[];
    let toolsDeleted = 0;
    let mcpsDeleted = 0;

    for (const mcp of mcps) {
        const toolRes = await ToolModel.deleteByMcpId(mcp.domainId, mcp.mid) as any;
        toolsDeleted += Number(toolRes?.deletedCount || 0);
        await McpModel.del(mcp.domainId, mcp.mid);
        mcpsDeleted++;
    }

    const orphanToolQuery = {
        docType: document.TYPE_TOOL,
        'source.type': 'plugin_mcp',
        ...sourceQuery,
        ...(input.domainId ? { domainId: input.domainId } : {}),
    } as any;
    const orphanTools = await document.coll.find(orphanToolQuery).toArray() as ToolDoc[];
    for (const tool of orphanTools) {
        await document.deleteOne(tool.domainId, document.TYPE_TOOL, tool.docId);
        toolsDeleted++;
    }

    return { mcpsDeleted, toolsDeleted };
}

function configHash(cfg: PluginMcpConfig): string {
    return createHash('sha256')
        .update(JSON.stringify({ transport: cfg.transport, url: cfg.url, headers: cfg.headers || {}, allow: cfg.toolAllowlist || [] }))
        .digest('hex');
}

export function redactSecretText(raw: unknown): string {
    let s = String(raw || '');
    s = s.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"'}]+/ig, '$1[redacted]');
    s = s.replace(/(api[-_]?key\s*[:=]\s*)[^\s,"'}]+/ig, '$1[redacted]');
    s = s.replace(/(token\s*[:=]\s*)[^\s,"'}]+/ig, '$1[redacted]');
    s = s.replace(/(cookie\s*[:=]\s*)[^\n]+/ig, '$1[redacted]');
    return s.slice(0, 500);
}

function resolveEnvPlaceholders(value: string): string {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => process.env[name] || '');
}

function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (!headers) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) out[key] = resolveEnvPlaceholders(value);
    return out;
}

function assertSafeUrl(urlRaw: string) {
    let u: URL;
    try { u = new URL(urlRaw); } catch { throw new Error('Invalid MCP URL'); }
    if (u.protocol === 'https:') return;
    const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    if (u.protocol === 'http:' && localHosts.has(u.hostname)) return;
    throw new Error('MCP URL must use https://, or http://localhost for local development');
}

async function testHttpMcpConfig(cfg: PluginMcpConfig, timeoutMs: number): Promise<PluginMcpServerTestResult> {
    const checkedAt = new Date();
    const hash = configHash(cfg);
    try {
        assertSafeUrl(cfg.url);
        const headers = resolveHeaders(cfg.headers);
        const initializeBody = {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'ejunz-plugin-mcp-check', version: '1.0.0' },
            },
        };
        const initReq = request.post(cfg.url)
            .set('content-type', 'application/json')
            .set('accept', 'application/json')
            .send(initializeBody)
            .timeout({ response: timeoutMs, deadline: timeoutMs + 1000 });
        if (headers) initReq.set(headers);
        const initRes = await initReq;
        if (initRes.body?.error) throw new Error(initRes.body.error.message || 'MCP initialize failed');
        const sessionId = initRes.headers?.['mcp-session-id'];
        const initializedReq = request.post(cfg.url)
            .set('content-type', 'application/json')
            .set('accept', 'application/json')
            .send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
            .timeout({ response: timeoutMs, deadline: timeoutMs + 1000 });
        if (headers) initializedReq.set(headers);
        if (sessionId) initializedReq.set('Mcp-Session-Id', sessionId);
        await initializedReq.catch(() => undefined);

        const toolsReq = request.post(cfg.url)
            .set('content-type', 'application/json')
            .set('accept', 'application/json')
            .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
            .timeout({ response: timeoutMs, deadline: timeoutMs + 1000 });
        if (headers) toolsReq.set(headers);
        if (sessionId) toolsReq.set('Mcp-Session-Id', sessionId);
        const toolsRes = await toolsReq;
        if (toolsRes.body?.error) throw new Error(toolsRes.body.error.message || 'MCP tools/list failed');
        const toolsRaw = Array.isArray(toolsRes.body?.result?.tools) ? toolsRes.body.result.tools : [];
        let tools = toolsRaw
            .map((t: any) => ({
                name: String(t?.name || '').trim(),
                description: String(t?.description || ''),
                inputSchema: t?.inputSchema || { type: 'object', properties: {} },
            }))
            .filter((t: any) => t.name);
        if (cfg.toolAllowlist?.length) {
            const allow = new Set(cfg.toolAllowlist);
            tools = tools.filter((t: any) => allow.has(t.name));
        }
        return { ok: true, serverKey: cfg.serverKey, transport: cfg.transport, url: cfg.url, tools, checkedAt, configHash: hash };
    } catch (err: any) {
        return { ok: false, serverKey: cfg.serverKey, transport: cfg.transport, url: cfg.url, tools: [], checkedAt, configHash: hash, error: redactSecretText(err?.message || err) };
    }
}

async function testOneConfig(cfg: PluginMcpConfig, timeoutMs: number): Promise<PluginMcpServerTestResult> {
    if (cfg.transport === 'sse') {
        return {
            ok: false,
            serverKey: cfg.serverKey,
            transport: cfg.transport,
            url: cfg.url,
            tools: [],
            checkedAt: new Date(),
            configHash: configHash(cfg),
            error: 'SSE plugin MCP health checks are not supported yet; use streamable HTTP MCP.',
        };
    }
    return testHttpMcpConfig(cfg, timeoutMs);
}

function allConfigs(definitions: PluginCardDefinition[]): Array<{ def: PluginCardDefinition; cfg: PluginMcpConfig }> {
    const out: Array<{ def: PluginCardDefinition; cfg: PluginMcpConfig }> = [];
    for (const def of definitions) {
        for (const cfg of def.mcpConfigs || []) out.push({ def, cfg });
    }
    return out;
}

export async function buildPluginDraftSnapshot(input: {
    domainId: string;
    plugin: PluginDoc;
    branch: string;
    batch: any;
}): Promise<{ nodes: BaseNode[]; nodeCardsMap: Record<string, CardDoc[]> }> {
    const data = getBranchData(input.plugin as any, input.branch);
    const nodes = (data.nodes || []).map((n: BaseNode) => ({ ...n, data: n.data ? { ...n.data } : n.data }));
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const deletedNodes = new Set<string>((input.batch.nodeDeletes || []).map((x: any) => String(x)));
    for (const nodeUpdate of input.batch.nodeUpdates || []) {
        const id = String(nodeUpdate.nodeId || '');
        const node = nodeById.get(id);
        if (!node) continue;
        if (nodeUpdate.text != null) node.text = nodeUpdate.text;
        if (nodeUpdate.order != null) node.order = nodeUpdate.order;
        if (nodeUpdate.data !== undefined) node.data = nodeUpdate.data;
    }
    for (const nodeCreate of input.batch.nodeCreates || []) {
        const id = String(nodeCreate.tempId || nodeCreate.id || '');
        if (!id) continue;
        const node: BaseNode = {
            id,
            text: nodeCreate.text || 'Untitled',
            x: nodeCreate.x,
            y: nodeCreate.y,
            parentId: nodeCreate.parentId,
            order: nodeCreate.order,
            data: nodeCreate.data,
        };
        nodes.push(node);
        nodeById.set(id, node);
    }

    const nodeCardsMap: Record<string, CardDoc[]> = {};
    for (const node of nodes) {
        if (deletedNodes.has(node.id)) continue;
        const filter: any = { baseDocId: input.plugin.docId, nodeId: node.id };
        if (input.branch === 'main') filter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
        else filter.branch = input.branch;
        const cards = await document.getMulti(input.domainId, document.TYPE_CARD, filter).sort({ order: 1, cid: 1 }).toArray() as CardDoc[];
        nodeCardsMap[node.id] = cards.map((c) => ({ ...c }));
    }

    const deletedCards = new Set<string>((input.batch.cardDeletes || []).map((x: any) => String(x)));
    for (const [nodeId, cards] of Object.entries(nodeCardsMap)) nodeCardsMap[nodeId] = cards.filter((c) => !deletedCards.has(String(c.docId)));

    for (const cardUpdate of input.batch.cardUpdates || []) {
        const cardId = String(cardUpdate.cardId || '');
        for (const [nodeId, cards] of Object.entries(nodeCardsMap)) {
            const idx = cards.findIndex((c) => String(c.docId) === cardId);
            if (idx < 0) continue;
            const updated = { ...cards[idx] };
            if (cardUpdate.title !== undefined) updated.title = cardUpdate.title;
            if (cardUpdate.content !== undefined) updated.content = cardUpdate.content;
            if (cardUpdate.nodeId !== undefined && cardUpdate.nodeId !== nodeId) {
                nodeCardsMap[nodeId].splice(idx, 1);
                const target = String(cardUpdate.nodeId);
                if (!nodeCardsMap[target]) nodeCardsMap[target] = [];
                updated.nodeId = target;
                nodeCardsMap[target].push(updated);
            } else {
                nodeCardsMap[nodeId][idx] = updated;
            }
        }
    }

    for (const cardCreate of input.batch.cardCreates || []) {
        const nodeId = String(cardCreate.nodeId || '');
        if (deletedNodes.has(nodeId)) continue;
        if (!nodeCardsMap[nodeId]) nodeCardsMap[nodeId] = [];
        nodeCardsMap[nodeId].push({
            docType: document.TYPE_CARD,
            docId: new ObjectId(),
            domainId: input.domainId,
            baseDocId: input.plugin.docId,
            nodeId,
            cid: 0,
            owner: input.plugin.owner,
            title: cardCreate.title || 'New Card',
            content: cardCreate.content || '',
            updateAt: new Date(),
            views: 0,
            order: cardCreate.order,
        } as CardDoc);
    }

    return { nodes: nodes.filter((n) => !deletedNodes.has(n.id)), nodeCardsMap };
}

export async function testPluginMcpDefinitions(input: {
    domainId: string;
    plugin: PluginDoc;
    branch: string;
    definitions: PluginCardDefinition[];
    timeoutMs?: number;
}): Promise<PluginMcpTestSummary> {
    const cfgs = allConfigs(input.definitions);
    const checkedAt = new Date();
    const parseErrors = input.definitions.flatMap((def) => (def.mcpConfigErrors || []).map((err) => `MCP "${def.name}" config error: ${err}`));
    if (!cfgs.length) return { ok: parseErrors.length === 0, hasMcpConfig: parseErrors.length > 0, checkedAt, results: [], errors: parseErrors };
    const results = await Promise.all(cfgs.map(({ cfg }) => testOneConfig(cfg, input.timeoutMs || DEFAULT_TIMEOUT_MS)));
    const errors = parseErrors.concat(results.filter((r) => !r.ok).map((r) => `MCP "${r.serverKey}" test failed: ${r.error || 'unknown error'}`));
    return { ok: errors.length === 0, hasMcpConfig: true, checkedAt, results, errors };
}

function statusFromSummary(summary: PluginMcpTestSummary, hasLegacyMcp = false): PluginMcpStatus {
    if (!summary.hasMcpConfig) {
        return {
            availability: 'available',
            hasMcpConfig: false,
            checkedAt: summary.checkedAt,
            ...(hasLegacyMcp ? { error: undefined } : {}),
            servers: [],
        };
    }
    const firstError = summary.errors[0];
    return {
        availability: summary.ok ? 'available' : 'unavailable',
        hasMcpConfig: true,
        checkedAt: summary.checkedAt,
        ...(firstError ? { error: firstError } : {}),
        servers: summary.results.map((r) => ({
            key: r.serverKey,
            availability: r.ok ? 'available' : 'unavailable',
            checkedAt: r.checkedAt,
            error: r.error,
            toolCount: r.tools.length,
            configHash: r.configHash,
        })),
    };
}

export async function syncPluginManagedMcps(input: {
    domainId: string;
    plugin: PluginDoc;
    branch: string;
    definitions: PluginCardDefinition[];
    testSummary?: PluginMcpTestSummary;
}): Promise<void> {
    const resultByKey = new Map((input.testSummary?.results || []).map((r) => [r.serverKey, r]));
    const activeKeys = new Set<string>();
    for (const def of input.definitions) {
        for (const cfg of def.mcpConfigs || []) {
            activeKeys.add(`${def.cardId}:${cfg.serverKey}`);
            const res = resultByKey.get(cfg.serverKey);
            let mcp = await McpModel.getByPluginSource(input.domainId, input.plugin.docId, def.cardId, cfg.serverKey);
            const source = {
                type: 'plugin' as const,
                pluginDocId: input.plugin.docId,
                pluginCardId: def.cardId,
                pluginServerKey: cfg.serverKey,
                configHash: res?.configHash || configHash(cfg),
                transport: cfg.transport,
                externalUrl: cfg.url,
            };
            if (!mcp) {
                mcp = await McpModel.add({
                    domainId: input.domainId,
                    owner: input.plugin.owner,
                    kind: 'plugin' as any,
                    source,
                    assignable: true,
                    status: res?.ok ? 'online' : 'offline',
                    name: cfg.name || `${input.plugin.title} · ${cfg.serverKey}`,
                    description: def.description || 'Plugin-managed MCP connection',
                    lastCheckedAt: res?.checkedAt,
                    lastCheckError: res?.error,
                    toolCount: res?.tools.length || 0,
                });
            } else {
                mcp = await McpModel.update(input.domainId, mcp.mid, {
                    source,
                    assignable: true,
                    status: res?.ok ? 'online' : 'offline',
                    name: cfg.name || mcp.name || `${input.plugin.title} · ${cfg.serverKey}`,
                    description: def.description || mcp.description,
                    lastCheckedAt: res?.checkedAt,
                    lastCheckError: res?.error,
                    toolCount: res?.tools.length || 0,
                } as any);
            }
            if (mcp && res?.ok) {
                await ToolModel.syncToolsFromPluginMcp(input.domainId, mcp.mid, {
                    type: 'plugin_mcp',
                    pluginDocId: input.plugin.docId,
                    pluginCardId: def.cardId,
                    pluginServerKey: cfg.serverKey,
                }, res.tools, input.plugin.owner);
            }
        }
    }

    const existing = await document.getMulti(input.domainId, document.TYPE_MCP, {
        kind: 'plugin',
        'source.type': 'plugin',
        'source.pluginDocId': input.plugin.docId,
    } as any).toArray() as any[];
    for (const mcp of existing) {
        const key = `${mcp.source?.pluginCardId}:${mcp.source?.pluginServerKey}`;
        if (!activeKeys.has(key)) {
            await ToolModel.deleteByMcpId(input.domainId, mcp.mid);
            await McpModel.del(input.domainId, mcp.mid);
        }
    }
}

export async function refreshPluginMcpStatus(input: {
    domainId: string;
    plugin: PluginDoc;
    branch?: string;
    reason: 'save' | 'periodic' | 'manual';
    definitions?: PluginCardDefinition[];
    testSummary?: PluginMcpTestSummary;
}): Promise<PluginMcpStatus> {
    const branch = input.branch || input.plugin.currentBranch || 'main';
    const definitions = input.definitions || await loadPluginCardDefinitions(input.domainId, input.plugin, branch);
    const hasLegacyMcp = definitions.some((d) => d.kind === 'mcp' && (d.toolIds?.length || 0) > 0);
    const summary = input.testSummary || await testPluginMcpDefinitions({
        domainId: input.domainId,
        plugin: input.plugin,
        branch,
        definitions,
    });
    const status = statusFromSummary(summary, hasLegacyMcp);
    await PluginModel.update(input.domainId, input.plugin.docId, { mcpStatus: status } as Partial<PluginDoc>);
    return status;
}

export async function summarizePluginMcpAvailability(domainId: string, plugin: PluginDoc, branch = 'main') {
    if (plugin.mcpStatus) return plugin.mcpStatus;
    try {
        const definitions = await loadPluginCardDefinitions(domainId, plugin, branch);
        const hasConfig = definitions.some((d) => (d.mcpConfigs?.length || 0) > 0);
        const hasLegacyMcp = definitions.some((d) => (d.toolIds?.length || 0) > 0);
        if (!hasConfig) {
            return {
                availability: 'available' as const,
                hasMcpConfig: false,
                checkedAt: new Date(),
                servers: [],
                ...(hasLegacyMcp ? {} : {}),
            };
        }
    } catch (err: any) {
        logger.warn('summarizePluginMcpAvailability failed: %s', err?.message || err);
    }
    return { availability: 'unknown' as const, hasMcpConfig: false, servers: [] };
}

export async function parseDraftPluginMcpDefinitions(input: {
    domainId: string;
    plugin: PluginDoc;
    branch: string;
    batch: any;
}) {
    const snapshot = await buildPluginDraftSnapshot(input);
    return parsePluginDefinitionsFromSnapshot({
        domainId: input.domainId,
        plugin: input.plugin,
        branch: input.branch,
        ...snapshot,
    });
}

export async function checkAllEnabledPluginMcpStatus(domainId: string): Promise<void> {
    const plugins = await PluginModel.getAll(domainId, { enabled: { $ne: false } } as any);
    for (const plugin of plugins) {
        try {
            const branch = plugin.currentBranch || 'main';
            const definitions = await loadPluginCardDefinitions(domainId, plugin, branch);
            const summary = await testPluginMcpDefinitions({ domainId, plugin, branch, definitions });
            await syncPluginManagedMcps({ domainId, plugin, branch, definitions, testSummary: summary });
            await refreshPluginMcpStatus({ domainId, plugin, branch, reason: 'periodic', definitions, testSummary: summary });
        } catch (err: any) {
            logger.warn('plugin MCP periodic check failed plugin=%s: %s', plugin.docId, err?.message || err);
        }
    }
}

export async function callPluginMcpTool(input: {
    domainId: string;
    mcpId: number;
    name: string;
    args: any;
    timeoutMs?: number;
}): Promise<any> {
    const mcp = await McpModel.getByMcpId(input.domainId, input.mcpId);
    if (!mcp) {
        const err = new Error(`Plugin MCP not found for tool: ${input.name}`);
        (err as any).code = 'MCP_NOT_FOUND';
        throw err;
    }
    if (mcp.kind !== 'plugin') {
        const err = new Error(`MCP is not a plugin MCP for tool: ${input.name}`);
        (err as any).code = 'MCP_NOT_FOUND';
        throw err;
    }
    if (mcp.status !== 'online') {
        const err = new Error(`Plugin MCP is offline for tool: ${input.name}`);
        (err as any).code = 'MCP_OFFLINE';
        throw err;
    }
    if (mcp.source?.type === 'plugin' && mcp.source?.runtimeMode === 'builtin' && mcp.source?.localKey) {
        const runtime = getBuiltinPluginMcpRuntime(mcp.source.localKey);
        if (!runtime) {
            const err = new Error(`Builtin plugin MCP runtime is offline for tool: ${input.name}`);
            (err as any).code = 'MCP_OFFLINE';
            throw err;
        }
        return runtime.callTool({
            domainId: input.domainId,
            mcpId: input.mcpId,
            name: input.name,
            args: input.args || {},
            timeoutMs: input.timeoutMs,
        });
    }
    const pluginDocId = mcp.source?.pluginDocId;
    const pluginCardId = mcp.source?.pluginCardId;
    const pluginServerKey = mcp.source?.pluginServerKey;
    if (!pluginDocId || !pluginCardId || !pluginServerKey) throw new Error('Plugin MCP source metadata is incomplete');
    const plugin = await PluginModel.get(input.domainId, pluginDocId);
    if (!plugin) throw new Error('Plugin not found for MCP tool');
    const definitions = await loadPluginCardDefinitions(input.domainId, plugin, plugin.currentBranch || 'main');
    const def = definitions.find((d) => d.cardId === pluginCardId);
    const cfg = def?.mcpConfigs?.find((c) => c.serverKey === pluginServerKey);
    if (!cfg) throw new Error('Plugin MCP config not found for tool');
    if (cfg.transport !== 'http') throw new Error('Only streamable HTTP plugin MCP tool calls are supported');
    assertSafeUrl(cfg.url);
    const headers = resolveHeaders(cfg.headers);
    const req = request.post(cfg.url)
        .set('content-type', 'application/json')
        .set('accept', 'application/json')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: input.name, arguments: input.args || {} } })
        .timeout({ response: input.timeoutMs || DEFAULT_TIMEOUT_MS, deadline: (input.timeoutMs || DEFAULT_TIMEOUT_MS) + 1000 });
    if (headers) req.set(headers);
    const res = await req;
    if (res.body?.error) throw new Error(res.body.error.message || 'Plugin MCP tool call failed');
    return res.body?.result ?? res.body;
}

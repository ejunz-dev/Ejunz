import { createHash } from 'crypto';
import { ObjectId } from 'mongodb';
import yaml from 'js-yaml';
import request from 'superagent';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import type { AgentDoc, BaseEdge, BaseNode, CardDoc, McpDoc, PluginDoc, PluginMcpStatus, PluginNodeData, ToolDoc } from '../interface';
import type { User } from '../interface';
import type { EdgeDoc } from './edge';
import EdgeModel from './edge';
import EdgeTokenModel from './edge_token';
import ToolModel, {
    getLocalMcpToolCatalog,
    getLocalSystemToolCatalog,
    findLocalMcpToolByIdOrName,
    isLocalMcpToolAvailableInDomain,
    resolveMcpTools,
    getBuiltinEjunzToolsLabel,
    getBuiltinEjunzToolsRuntime,
    getBuiltinEjunzToolsVersion,
    getEjunzToolsCatalog,
} from './tool';
import DomainMarketToolModel from './domain_market_tool';
import { BaseModel, CardModel, getBranchData } from './base';
import PluginModel from './plugin';

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
            kind: mcp.kind,
            source: mcp.source,
            assignable: mcp.assignable,
            status: mcp.status || 'offline',
            lastUsedAt: mcp.lastUsedAt,
            lastCheckedAt: mcp.lastCheckedAt,
            lastCheckError: mcp.lastCheckError,
            toolCount: mcp.toolCount,
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

    static async getBySourceSystemKey(domainId: string, systemKey: string): Promise<McpDoc | null> {
        const list = await document.getMulti(domainId, document.TYPE_MCP, {
            kind: 'system',
            'source.type': 'system_tools',
            'source.localKey': systemKey,
        } as any)
            .limit(1)
            .toArray();
        return (list[0] as McpDoc) || null;
    }

    static async getBySourceEdgeDocId(domainId: string, edgeDocId: ObjectId): Promise<McpDoc | null> {
        const list = await document.getMulti(domainId, document.TYPE_MCP, {
            'source.edgeDocId': edgeDocId,
        } as any)
            .limit(1)
            .toArray();
        return (list[0] as McpDoc) || null;
    }

    static async getByPluginSource(domainId: string, pluginDocId: number, pluginCardId: string, pluginServerKey: string): Promise<McpDoc | null> {
        const list = await document.getMulti(domainId, document.TYPE_MCP, {
            kind: 'plugin',
            'source.type': 'plugin',
            'source.pluginDocId': pluginDocId,
            'source.pluginCardId': pluginCardId,
            'source.pluginServerKey': pluginServerKey,
        } as any)
            .limit(1)
            .toArray();
        return (list[0] as McpDoc) || null;
    }

    static async getByPluginLocalKey(domainId: string, localKey: string): Promise<McpDoc | null> {
        const list = await document.getMulti(domainId, document.TYPE_MCP, {
            kind: 'plugin',
            'source.type': 'plugin',
            'source.localKey': localKey,
        } as any)
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

    static async deleteOutboundAndInvalidateToken(domainId: string, mid: number) {
        const mcp = await this.getByMcpId(domainId, mid);
        if (!mcp) return;
        if (mcpKind(mcp) !== 'outbound') throw new Error('Only outbound MCP endpoints can be deleted this way.');
        if (mcp.token) await EdgeTokenModel.delete(mcp.token);
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

// ---- pluginRuntime ----
const SLUG_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const SLASH_NAME_RE = /^[a-zA-Z0-9._-]{1,80}(?:\/[a-zA-Z0-9._-]{1,80}){0,2}$/;
export const SYSTEM_TOOL_ID_PREFIX = 'system:';
const PLUGIN_TOOL_ID_PREFIX = 'plugin:';

function trimString(v: unknown, max = 4000): string | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    if (!s) return undefined;
    return s.slice(0, max);
}

function trimStringArray(v: unknown, maxItems = 20, maxLen = 80): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v
        .map((x) => trimString(x, maxLen))
        .filter((x): x is string => !!x)
        .slice(0, maxItems);
    return out.length ? Array.from(new Set(out)) : undefined;
}

export async function sanitizePluginNodeData(raw: unknown, _domainId?: string): Promise<PluginNodeData | undefined> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, any>;
    const slugRaw = trimString(o.slug, 80) || 'folder';
    const slug = SLUG_RE.test(slugRaw) ? slugRaw : slugRaw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'folder';

    const out: PluginNodeData = {
        pluginNodeType: 'folder',
        slug,
        enabled: o.enabled !== false,
    };
    const description = trimString(o.description, 2000);
    if (description) out.description = description;
    return out;
}

type PluginCardType = 'skill' | 'command' | 'mcp';

export type PluginMcpTransport = 'http' | 'sse';

export type PluginMcpConfig = {
    serverKey: string;
    name?: string;
    transport: PluginMcpTransport;
    url: string;
    headers?: Record<string, string>;
    toolAllowlist?: string[];
    requireConfirmation?: boolean;
};

export type PluginCardDefinition = {
    kind: PluginCardType;
    name: string;
    aliases: string[];
    description: string;
    pluginDocId: number;
    pluginTitle: string;
    nodeId: string;
    nodeTitle: string;
    cardId: string;
    cardTitle: string;
    instructions?: string;
    promptTemplate?: string;
    toolIds?: string[];
    mcpConfigs?: PluginMcpConfig[];
    mcpConfigErrors?: string[];
    requireConfirmation?: boolean;
};

function parsePluginCardFrontmatter(content: string): { meta: Record<string, any>; body: string } {
    const text = String(content || '').replace(/^﻿/, '');
    const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/);
    if (!m) return { meta: {}, body: text.trim() };
    try {
        const loaded = yaml.load(m[1]);
        const meta = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded as Record<string, any> : {};
        return { meta, body: String(m[2] || '').trim() };
    } catch {
        return { meta: {}, body: text.trim() };
    }
}

function cardTitleSlug(title: string): string {
    return String(title || '')
        .replace(/\.[a-z0-9]+$/i, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

function normalizeServerKey(raw: unknown, fallback: string): string {
    const s = trimString(raw, 80) || fallback;
    return SLUG_RE.test(s) ? s : s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
}

function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const k = trimString(key, 120);
        if (!k) continue;
        const v = typeof value === 'string' ? value : value == null ? '' : String(value);
        out[k] = v.slice(0, 4000);
    }
    return Object.keys(out).length ? out : undefined;
}

function normalizeTransport(raw: unknown): PluginMcpTransport | undefined {
    const t = String(raw || 'http').trim().toLowerCase();
    if (t === 'http' || t === 'streamable_http' || t === 'streamable-http') return 'http';
    if (t === 'sse') return 'sse';
    return undefined;
}

function normalizeMcpConfig(raw: unknown, fallbackKey: string, requireConfirmation: boolean): PluginMcpConfig | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, any>;
    const url = trimString(o.url, 4000);
    if (!url) return null;
    const transport = normalizeTransport(o.type ?? o.transport);
    if (!transport) return null;
    const serverKey = normalizeServerKey(o.key ?? o.name ?? o.serverKey, fallbackKey);
    const cfg: PluginMcpConfig = {
        serverKey,
        transport,
        url,
        requireConfirmation: o.requireConfirmation === true || requireConfirmation,
    };
    const name = trimString(o.title ?? o.displayName ?? o.name, 200);
    if (name) cfg.name = name;
    const headers = normalizeHeaders(o.headers);
    if (headers) cfg.headers = headers;
    const allow = trimStringArray(o.tools?.allow ?? o.toolAllowlist ?? o.allowTools, 200, 200);
    if (allow) cfg.toolAllowlist = allow;
    return cfg;
}

function parsePluginMcpConfigs(o: Record<string, any>, baseName: string, requireConfirmation: boolean): { configs: PluginMcpConfig[]; errors: string[] } {
    const configs: PluginMcpConfig[] = [];
    const errors: string[] = [];
    const mcp = o.mcp && typeof o.mcp === 'object' && !Array.isArray(o.mcp) ? o.mcp as Record<string, any> : {};
    const add = (cfg: PluginMcpConfig | null, label: string) => {
        if (!cfg) {
            errors.push(`Invalid MCP config: ${label}`);
            return;
        }
        if (!configs.some((x) => x.serverKey === cfg.serverKey)) configs.push(cfg);
    };

    if (mcp.config) add(normalizeMcpConfig(mcp.config, baseName, requireConfirmation), baseName);
    if (Array.isArray(mcp.configs)) {
        for (const [i, raw] of mcp.configs.entries()) add(normalizeMcpConfig(raw, `${baseName}-${i + 1}`, requireConfirmation), `${baseName}-${i + 1}`);
    }
    if (o.mcpServers && typeof o.mcpServers === 'object' && !Array.isArray(o.mcpServers)) {
        for (const [key, raw] of Object.entries(o.mcpServers as Record<string, unknown>)) {
            add(normalizeMcpConfig({ ...(raw as any), key }, normalizeServerKey(key, baseName), requireConfirmation), key);
        }
    }
    return { configs, errors };
}

async function sanitizePluginCardDefinition(raw: unknown, body: string, card: CardDoc, node: BaseNode, plugin: PluginDoc, domainId?: string): Promise<PluginCardDefinition | null> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, any>;
    const rawType = String(o.type || o.pluginType || o.kind || '').trim().toLowerCase();
    if (rawType !== 'skill' && rawType !== 'command' && rawType !== 'mcp') return null;
    const slugRaw = trimString(o.slug, 240) || cardTitleSlug(card.title) || rawType;
    const nameRe = rawType === 'skill' || rawType === 'command' ? SLASH_NAME_RE : SLUG_RE;
    const sanitizedSlug = slugRaw.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 240);
    const name = nameRe.test(slugRaw) ? slugRaw : (nameRe.test(sanitizedSlug) ? sanitizedSlug : rawType);
    const aliases = trimStringArray(o.aliases, 20, 240)?.filter((x) => nameRe.test(x)) || [];
    const description = trimString(o.description, 2000) || card.title || node.text || '';
    const security = o.security && typeof o.security === 'object' && !Array.isArray(o.security) ? o.security : {};
    const base: PluginCardDefinition = {
        kind: rawType,
        name,
        aliases,
        description,
        pluginDocId: plugin.docId,
        pluginTitle: plugin.title,
        nodeId: node.id,
        nodeTitle: node.text,
        cardId: String(card.docId),
        cardTitle: card.title,
        requireConfirmation: security.requireConfirmation === true,
    };
    if (rawType === 'skill') {
        const instructions = trimString(o.skill?.instructions ?? o.instructions, 50000) || body;
        if (instructions) base.instructions = instructions;
    }
    if (rawType === 'command') {
        const promptTemplate = trimString(o.command?.promptTemplate ?? o.promptTemplate, 50000) || body;
        if (promptTemplate) base.promptTemplate = promptTemplate;
        base.requireConfirmation = o.command?.requireConfirmation === true || security.requireConfirmation === true;
    }
    if (rawType === 'mcp') {
        const toolIdsRaw = Array.isArray(o.mcp?.toolIds) ? o.mcp.toolIds : Array.isArray(o.toolIds) ? o.toolIds : [];
        const toolIds: string[] = [];
        for (const idRaw of toolIdsRaw.slice(0, 100)) {
            const id = String(idRaw || '').trim();
            if (!id) continue;
            if (ObjectId.isValid(id)) {
                if (domainId) {
                    const tool = await document.get(domainId, document.TYPE_TOOL, new ObjectId(id));
                    if (!tool) continue;
                }
                toolIds.push(id);
                continue;
            }
            if (id.startsWith(SYSTEM_TOOL_ID_PREFIX)) {
                const toolKey = id.slice(SYSTEM_TOOL_ID_PREFIX.length).trim();
                if (!toolKey || !SLUG_RE.test(toolKey)) continue;
                const entry = findLocalMcpToolByIdOrName(toolKey);
                if (!entry) continue;
                if (domainId && !(await isLocalMcpToolAvailableInDomain(domainId, toolKey))) continue;
                toolIds.push(`${SYSTEM_TOOL_ID_PREFIX}${toolKey}`);
                continue;
            }
            if (id.startsWith(PLUGIN_TOOL_ID_PREFIX)) {
                const parts = id.slice(PLUGIN_TOOL_ID_PREFIX.length).split(':').map((x) => x.trim()).filter(Boolean);
                const toolDocId = parts.length ? parts[parts.length - 1] : '';
                if (!ObjectId.isValid(toolDocId)) continue;
                if (domainId) {
                    const tool = await document.get(domainId, document.TYPE_TOOL, new ObjectId(toolDocId));
                    if (!tool) continue;
                }
                toolIds.push(toolDocId);
            }
        }
        base.toolIds = Array.from(new Set(toolIds));
        const instructions = trimString(o.mcp?.instructions ?? o.instructions, 20000) || body;
        if (instructions) base.instructions = instructions;
        base.requireConfirmation = o.mcp?.requireConfirmation === true || security.requireConfirmation === true;
        const parsedMcpConfigs = parsePluginMcpConfigs(o, name, base.requireConfirmation === true);
        base.mcpConfigs = parsedMcpConfigs.configs;
        if (parsedMcpConfigs.errors.length) base.mcpConfigErrors = parsedMcpConfigs.errors;
    }
    return base;
}

export async function parsePluginCardDefinition(card: CardDoc, node: BaseNode, plugin: PluginDoc, domainId?: string): Promise<PluginCardDefinition | null> {
    const { meta, body } = parsePluginCardFrontmatter(card.content || '');
    if (meta.enabled === false) return null;
    return sanitizePluginCardDefinition(meta, body, card, node, plugin, domainId);
}

export async function loadPluginCardDefinitions(domainId: string, plugin: PluginDoc, branch = 'main', enabledNodeIds?: Set<string>): Promise<PluginCardDefinition[]> {
    const data = getBranchData(plugin as any, branch);
    const nodes = data.nodes || [];
    const out: PluginCardDefinition[] = [];
    for (const node of nodes) {
        if (enabledNodeIds && !enabledNodeIds.has(node.id)) continue;
        const filter: any = { baseDocId: plugin.docId, nodeId: node.id };
        if (branch === 'main') filter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
        else filter.branch = branch;
        const cards = await document.getMulti(domainId, document.TYPE_CARD, filter).sort({ order: 1, cid: 1 }).toArray() as CardDoc[];
        for (const card of cards) {
            const def = await parsePluginCardDefinition(card, node, plugin, domainId);
            if (def) out.push(def);
        }
    }
    return out;
}

export async function parsePluginDefinitionsFromSnapshot(input: {
    domainId: string;
    plugin: PluginDoc;
    branch?: string;
    nodes: BaseNode[];
    nodeCardsMap: Record<string, CardDoc[]>;
}): Promise<PluginCardDefinition[]> {
    const out: PluginCardDefinition[] = [];
    for (const node of input.nodes || []) {
        const cards = input.nodeCardsMap[node.id] || [];
        for (const card of cards) {
            const def = await parsePluginCardDefinition(card, node, input.plugin, input.domainId);
            if (def) out.push(def);
        }
    }
    return out;
}

export async function summarizePluginDefinitions(domainId: string, plugin: PluginDoc, branch = 'main') {
    const data = getBranchData(plugin as any, branch);
    const counts = { folder: (data.nodes || []).length, skill: 0, command: 0, mcp: 0 };
    for (const def of await loadPluginCardDefinitions(domainId, plugin, branch)) {
        counts[def.kind] += 1;
    }
    return counts;
}

export type SlashCatalogEntry = {
    kind: 'skill' | 'command';
    name: string;
    aliases: string[];
    description: string;
    pluginDocId: number;
    pluginTitle: string;
    nodeId: string;
    nodeTitle: string;
    instructions?: string;
    promptTemplate?: string;
    requireConfirmation?: boolean;
};

export function normalizeAgentPluginBindings(adoc: AgentDoc): Array<{ docId: number; branch: string; enabledNodeIds?: string[] }> {
    const raw = (adoc as any).pluginBindings;
    if (!Array.isArray(raw)) return [];
    const out: Array<{ docId: number; branch: string; enabledNodeIds?: string[] }> = [];
    const seen = new Set<number>();
    for (const b of raw) {
        const docId = Number(b?.docId);
        if (!Number.isFinite(docId) || docId <= 0 || seen.has(docId)) continue;
        seen.add(docId);
        const branch = String(b?.branch || 'main').trim() || 'main';
        const enabledNodeIds = Array.isArray(b?.enabledNodeIds)
            ? b.enabledNodeIds.map((x: unknown) => String(x)).filter(Boolean).slice(0, 500)
            : undefined;
        out.push({ docId, branch, ...(enabledNodeIds?.length ? { enabledNodeIds } : {}) });
    }
    return out;
}

export async function visiblePluginsForUser(domainId: string, user: any): Promise<PluginDoc[]> {
    const plugins = await PluginModel.getAll(domainId, {} as any);
    return plugins.filter((p) => PluginModel.canRead(user, p) || PluginModel.canEdit(user, p));
}

async function loadBoundPluginDocs(domainId: string, adoc: AgentDoc): Promise<Array<{ plugin: PluginDoc; branch: string; enabledNodeIds?: Set<string> }>> {
    const bindings = normalizeAgentPluginBindings(adoc);
    const out: Array<{ plugin: PluginDoc; branch: string; enabledNodeIds?: Set<string> }> = [];
    for (const b of bindings) {
        const plugin = await PluginModel.get(domainId, b.docId);
        if (!plugin || plugin.enabled === false) continue;
        out.push({
            plugin,
            branch: b.branch || 'main',
            ...(b.enabledNodeIds?.length ? { enabledNodeIds: new Set(b.enabledNodeIds) } : {}),
        });
    }
    return out;
}

export async function resolveAgentSlashCatalog(domainId: string, adoc: AgentDoc): Promise<SlashCatalogEntry[]> {
    const out: SlashCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const { plugin, branch, enabledNodeIds } of await loadBoundPluginDocs(domainId, adoc)) {
        for (const def of await loadPluginCardDefinitions(domainId, plugin, branch, enabledNodeIds)) {
            if (def.kind !== 'skill' && def.kind !== 'command') continue;
            if (!def.name || !SLUG_RE.test(def.name) || seen.has(def.name)) continue;
            seen.add(def.name);
            out.push({
                kind: def.kind,
                name: def.name,
                aliases: def.aliases,
                description: def.description,
                pluginDocId: def.pluginDocId,
                pluginTitle: def.pluginTitle,
                nodeId: def.nodeId,
                nodeTitle: def.cardTitle || def.nodeTitle,
                ...(def.instructions ? { instructions: def.instructions } : {}),
                ...(def.promptTemplate ? { promptTemplate: def.promptTemplate } : {}),
                requireConfirmation: def.requireConfirmation === true,
            });
        }
    }
    return out;
}

export type AgentPluginTool = ToolDoc & {
    token?: string;
    type?: 'system' | 'market_mcp' | 'edge' | 'plugin_mcp' | 'ejunztools';
    edgeId?: ObjectId;
    toolDocId?: ObjectId;
    mcpId?: number;
    pluginDocId?: number;
    pluginCardId?: string;
    pluginServerKey?: string;
    toolKey?: string;
    system?: boolean;
};

function shouldRefreshPluginMcpStatus(status: PluginDoc['mcpStatus']): boolean {
    if (!status) return true;
    if (status.availability === 'unknown' || status.availability === 'checking') return true;
    const checkedAt = status.checkedAt ? new Date(status.checkedAt).getTime() : 0;
    if (!checkedAt || Number.isNaN(checkedAt)) return true;
    return Date.now() - checkedAt > 5 * 60 * 1000;
}

export async function resolveAgentPluginTools(domainId: string, adoc: AgentDoc): Promise<AgentPluginTool[]> {
    const byId = new Map<string, AgentPluginTool>();
    for (const { plugin, branch, enabledNodeIds } of await loadBoundPluginDocs(domainId, adoc)) {
        const definitions = await loadPluginCardDefinitions(domainId, plugin, branch, enabledNodeIds);
        let mcpStatus = plugin.mcpStatus;
        if (definitions.some((def) => def.kind === 'mcp' && (def.mcpConfigs?.length || 0) > 0) && shouldRefreshPluginMcpStatus(mcpStatus)) {
            try {
                                const summary = await testPluginMcpDefinitions({ domainId, plugin, branch, definitions });
                await syncPluginManagedMcps({ domainId, plugin, branch, definitions, testSummary: summary });
                mcpStatus = await refreshPluginMcpStatus({ domainId, plugin, branch, reason: 'manual', definitions, testSummary: summary });
            } catch (err: any) {
                console.warn('[plugin-runtime] refresh plugin MCP tools failed:', err?.message || err);
            }
        }
        for (const def of definitions) {
            if (def.kind !== 'mcp') continue;
            for (const id of def.toolIds || []) {
                if (id.startsWith(SYSTEM_TOOL_ID_PREFIX)) {
                    if (byId.has(id)) continue;
                    const toolKey = id.slice(SYSTEM_TOOL_ID_PREFIX.length).trim();
                    const entry = findLocalMcpToolByIdOrName(toolKey);
                    if (!entry || !(await isLocalMcpToolAvailableInDomain(domainId, toolKey))) continue;
                    byId.set(id, {
                        name: entry.name,
                        description: entry.description || '',
                        inputSchema: entry.inputSchema || { type: 'object', properties: {} },
                        type: entry.source === 'system' ? 'system' as const : 'market_mcp' as const,
                        ...(entry.source === 'system' ? { system: true } : {}),
                        toolKey,
                        source: { type: 'system_tools' },
                    } as AgentPluginTool);
                    continue;
                }
                if (!ObjectId.isValid(id) || byId.has(id)) continue;
                const tool = await document.get(domainId, document.TYPE_TOOL, new ObjectId(id));
                if (tool) byId.set(id, tool as AgentPluginTool);
            }
            if (def.mcpConfigs?.length && mcpStatus?.availability === 'available') {
                for (const cfg of def.mcpConfigs) {
                    const serverStatus = mcpStatus.servers?.find((s) => s.key === cfg.serverKey);
                    if (serverStatus && serverStatus.availability !== 'available') continue;
                    const tools = await document.getMulti(domainId, document.TYPE_TOOL, {
                        'source.type': 'plugin_mcp',
                        'source.pluginDocId': plugin.docId,
                        'source.pluginCardId': def.cardId,
                        'source.pluginServerKey': cfg.serverKey,
                    } as any).toArray() as ToolDoc[];
                    for (const tool of tools) byId.set(`plugin:${tool.docId.toString()}`, tool as AgentPluginTool);
                }
            }
        }
    }

    const tools = [...byId.values()];
    const edgeIds = tools.map((tool) => tool.edgeDocId).filter(Boolean);
    const edges = edgeIds.length
        ? await document.getMulti(domainId, document.TYPE_EDGE, { _id: { $in: edgeIds } as any }).toArray()
        : [];
    const edgeById = new Map(edges.map((edge: any) => [edge._id.toString(), edge]));
    return tools.map((tool) => {
        if (tool.source?.type === 'system_tools') {
            return tool.type === 'system'
                ? { ...tool, type: 'system' as const, system: true }
                : { ...tool, type: 'market_mcp' as const, system: false };
        }
        if (tool.source?.type === 'plugin_mcp') {
            return {
                ...tool,
                type: 'plugin_mcp' as const,
                toolDocId: tool._id,
                mcpId: tool.mcpId,
                pluginDocId: tool.source.pluginDocId,
                pluginCardId: tool.source.pluginCardId,
                pluginServerKey: tool.source.pluginServerKey,
            };
        }
        const edge = tool.edgeDocId ? edgeById.get(tool.edgeDocId.toString()) : null;
        return {
            ...tool,
            type: 'edge' as const,
            token: edge?.token || tool.token,
            edgeId: edge?._id || tool.edgeDocId,
            toolDocId: tool._id,
        };
    });
}

export function parseAgentSlashInvocation(message: string, catalog: SlashCatalogEntry[]) {
    const raw = String(message || '').trim();
    if (!raw.startsWith('/')) return null;
    const m = raw.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!m) return { error: 'Invalid slash command', suggestions: catalog.slice(0, 8) };
    const name = m[1];
    const args = m[2] || '';
    const entry = catalog.find((x) => x.name === name || x.aliases.includes(name));
    if (!entry) {
        const suggestions = catalog
            .filter((x) => x.name.includes(name) || x.aliases.some((a) => a.includes(name)))
            .slice(0, 8);
        return { error: `Unknown slash command: /${name}`, suggestions };
    }
    return { entry, args, raw };
}

export function renderSlashSystemBlock(entry: SlashCatalogEntry, args: string, domainId: string, agent: AgentDoc, raw: string): string {
    if (entry.kind === 'skill') {
        return `\n\n---\n[Plugin Skill Invocation]\nThe user invoked /${entry.name}. Apply this skill for this turn only.\nPlugin: ${entry.pluginTitle} (#${entry.pluginDocId})\nNode: ${entry.nodeTitle} (${entry.nodeId})\nArguments:\n${args || '(none)'}\nInstructions:\n${entry.instructions || entry.description || ''}\n---`;
    }
    const template = entry.promptTemplate || entry.description || '';
    const expanded = template
        .replace(/{{\s*args\s*}}/g, args || '')
        .replace(/{{\s*userMessage\s*}}/g, raw || '')
        .replace(/{{\s*agent\.title\s*}}/g, agent.title || '')
        .replace(/{{\s*domainId\s*}}/g, domainId || '');
    return `\n\n---\n[Plugin Command Invocation]\nThe user invoked /${entry.name}. Follow the expanded command instructions for this turn only.\nPlugin: ${entry.pluginTitle} (#${entry.pluginDocId})\nNode: ${entry.nodeTitle} (${entry.nodeId})\nArguments:\n${args || '(none)'}\nExpanded command:\n${expanded}\n---`;
}


// ---- pluginMcp ----
const pluginMcpLogger = new Logger('plugin-mcp');
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
    const nodes: BaseNode[] = (data.nodes || []).map((n: BaseNode) => ({ ...n, data: n.data ? { ...n.data } : n.data }));
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
        pluginMcpLogger.warn('summarizePluginMcpAvailability failed: %s', err?.message || err);
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
            pluginMcpLogger.warn('plugin MCP periodic check failed plugin=%s: %s', plugin.docId, err?.message || err);
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


// ---- systemDefaultPlugin ----
export const SYSTEM_DEFAULT_PLUGIN_SLUG = 'system-default';

const SYSTEM_DEFAULT_PLUGIN_TITLE = 'System Default';
const SYSTEM_DEFAULT_PLUGIN_DESCRIPTION = 'Default system plugin seeded for new domains. Provides starter skills, commands, and System Tools MCP bindings.';

const DEFAULT_FOLDERS = [
    { key: 'commands', title: 'commands', slug: 'commands' },
    { key: 'skills', title: 'skills', slug: 'skills' },
    { key: 'mcp', title: 'mcp', slug: 'mcp' },
] as const;

type DefaultFolderKey = typeof DEFAULT_FOLDERS[number]['key'];

async function systemToolIds(): Promise<string[]> {
    return getLocalSystemToolCatalog().map((tool) => `${SYSTEM_TOOL_ID_PREFIX}${tool.id}`);
}

function yamlList(values: string[]): string {
    return values.map((value) => `    - ${value}`).join('\n');
}

function generatedId(prefix: string, seed: string): string {
    return `${prefix}_${Date.now()}_${seed}`;
}

function pluginFolderData(slug: string): Record<string, any> {
    return {
        pluginNodeType: 'folder',
        slug,
        enabled: true,
    };
}

function normalizeRootNode(root?: BaseNode): BaseNode {
    return {
        id: root?.id || generatedId('node', 'root'),
        text: SYSTEM_DEFAULT_PLUGIN_TITLE,
        x: root?.x ?? 0,
        y: root?.y ?? 0,
        level: 0,
        expanded: root?.expanded !== false,
    };
}

function findFolderNode(nodes: BaseNode[], slug: string): BaseNode | undefined {
    return nodes.find((node) => node.data?.slug === slug || node.text === slug);
}

function buildDefaultPluginGraph(plugin: PluginDoc): { nodes: BaseNode[]; edges: BaseEdge[]; folders: Record<DefaultFolderKey, BaseNode> } {
    const current = getBranchData(plugin as any, plugin.currentBranch || 'main');
    const existingNodes = current.nodes?.length ? current.nodes : plugin.nodes || [];
    const existingEdges = current.edges?.length ? current.edges : plugin.edges || [];
    const root = normalizeRootNode(existingNodes[0]);
    const folders = {} as Record<DefaultFolderKey, BaseNode>;

    const folderNodes = DEFAULT_FOLDERS.map((folder) => {
        const existing = findFolderNode(existingNodes, folder.slug);
        const node: BaseNode = {
            id: existing?.id || generatedId('node', folder.key),
            text: folder.title,
            x: existing?.x,
            y: existing?.y,
            parentId: root.id,
            data: pluginFolderData(folder.slug),
            level: 1,
        };
        folders[folder.key] = node;
        return node;
    });

    root.children = folderNodes.map((node) => node.id);

    const edges = folderNodes.map((node) => {
        const existing = existingEdges.find((edge) => edge.source === root.id && edge.target === node.id);
        return {
            id: existing?.id || generatedId('edge', node.id.replace(/^node_/, '')),
            source: root.id,
            target: node.id,
        };
    });

    return { nodes: [root, ...folderNodes], edges, folders };
}

function systemToolsGuideCard(): string {
    return `---
type: skill
slug: system-tools-guide
description: Guide agents on safe use of this domain's built-in System Tools.
aliases:
  - tools-guide
  - system-tools
---

## Purpose

Use this skill when the user asks about domain System Tools or when you need guidance before using built-in tools.

## Operating rules

1. Explain what you are about to inspect or change before using tools.
2. Prefer read-only tools unless the user explicitly asks for edits.
3. Treat mutating tools as user-confirmed actions only.
4. Some outline/card editing tools require a base-bound execution context; if that context is missing, explain what the user needs to open or select first.
5. Summarize tool results clearly and mention any skipped or unavailable tools.
`;
}

function scheduleCommandCard(): string {
    return `---
type: command
slug: schedule
description: Show scheduled agent tasks for this domain.
command:
  requireConfirmation: false
security:
  requireConfirmation: false
---

## Task

Show scheduled agent tasks for domain {{domainId}}.

## Instructions

- Use the \`schedule_list\` System Tool.
- Use {{args}} and {{userMessage}} to decide whether to filter by agent or enabled status.
- Present a concise table with schedule id, title, agent, rule, enabled state, next run, last run status, and history URL.
- Copy any URLs returned by the tool exactly.
`;
}

function scheduleHistoryCommandCard(): string {
    return `---
type: command
slug: schedule/history
aliases:
  - schedule-history
  - schedule.history
description: Show executed scheduled agent task history for this domain.
command:
  requireConfirmation: false
security:
  requireConfirmation: false
---

## Task

Show scheduled agent task execution history for domain {{domainId}}.

## Instructions

- Use the \`schedule_history\` System Tool.
- Use {{args}} and {{userMessage}} to decide whether to filter by schedule id, agent, or status.
- Present a concise table with run id, schedule id, agent, planned time, status, record URL, and session URL.
- The record URL is the best detail link for what the agent did. Copy all URLs returned by the tool exactly.
`;
}

function systemToolsHelpCard(): string {
    return `---
type: command
slug: system-tools-help
description: Explain the default System Tools available in this domain.
command:
  requireConfirmation: false
security:
  requireConfirmation: false
---

## Task

Explain the available System Tools for domain {{domainId}} and how to use them safely.

## User input

Use {{args}} and {{userMessage}} to understand whether the user wants:

1. a general overview of System Tools;
2. help choosing the right tool;
3. safety guidance for outline/card editing tools;
4. troubleshooting for unavailable tools.

## Response guidance

- Mention that System Tools are provided by the default system MCP/plugin binding.
- Group tools by purpose when possible.
- Explain which actions are read-only and which may mutate domain data.
- If a requested tool requires a base-bound context, tell the user to open/select the relevant base first.
`;
}

async function systemToolsMcpCard(): Promise<string> {
    return `---
type: mcp
slug: system-tools
description: Built-in System Tools for this domain.
display: {}
mcp:
  toolIds:
${yamlList(await systemToolIds())}
security:
  mutating: true
  requireConfirmation: true
---

## Available tools

This MCP card exposes the domain's built-in System Tools through plugin bindings.

## Usage rules

- Use the listed \`system:*\` unique tool IDs exactly as configured in \`mcp.toolIds\`.
- Prefer read-only operations when possible.
- Ask for confirmation before using tools that edit outlines, cards, files, or other persisted data.
- Some tools require an Ejunz base-bound execution context; if missing, explain that the user should open the relevant base first.
`;
}

async function allPluginCards(domainId: string, plugin: PluginDoc): Promise<CardDoc[]> {
    return document.getMulti(domainId, document.TYPE_CARD, { baseDocId: plugin.docId } as any)
        .sort({ order: 1, cid: 1 })
        .toArray() as Promise<CardDoc[]>;
}

async function upsertDefaultCard(
    domainId: string,
    plugin: PluginDoc,
    owner: number,
    nodeId: string,
    title: string,
    content: string,
    order: number,
    cards: CardDoc[],
): Promise<void> {
    const existing = cards.find((card) => card.title === title);
    if (existing) {
        await CardModel.update(domainId, existing.docId, {
            title,
            content,
            nodeId,
            order,
        });
        await document.set(domainId, document.TYPE_CARD, existing.docId, { branch: 'main' } as any);
        return;
    }
    await CardModel.create(domainId, plugin.docId, nodeId, owner, title, content, undefined, undefined, order, 'main');
}

export async function syncSystemDefaultPluginShape(domainId: string, plugin: PluginDoc, owner: number): Promise<PluginDoc> {
    const { nodes, edges, folders } = buildDefaultPluginGraph(plugin);
    const branchData = {
        ...(plugin.branchData || {}),
        main: { nodes, edges },
    };

    await PluginModel.update(domainId, plugin.docId, {
        title: SYSTEM_DEFAULT_PLUGIN_TITLE,
        content: SYSTEM_DEFAULT_PLUGIN_DESCRIPTION,
        nodes,
        edges,
        branchData,
        pluginSlug: SYSTEM_DEFAULT_PLUGIN_SLUG,
        enabled: true,
        visibility: 'system',
        version: plugin.version || '1.0.0',
        source: plugin.source || { type: 'web' },
    } as Partial<PluginDoc>);

    const cards = await allPluginCards(domainId, plugin);
    await upsertDefaultCard(
        domainId,
        plugin,
        owner,
        folders.skills.id,
        'system-tools-guide.md',
        systemToolsGuideCard(),
        1,
        cards,
    );
    await upsertDefaultCard(
        domainId,
        plugin,
        owner,
        folders.commands.id,
        'system-tools-help.md',
        systemToolsHelpCard(),
        1,
        cards,
    );
    await upsertDefaultCard(
        domainId,
        plugin,
        owner,
        folders.commands.id,
        'schedule.md',
        scheduleCommandCard(),
        2,
        cards,
    );
    await upsertDefaultCard(
        domainId,
        plugin,
        owner,
        folders.commands.id,
        'schedule-history.md',
        scheduleHistoryCommandCard(),
        3,
        cards,
    );
    await upsertDefaultCard(
        domainId,
        plugin,
        owner,
        folders.mcp.id,
        'system-tools.md',
        await systemToolsMcpCard(),
        1,
        cards,
    );

    const updated = await PluginModel.get(domainId, plugin.docId);
    if (!updated) throw new Error(`Failed to reload default plugin ${plugin.docId} after sync.`);
    return updated;
}

export async function ensureSystemDefaultPlugin(domainId: string, owner: number): Promise<PluginDoc> {
    const existing = await PluginModel.getAll(domainId, { pluginSlug: SYSTEM_DEFAULT_PLUGIN_SLUG } as any);
    if (existing.length) return syncSystemDefaultPluginShape(domainId, existing[0], owner);

    const { docId } = await PluginModel.create(
        domainId,
        owner,
        SYSTEM_DEFAULT_PLUGIN_TITLE,
        SYSTEM_DEFAULT_PLUGIN_DESCRIPTION,
        undefined,
        {
            pluginSlug: SYSTEM_DEFAULT_PLUGIN_SLUG,
            enabled: true,
            visibility: 'system',
            version: '1.0.0',
            tag: ['system', 'default'],
        },
    );
    const plugin = await PluginModel.get(domainId, docId);
    if (!plugin) throw new Error(`Failed to load default plugin ${docId} after creation.`);

    return syncSystemDefaultPluginShape(domainId, plugin, owner);
}

export async function ensureDomainSystemDefaults(domainId: string, owner: number): Promise<{ mcp: McpDoc; plugin: PluginDoc }> {
    const mcp = await ensureSystemToolsMcp(domainId, owner);
    const plugin = await ensureSystemDefaultPlugin(domainId, owner);
    return { mcp, plugin };
}


// ---- mcpRegistry ----
export type McpKind = 'outbound' | 'system' | 'inbound' | 'plugin' | 'ejunztools';
export type McpRuntimeMode = 'builtin' | 'ws';

const SYSTEM_TOOLS_MCP_NAME = 'System Tools';
const SYSTEM_TOOLS_MCP_DESCRIPTION = '本站内置的 System Tools 工具集合，按 domain 启用。';
const SYSTEM_TOOLS_MCP_SOURCE_LABEL = 'system_tools';
const SYSTEM_TOOLS_MCP_KIND = 'system';
const SYSTEM_TOOLS_MCP_SOURCE_TYPE = 'system_tools';
const SYSTEM_TOOLS_MCP_LOCAL_KEY = 'system_tools';

const mcpRegistryLogger = new Logger('mcpRegistry');

let edgeTokenConnectedChecker: ((token: string) => boolean) | undefined;

export function setEdgeTokenConnectedChecker(checker: (token: string) => boolean) {
    edgeTokenConnectedChecker = checker;
}

function isEdgeTokenConnected(token?: string): boolean {
    return !!token && !!edgeTokenConnectedChecker?.(token);
}

const EJUNZ_TOOLS_MCP_NAME = 'Ejunz Tools';
const EJUNZ_TOOLS_MCP_DESCRIPTION = 'Ejunz Tools MCP provider，支持 builtin / ws 启动方式。';
const EJUNZ_TOOLS_MCP_KIND = 'ejunztools';
const EJUNZ_TOOLS_MCP_SOURCE_TYPE = 'ejunztools';
export const EJUNZ_TOOLS_MCP_LOCAL_KEY = 'ejunztools';
export const EJUNZ_TOOLS_PACKAGE_NAME = '@ejunz/ejunztools';

export interface NormalizedMcpTool {
    uniqueId: string;
    name: string;
    description: string;
    inputSchema?: any;
    kind: McpKind;
    toolKey?: string;
    token?: string;
    toolDocId?: ObjectId;
    edgeDocId?: ObjectId;
    edgeId?: number;
    type?: 'system' | 'market_mcp' | 'edge' | 'plugin_mcp' | 'ejunztools';
    system?: boolean;
}

export interface NormalizedMcpRow {
    mcp: McpDoc;
    mid: number;
    kind: McpKind;
    kindLabel: string;
    sourceLabel: string;
    assignableLabel: string;
    name: string;
    description: string;
    status: 'online' | 'offline' | 'pending';
    online: boolean;
    assignable: boolean;
    toolCount: number;
    working?: boolean;
    lastUsedAt?: Date;
    tools?: NormalizedMcpTool[];
    edge?: EdgeDoc | null;
    tokenInfo?: {
        tokenPreview: string;
        createdAt?: Date;
        authenticatedAt?: Date;
        lastUsedAt?: Date;
        expireAt?: Date | null;
        noExpiration: boolean;
        expired: boolean;
    };
    runtimeMode?: McpRuntimeMode;
    runtimeVersion?: string;
    runtimeLabel?: string;
}

export function mcpKind(mcp: Partial<McpDoc>): McpKind {
    return (mcp.kind || 'outbound') as McpKind;
}

export function uniqueOutboundToolId(mcp: McpDoc, toolName: string): string {
    return `outbound:${mcp._id.toString()}:${toolName}`;
}

export function uniqueSystemToolId(toolKey: string): string {
    return `system:${toolKey}`;
}

export function uniqueEjunzToolsToolId(toolKey: string): string {
    return `ejunztools:${toolKey}`;
}

export function uniqueInboundToolId(edgeDocId: ObjectId, toolDocId: ObjectId): string {
    return `inbound:${edgeDocId.toString()}:${toolDocId.toString()}`;
}

export function uniquePluginToolId(mcp: McpDoc, toolDocId: ObjectId): string {
    return `plugin:${mcp._id.toString()}:${toolDocId.toString()}`;
}

function edgeDisplayName(edge: EdgeDoc): string {
    return edge.name || `Edge-${edge.eid}`;
}

function edgeIsEjunzTools(edge: EdgeDoc): boolean {
    return edge.provider?.packageName === EJUNZ_TOOLS_PACKAGE_NAME
        || edge.provider?.name === 'ejunztools'
        || edge.provider?.name === EJUNZ_TOOLS_PACKAGE_NAME;
}

function edgeRuntimeMode(edge?: EdgeDoc | null): McpRuntimeMode | undefined {
    return edge?.provider?.runtimeMode === 'ws' || edge?.provider?.runtimeMode === 'builtin'
        ? edge.provider.runtimeMode
        : undefined;
}

function edgeRuntimeVersion(edge?: EdgeDoc | null): string | undefined {
    return edge?.provider?.runtimeVersion;
}

function tokenPreview(token: string): string {
    if (token.length <= 12) return token;
    return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

async function systemTools(domainId: string): Promise<NormalizedMcpTool[]> {
    const enabled = await DomainMarketToolModel.getByDomain(domainId);
    const enabledKeys = new Set(enabled.map((doc) => doc.toolKey));
    const tools = getLocalMcpToolCatalog()
        .filter((entry) => entry.source === 'system' || enabledKeys.has(entry.id))
        .map((entry) => ({
            uniqueId: uniqueSystemToolId(entry.id),
            name: entry.name,
            description: entry.description || '',
            inputSchema: entry.inputSchema,
            kind: SYSTEM_TOOLS_MCP_KIND as McpKind,
            toolKey: entry.id,
            type: entry.source === 'system' ? 'system' as const : 'market_mcp' as const,
            system: entry.source === 'system' ? true : undefined,
        }));
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return tools;
}

async function builtinEjunzTools(): Promise<NormalizedMcpTool[]> {
    return getEjunzToolsCatalog()
        .map((entry) => ({
            uniqueId: uniqueEjunzToolsToolId(entry.id),
            name: entry.name,
            description: entry.description || '',
            inputSchema: entry.inputSchema || { type: 'object', properties: {} },
            kind: EJUNZ_TOOLS_MCP_KIND as McpKind,
            toolKey: entry.id,
            type: 'ejunztools' as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function inboundTools(domainId: string, edge: EdgeDoc, kind: McpKind = 'inbound'): Promise<NormalizedMcpTool[]> {
    const docs = await ToolModel.getByEdgeDocId(domainId, edge._id);
    return docs
        .map((tool) => ({
            uniqueId: uniqueInboundToolId(edge._id, tool._id),
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema,
            kind,
            token: edge.token,
            toolDocId: tool._id,
            edgeDocId: edge._id,
            edgeId: edge.eid,
            type: 'edge' as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function outboundTools(mcp: McpDoc): Promise<NormalizedMcpTool[]> {
    return resolveMcpTools(mcp.tools).map((tool) => ({
        uniqueId: uniqueOutboundToolId(mcp, tool.name),
        name: tool.name,
        description: tool.description || '',
        inputSchema: (tool as any).inputSchema,
        kind: 'outbound' as const,
    }));
}

async function pluginTools(domainId: string, mcp: McpDoc): Promise<NormalizedMcpTool[]> {
    const docs = await ToolModel.getByMcpId(domainId, mcp.mid);
    return docs.map((tool) => ({
        uniqueId: uniquePluginToolId(mcp, tool._id),
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema,
        kind: 'plugin' as const,
        toolDocId: tool._id,
        type: 'plugin_mcp' as const,
    })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function ensureSystemToolsMcp(domainId: string, owner: number): Promise<McpDoc> {
    let mcp = await McpModel.getBySourceSystemKey(domainId, SYSTEM_TOOLS_MCP_LOCAL_KEY);
    if (mcp) {
        const tools = await systemTools(domainId);
        await McpModel.update(domainId, mcp.mid, {
            kind: SYSTEM_TOOLS_MCP_KIND,
            source: { type: SYSTEM_TOOLS_MCP_SOURCE_TYPE, localKey: SYSTEM_TOOLS_MCP_LOCAL_KEY },
            assignable: true,
            status: 'online',
            name: mcp.name || SYSTEM_TOOLS_MCP_NAME,
            description: mcp.description || SYSTEM_TOOLS_MCP_DESCRIPTION,
            toolCount: tools.length,
        });
        try {
            await ensureSystemDefaultPlugin(domainId, owner);
        } catch (e) {
            mcpRegistryLogger.warn('failed to sync System Default plugin for domain=%s: %s', domainId, (e as Error).message);
        }
        return await McpModel.getByMcpId(domainId, mcp.mid) || mcp;
    }
    mcp = await McpModel.add({
        domainId,
        owner,
        kind: SYSTEM_TOOLS_MCP_KIND,
        source: { type: SYSTEM_TOOLS_MCP_SOURCE_TYPE, localKey: SYSTEM_TOOLS_MCP_LOCAL_KEY },
        assignable: true,
        status: 'online',
        name: SYSTEM_TOOLS_MCP_NAME,
        description: SYSTEM_TOOLS_MCP_DESCRIPTION,
    });
    return mcp;
}

export async function getBuiltinEjunzToolsMcp(domainId: string): Promise<McpDoc | null> {
    const docs = await McpModel.getByDomain(domainId);
    return docs.find((mcp) => mcp.kind === EJUNZ_TOOLS_MCP_KIND
        && mcp.source?.type === EJUNZ_TOOLS_MCP_SOURCE_TYPE
        && mcp.source?.localKey === EJUNZ_TOOLS_MCP_LOCAL_KEY) || null;
}

export async function removeBuiltinEjunzToolsMcp(domainId: string): Promise<boolean> {
    const mcps = (await McpModel.getByDomain(domainId)).filter((mcp) => mcp.kind === EJUNZ_TOOLS_MCP_KIND
        && mcp.source?.type === EJUNZ_TOOLS_MCP_SOURCE_TYPE
        && mcp.source?.localKey === EJUNZ_TOOLS_MCP_LOCAL_KEY);
    for (const mcp of mcps) {
        await ToolModel.deleteByMcpId(domainId, mcp.mid);
        await McpModel.del(domainId, mcp.mid);
    }
    return mcps.length > 0;
}

export async function ensureBuiltinEjunzToolsMcp(domainId: string, owner: number): Promise<McpDoc | null> {
    const runtime = getBuiltinEjunzToolsRuntime();
    const runtimeActive = !!runtime;
    const version = getBuiltinEjunzToolsVersion();
    const name = getBuiltinEjunzToolsLabel();
    const source = {
        type: EJUNZ_TOOLS_MCP_SOURCE_TYPE as 'ejunztools',
        localKey: EJUNZ_TOOLS_MCP_LOCAL_KEY,
        runtimeMode: 'builtin' as const,
        runtimeVersion: version,
        packageName: EJUNZ_TOOLS_PACKAGE_NAME,
    };
    const tools = await builtinEjunzTools();
    let mcp = await getBuiltinEjunzToolsMcp(domainId);
    if (mcp) {
        await McpModel.update(domainId, mcp.mid, {
            name: mcp.name || name,
            description: mcp.description || EJUNZ_TOOLS_MCP_DESCRIPTION,
            source,
            assignable: true,
            status: runtimeActive ? 'online' : 'offline',
            toolCount: tools.length,
        });
        const updated = await McpModel.getByMcpId(domainId, mcp.mid) || mcp;
        mcpRegistryLogger.info('ensured builtin ejunztools MCP: domain=%s mid=%d version=%s tools=%d', domainId, updated.mid, version, tools.length);
        return updated;
    }
    mcp = await McpModel.add({
        domainId,
        owner,
        kind: EJUNZ_TOOLS_MCP_KIND,
        source,
        assignable: true,
        status: runtimeActive ? 'online' : 'offline',
        name,
        description: EJUNZ_TOOLS_MCP_DESCRIPTION,
        toolCount: tools.length,
    });
    mcpRegistryLogger.info('created builtin ejunztools MCP: domain=%s mid=%d version=%s tools=%d', domainId, mcp.mid, version, tools.length);
    return mcp;
}

export async function ensureInboundMcpForEdge(domainId: string, edge: EdgeDoc): Promise<McpDoc> {
    let mcp = await McpModel.getBySourceEdgeDocId(domainId, edge._id);
    if (mcp) return mcp;
    const isEjunzTools = edgeIsEjunzTools(edge);
    mcp = await McpModel.add({
        domainId,
        owner: edge.owner,
        kind: isEjunzTools ? EJUNZ_TOOLS_MCP_KIND : 'inbound',
        source: {
            type: isEjunzTools ? EJUNZ_TOOLS_MCP_SOURCE_TYPE : 'edge',
            edgeDocId: edge._id,
            edgeId: edge.eid,
            externalUrl: edge.wsEndpoint,
            ...(isEjunzTools ? {
                runtimeMode: 'ws' as const,
                runtimeVersion: edge.provider?.runtimeVersion,
                packageName: EJUNZ_TOOLS_PACKAGE_NAME,
            } : {}),
        },
        assignable: false,
        status: edge.status === 'online' || edge.status === 'working' ? 'online' : 'offline',
        edgeId: edge.eid,
        name: isEjunzTools ? (edge.name || EJUNZ_TOOLS_MCP_NAME) : edgeDisplayName(edge),
        description: edge.description || (isEjunzTools ? '外部 ejunztools WebSocket MCP provider。' : '外部接入的 MCP / Edge provider。'),
    });
    return mcp;
}

export async function getMcpTools(domainId: string, mcp: McpDoc): Promise<NormalizedMcpTool[]> {
    const kind = mcpKind(mcp);
    if (kind === 'outbound') return outboundTools(mcp);
    if (kind === SYSTEM_TOOLS_MCP_KIND) return systemTools(domainId);
    if (kind === 'plugin' || mcp.source?.type === 'plugin') return pluginTools(domainId, mcp);
    if (kind === EJUNZ_TOOLS_MCP_KIND && mcp.source?.runtimeMode === 'builtin') {
        return getBuiltinEjunzToolsRuntime() ? builtinEjunzTools() : [];
    }

    const edgeDocId = mcp.source?.edgeDocId;
    let edge: EdgeDoc | null = null;
    if (edgeDocId) edge = await EdgeModel.get(edgeDocId);
    if (!edge && mcp.edgeId) edge = await EdgeModel.getByEdgeId(domainId, mcp.edgeId);
    if (!edge) return [];
    return inboundTools(domainId, edge, kind === EJUNZ_TOOLS_MCP_KIND ? EJUNZ_TOOLS_MCP_KIND : 'inbound');
}

export async function getNormalizedMcp(domainId: string, mid: number): Promise<NormalizedMcpRow | null> {
    const mcp = await McpModel.getByMcpId(domainId, mid);
    if (!mcp) return null;
    const kind = mcpKind(mcp);
    const tools = await getMcpTools(domainId, mcp);
    let edge: EdgeDoc | null = null;
    if (kind === 'inbound' || (kind === EJUNZ_TOOLS_MCP_KIND && mcp.source?.edgeDocId)) {
        if (mcp.source?.edgeDocId) edge = await EdgeModel.get(mcp.source.edgeDocId);
        if (!edge && mcp.edgeId) edge = await EdgeModel.getByEdgeId(domainId, mcp.edgeId);
    } else if (kind === 'outbound' && mcp.edgeId) {
        edge = await EdgeModel.getByEdgeId(domainId, mcp.edgeId);
    }
    const tokenDoc = kind === 'outbound' && mcp.token
        ? await EdgeTokenModel.coll.findOne({ domainId, type: 'mcp_sse', token: mcp.token })
        : null;
    const tokenExpireAt = tokenDoc?.expireAt || null;
    const runtimeMode = (mcp.source?.runtimeMode || edgeRuntimeMode(edge)) as McpRuntimeMode | undefined;
    const runtimeVersion = mcp.source?.runtimeVersion || edgeRuntimeVersion(edge);
    const online = kind === 'outbound' || kind === 'plugin'
        ? mcp.status === 'online'
        : kind === SYSTEM_TOOLS_MCP_KIND
            ? true
            : kind === EJUNZ_TOOLS_MCP_KIND && runtimeMode === 'builtin'
                ? !!getBuiltinEjunzToolsRuntime()
                : !!edge && isEdgeTokenConnected(edge.token);
    const assignable = kind !== 'outbound' && tools.length > 0 && mcp.assignable !== false;
    const sourceLabel = kind === SYSTEM_TOOLS_MCP_KIND
        ? SYSTEM_TOOLS_MCP_SOURCE_LABEL
        : kind === EJUNZ_TOOLS_MCP_KIND
            ? (runtimeMode === 'ws' && edge ? edgeDisplayName(edge) : EJUNZ_TOOLS_PACKAGE_NAME)
            : kind === 'inbound'
                ? (edge ? edgeDisplayName(edge) : 'external')
                : kind === 'plugin'
                    ? 'plugin MCP'
                    : 'outbound endpoint';
    return {
        mcp,
        mid: mcp.mid,
        kind,
        sourceLabel,
        kindLabel: kind,
        assignableLabel: assignable ? 'assignable' : 'not assignable',
        name: mcp.name || (kind === SYSTEM_TOOLS_MCP_KIND ? SYSTEM_TOOLS_MCP_NAME : kind === EJUNZ_TOOLS_MCP_KIND ? EJUNZ_TOOLS_MCP_NAME : kind === 'inbound' ? 'Inbound MCP' : kind === 'plugin' ? 'Plugin MCP' : `MCP-${mcp.mid}`),
        description: mcp.description || '',
        status: online ? 'online' : (kind === 'outbound' && !mcp.edgeId ? 'pending' : 'offline'),
        online,
        assignable,
        toolCount: tools.length,
        lastUsedAt: mcp.lastUsedAt || tokenDoc?.lastUsedAt,
        tools,
        edge,
        tokenInfo: tokenDoc ? {
            tokenPreview: tokenPreview(tokenDoc.token),
            createdAt: tokenDoc.createdAt,
            authenticatedAt: tokenDoc.authenticatedAt || tokenDoc.createdAt || tokenDoc.lastUsedAt,
            lastUsedAt: tokenDoc.lastUsedAt,
            expireAt: tokenExpireAt,
            noExpiration: !tokenExpireAt,
            expired: !!tokenExpireAt && tokenExpireAt.getTime() <= Date.now(),
        } : undefined,
        runtimeMode,
        runtimeVersion,
        runtimeLabel: runtimeMode ? `${runtimeMode}${runtimeVersion ? ` v${runtimeVersion}` : ''}` : undefined,
    };
}

export async function listDomainMcps(domainId: string, user?: User): Promise<NormalizedMcpRow[]> {
    const owner = user?._id || 1;
    await ensureSystemToolsMcp(domainId, owner);
    const ejunzToolsInstalled = await DomainMarketToolModel.has(domainId, EJUNZ_TOOLS_MCP_LOCAL_KEY);
    if (ejunzToolsInstalled) await ensureBuiltinEjunzToolsMcp(domainId, owner);

    const edges = await EdgeModel.getByDomain(domainId);
    for (const edge of edges) {
        if (edge.category === 'outbound' || edge.type === 'mcp') continue;
        const tools = await ToolModel.getByEdgeDocId(domainId, edge._id);
        if (edge.tokenUsedAt || tools.length > 0) {
            const mcp = await ensureInboundMcpForEdge(domainId, edge);
            const isEjunzTools = edgeIsEjunzTools(edge) || mcp.kind === EJUNZ_TOOLS_MCP_KIND;
            const assignable = tools.length > 0;
            const status = isEdgeTokenConnected(edge.token) ? 'online' : 'offline';
            await McpModel.update(domainId, mcp.mid, {
                kind: isEjunzTools ? EJUNZ_TOOLS_MCP_KIND : mcp.kind,
                name: isEjunzTools ? (edge.name || EJUNZ_TOOLS_MCP_NAME) : (mcp.name || edgeDisplayName(edge)),
                edgeId: edge.eid,
                assignable,
                status,
                toolCount: tools.length,
                source: {
                    ...(mcp.source || { type: isEjunzTools ? EJUNZ_TOOLS_MCP_SOURCE_TYPE : 'edge' }),
                    type: isEjunzTools ? EJUNZ_TOOLS_MCP_SOURCE_TYPE : 'edge',
                    edgeDocId: edge._id,
                    edgeId: edge.eid,
                    externalUrl: edge.wsEndpoint,
                    ...(isEjunzTools ? {
                        runtimeMode: 'ws' as const,
                        runtimeVersion: edge.provider?.runtimeVersion,
                        packageName: EJUNZ_TOOLS_PACKAGE_NAME,
                    } : {}),
                },
            });
        }
    }

    const docs = await McpModel.getByDomain(domainId);
    const visibleDocs = docs.filter((mcp) => !(mcp.kind === EJUNZ_TOOLS_MCP_KIND
        && mcp.source?.type === EJUNZ_TOOLS_MCP_SOURCE_TYPE
        && mcp.source?.localKey === EJUNZ_TOOLS_MCP_LOCAL_KEY
        && !ejunzToolsInstalled));
    const rows = (await Promise.all(visibleDocs.map((mcp) => getNormalizedMcp(domainId, mcp.mid))))
        .filter((row): row is NormalizedMcpRow => !!row);
    rows.sort((a, b) => {
        const order = { outbound: 0, system: 1, ejunztools: 2, inbound: 3, plugin: 4 } as Record<McpKind, number>;
        if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
        return (a.mid || 0) - (b.mid || 0);
    });
    return rows;
}


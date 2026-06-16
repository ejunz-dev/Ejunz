import { ObjectId } from 'mongodb';
import yaml from 'js-yaml';
import type { AgentDoc, BaseNode, CardDoc, PluginDoc, PluginNodeData, ToolDoc } from '../interface';
import { getBranchData } from '../model/base';
import * as document from '../model/document';
import PluginModel from '../model/plugin';
import DomainMarketToolModel from '../model/domain_market_tool';
import { SYSTEM_TOOLS_CATALOG } from '@ejunz/ejunztools';

const SLUG_RE = /^[a-zA-Z0-9._-]{1,80}$/;
export const LOCAL_EJUNZTOOLS_TOOL_ID_PREFIX = 'local:ejunztools:';

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
    const slugRaw = trimString(o.slug, 80) || cardTitleSlug(card.title) || rawType;
    const name = SLUG_RE.test(slugRaw) ? slugRaw : slugRaw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || rawType;
    const aliases = trimStringArray(o.aliases, 20, 80)?.filter((x) => SLUG_RE.test(x)) || [];
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
            if (id.startsWith(LOCAL_EJUNZTOOLS_TOOL_ID_PREFIX)) {
                const toolKey = id.slice(LOCAL_EJUNZTOOLS_TOOL_ID_PREFIX.length).trim();
                if (!toolKey || !SLUG_RE.test(toolKey)) continue;
                const entry = SYSTEM_TOOLS_CATALOG.find((tool) => tool.id === toolKey);
                if (!entry) continue;
                if (domainId && !(await DomainMarketToolModel.has(domainId, toolKey))) continue;
                toolIds.push(`${LOCAL_EJUNZTOOLS_TOOL_ID_PREFIX}${toolKey}`);
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
    type?: 'system' | 'edge' | 'plugin_mcp';
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
                const { testPluginMcpDefinitions, syncPluginManagedMcps, refreshPluginMcpStatus } = require('./pluginMcp');
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
                if (id.startsWith(LOCAL_EJUNZTOOLS_TOOL_ID_PREFIX)) {
                    if (byId.has(id)) continue;
                    const toolKey = id.slice(LOCAL_EJUNZTOOLS_TOOL_ID_PREFIX.length).trim();
                    const entry = SYSTEM_TOOLS_CATALOG.find((tool) => tool.id === toolKey);
                    if (!entry || !(await DomainMarketToolModel.has(domainId, toolKey))) continue;
                    byId.set(id, {
                        name: entry.name,
                        description: entry.description || '',
                        inputSchema: entry.inputSchema || { type: 'object', properties: {} },
                        type: 'system',
                        system: true,
                        toolKey,
                        source: { type: 'local' },
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
        if (tool.type === 'system' || tool.source?.type === 'local') {
            return {
                ...tool,
                type: 'system' as const,
                system: true,
            };
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

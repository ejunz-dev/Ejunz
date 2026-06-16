import { ObjectId } from 'mongodb';
import yaml from 'js-yaml';
import type { AgentDoc, BaseNode, CardDoc, PluginDoc, PluginNodeData, ToolDoc } from '../interface';
import { getBranchData } from '../model/base';
import * as document from '../model/document';
import PluginModel from '../model/plugin';

const SLUG_RE = /^[a-zA-Z0-9._-]{1,80}$/;

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

type PluginCardDefinition = {
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
            if (!ObjectId.isValid(id)) continue;
            if (domainId) {
                const tool = await document.get(domainId, document.TYPE_TOOL, new ObjectId(id));
                if (!tool) continue;
            }
            toolIds.push(id);
        }
        base.toolIds = Array.from(new Set(toolIds));
        const instructions = trimString(o.mcp?.instructions ?? o.instructions, 20000) || body;
        if (instructions) base.instructions = instructions;
        base.requireConfirmation = o.mcp?.requireConfirmation === true || security.requireConfirmation === true;
    }
    return base;
}

export async function parsePluginCardDefinition(card: CardDoc, node: BaseNode, plugin: PluginDoc, domainId?: string): Promise<PluginCardDefinition | null> {
    const { meta, body } = parsePluginCardFrontmatter(card.content || '');
    if (meta.enabled === false) return null;
    return sanitizePluginCardDefinition(meta, body, card, node, plugin, domainId);
}

async function loadPluginCardDefinitions(domainId: string, plugin: PluginDoc, branch = 'main', enabledNodeIds?: Set<string>): Promise<PluginCardDefinition[]> {
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

export async function resolveAgentPluginTools(domainId: string, adoc: AgentDoc): Promise<ToolDoc[]> {
    const byId = new Map<string, ToolDoc>();
    for (const { plugin, branch, enabledNodeIds } of await loadBoundPluginDocs(domainId, adoc)) {
        for (const def of await loadPluginCardDefinitions(domainId, plugin, branch, enabledNodeIds)) {
            if (def.kind !== 'mcp') continue;
            for (const id of def.toolIds || []) {
                if (!ObjectId.isValid(id) || byId.has(id)) continue;
                const tool = await document.get(domainId, document.TYPE_TOOL, new ObjectId(id));
                if (tool) byId.set(id, tool as ToolDoc);
            }
        }
    }
    return [...byId.values()];
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

import type { BaseEdge, BaseNode, CardDoc, McpDoc, PluginDoc } from '../interface';
import { CardModel, getBranchData } from '../model/base';
import * as document from '../model/document';
import PluginModel from '../model/plugin';

export const SYSTEM_DEFAULT_PLUGIN_SLUG = 'system-default';

const SYSTEM_TOOL_ID_PREFIX = 'system:';
const SYSTEM_DEFAULT_PLUGIN_TITLE = 'System Default';
const SYSTEM_DEFAULT_PLUGIN_DESCRIPTION = 'Default system plugin seeded for new domains. Provides starter skills, commands, and System Tools MCP bindings.';

const DEFAULT_FOLDERS = [
    { key: 'commands', title: 'commands', slug: 'commands' },
    { key: 'skills', title: 'skills', slug: 'skills' },
    { key: 'mcp', title: 'mcp', slug: 'mcp' },
] as const;

type DefaultFolderKey = typeof DEFAULT_FOLDERS[number]['key'];

async function systemToolIds(): Promise<string[]> {
    const { getLocalSystemToolCatalog } = await import('./localSystemTools');
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
    const { ensureSystemToolsMcp } = await import('./mcpRegistry');
    const mcp = await ensureSystemToolsMcp(domainId, owner);
    const plugin = await ensureSystemDefaultPlugin(domainId, owner);
    return { mcp, plugin };
}

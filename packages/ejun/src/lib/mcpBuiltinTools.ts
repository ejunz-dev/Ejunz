import { ObjectId } from 'mongodb';
import * as document from '../model/document';
import {
    BaseModel, CardModel, getBranchData,
    applyDetailExplorerUrlFilters, type DetailExplorerFilters,
} from '../model/base';
import type { CardDoc, BaseNode, BaseEdge, Problem, ProblemKind } from '../interface';
import { migrateRawProblem } from '../model/problem';
import {
    mcpBaseGitCommit,
    mcpBaseGitConfigGet,
    mcpBaseGitConfigSet,
    mcpBaseGitPull,
    mcpBaseGitPush,
    mcpBaseGitStatus,
    type McpBaseGitInput,
} from '../handler/base';

export interface McpToolContext {
    domainId: string;
    baseDocId: number;
    branch: string;
    owner: number;
    setting?: { get: (k: string) => unknown };
}

export interface McpToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

export const MCP_BUILTIN_TOOLS_CATALOG: McpToolDef[] = [
    {
        name: 'detail_list_nodes',
        description: 'Node = a section/topic in this base\'s node tree (hierarchical). '
            + 'Returns every node of the bound base: id, text (title), parentId (null at root), level (depth), order. '
            + 'Call this first to understand the structure before reading or editing cards.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'detail_create_node',
        description: 'Create a new node (section/topic). '
            + 'Pass parentId to nest it under an existing node; omit parentId to create it under the bound base root node.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Node title/text.' },
                parentId: { type: 'string', description: 'Parent node id from detail_list_nodes (optional; omit to place under the base root node).' },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
    {
        name: 'detail_update_node',
        description: 'Rename a node (change its title/text). Use nodeId from detail_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Node id from detail_list_nodes.' },
                text: { type: 'string', description: 'New node title/text.' },
            },
            required: ['nodeId', 'text'],
            additionalProperties: false,
        },
    },
    {
        name: 'detail_delete_node',
        description: 'Delete a node by id (and its cards). Use nodeId from detail_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Node id from detail_list_nodes.' } },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_list',
        description: 'Card = a content block (title + markdown body) attached to a node; a node can hold several ordered cards. '
            + 'Lists the cards under one node: cardId, title, order. Use nodeId from detail_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Node id from detail_list_nodes.' } },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_get',
        description: 'Read a single card\'s full content (title + markdown body) by cardId. Use cardId from card_list.',
        inputSchema: {
            type: 'object',
            properties: { cardId: { type: 'string', description: 'Card docId (hex) from card_list.' } },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_create',
        description: 'Create a new card (content block) under a node. Use nodeId from detail_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Owning node id from detail_list_nodes.' },
                title: { type: 'string', description: 'Card title.' },
                content: { type: 'string', description: 'Markdown body (optional).' },
            },
            required: ['nodeId', 'title'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_update',
        description: 'Update a card\'s title and/or markdown content by cardId. Use cardId from card_list.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
                title: { type: 'string', description: 'New title (optional).' },
                content: { type: 'string', description: 'New markdown body (optional).' },
            },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_delete',
        description: 'Delete a card by cardId. Use cardId from card_list.',
        inputSchema: {
            type: 'object',
            properties: { cardId: { type: 'string', description: 'Card docId (hex) from card_list.' } },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'detail_tree',
        description: 'Return the whole node tree as a nested tree (overview/table of contents). '
            + 'Each node carries only its id and text (title) and its cards (cardId + title); card content is NOT included. '
            + 'Use this to grasp the full structure at a glance, then call card_get to read specific cards.',
        inputSchema: {
            type: 'object',
            properties: {
                includeCards: {
                    type: 'boolean',
                    description: 'Include each node\'s cards (id + title) in the tree. Default true; set false for nodes only.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'detail_search',
        description: 'Search and/or filter the node tree (same semantics as the base detail page). '
            + 'Provide `query` to match a keyword or an exact id against node titles/ids and card titles/ids. '
            + 'Provide any of `filterNode` / `filterCard` / `filterProblem` to narrow by node title, card title, or problem content. '
            + 'You may combine `query` with the filters; all supplied conditions are applied together (intersection). '
            + 'Returns matching nodes and cards with id, title and the node path; card content is NOT included.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Keyword or exact id to match against node text/id and card title/id (case-insensitive).' },
                filterNode: { type: 'string', description: 'Keep only nodes whose title contains this text (like the detail page filterNode).' },
                filterCard: { type: 'string', description: 'Keep only nodes that have a card whose title contains this text (filterCard).' },
                filterProblem: { type: 'string', description: 'Keep only nodes that have a card with a problem matching this text (filterProblem).' },
                limit: { type: 'number', description: 'Max results to return per kind (nodes/cards). Default 50.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'problem_list',
        description: 'Problem = a practice exercise attached to a card (quiz, flip card, matching table, etc.). '
            + 'Lists every problem on one card: pid, type, title, and a short content preview. Use cardId from card_list.',
        inputSchema: {
            type: 'object',
            properties: { cardId: { type: 'string', description: 'Card docId (hex) from card_list.' } },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_get',
        description: 'Read one practice problem in full by cardId + pid. Use pid from problem_list.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
                pid: { type: 'string', description: 'Problem id from problem_list.' },
            },
            required: ['cardId', 'pid'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_create',
        description: 'Add a practice problem to a card. Pass `problem` as a JSON object. '
            + 'Common fields: title (short sidebar label), stem, analysis, tags. '
            + 'type: single (default) | multi | true_false | flip | fill_blank | matching | super_flip | ai_eval. '
            + 'single/multi: options[] + answer (index or index array). true_false: stem + answer 0|1. '
            + 'flip: faceA, faceB, optional hint. fill_blank: stem with ___ + answers[]. '
            + 'matching: columns[][] (≥2 cols, ≥2 rows) or legacy left/right. '
            + 'super_flip: headers[] + columns[][] (allows 1×1). ai_eval: stem + points[].',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
                problem: {
                    type: 'object',
                    description: 'Problem payload. `type` defaults to single choice when omitted.',
                },
            },
            required: ['cardId', 'problem'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_update',
        description: 'Update an existing problem by pid. Pass `problem` with fields to change (merged with the stored row, then normalized). '
            + 'Include `type` only when changing the problem kind.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
                pid: { type: 'string', description: 'Problem id from problem_list.' },
                problem: { type: 'object', description: 'Fields to update.' },
            },
            required: ['cardId', 'pid', 'problem'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_delete',
        description: 'Delete a practice problem from a card by pid. Use pid from problem_list.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
                pid: { type: 'string', description: 'Problem id from problem_list.' },
            },
            required: ['cardId', 'pid'],
            additionalProperties: false,
        },
    },
    {
        name: 'git_status',
        description: 'Get git sync status for this base: local/remote branch, ahead/behind, uncommitted changes, and file change lists. '
            + 'Requires a local git repo (created on first commit/push). Optionally pass `branch` (defaults to MCP-bound branch).',
        inputSchema: {
            type: 'object',
            properties: {
                branch: { type: 'string', description: 'Git branch to inspect (optional; defaults to bound branch).' },
                githubToken: { type: 'string', description: 'GitHub PAT override for remote fetch (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_commit',
        description: 'Export the current base/branch to the local git working tree and commit (does not push). '
            + 'Use after editing nodes/cards/problems when you want a local snapshot.',
        inputSchema: {
            type: 'object',
            properties: {
                branch: { type: 'string', description: 'Branch to commit on (optional).' },
                commitMessage: { type: 'string', description: 'Commit message body (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_push',
        description: 'Commit local changes and push to the configured GitHub remote (`git_config_get`). '
            + 'Requires githubRepo on the base and a GitHub token (user profile or system setting).',
        inputSchema: {
            type: 'object',
            properties: {
                branch: { type: 'string', description: 'Branch to push (optional).' },
                commitMessage: { type: 'string', description: 'Commit message (optional).' },
                githubToken: { type: 'string', description: 'GitHub PAT override (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_pull',
        description: 'Pull from GitHub and import the remote branch into this base (overwrites local branch data from remote). '
            + 'Destructive: replaces nodes/cards from the git tree. Requires githubRepo and token.',
        inputSchema: {
            type: 'object',
            properties: {
                branch: { type: 'string', description: 'Branch to pull (optional).' },
                githubToken: { type: 'string', description: 'GitHub PAT override (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_config_get',
        description: 'Read the GitHub repository URL/path configured for this base (used by git_push / git_pull).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'git_config_set',
        description: 'Set or clear the GitHub repository for this base. Pass `githubRepo` as owner/repo, full https URL, or null/empty to clear.',
        inputSchema: {
            type: 'object',
            properties: {
                githubRepo: {
                    type: 'string',
                    description: 'e.g. org/repo, https://github.com/org/repo, or empty string to clear.',
                },
            },
            required: ['githubRepo'],
            additionalProperties: false,
        },
    },
];

export async function buildMcpInstructions(
    ctx: { domainId: string; baseDocId?: number; branch?: string },
): Promise<string> {
    const lines: string[] = [
        'This MCP server is bound to a single Ejunz "base" — a knowledge base organized as an node tree.',
        '',
        'Concepts:',
        '- Node: a section/topic in the base\'s node tree. Nodes form a hierarchy via parentId/level. Each node has an id and text (title).',
        '- Card: a content block (title + markdown body) attached to a node. One node can hold multiple ordered cards.',
        '- Problem: a practice exercise (quiz, flip card, matching, etc.) attached to a card. Types: single, multi, true_false, flip, fill_blank, matching, super_flip, ai_eval.',
        '',
        'Relationship: base → nodes (tree) → cards (content) → problems (exercises on each card).',
    ];
    if (ctx.baseDocId) {
        let title = '';
        try {
            const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
            title = (base as any)?.title || '';
        } catch { /* ignore */ }
        lines.push(
            '',
            `This endpoint is bound to base #${ctx.baseDocId}${title ? ` "${title}"` : ''} on branch "${ctx.branch || 'main'}". `
            + 'All tools operate only within this base/branch.',
        );
    }
    lines.push(
        '',
        'Typical workflow:',
        '1. detail_tree — get the whole node tree (nodes + cards, titles only) at a glance.',
        '2. detail_search(query/filterNode/filterCard/filterProblem) — find nodes/cards by keyword, id or filters.',
        '3. detail_list_nodes — flat list of nodes; card_list(nodeId) — cards under a node.',
        '4. card_get(cardId) — read a card\'s full content.',
        '5. problem_list(cardId) / problem_get(cardId, pid) — list or read practice problems on a card.',
        '6. git_status — check local/remote sync; git_commit / git_push / git_pull — sync with GitHub (configure repo via git_config_set).',
        '7. Use the create/update/delete tools to modify nodes, cards, and problems.',
    );
    return lines.join('\n');
}

const MCP_BUILTIN_MUTATING_TOOLS = new Set([
    'detail_create_node', 'detail_update_node', 'detail_delete_node',
    'card_create', 'card_update', 'card_delete',
    'problem_create', 'problem_update', 'problem_delete',
    'git_pull', 'git_config_set',
]);

export function isMcpBuiltinTool(name: string): boolean {
    return MCP_BUILTIN_TOOLS_CATALOG.some((t) => t.name === name);
}

export function isMcpBuiltinMutatingTool(name: string): boolean {
    return MCP_BUILTIN_MUTATING_TOOLS.has(name);
}

export function defaultMcpToolDescriptions(): { name: string; description: string }[] {
    return MCP_BUILTIN_TOOLS_CATALOG.map((t) => ({ name: t.name, description: t.description }));
}

export function resolveMcpTools(overrides?: { name: string; description: string }[]): McpToolDef[] {
    if (!overrides || !overrides.length) return MCP_BUILTIN_TOOLS_CATALOG;
    const map = new Map(overrides.map((o) => [o.name, o.description]));
    return MCP_BUILTIN_TOOLS_CATALOG.map((t) => ({
        ...t,
        description: map.has(t.name) && map.get(t.name) ? (map.get(t.name) as string) : t.description,
    }));
}

function toObjectId(value: unknown): ObjectId {
    const s = String(value || '').trim();
    if (!ObjectId.isValid(s)) throw new Error(`Invalid cardId: ${s}`);
    return new ObjectId(s);
}

function cardMatchesBranch(card: CardDoc, branch: string): boolean {
    const cardBranch = (card as CardDoc & { branch?: string }).branch || 'main';
    if (branch === 'main') return cardBranch === 'main' || !cardBranch;
    return cardBranch === branch;
}

async function requireCard(ctx: McpToolContext, cardId: unknown): Promise<CardDoc> {
    const card = await CardModel.get(ctx.domainId, toObjectId(cardId));
    if (!card) throw new Error('Card not found');
    if (String(card.baseDocId) !== String(ctx.baseDocId)) {
        throw new Error('Card does not belong to this base');
    }
    if (!cardMatchesBranch(card, ctx.branch)) {
        throw new Error(`Card is on branch "${(card as CardDoc & { branch?: string }).branch || 'main'}", not "${ctx.branch}"`);
    }
    return card;
}

function parseProblemPayload(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch { /* fall through */ }
    }
    throw new Error('problem must be a JSON object');
}

function normalizeProblemKind(raw: unknown): ProblemKind | undefined {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return undefined;
    const kinds: ProblemKind[] = [
        'single', 'multi', 'true_false', 'flip', 'fill_blank', 'matching', 'super_flip', 'ai_eval',
    ];
    return kinds.includes(s as ProblemKind) ? (s as ProblemKind) : undefined;
}

function buildProblemRaw(payload: Record<string, unknown>, pid: string): Record<string, unknown> {
    const raw: Record<string, unknown> = { ...payload, pid };
    const kind = normalizeProblemKind(payload.type ?? payload.problemKind ?? payload.kind);
    if (kind) raw.type = kind;
    return raw;
}

function newProblemPid(): string {
    return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function problemPreview(p: Problem): string {
    const type = (p as Problem & { type?: string }).type || 'single';
    let text = '';
    if (type === 'flip') {
        text = String((p as { faceA?: string }).faceA || '');
    } else if ('stem' in p) {
        text = String((p as { stem?: string }).stem || '');
    } else if (type === 'matching' || type === 'super_flip') {
        const cols = (p as { columns?: string[][] }).columns;
        if (Array.isArray(cols) && cols[0]?.length) text = cols[0].join(' | ');
    }
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function summarizeProblem(p: Problem) {
    const type = (p as Problem & { type?: string }).type || 'single';
    return {
        pid: p.pid,
        type,
        title: p.title || '',
        preview: problemPreview(p),
        tags: Array.isArray(p.tags) ? p.tags : [],
    };
}

async function saveCardProblems(domainId: string, card: CardDoc, problems: Problem[]): Promise<void> {
    await CardModel.update(domainId, card.docId, { problems });
}

function findProblemIndex(problems: Problem[], pid: string): number {
    return problems.findIndex((p) => String(p.pid) === pid);
}

function toMcpGitInput(ctx: McpToolContext, args: Record<string, any>): McpBaseGitInput {
    const branchArg = args.branch != null ? String(args.branch).trim() : '';
    return {
        domainId: ctx.domainId,
        baseDocId: ctx.baseDocId,
        branch: branchArg || ctx.branch,
        owner: ctx.owner,
        setting: ctx.setting,
        githubToken: typeof args.githubToken === 'string' && args.githubToken.trim()
            ? args.githubToken.trim()
            : undefined,
        commitMessage: typeof args.commitMessage === 'string' ? args.commitMessage : undefined,
    };
}

function summarizeNode(n: any) {
    return { id: n.id, text: n.text, parentId: n.parentId || null, level: n.level ?? 0, order: n.order ?? 0 };
}

function summarizeCard(c: CardDoc) {
    return { cardId: String(c.docId), title: c.title, order: c.order ?? 0, nodeId: c.nodeId };
}

/** Loads all cards of the base/branch grouped by their owning node id. */
async function loadNodeCardsMap(
    domainId: string,
    baseDocId: number,
    branch: string,
    nodes: BaseNode[],
): Promise<Record<string, CardDoc[]>> {
    const map: Record<string, CardDoc[]> = {};
    await Promise.all((nodes || []).map(async (n) => {
        map[n.id] = await CardModel.getByNodeId(domainId, baseDocId, n.id, branch);
    }));
    return map;
}

/** target -> source (child -> parent) map derived from edges. */
function buildParentMap(edges: BaseEdge[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const e of edges || []) m.set(e.target, e.source);
    return m;
}

function findRootNodeId(nodes: BaseNode[] = [], edges: BaseEdge[] = []): string | undefined {
    if (!nodes.length) return undefined;
    const levelRoot = nodes.find((n) => n.level === 0);
    if (levelRoot?.id) return levelRoot.id;
    const parentMap = buildParentMap(edges);
    return nodes.find((n) => !parentMap.has(n.id))?.id || nodes[0]?.id;
}

/** Builds the " › " separated node-title path for a node, root first. */
function pathLabelFor(nodeId: string, parentMap: Map<string, string>, nodeById: Map<string, BaseNode>): string {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = nodeId;
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        const n = nodeById.get(cur);
        chain.push((n?.text || '').trim() || 'Untitled');
        cur = parentMap.get(cur);
    }
    return chain.reverse().join(' › ');
}

interface DetailTreeNode {
    id: string;
    text: string;
    cards?: { cardId: string; title: string; order: number }[];
    children: DetailTreeNode[];
}

/** Builds nested node tree (id + text only; cards as id + title when requested). */
function buildDetailTree(
    nodes: BaseNode[],
    edges: BaseEdge[],
    nodeCardsMap: Record<string, CardDoc[]>,
    includeCards: boolean,
): DetailTreeNode[] {
    const parentMap = buildParentMap(edges);
    const childrenMap = new Map<string, string[]>();
    for (const e of edges || []) {
        if (!childrenMap.has(e.source)) childrenMap.set(e.source, []);
        childrenMap.get(e.source)!.push(e.target);
    }
    const nodeById = new Map((nodes || []).map((n) => [n.id, n]));
    const orderOf = (id: string) => nodeById.get(id)?.order ?? 0;

    const build = (id: string, seen: Set<string>): DetailTreeNode | null => {
        if (seen.has(id)) return null;
        seen.add(id);
        const n = nodeById.get(id);
        if (!n) return null;
        const childIds = (childrenMap.get(id) || []).slice().sort((a, b) => orderOf(a) - orderOf(b));
        const out: DetailTreeNode = {
            id,
            text: n.text || '',
            children: childIds.map((c) => build(c, seen)).filter(Boolean) as DetailTreeNode[],
        };
        if (includeCards) {
            out.cards = (nodeCardsMap[id] || [])
                .slice()
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                .map((c) => ({ cardId: String(c.docId), title: c.title || '', order: c.order ?? 0 }));
        }
        return out;
    };

    const roots = (nodes || [])
        .filter((n) => !parentMap.has(n.id))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const seen = new Set<string>();
    return roots.map((r) => build(r.id, seen)).filter(Boolean) as DetailTreeNode[];
}

export async function executeMcpBuiltinTool(
    ctx: McpToolContext,
    name: string,
    args: Record<string, any>,
): Promise<unknown> {
    const { domainId, baseDocId, branch, owner } = ctx;
    if (!baseDocId) throw new Error('This MCP endpoint is not bound to a base.');
    const base = await BaseModel.get(domainId, baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${baseDocId}`);

    switch (name) {
    case 'detail_list_nodes': {
        const { nodes, edges } = getBranchData(base, branch);
        const parentMap = buildParentMap(edges);
        return (nodes || []).map((n) => ({
            ...summarizeNode(n),
            parentId: parentMap.get(n.id) || n.parentId || null,
        }));
    }
    case 'detail_create_node': {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('text is required');
        const { nodes, edges } = getBranchData(base, branch);
        const parentId = args.parentId
            ? String(args.parentId).trim()
            : findRootNodeId(nodes || [], edges || []);
        if (parentId && !(nodes || []).some((n) => n.id === parentId)) {
            throw new Error(`Parent node not found: ${parentId}`);
        }
        const res = await BaseModel.addNode(
            domainId, baseDocId, { text } as any, parentId, branch, parentId,
        );
        return { ok: true, nodeId: res.nodeId, edgeId: res.edgeId, parentId: parentId ?? null };
    }
    case 'detail_update_node': {
        const nodeId = String(args.nodeId || '');
        const text = String(args.text || '');
        if (!nodeId) throw new Error('nodeId is required');
        await BaseModel.updateNode(domainId, baseDocId, nodeId, { text } as any, branch);
        return { ok: true, nodeId };
    }
    case 'detail_delete_node': {
        const nodeId = String(args.nodeId || '');
        if (!nodeId) throw new Error('nodeId is required');
        await BaseModel.deleteNode(domainId, baseDocId, nodeId, branch);
        return { ok: true, nodeId };
    }
    case 'card_list': {
        const nodeId = String(args.nodeId || '');
        if (!nodeId) throw new Error('nodeId is required');
        const cards = await CardModel.getByNodeId(domainId, baseDocId, nodeId, branch);
        return cards.map(summarizeCard);
    }
    case 'card_get': {
        const card = await CardModel.get(domainId, toObjectId(args.cardId));
        if (!card) throw new Error('Card not found');
        return { cardId: String(card.docId), title: card.title, content: card.content, nodeId: card.nodeId };
    }
    case 'card_create': {
        const nodeId = String(args.nodeId || '');
        const title = String(args.title || '').trim();
        if (!nodeId) throw new Error('nodeId is required');
        if (!title) throw new Error('title is required');
        const docId = await CardModel.create(
            domainId, baseDocId, nodeId, owner, title, String(args.content || ''),
            undefined, undefined, undefined, branch,
        );
        return { ok: true, cardId: String(docId) };
    }
    case 'card_update': {
        const updates: Record<string, any> = {};
        if (typeof args.title === 'string') updates.title = args.title;
        if (typeof args.content === 'string') updates.content = args.content;
        if (!Object.keys(updates).length) throw new Error('Nothing to update (title or content required)');
        await CardModel.update(domainId, toObjectId(args.cardId), updates);
        return { ok: true, cardId: String(args.cardId) };
    }
    case 'card_delete': {
        await CardModel.delete(domainId, toObjectId(args.cardId));
        return { ok: true, cardId: String(args.cardId) };
    }
    case 'detail_tree': {
        const includeCards = args.includeCards === undefined ? true : !!args.includeCards;
        const { nodes, edges } = getBranchData(base, branch);
        const nodeCardsMap = includeCards
            ? await loadNodeCardsMap(domainId, baseDocId, branch, nodes || [])
            : {};
        const tree = buildDetailTree(nodes || [], edges || [], nodeCardsMap, includeCards);
        return { nodeCount: (nodes || []).length, tree };
    }
    case 'detail_search': {
        const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));
        const filters: DetailExplorerFilters = {
            filterNode: String(args.filterNode || ''),
            filterCard: String(args.filterCard || ''),
            filterProblem: String(args.filterProblem || ''),
        };
        const raw = getBranchData(base, branch);
        const allNodes = raw.nodes || [];
        const allEdges = raw.edges || [];
        const nodeCardsMap = await loadNodeCardsMap(domainId, baseDocId, branch, allNodes);

        const filtered = applyDetailExplorerUrlFilters(allNodes, allEdges, nodeCardsMap, filters);
        const scopeNodes = filtered.nodes;
        const scopeEdges = filtered.edges;
        const scopeCardsMap = filtered.nodeCardsMap;

        const parentMap = buildParentMap(scopeEdges);
        const nodeById = new Map(scopeNodes.map((n) => [n.id, n]));
        const q = String(args.query || '').trim().toLowerCase();
        const matchText = (s: string | undefined) => !q || (s || '').toLowerCase().includes(q);

        const nodeMatches: any[] = [];
        for (const n of scopeNodes) {
            if (matchText(n.text) || matchText(n.id)) {
                nodeMatches.push({
                    type: 'node',
                    id: n.id,
                    text: n.text || '',
                    path: pathLabelFor(n.id, parentMap, nodeById),
                });
                if (nodeMatches.length >= limit) break;
            }
        }

        const cardMatches: any[] = [];
        outer: for (const nodeId of Object.keys(scopeCardsMap)) {
            for (const c of scopeCardsMap[nodeId] || []) {
                const cid = String(c.docId);
                if (matchText(c.title) || matchText(cid)) {
                    cardMatches.push({
                        type: 'card',
                        cardId: cid,
                        title: c.title || '',
                        nodeId: c.nodeId || nodeId,
                        path: pathLabelFor(c.nodeId || nodeId, parentMap, nodeById),
                    });
                    if (cardMatches.length >= limit) break outer;
                }
            }
        }

        return {
            query: q || null,
            filters,
            matchedNodeCount: nodeMatches.length,
            matchedCardCount: cardMatches.length,
            nodes: nodeMatches,
            cards: cardMatches,
        };
    }
    case 'problem_list': {
        const card = await requireCard(ctx, args.cardId);
        const problems = card.problems || [];
        return {
            cardId: String(card.docId),
            count: problems.length,
            problems: problems.map(summarizeProblem),
        };
    }
    case 'problem_get': {
        const card = await requireCard(ctx, args.cardId);
        const pid = String(args.pid || '').trim();
        if (!pid) throw new Error('pid is required');
        const problems = card.problems || [];
        const idx = findProblemIndex(problems, pid);
        if (idx < 0) throw new Error(`Problem not found: ${pid}`);
        return { cardId: String(card.docId), problem: problems[idx] };
    }
    case 'problem_create': {
        const card = await requireCard(ctx, args.cardId);
        const payload = parseProblemPayload(args.problem);
        const pid = newProblemPid();
        const problem = migrateRawProblem(buildProblemRaw(payload, pid));
        const problems = [...(card.problems || []), problem];
        await saveCardProblems(domainId, card, problems);
        return { ok: true, cardId: String(card.docId), pid: problem.pid, problem };
    }
    case 'problem_update': {
        const card = await requireCard(ctx, args.cardId);
        const pid = String(args.pid || '').trim();
        if (!pid) throw new Error('pid is required');
        const payload = parseProblemPayload(args.problem);
        const problems = [...(card.problems || [])];
        const idx = findProblemIndex(problems, pid);
        if (idx < 0) throw new Error(`Problem not found: ${pid}`);
        const merged = { ...(problems[idx] as unknown as Record<string, unknown>), ...payload, pid };
        const problem = migrateRawProblem(buildProblemRaw(merged, pid));
        problems[idx] = problem;
        await saveCardProblems(domainId, card, problems);
        return { ok: true, cardId: String(card.docId), pid, problem };
    }
    case 'problem_delete': {
        const card = await requireCard(ctx, args.cardId);
        const pid = String(args.pid || '').trim();
        if (!pid) throw new Error('pid is required');
        const problems = card.problems || [];
        const idx = findProblemIndex(problems, pid);
        if (idx < 0) throw new Error(`Problem not found: ${pid}`);
        const next = problems.filter((_, i) => i !== idx);
        await saveCardProblems(domainId, card, next);
        return { ok: true, cardId: String(card.docId), pid };
    }
    case 'git_status':
        return mcpBaseGitStatus(toMcpGitInput(ctx, args));
    case 'git_commit':
        return mcpBaseGitCommit(toMcpGitInput(ctx, args));
    case 'git_push':
        return mcpBaseGitPush(toMcpGitInput(ctx, args));
    case 'git_pull':
        return mcpBaseGitPull(toMcpGitInput(ctx, args));
    case 'git_config_get':
        return mcpBaseGitConfigGet({ domainId: ctx.domainId, baseDocId: ctx.baseDocId });
    case 'git_config_set': {
        const raw = args.githubRepo;
        const githubRepo = raw == null ? null : String(raw).trim();
        return mcpBaseGitConfigSet({
            ...toMcpGitInput(ctx, args),
            githubRepo: githubRepo || null,
        });
    }
    default:
        throw new Error(`Unknown tool: ${name}`);
    }
}

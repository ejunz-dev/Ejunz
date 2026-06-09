import { ObjectId } from 'mongodb';
import * as document from '../model/document';
import {
    BaseModel, CardModel, getBranchData,
    applyOutlineExplorerUrlFilters, type OutlineExplorerFilters,
} from '../model/base';
import type { CardDoc, BaseNode, BaseEdge } from '../interface';

export interface McpToolContext {
    domainId: string;
    baseDocId: number;
    branch: string;
    owner: number;
}

export interface McpToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

export const MCP_BUILTIN_TOOLS_CATALOG: McpToolDef[] = [
    {
        name: 'outline_list_nodes',
        description: 'Outline node = a section/topic in this base\'s outline tree (hierarchical). '
            + 'Returns every node of the bound base: id, text (title), parentId (null at root), level (depth), order. '
            + 'Call this first to understand the structure before reading or editing cards.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'outline_create_node',
        description: 'Create a new outline node (section/topic). '
            + 'Pass parentId to nest it under an existing node, or omit it to create a top-level node.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Node title/text.' },
                parentId: { type: 'string', description: 'Parent node id from outline_list_nodes (optional; omit for a root-level node).' },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
    {
        name: 'outline_update_node',
        description: 'Rename an outline node (change its title/text). Use nodeId from outline_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Node id from outline_list_nodes.' },
                text: { type: 'string', description: 'New node title/text.' },
            },
            required: ['nodeId', 'text'],
            additionalProperties: false,
        },
    },
    {
        name: 'outline_delete_node',
        description: 'Delete an outline node by id (and its cards). Use nodeId from outline_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Node id from outline_list_nodes.' } },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_list',
        description: 'Card = a content block (title + markdown body) attached to an outline node; a node can hold several ordered cards. '
            + 'Lists the cards under one node: cardId, title, order. Use nodeId from outline_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Node id from outline_list_nodes.' } },
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
        description: 'Create a new card (content block) under an outline node. Use nodeId from outline_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Owning node id from outline_list_nodes.' },
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
        name: 'outline_tree',
        description: 'Return the whole outline as a nested tree (overview/table of contents). '
            + 'Each node carries only its id and text (title) and its cards (cardId + title); card content is NOT included. '
            + 'Use this to grasp the full structure at a glance, then call card_get to read specific cards.',
        inputSchema: {
            type: 'object',
            properties: {
                includeCards: {
                    type: 'boolean',
                    description: 'Include each node\'s cards (id + title) in the tree. Default true; set false for a nodes-only outline.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'outline_search',
        description: 'Search and/or filter the outline (same semantics as the base outline page). '
            + 'Provide `query` to match a keyword or an exact id against node titles/ids and card titles/ids. '
            + 'Provide any of `filterNode` / `filterCard` / `filterProblem` to narrow by node title, card title, or problem content. '
            + 'You may combine `query` with the filters; all supplied conditions are applied together (intersection). '
            + 'Returns matching nodes and cards with id, title and the node path; card content is NOT included.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Keyword or exact id to match against node text/id and card title/id (case-insensitive).' },
                filterNode: { type: 'string', description: 'Keep only nodes whose title contains this text (like the outline page filterNode).' },
                filterCard: { type: 'string', description: 'Keep only nodes that have a card whose title contains this text (filterCard).' },
                filterProblem: { type: 'string', description: 'Keep only nodes that have a card with a problem matching this text (filterProblem).' },
                limit: { type: 'number', description: 'Max results to return per kind (nodes/cards). Default 50.' },
            },
            additionalProperties: false,
        },
    },
];

export async function buildMcpInstructions(
    ctx: { domainId: string; baseDocId?: number; branch?: string },
): Promise<string> {
    const lines: string[] = [
        'This MCP server is bound to a single Ejunz "base" — a knowledge base organized as an outline tree.',
        '',
        'Concepts:',
        '- Outline node: a section/topic in the base\'s outline tree. Nodes form a hierarchy via parentId/level. Each node has an id and text (title).',
        '- Card: a content block (title + markdown body) attached to an outline node. One node can hold multiple ordered cards.',
        '',
        'Relationship: base → outline nodes (tree) → cards (content under each node).',
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
        '1. outline_tree — get the whole outline (nodes + cards, titles only) at a glance.',
        '2. outline_search(query/filterNode/filterCard/filterProblem) — find nodes/cards by keyword, id or filters.',
        '3. outline_list_nodes — flat list of nodes; card_list(nodeId) — cards under a node.',
        '4. card_get(cardId) — read a card\'s full content.',
        '5. Use the create/update/delete tools to modify nodes and cards.',
    );
    return lines.join('\n');
}

export function isMcpBuiltinTool(name: string): boolean {
    return MCP_BUILTIN_TOOLS_CATALOG.some((t) => t.name === name);
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

interface OutlineTreeNode {
    id: string;
    text: string;
    cards?: { cardId: string; title: string; order: number }[];
    children: OutlineTreeNode[];
}

/** Builds nested outline tree (id + text only; cards as id + title when requested). */
function buildOutlineTree(
    nodes: BaseNode[],
    edges: BaseEdge[],
    nodeCardsMap: Record<string, CardDoc[]>,
    includeCards: boolean,
): OutlineTreeNode[] {
    const parentMap = buildParentMap(edges);
    const childrenMap = new Map<string, string[]>();
    for (const e of edges || []) {
        if (!childrenMap.has(e.source)) childrenMap.set(e.source, []);
        childrenMap.get(e.source)!.push(e.target);
    }
    const nodeById = new Map((nodes || []).map((n) => [n.id, n]));
    const orderOf = (id: string) => nodeById.get(id)?.order ?? 0;

    const build = (id: string, seen: Set<string>): OutlineTreeNode | null => {
        if (seen.has(id)) return null;
        seen.add(id);
        const n = nodeById.get(id);
        if (!n) return null;
        const childIds = (childrenMap.get(id) || []).slice().sort((a, b) => orderOf(a) - orderOf(b));
        const out: OutlineTreeNode = {
            id,
            text: n.text || '',
            children: childIds.map((c) => build(c, seen)).filter(Boolean) as OutlineTreeNode[],
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
    return roots.map((r) => build(r.id, seen)).filter(Boolean) as OutlineTreeNode[];
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
    case 'outline_list_nodes': {
        const { nodes } = getBranchData(base, branch);
        return (nodes || []).map(summarizeNode);
    }
    case 'outline_create_node': {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('text is required');
        const parentId = args.parentId ? String(args.parentId) : undefined;
        const res = await BaseModel.addNode(domainId, baseDocId, { text } as any, parentId, branch);
        return { ok: true, nodeId: res.nodeId, edgeId: res.edgeId };
    }
    case 'outline_update_node': {
        const nodeId = String(args.nodeId || '');
        const text = String(args.text || '');
        if (!nodeId) throw new Error('nodeId is required');
        await BaseModel.updateNode(domainId, baseDocId, nodeId, { text } as any, branch);
        return { ok: true, nodeId };
    }
    case 'outline_delete_node': {
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
    case 'outline_tree': {
        const includeCards = args.includeCards === undefined ? true : !!args.includeCards;
        const { nodes, edges } = getBranchData(base, branch);
        const nodeCardsMap = includeCards
            ? await loadNodeCardsMap(domainId, baseDocId, branch, nodes || [])
            : {};
        const tree = buildOutlineTree(nodes || [], edges || [], nodeCardsMap, includeCards);
        return { nodeCount: (nodes || []).length, tree };
    }
    case 'outline_search': {
        const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));
        const filters: OutlineExplorerFilters = {
            filterNode: String(args.filterNode || ''),
            filterCard: String(args.filterCard || ''),
            filterProblem: String(args.filterProblem || ''),
        };
        const raw = getBranchData(base, branch);
        const allNodes = raw.nodes || [];
        const allEdges = raw.edges || [];
        const nodeCardsMap = await loadNodeCardsMap(domainId, baseDocId, branch, allNodes);

        const filtered = applyOutlineExplorerUrlFilters(allNodes, allEdges, nodeCardsMap, filters);
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
    default:
        throw new Error(`Unknown tool: ${name}`);
    }
}

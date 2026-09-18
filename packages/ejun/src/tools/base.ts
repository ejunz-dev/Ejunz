import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import * as document from 'ejun/src/model/document';
import { BaseModel, CardModel, loadCardStatsByBaseDocId } from 'ejun/src/model/base';
import { baseUrl } from '../lib/tool-shared';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/registry';

export const inject = ['server'];

export const Create = Schema.object({
    title: Schema.string().required().description('Base title (required).'),
    content: Schema.string().description('Base description or markdown content (optional).'),
    slug: Schema.string().description('Optional unique lowercase URL slug.'),
    tag: Schema.array(Schema.string()).description('Optional Base tags.'),
}).description('Create a new Ejunz Base in the current domain. The new Base is returned by id with the URL its detail page is served at, and is not automatically selected for this session.');

export const List = Schema.object({
    limit: Schema.number().min(1).max(50).description('Maximum result count, up to 50.'),
}).description('List all Ejunz Bases in the current domain, each with its node, card, and problem count and a link to open it.');

export const Search = Schema.object({
    query: Schema.string().required().description('Search text.'),
    limit: Schema.number().min(1).max(50).description('Maximum result count, up to 50.'),
}).description('Search Ejunz Bases in the current domain by title, content, slug, or tags. Each result carries the URL its detail page is served at.');

export const Get = Schema.object({
    baseId: Schema.number().step(1).min(1).required().description('Existing Base id.'),
}).description('Read an Ejunz Base by baseId, including metadata, content, nodes, edges, a tree-shaped outline of node/card ids and titles, and the URL its detail page is served at.');

export const Update = Schema.object({
    baseId: Schema.number().step(1).min(1).required().description('Existing Base id.'),
    title: Schema.string().description('New Base title.'),
    content: Schema.string().description('New Base description or markdown content.'),
    slug: Schema.string().description('New unique lowercase URL slug; empty clears it.'),
    tag: Schema.array(Schema.string()).description('Replacement Base tags.'),
}).description('Update an Ejunz Base by baseId: title, content, slug, or tags. Returns the updated Base and the URL its detail page is served at.');

export const Remove = Schema.object({
    baseId: Schema.number().step(1).min(1).required().description('Existing Base id.'),
}).description('Delete an Ejunz Base by baseId, including its cards, problems, stored files, and vector index.');

interface OutlineEntry {
    type: 'node' | 'card';
    id: string;
    title: string;
    children?: OutlineEntry[];
}

function outlineParentMap(base: { nodes?: { id: string; parentId?: string; children?: string[] }[]; edges?: { source: string; target: string }[] }): Map<string, string> {
    const nodes = base.nodes || [];
    const nodeIds = new Set(nodes.map((node) => node.id));
    const parentByNode = new Map<string, string>();
    for (const node of nodes) {
        if (node.parentId && nodeIds.has(node.parentId)) parentByNode.set(node.id, node.parentId);
    }
    for (const edge of base.edges || []) {
        if (nodeIds.has(edge.source) && nodeIds.has(edge.target) && !parentByNode.has(edge.target)) {
            parentByNode.set(edge.target, edge.source);
        }
    }
    for (const node of nodes) {
        for (const childId of node.children || []) {
            if (nodeIds.has(childId) && !parentByNode.has(childId)) parentByNode.set(childId, node.id);
        }
    }
    return parentByNode;
}

export async function create(ctx: ToolContext, args: ToolArgs) {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('title is required');
    const content = typeof args.content === 'string' ? args.content : '';
    const slug = typeof args.slug === 'string' ? args.slug.trim() : undefined;
    const tag = Array.isArray(args.tag)
        ? args.tag.filter((value: unknown): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
        : undefined;
    const created = await BaseModel.create(ctx.domainId, ctx.owner, title, content, undefined, undefined, undefined, undefined, true, tag, document.TYPE_BASE, undefined, slug === undefined ? undefined : { slug });
    const base = await BaseModel.get(ctx.domainId, created.docId, document.TYPE_BASE);
    return { ok: true, baseId: created.docId, base, url: baseUrl(ctx, created.docId) };
}

export async function list(ctx: ToolContext, args: ToolArgs) {
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
    const bases = await BaseModel.getAll(ctx.domainId, undefined, document.TYPE_BASE);
    const page = bases.slice(0, limit);
    const cardStats = await loadCardStatsByBaseDocId(ctx.domainId, page.map((item) => item.docId));
    return {
        ok: true,
        query: null,
        count: page.length,
        bases: page.map((item) => {
            const stats = cardStats.get(item.docId);
            return {
                baseId: item.docId,
                title: item.title,
                content: item.content,
                ...(item.slug ? { slug: item.slug } : {}),
                ...(item.tag?.length ? { tag: item.tag } : {}),
                url: baseUrl(ctx, item.docId),
                nodeCount: item.nodes?.length ?? 0,
                cardCount: stats?.cardCount ?? 0,
                problemCount: stats?.problemCount ?? 0,
                createdAt: item.createdAt,
                updateAt: item.updateAt,
            };
        }),
    };
}

export async function search(ctx: ToolContext, args: ToolArgs) {
    const query = String(args.query || '').trim().toLowerCase();
    if (!query) throw new Error('query is required');
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
    const bases = await BaseModel.getAll(ctx.domainId, undefined, document.TYPE_BASE);
    const matches = bases.filter((item) => [item.title, item.content, item.slug, ...(item.tag || [])].filter((value): value is string => typeof value === 'string').some((value) => value.toLowerCase().includes(query)));
    return {
        ok: true,
        query,
        count: Math.min(matches.length, limit),
        bases: matches.slice(0, limit).map((item) => ({
            baseId: item.docId,
            title: item.title,
            content: item.content,
            ...(item.slug ? { slug: item.slug } : {}),
            ...(item.tag?.length ? { tag: item.tag } : {}),
            createdAt: item.createdAt,
            updateAt: item.updateAt,
            url: baseUrl(ctx, item.docId),
        })),
    };
}

export async function get(ctx: ToolContext, _args: ToolArgs) {
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const nodes = base.nodes || [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const parentByNode = outlineParentMap(base);
    const childrenByParent = new Map<string, string[]>();
    for (const node of nodes) {
        const parentId = parentByNode.get(node.id);
        if (!parentId) continue;
        const children = childrenByParent.get(parentId);
        if (children) children.push(node.id);
        else childrenByParent.set(parentId, [node.id]);
    }
    const cardsByNode = await CardModel.getByNodeIds(ctx.domainId, ctx.baseDocId, nodes.map((node) => node.id));
    const renderedNodes = new Set<string>();
    const renderNode = (nodeId: string): OutlineEntry | undefined => {
        if (renderedNodes.has(nodeId)) return undefined;
        const node = nodeById.get(nodeId);
        if (!node) return undefined;
        renderedNodes.add(nodeId);
        const children: OutlineEntry[] = (cardsByNode.get(nodeId) || []).map((card) => ({
            type: 'card',
            id: String(card.docId),
            title: card.title || '',
        }));
        for (const childId of childrenByParent.get(nodeId) || []) {
            const child = renderNode(childId);
            if (child) children.push(child);
        }
        return { type: 'node', id: node.id, title: node.text || '', children };
    };
    const outline: OutlineEntry[] = [];
    for (const node of nodes) {
        if (!parentByNode.has(node.id)) {
            const entry = renderNode(node.id);
            if (entry) outline.push(entry);
        }
    }
    for (const node of nodes) {
        const entry = renderNode(node.id);
        if (entry) outline.push(entry);
    }
    return { ok: true, base, outline, url: baseUrl(ctx, ctx.baseDocId) };
}

export async function update(ctx: ToolContext, args: ToolArgs) {
    const updates: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(args, 'title')) {
        const title = String(args.title || '').trim();
        if (!title) throw new Error('title cannot be empty');
        updates.title = title;
    }
    if (typeof args.content === 'string') updates.content = args.content;
    if (typeof args.slug === 'string') updates.slug = args.slug.trim();
    if (Array.isArray(args.tag)) updates.tag = args.tag.filter((value: unknown): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean);
    if (Object.keys(updates).length === 0) throw new Error('Nothing to update');
    await BaseModel.update(ctx.domainId, ctx.baseDocId, updates as Parameters<typeof BaseModel.update>[2], document.TYPE_BASE);
    return {
        ok: true,
        baseId: ctx.baseDocId,
        base: await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE),
        url: baseUrl(ctx, ctx.baseDocId),
    };
}

export async function remove(ctx: ToolContext, _args: ToolArgs) {
    await BaseModel.delete(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    return { ok: true, baseId: ctx.baseDocId };
}

export function apply(ctx: Context) {
    const none = { source: 'base' as const, bindBase: 'none' as const };
    const explicit = { source: 'base' as const, bindBase: 'explicit' as const };
    ctx.Tool('base_create', create, Create, { ...none, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_list', list, List, none, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_search', search, Search, none, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_get', get, Get, explicit, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_update', update, Update, { ...explicit, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_delete', remove, Remove, { ...explicit, mutating: true }, PRIV.PRIV_USER_PROFILE);
}

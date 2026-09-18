import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import type { BaseEdge, BaseNode } from 'ejun/src/interface';
import { BaseModel, CardModel } from 'ejun/src/model/base';
import { MAX_NODES_PER_CALL } from '../lib/tool-limits';
import { asText, buildParentMap, findRootNodeId, idList, nodeUrl, pathLabelFor } from '../lib/tool-shared';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/registry';

export const inject = ['server'];

export const Create = Schema.object({
    text: Schema.string().required().description('Node title/text.'),
    parentId: Schema.string().description('Existing parent node id (optional; omit to place under the base root node).'),
}).description('Create a new node (section/topic). '
    + 'Pass parentId to nest it under an existing node; omit parentId to create it under the bound base root node. '
    + 'Returns the new node id and the URL that opens the Base at that node.');

export const Update = Schema.object({
    nodeId: Schema.string().required().description('Existing node id.'),
    text: Schema.string().required().description('New node title/text.'),
    parentId: Schema.string().description('Existing parent node id (optional; omit to keep the current parent).'),
}).description('Rename and/or move a node. Pass parentId to move it under an existing node; omit parentId to keep its current parent. Returns the URL that opens the Base at the node.');

export const Get = Schema.object({
    nodeId: Schema.string().required().description('Existing node id.'),
}).description('Read a node and its direct child nodes plus cards attached to it. Returns ids and titles for child nodes, and ids, titles, and content for cards without recursively expanding nested nodes. Also returns the URL that opens the Base at this node.');

export const Remove = Schema.object({
    nodeId: Schema.string().required().description('Existing node id.'),
}).description('Delete a node by id (and its cards). Use an existing nodeId.');

export const CreateMany = Schema.object({
    parentId: Schema.string().description('Node that every entry without a parent attaches to (optional; defaults to the Base\'s root node). The node must already exist.'),
    nodes: Schema.array(Schema.object({
        text: Schema.string().required().description('Node text (required).'),
        ref: Schema.string().description('Optional name for this entry, for a later entry\'s parentRef.'),
        parentId: Schema.string().description('Existing node of this Base to attach to (optional).'),
        parentRef: Schema.string().description('ref of an earlier entry to attach to (optional; keep one of parentId and parentRef).'),
    })).min(1).max(MAX_NODES_PER_CALL).required().description('Nodes to create, in order: a parent must come before the entries that name it.'),
}).description('Create several nodes at once, in one read and one write of the Base. `nodes` is an array of '
    + '`{ text, ref?, parentId?, parentRef? }`. A `ref` names an entry so a later entry can use it as its `parentRef`, which builds a whole '
    + 'tree in one call; an entry with neither parent attaches to the call\'s `parentId`, or to the Base\'s root node. The Base is read once, '
    + 'every node and edge is built in memory, and one update writes them all, so the call is atomic: either every node arrives or nothing '
    + 'changes. Refused for a missing text, a duplicate or dangling reference, or too many entries, and it writes nothing in that case. '
    + `Use it instead of calling \`base_node_create\` once per node. One call creates at most ${MAX_NODES_PER_CALL} nodes. `
    + 'Every entry carries the URL that opens the Base at that node.');

export const GetMany = Schema.object({
    nodeIds: Schema.array(Schema.string()).min(1).max(MAX_NODES_PER_CALL).required().description('Node ids to read, in order.'),
}).description('Read several nodes of one Base in a single call, each reported exactly as `base_node_get` reports one: its title, its child nodes '
    + 'and its cards. The Base document is read once and the cards of every named node come from one further read, so the call costs two reads '
    + 'however many nodes it names, instead of two reads per node. A read changes nothing, so a node this Base does not hold is listed in '
    + `\`missingNodeIds\` and \`ok\` is false. Use it instead of calling \`base_node_get\` once per node. One call reads at most ${MAX_NODES_PER_CALL} nodes.`);

export const UpdateMany = Schema.object({
    entries: Schema.array(Schema.object({
        nodeId: Schema.string().required().description('Node to change (required).'),
        text: Schema.string().description('New node text (optional).'),
        parentId: Schema.string().description('Existing node to move this node under (optional).'),
    })).min(1).max(MAX_NODES_PER_CALL).required().description('One entry per node, in the order the updates apply.'),
}).description('Update several nodes of one Base in a single call: `entries` is an array of `{ nodeId, text?, parentId? }`, and an entry changes '
    + 'what it names. Node text and place in the tree live in the Base document, so one read and one write apply every entry, instead of one of '
    + 'each per node, and the call is atomic: either every entry lands or the document is unchanged. An entry the move rules refuse (an absent '
    + 'node or parent, a move under itself or under one of its descendants) refuses the whole call and writes nothing. Renaming the root node '
    + `renames the Base, as \`base_node_update\` does. Use it instead of calling \`base_node_update\` once per node. One call updates at most ${MAX_NODES_PER_CALL} nodes, and every entry carries the URL that opens the Base at that node.`);

export const RemoveMany = Schema.object({
    nodeIds: Schema.array(Schema.string()).min(1).max(MAX_NODES_PER_CALL).required().description('Nodes to remove; a node already removed as a descendant of another is ignored.'),
}).description('Delete several nodes of one Base in a single call: `nodeIds` names the nodes, and each one takes its descendants with it exactly '
    + 'as `base_node_delete` does. The whole graph change is one read and one write of the Base document, so n subtrees cost one of each instead '
    + 'of one per node, and the node and edge removal is atomic. The cards on the removed nodes, and the files stored on those nodes and cards, '
    + 'follow their nodes one operation each. The root node cannot be removed: naming it refuses the whole call and writes nothing. An id this '
    + `Base does not hold is listed in \`missingNodeIds\` and \`ok\` is false. Use it instead of calling \`base_node_delete\` once per node. One call removes at most ${MAX_NODES_PER_CALL} nodes.`);

function newNodeId() {
    return `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function newEdgeId() {
    return `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export async function create(ctx: ToolContext, args: ToolArgs) {
    const text = String(args.text || '').trim();
    if (!text) throw new Error('text is required');
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const parentId = args.parentId ? String(args.parentId).trim() : findRootNodeId(base.nodes || [], base.edges || []);
    if (parentId && !(base.nodes || []).some((node) => node.id === parentId)) throw new Error(`Parent node not found: ${parentId}`);
    const result = await BaseModel.addNode(ctx.domainId, ctx.baseDocId, { text } as any, parentId, parentId);
    return { ok: true, nodeId: result.nodeId, edgeId: result.edgeId, parentId: parentId ?? null, url: nodeUrl(ctx, ctx.baseDocId, result.nodeId) };
}

export async function update(ctx: ToolContext, args: ToolArgs) {
    const nodeId = String(args.nodeId || '');
    const text = String(args.text || '');
    if (!nodeId) throw new Error('nodeId is required');
    const updates: Record<string, unknown> = { text };
    if (Object.prototype.hasOwnProperty.call(args, 'parentId')) {
        const parentId = String(args.parentId || '').trim();
        if (!parentId) throw new Error('parentId is required when provided');
        updates.parentId = parentId;
    }
    await BaseModel.updateNode(ctx.domainId, ctx.baseDocId, nodeId, updates as any);
    return {
        ok: true,
        nodeId,
        ...(updates.parentId ? { parentId: updates.parentId } : {}),
        url: nodeUrl(ctx, ctx.baseDocId, nodeId),
    };
}

export async function get(ctx: ToolContext, args: ToolArgs) {
    const nodeId = String(args.nodeId || '').trim();
    if (!nodeId) throw new Error('nodeId is required');
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const node = (base.nodes || []).find((item) => item.id === nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const nodeById = new Map((base.nodes || []).map((item) => [item.id, item]));
    const childIds = new Set<string>();
    for (const child of base.nodes || []) {
        if (child.parentId === nodeId) childIds.add(child.id);
    }
    for (const edge of base.edges || []) {
        const child = nodeById.get(edge.target);
        if (edge.source === nodeId && child && !child.parentId) childIds.add(child.id);
    }
    for (const childId of node.children || []) {
        const child = nodeById.get(childId);
        if (child && !child.parentId) childIds.add(childId);
    }
    const cards = await CardModel.getByNodeId(ctx.domainId, ctx.baseDocId, nodeId);
    return {
        ok: true,
        node: {
            nodeId: node.id,
            title: node.text || '',
            url: nodeUrl(ctx, ctx.baseDocId, node.id),
        },
        childNodes: (base.nodes || [])
            .filter((child) => childIds.has(child.id))
            .map((child) => ({ nodeId: child.id, title: child.text || '' })),
        cards: cards.map((card) => ({
            cardId: String(card.docId),
            title: card.title || '',
            content: card.content || '',
        })),
    };
}

export async function remove(ctx: ToolContext, args: ToolArgs) {
    const nodeId = String(args.nodeId || '');
    if (!nodeId) throw new Error('nodeId is required');
    await BaseModel.deleteNode(ctx.domainId, ctx.baseDocId, nodeId);
    return { ok: true, nodeId };
}

export async function createMany(ctx: ToolContext, args: ToolArgs) {
    const raw = args.nodes;
    if (!Array.isArray(raw) || !raw.length) throw new Error('nodes must be a non-empty array of { text, ref?, parentId?, parentRef? }');
    if (raw.length > MAX_NODES_PER_CALL) {
        throw new Error(`nodes holds ${raw.length} entries and one call creates ${MAX_NODES_PER_CALL}; split the work across calls`);
    }
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const nodes: BaseNode[] = base.nodes || [];
    const edges: BaseEdge[] = base.edges || [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const namedParent = asText(args.parentId);
    if (namedParent && !nodeById.has(namedParent)) throw new Error(`Parent node not found: ${namedParent}`);
    const defaultParent = namedParent || findRootNodeId(nodes, edges) || '';
    const planned: { index: number; ref: string; text: string; parentId: string; level: number; nodeId: string }[] = [];
    const byRef = new Map<string, typeof planned[number]>();
    const refOwner = new Map<string, number>();
    for (const [index, entry] of raw.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`nodes[${index}] must be an object with text`);
        const fields = entry as Record<string, unknown>;
        const text = asText(fields.text);
        if (!text) throw new Error(`nodes[${index}].text is required`);
        const ref = asText(fields.ref);
        if (ref && refOwner.has(ref)) throw new Error(`nodes[${index}].ref ${ref} is already the ref of nodes[${refOwner.get(ref)}]`);
        const parentRef = asText(fields.parentRef);
        const ownParent = asText(fields.parentId);
        if (parentRef && ownParent) throw new Error(`nodes[${index}] names both parentRef and parentId; keep one`);
        let parentId: string;
        if (parentRef) {
            const referenced = byRef.get(parentRef);
            if (!referenced) throw new Error(`nodes[${index}].parentRef ${parentRef} does not name an earlier entry; list a parent before its children`);
            parentId = referenced.nodeId;
        } else if (ownParent) {
            if (!nodeById.has(ownParent)) throw new Error(`nodes[${index}].parentId ${ownParent} is not a node of this Base`);
            parentId = ownParent;
        } else {
            if (!defaultParent) throw new Error('This Base has no node to attach the new nodes to; pass parentId');
            parentId = defaultParent;
        }
        const parent = nodeById.get(parentId);
        if (!parent) throw new Error(`Parent node not found: ${parentId}`);
        const nodeId = newNodeId();
        const level = (parent.level ?? -1) + 1;
        const now = new Date();
        const node: BaseNode = { id: nodeId, text, parentId, level, createdAt: now, updateAt: now };
        nodes.push(node);
        parent.children = [...(parent.children || []), nodeId];
        edges.push({ id: newEdgeId(), source: parentId, target: nodeId });
        nodeById.set(nodeId, node);
        const created = { index, ref, text, parentId, level, nodeId };
        planned.push(created);
        if (ref) {
            byRef.set(ref, created);
            refOwner.set(ref, index);
        }
    }
    await BaseModel.updateFull(ctx.domainId, ctx.baseDocId, { nodes, edges });
    const parentMap = buildParentMap(edges);
    return {
        ok: true,
        baseId: ctx.baseDocId,
        nodeCount: planned.length,
        nodes: planned.map((entry) => ({
            index: entry.index,
            ref: entry.ref,
            nodeId: entry.nodeId,
            parentId: entry.parentId,
            level: entry.level,
            path: pathLabelFor(entry.nodeId, parentMap, nodeById),
            url: nodeUrl(ctx, ctx.baseDocId, entry.nodeId),
        })),
        writes: 1,
    };
}

export async function getMany(ctx: ToolContext, args: ToolArgs) {
    const nodeIds = idList(args.nodeIds, 'nodeIds', MAX_NODES_PER_CALL);
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const nodes = base.nodes || [];
    const edges = base.edges || [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const cardsByNode = await CardModel.getByNodeIds(ctx.domainId, ctx.baseDocId, nodeIds);
    const found: unknown[] = [];
    const missing: string[] = [];
    for (const [index, nodeId] of nodeIds.entries()) {
        const node = nodeById.get(nodeId);
        if (!node) {
            missing.push(nodeId);
            continue;
        }
        const childIds = new Set<string>();
        for (const child of nodes) {
            if (child.parentId === nodeId) childIds.add(child.id);
        }
        for (const edge of edges) {
            const child = nodeById.get(edge.target);
            if (edge.source === nodeId && child && !child.parentId) childIds.add(child.id);
        }
        for (const childId of node.children || []) {
            const child = nodeById.get(childId);
            if (child && !child.parentId) childIds.add(childId);
        }
        const cards = cardsByNode.get(nodeId) || [];
        found.push({
            index,
            nodeId,
            title: node.text || '',
            url: nodeUrl(ctx, ctx.baseDocId, nodeId),
            childNodes: nodes
                .filter((child) => childIds.has(child.id))
                .map((child) => ({ nodeId: child.id, title: child.text || '' })),
            cards: cards.map((card) => ({
                cardId: String(card.docId),
                title: card.title || '',
                content: card.content || '',
            })),
        });
    }
    return {
        ok: missing.length === 0,
        baseId: ctx.baseDocId,
        nodeCount: found.length,
        nodes: found,
        missingNodeIds: missing,
        reads: { base: 1, cards: 1 },
    };
}

export async function updateMany(ctx: ToolContext, args: ToolArgs) {
    const raw = args.entries;
    if (!Array.isArray(raw) || !raw.length) throw new Error('entries must be a non-empty array of { nodeId, text?, parentId? }');
    if (raw.length > MAX_NODES_PER_CALL) {
        throw new Error(`entries holds ${raw.length} entries and one call updates ${MAX_NODES_PER_CALL}; split the work across calls`);
    }
    const planned: { index: number; nodeId: string; update: Partial<BaseNode> & { nodeId: string }; fields: string[] }[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`entries[${index}] must be an object with nodeId`);
        const fields = entry as Record<string, unknown>;
        const nodeId = asText(fields.nodeId);
        if (!nodeId) throw new Error(`entries[${index}].nodeId is required`);
        if (seen.has(nodeId)) throw new Error(`entries[${index}].nodeId ${nodeId} appears twice; send one entry per node`);
        seen.add(nodeId);
        const update: Partial<BaseNode> & { nodeId: string } = { nodeId };
        const changed: string[] = [];
        if (Object.prototype.hasOwnProperty.call(fields, 'text')) {
            if (typeof fields.text !== 'string') throw new Error(`entries[${index}].text must be a string`);
            update.text = fields.text;
            changed.push('text');
        }
        if (Object.prototype.hasOwnProperty.call(fields, 'parentId')) {
            const parentId = asText(fields.parentId);
            if (!parentId) throw new Error(`entries[${index}].parentId is required when provided`);
            update.parentId = parentId;
            changed.push('parentId');
        }
        if (!changed.length) throw new Error(`entries[${index}] names nothing to change; give text, parentId, or both`);
        planned.push({ index, nodeId, update, fields: changed });
    }
    await BaseModel.applyNodeUpdates(ctx.domainId, ctx.baseDocId, planned.map((entry) => entry.update));
    return {
        ok: true,
        baseId: ctx.baseDocId,
        nodeCount: planned.length,
        nodes: planned.map((entry) => ({
            index: entry.index,
            nodeId: entry.nodeId,
            changed: entry.fields,
            ...entry.update,
            url: nodeUrl(ctx, ctx.baseDocId, entry.nodeId),
        })),
        reads: 1,
        writes: 1,
    };
}

export async function removeMany(ctx: ToolContext, args: ToolArgs) {
    const nodeIds = idList(args.nodeIds, 'nodeIds', MAX_NODES_PER_CALL);
    const result = await BaseModel.deleteNodes(ctx.domainId, ctx.baseDocId, nodeIds);
    return {
        ok: result.missing.length === 0,
        baseId: ctx.baseDocId,
        removedNodeIds: result.removed,
        missingNodeIds: result.missing,
        writes: { graph: 1 },
    };
}

export function apply(ctx: Context) {
    const opts = { source: 'base' as const, bindBase: 'session' as const };
    ctx.Tool('base_node_create', create, Create, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_update', update, Update, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_get', get, Get, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_delete', remove, Remove, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_create_many', createMany, CreateMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_get_many', getMany, GetMany, opts, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_update_many', updateMany, UpdateMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_node_delete_many', removeMany, RemoveMany, { ...opts, mutating: true }, PRIV.PRIV_USER_PROFILE);
}

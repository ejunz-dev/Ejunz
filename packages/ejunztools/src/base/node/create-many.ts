import type { BaseEdge, BaseNode } from 'ejun/src/interface';
import { BaseModel } from 'ejun/src/model/base';
import { MAX_NODES_PER_CALL } from '../../catalog';
import { asText, buildParentMap, findRootNodeId, pathLabelFor } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

interface PlannedNode {
    index: number;
    ref: string;
    text: string;
    parentId: string;
    level: number;
    nodeId: string;
}

function newNodeId(): string {
    return `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function newEdgeId(): string {
    return `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
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

    const planned: PlannedNode[] = [];
    const byRef = new Map<string, PlannedNode>();
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

        const created: PlannedNode = { index, ref, text, parentId, level, nodeId };
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
        })),
        writes: 1,
    };
}

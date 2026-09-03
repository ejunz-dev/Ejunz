import * as document from '../../model/document';
import { CardModel, BaseModel } from '../../model/base';
import type { ToolContext, ToolArgs } from '../types';

interface OutlineEntry {
    type: 'node' | 'card';
    id: string;
    title: string;
    children?: OutlineEntry[];
}

function buildParentMap(base: { nodes?: { id: string; parentId?: string; children?: string[] }[]; edges?: { source: string; target: string }[] }): Map<string, string> {
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

export async function execute(ctx: ToolContext, _args: ToolArgs): Promise<unknown> {
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);

    const nodes = base.nodes || [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const parentByNode = buildParentMap(base);
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

    return { ok: true, base, outline };
}

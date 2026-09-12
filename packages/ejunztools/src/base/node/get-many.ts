import { CardModel, BaseModel } from 'ejun/src/model/base';
import { MAX_NODES_PER_CALL } from '../../catalog';
import { idList } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
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
            if (child && !child.parentId) childIds.add(child.id);
        }
        const cards = cardsByNode.get(nodeId) || [];
        found.push({
            index,
            nodeId,
            title: node.text || '',
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

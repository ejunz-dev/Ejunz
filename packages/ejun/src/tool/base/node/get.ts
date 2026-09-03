import { CardModel, BaseModel } from '../../../model/base';
import type { ToolContext, ToolArgs } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
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
        if (child && !child.parentId) childIds.add(child.id);
    }

    const cards = await CardModel.getByNodeId(ctx.domainId, ctx.baseDocId, nodeId);
    return {
        ok: true,
        node: {
            nodeId: node.id,
            title: node.text || '',
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

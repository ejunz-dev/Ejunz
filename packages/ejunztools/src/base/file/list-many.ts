import * as document from 'ejun/src/model/document';
import { BaseModel, CardModel } from 'ejun/src/model/base';
import type { CardDoc } from 'ejun/src/interface';
import { MAX_NODES_PER_CALL } from '../../catalog';
import { fileCardSummary, idList } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const nodeIds = idList(args.nodeIds, 'nodeIds', MAX_NODES_PER_CALL);
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    const known = new Set((base.nodes || []).map((node) => node.id));
    const missing = nodeIds.filter((nodeId) => !known.has(nodeId));
    const present = nodeIds.filter((nodeId) => known.has(nodeId));
    const cardsByNode = await CardModel.getByNodeIds(ctx.domainId, ctx.baseDocId, present);

    const nodes = present.map((nodeId, index) => {
        const files = (cardsByNode.get(nodeId) || []).filter((card) => (card as CardDoc).cardType === 'file');
        return { index, nodeId, files: files.map((card) => fileCardSummary(card)) };
    });

    return {
        ok: missing.length === 0,
        baseId: ctx.baseDocId,
        nodeCount: nodes.length,
        nodes,
        fileCount: nodes.reduce((sum, node) => sum + node.files.length, 0),
        missingNodeIds: missing,
        reads: { base: 1, cards: 1 },
    };
}

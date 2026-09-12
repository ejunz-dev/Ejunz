import { BaseModel } from 'ejun/src/model/base';
import { MAX_NODES_PER_CALL } from '../../catalog';
import { idList } from '../shared';
import type { ToolArgs, ToolContext } from '../../types';

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
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

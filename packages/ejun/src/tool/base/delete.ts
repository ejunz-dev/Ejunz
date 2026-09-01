import * as document from '../../model/document';
import { BaseModel } from '../../model/base';
import type { McpToolContext, ToolArgs } from '../types';

export async function execute(ctx: McpToolContext, _args: ToolArgs): Promise<unknown> {
    await BaseModel.delete(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    return { ok: true, baseId: ctx.baseDocId };
}

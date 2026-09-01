import * as document from '../../model/document';
import { BaseModel } from '../../model/base';
import type { McpToolContext, ToolArgs } from '../types';

export async function execute(ctx: McpToolContext, _args: ToolArgs): Promise<unknown> {
    const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${ctx.baseDocId}`);
    return { ok: true, base };
}

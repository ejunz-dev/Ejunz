import * as document from '../../model/document';
import { BaseModel } from '../../model/base';
import type { ToolContext, ToolArgs } from '../types';

export async function execute(ctx: ToolContext, _args: ToolArgs): Promise<unknown> {
    await BaseModel.delete(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
    return { ok: true, baseId: ctx.baseDocId };
}

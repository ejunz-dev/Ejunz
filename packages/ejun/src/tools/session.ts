import Schema from 'schemastery';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import * as document from 'ejun/src/model/document';
import { BaseModel } from 'ejun/src/model/base';
import type { ToolArgs, ToolBaseSelectPayload, ToolContext } from '../lib/tool-types';
import type { ToolInstructionsContext } from '../service/registry';

export const inject = ['server'];

export const ContextConfig = Schema.object({}).description('Get the current Ejunz Base domain context and scope.');

export const SelectConfig = Schema.object({
    baseId: Schema.number().step(1).min(1).required().description('Existing Base id.'),
}).description('Switch the current Agent session to an Ejunz Base by baseId.');

async function instructions(context: ToolInstructionsContext): Promise<string> {
    const baseId = Number(context.baseDocId);
    if (!Number.isSafeInteger(baseId) || baseId <= 0) {
        return 'The current Agent session supplies the Ejunz Base scope for each tool call.';
    }
    const base = await BaseModel.get(context.domainId, baseId, document.TYPE_BASE);
    return `Current Ejunz Base domain: ${context.domainId}; Base id: ${baseId}${base?.title ? ` (${base.title})` : ''}.`;
}

export async function context(ctx: ToolContext) {
    const baseId = Number(ctx.baseDocId);
    if (!Number.isSafeInteger(baseId) || baseId <= 0) return { domain: ctx.domainId };
    const base = await BaseModel.get(ctx.domainId, baseId, document.TYPE_BASE);
    return {
        domain: ctx.domainId,
        baseId,
        ...(base?.title ? { baseName: base.title } : {}),
    };
}

export async function select(app: Context, ctx: ToolContext, args: ToolArgs) {
    const sessionId = ctx.sessionId;
    if (!sessionId) throw new Error('base_select requires an Agent session');
    const baseDocId = Number(args.baseId);
    if (!Number.isSafeInteger(baseDocId) || baseDocId <= 0) throw new Error('baseId is required');
    const base = await BaseModel.get(ctx.domainId, baseDocId, document.TYPE_BASE);
    if (!base) throw new Error('Base not found in current domain');
    const payload: ToolBaseSelectPayload = {
        sessionId,
        domainId: ctx.domainId,
        owner: ctx.owner,
        baseDocId,
        ...(base.title ? { baseName: base.title } : {}),
    };
    await app.parallel('tool/base-select', payload);
    return { sessionId, baseDocId, baseName: base.title || undefined };
}

export function apply(ctx: Context) {
    const session = { source: 'session' as const, bindBase: 'none' as const };
    ctx.Tool('base_context', context, ContextConfig, { ...session, instructions }, PRIV.PRIV_USER_PROFILE);
    ctx.Tool('base_select', (toolCtx, args) => select(ctx, toolCtx, args), SelectConfig, { ...session, mutating: true }, PRIV.PRIV_USER_PROFILE);
}

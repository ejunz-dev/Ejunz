import Schema from 'schemastery';
import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import * as document from 'ejun/src/model/document';
import { BaseModel } from 'ejun/src/model/base';
import type { ToolArgs, ToolBaseSelectPayload, ToolContext } from '../lib/tool-types';
import type { ToolInstructionsContext } from '../service/registry';
import { registerAgentAddon } from '../service/addons';

export const inject = ['server'];

export const ContextConfigSchema = Schema.object({}).description('Get the current Ejunz Base domain context and scope.');

export const SelectConfigSchema = Schema.object({
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

class BaseContextExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        const ctx = this.context;
        const baseId = Number(ctx.baseDocId);
        if (!Number.isSafeInteger(baseId) || baseId <= 0) return { domain: ctx.domainId };
        const base = await BaseModel.get(ctx.domainId, baseId, document.TYPE_BASE);
        return {
            domain: ctx.domainId,
            baseId,
            ...(base?.title ? { baseName: base.title } : {}),
        };
    }
}

export function apply(ctx: Context) {
    class BaseSelectExecutor extends Executor<ToolContext, ToolArgs> {
        async execute() {
            const toolContext = this.context;
            const args = this.args;
            const sessionId = toolContext.sessionId;
            if (!sessionId) throw new Error('base_select requires an Agent session');
            const baseDocId = Number(args.baseId);
            if (!Number.isSafeInteger(baseDocId) || baseDocId <= 0) throw new Error('baseId is required');
            const base = await BaseModel.get(toolContext.domainId, baseDocId, document.TYPE_BASE);
            if (!base) throw new Error('Base not found in current domain');
            const payload: ToolBaseSelectPayload = {
                sessionId,
                domainId: toolContext.domainId,
                owner: toolContext.owner,
                baseDocId,
                ...(base.title ? { baseName: base.title } : {}),
            };
            await ctx.parallel('tool/base-select', payload);
            return { sessionId, baseDocId, baseName: base.title || undefined };
        }
    }
    const unregister = registerAgentAddon({
        addonId: 'base',
        displayName: 'Ejunz Base',
        description: '选择一个 Ejunz Base 作为会话上下文，并使用 Base 工具处理其中的内容。',
        permissions: [
            { id: 'read', name: 'Read Base data', description: 'Read Base structure, cards, files, and records.' },
            { id: 'write', name: 'Change Base data', description: 'Create, update, or delete Base content and files.' },
        ],
        toolPrefixes: ['base_'],
        contextSources: ['ejunz-base-selector'],
        defaultEnabled: true,
    });
    ctx.effect(() => unregister);
    const session = { source: 'session' as const, bindBase: 'none' as const };
    ctx.Tool('base', 'base_context', BaseContextExecutor, ContextConfigSchema, { ...session, instructions }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('base', 'base_select', BaseSelectExecutor, SelectConfigSchema, { ...session, mutating: true }, PRIV.USER_PRIV_USER_PROFILE);
}

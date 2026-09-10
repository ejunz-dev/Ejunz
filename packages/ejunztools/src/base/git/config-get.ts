import type { ToolContext, ToolArgs } from '../../types';

function getGitHandlers(): typeof import('ejun/src/handler/base') {
    return require('ejun/src/handler/base');
}

export async function execute(ctx: ToolContext, _args: ToolArgs): Promise<unknown> {
    return getGitHandlers().baseGitConfigGet({ domainId: ctx.domainId, baseDocId: ctx.baseDocId });
}

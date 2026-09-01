import type { ToolContext, ToolArgs } from '../../types';

function getGitHandlers(): typeof import('../../../handler/base') {
    return require('../../../handler/base');
}

export async function execute(ctx: ToolContext, _args: ToolArgs): Promise<unknown> {
    return getGitHandlers().baseGitConfigGet({ domainId: ctx.domainId, baseDocId: ctx.baseDocId });
}

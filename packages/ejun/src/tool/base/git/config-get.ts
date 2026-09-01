import type { McpToolContext, ToolArgs } from '../../types';

function getGitHandlers(): typeof import('../../../handler/base') {
    return require('../../../handler/base');
}

export async function execute(ctx: McpToolContext, _args: ToolArgs): Promise<unknown> {
    return getGitHandlers().mcpBaseGitConfigGet({ domainId: ctx.domainId, baseDocId: ctx.baseDocId });
}

import { toMcpGitInput } from '../shared';
import type { McpToolContext, ToolArgs } from '../../types';

function getGitHandlers(): typeof import('../../../handler/base') {
    return require('../../../handler/base');
}

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    return getGitHandlers().mcpBaseGitPush(toMcpGitInput(ctx, args));
}

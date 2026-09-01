import { toMcpGitInput } from '../shared';
import type { McpToolContext, ToolArgs } from '../../types';

function getGitHandlers(): typeof import('../../../handler/base') {
    return require('../../../handler/base');
}

export async function execute(ctx: McpToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.githubRepo;
    const githubRepo = raw == null ? null : String(raw).trim();
    return getGitHandlers().mcpBaseGitConfigSet({ ...toMcpGitInput(ctx, args), githubRepo: githubRepo || null });
}

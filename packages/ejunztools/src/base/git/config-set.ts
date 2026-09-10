import { toGitInput } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

function getGitHandlers(): typeof import('ejun/src/handler/base') {
    return require('ejun/src/handler/base');
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.githubRepo;
    const githubRepo = raw == null ? null : String(raw).trim();
    return getGitHandlers().baseGitConfigSet({ ...toGitInput(ctx, args), githubRepo: githubRepo || null });
}

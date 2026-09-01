import { toGitInput } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

function getGitHandlers(): typeof import('../../../handler/base') {
    return require('../../../handler/base');
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    const raw = args.githubRepo;
    const githubRepo = raw == null ? null : String(raw).trim();
    return getGitHandlers().baseGitConfigSet({ ...toGitInput(ctx, args), githubRepo: githubRepo || null });
}

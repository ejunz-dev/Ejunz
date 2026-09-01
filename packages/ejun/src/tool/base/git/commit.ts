import { toGitInput } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

function getGitHandlers(): typeof import('../../../handler/base') {
    return require('../../../handler/base');
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    return getGitHandlers().baseGitCommit(toGitInput(ctx, args));
}

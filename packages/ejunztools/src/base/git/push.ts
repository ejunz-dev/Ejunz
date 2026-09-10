import { toGitInput } from '../shared';
import type { ToolContext, ToolArgs } from '../../types';

function getGitHandlers(): typeof import('ejun/src/handler/base') {
    return require('ejun/src/handler/base');
}

export async function execute(ctx: ToolContext, args: ToolArgs): Promise<unknown> {
    return getGitHandlers().baseGitPush(toGitInput(ctx, args));
}

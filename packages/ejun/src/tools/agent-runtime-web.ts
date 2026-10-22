import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import { delegateAgentRuntimeTool } from '../lib/agent-runtime-tool';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/server';

export const inject = ['server'];

const WebFetchDescription = 'Fetch the content of a specific HTTP(S) URL and return it decoded to text.';
const WebFetchInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'The HTTP(S) URL to fetch.'
    }
  },
  required: [
    'url'
  ]
};

class WebFetchExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('web_fetch');
    }
}

export function apply(ctx: Context): void {
    ctx.Tool('agent-runtime', 'web_fetch', WebFetchExecutor, {
        source: 'session',
        bindBase: 'none',
        description: WebFetchDescription,
        inputSchema: WebFetchInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
}

import type { Context } from 'ejun/src/context';
import type {} from '../service/server';
import { PRIV } from 'ejun/src/model/builtin';
import { ADDON_ID, SESSION_TOOL, runtimeToolExecutor } from './agent-runtime';

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

export function apply(ctx: Context): void {
    ctx.Tool(ADDON_ID, 'web_fetch', runtimeToolExecutor('web_fetch'), {
        ...SESSION_TOOL,
        description: WebFetchDescription,
        inputSchema: WebFetchInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
}

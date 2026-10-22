import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import Schema from 'schemastery';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/server';

export const inject = ['server'];

const WebFetchSchema = Schema.object({
    url: Schema.string().required().description('The HTTP(S) URL to fetch.'),
}).description('Fetch the content of a specific HTTP(S) URL and return it decoded to text.');

class WebFetchExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return { type: 'ejunz/runtime-tool-call', toolName: 'web_fetch' };
    }
}

export function apply(ctx: Context): void {
    ctx.Tool('agent-runtime', 'web_fetch', WebFetchExecutor, WebFetchSchema, PRIV.USER_PRIV_USER_PROFILE);
}

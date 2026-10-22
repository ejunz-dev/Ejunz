import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import Schema from 'schemastery';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import { searchExa } from '../lib/exa-search';
import type { WebSearchResult } from '../lib/exa-search';
import { registerAgentAddon } from '../service/addons';
import type {} from '../service/server';

export const inject = ['server'];

export const SearchSchema = Schema.object({
    query: Schema.string().required().description('Search query for current information from the public web.'),
}).description('Search the public web for current information. Returns source URLs and snippets; cite relevant URLs in the answer.');

class WebSearchExecutor extends Executor<ToolContext, ToolArgs> {
    async execute(): Promise<WebSearchResult> {
        const query = typeof this.args.query === 'string' ? this.args.query : '';
        return searchExa(query, process.env.EXA_API_KEY ?? '');
    }
}

export function apply(ctx: Context): void {
    const unregisterAddon = registerAgentAddon({
        addonId: 'web',
        displayName: 'Web Search',
        description: 'Search the public web for current information.',
        toolPrefixes: ['web_'],
        defaultEnabled: true,
    });
    ctx.effect(() => unregisterAddon);
    ctx.Tool('web', 'web_search', WebSearchExecutor, SearchSchema, {
        source: 'session',
        bindBase: 'none',
    }, PRIV.USER_PRIV_USER_PROFILE);
}

import type { ToolModule } from './types';

/**
 * load_base_instructions is executed in core (ejun model/agent callTool), not here.
 * This module only provides the catalog entry for market and getAssignedTools.
 */
export const load_base_instructions: ToolModule = {
    catalog: {
        id: 'load_base_instructions',
        name: 'load_base_instructions',
        description:
            'Load base (knowledge base): by level returns outline only (node names and card titles with links, no card body); by urls returns full content for those cards. When replying to the user, always present links as Markdown hyperlinks, e.g. [标题](url), not as plain URL. Parameters: level (optional) - 1=overview, 2+=depth; urls (optional) - card/node URLs to load content.',
        inputSchema: {
            type: 'object',
            properties: {
                level: {
                    type: 'number',
                    description: 'Outline depth (1=overview, 2+=deeper). Returns only node and card titles with links; no card body. Ignored when urls is provided.',
                },
                urls: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Card/node URLs to load full content (e.g. .../base/branch/main?cardId=xxx or ?nodeId=xxx). Use after outline when user needs detail.',
                },
            },
        },
    },
    async execute() {
        throw new Error('load_base_instructions is handled by the agent runtime; it should not be executed from ejunztools.');
    },
};

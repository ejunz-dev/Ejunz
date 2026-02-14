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
            'Load base (knowledge base) instructions. Either by level (overview/depth/full) or by multiple card/node URLs (e.g. http://localhost:8000/d/Bazi/base/branch/main?cardId=xxx). Parameters: level (optional) - 1=overview, 2+=depth, omit for full; urls (optional) - array of card/node URLs to load those cards only.',
        inputSchema: {
            type: 'object',
            properties: {
                level: {
                    type: 'number',
                    description: 'Maximum level to load (1=overview, 2+=depth, omit for full content). Ignored when urls is provided.',
                },
                urls: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Card/node URLs to load (e.g. with cardId in query). When provided, only these cards are loaded.',
                },
            },
        },
    },
    async execute() {
        throw new Error('load_base_instructions is handled by the agent runtime; it should not be executed from ejunztools.');
    },
};

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
            'Load base (knowledge base) in two steps. 1) By level: full node structure only. 2) By urls (one node URL per call): node course URL + cards with real lesson links. Never invent card URLs: use only returned links; cardId in URL must be the 24-char hex ID, never the card title. Parameters: level (optional); urls (optional) - single node or card URL.',
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
                    description: 'Pass only one URL per call (one node or one card, e.g. .../base/branch/main?nodeId=xxx or ?cardId=xxx). Call the tool again to open the next.',
                },
            },
        },
    },
    async execute() {
        throw new Error('load_base_instructions is handled by the agent runtime; it should not be executed from ejunztools.');
    },
};

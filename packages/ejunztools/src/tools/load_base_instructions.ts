import type { ToolModule } from './types';

/**
 * load_base_instructions is executed in core (ejun model/agent callTool), not here.
 * This module only provides the catalog entry for market and getAssignedTools.
 */
export const load_base_instructions: ToolModule = {
    catalog: {
        id: 'load_base_instructions',
        name: 'load_base_instructions',
        description: 'Load base (knowledge base) instructions progressively. Use when you need domain base content. Parameters: level (optional, number) - 1 for overview, 2+ for depth, omit for full content.',
        inputSchema: {
            type: 'object',
            properties: {
                level: {
                    type: 'number',
                    description: 'Maximum level to load (1=overview, 2+=depth, omit for full content).',
                },
            },
        },
    },
    async execute() {
        throw new Error('load_base_instructions is handled by the agent runtime; it should not be executed from ejunztools.');
    },
};

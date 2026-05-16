import type { ToolModule } from './types';

/**
 * load_base is executed in core (ejun model/agent callTool), not here.
 * This module only provides the catalog entry for market and getAssignedTools.
 */
export const load_base: ToolModule = {
    catalog: {
        id: 'load_base',
        name: 'load_base',
        description:
            'Load base (knowledge base) in two steps. Filtering matches the base/data outline UI: optional filterNode, filterCard, filterProblem (also filter_node / filter_card / filter_problem). 1) By level: node structure only (after filters). 2) By urls (one URL per call): node + filtered card list or one card body. '
            + 'Use only links exactly as returned (same path/query/host); never invent card URLs; cardId must be the 24-char hex ID. '
            + 'When you quote links in chat, copy them character-for-character from this tool\'s result—do not prepend a random https:// host or swap in the chat app domain. '
            + 'Parameters: level (optional); urls (optional); filter fields (optional).',
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
                    description:
                        'One URL per call, must be the outline link from load_base: /d/{domainId}/base/{baseDocId}/outline/branch/{branch}?nodeId=... or ?cardId=... .',
                },
                filterNode: {
                    type: 'string',
                    description: 'Substring filter on node titles (same as base outline explorer).',
                },
                filter_node: {
                    type: 'string',
                    description: 'Alias of filterNode.',
                },
                filterCard: {
                    type: 'string',
                    description: 'Substring filter on card titles (same as base outline explorer).',
                },
                filter_card: {
                    type: 'string',
                    description: 'Alias of filterCard.',
                },
                filterProblem: {
                    type: 'string',
                    description: 'Substring filter on problem content in cards (same as base outline explorer).',
                },
                filter_problem: {
                    type: 'string',
                    description: 'Alias of filterProblem.',
                },
            },
        },
    },
    async execute() {
        throw new Error('load_base is handled by the agent runtime; it should not be executed from ejunztools.');
    },
};

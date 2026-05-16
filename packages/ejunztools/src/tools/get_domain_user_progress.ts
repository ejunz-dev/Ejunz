import type { ToolModule } from './types';

/**
 * Executed in ejun core (McpClient.callTool). Catalog only here for domain tool market + skills.
 */
export const get_domain_user_progress: ToolModule = {
    catalog: {
        id: 'get_domain_user_progress',
        name: 'get_domain_user_progress',
        description:
            'Returns the current user’s daily learning and develop progress in this domain (UTC date). '
            + 'Learn: daily card goal vs today’s consumption (nodes/cards/problems), active learn days. '
            + 'Develop: pool rows with per-base daily goals vs today’s saves, check-in streak, whether a develop session is in progress/paused, '
            + 'pending queue size, optional resumable develop session id. No parameters — the server uses the chat user.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    async execute() {
        throw new Error('get_domain_user_progress is handled by the agent runtime; it should not be executed from ejunztools.');
    },
};

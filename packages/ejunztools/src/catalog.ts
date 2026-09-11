export interface ToolDef {
    name: string;
    expose: string;
    description: string;
    inputSchema: Record<string, any>;
}

export interface SessionToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

export interface ScheduleToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

export const BUILTIN_TOOLS_CATALOG: ToolDef[] = [
    {
        name: 'base_create',
        expose: 'base_create',
        description: 'Create a new Ejunz Base in the current domain. The new Base is returned by id and is not automatically selected for this session.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Base title (required).' },
                content: { type: 'string', description: 'Base description or markdown content (optional).' },
                slug: { type: 'string', description: 'Optional unique lowercase URL slug.' },
                tag: { type: 'array', items: { type: 'string' }, description: 'Optional Base tags.' },
            },
            required: ['title'],
            additionalProperties: false,
        },
    },
    {
        name: 'base_list',
        expose: 'base_list',
        description: 'List all Ejunz Bases in the current domain.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'base_search',
        expose: 'base_search',
        description: 'Search Ejunz Bases in the current domain by title, content, slug, or tags.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search text.' },
                limit: { type: 'number', description: 'Maximum result count, up to 50.' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'base_get',
        expose: 'base_get',
        description: 'Read an Ejunz Base by baseId, including metadata, content, nodes, edges, and a tree-shaped outline of node/card ids and titles.',
        inputSchema: {
            type: 'object',
            properties: { baseId: { type: 'integer', description: 'Existing Base id.' } },
            required: ['baseId'],
            additionalProperties: false,
        },
    },
    {
        name: 'base_update',
        expose: 'base_update',
        description: 'Update an Ejunz Base by baseId: title, content, slug, or tags.',
        inputSchema: {
            type: 'object',
            properties: {
                baseId: { type: 'integer', description: 'Existing Base id.' },
                title: { type: 'string', description: 'New Base title.' },
                content: { type: 'string', description: 'New Base description or markdown content.' },
                slug: { type: 'string', description: 'New unique lowercase URL slug; empty clears it.' },
                tag: { type: 'array', items: { type: 'string' }, description: 'Replacement Base tags.' },
            },
            required: ['baseId'],
            additionalProperties: false,
        },
    },
    {
        name: 'base_delete',
        expose: 'base_delete',
        description: 'Delete an Ejunz Base by baseId.',
        inputSchema: {
            type: 'object',
            properties: { baseId: { type: 'integer', description: 'Existing Base id.' } },
            required: ['baseId'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_create',
        expose: 'base_node_create',
        description: 'Create a new node (section/topic). '
            + 'Pass parentId to nest it under an existing node; omit parentId to create it under the bound base root node.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Node title/text.' },
                parentId: { type: 'string', description: 'Existing parent node id (optional; omit to place under the base root node).' },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_update',
        expose: 'base_node_update',
        description: 'Rename and/or move a node. Pass parentId to move it under an existing node; omit parentId to keep its current parent.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Existing node id.' },
                text: { type: 'string', description: 'New node title/text.' },
                parentId: { type: 'string', description: 'Existing parent node id (optional; omit to keep the current parent).' },
            },
            required: ['nodeId', 'text'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_get',
        expose: 'base_node_get',
        description: 'Read a node and its direct child nodes plus cards attached to it. Returns ids and titles for child nodes, and ids, titles, and content for cards without recursively expanding nested nodes.',
        inputSchema: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Existing node id.' } },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_delete',
        expose: 'base_node_delete',
        description: 'Delete a node by id (and its cards). Use an existing nodeId.',
        inputSchema: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Existing node id.' } },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_create',
        expose: 'base_card_create',
        description: 'Create a new card (content block) under a node. Use an existing nodeId.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Owning existing node id.' },
                title: { type: 'string', description: 'Card title.' },
                content: { type: 'string', description: 'Markdown body (optional).' },
            },
            required: ['nodeId', 'title'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_update',
        expose: 'base_card_update',
        description: 'Update a card\'s title and/or markdown content by cardId. Use cardId.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex).' },
                title: { type: 'string', description: 'New title (optional).' },
                content: { type: 'string', description: 'New markdown body (optional).' },
            },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_get',
        expose: 'base_card_get',
        description: 'Read a card by cardId and return its title and markdown content.',
        inputSchema: {
            type: 'object',
            properties: { cardId: { type: 'string', description: 'Card docId (hex).' } },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_delete',
        expose: 'base_card_delete',
        description: 'Delete a card by cardId. Use cardId.',
        inputSchema: {
            type: 'object',
            properties: { cardId: { type: 'string', description: 'Card docId (hex).' } },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'semantic_search',
        expose: 'base_semantic_search',
        description: 'Semantic (vector) search across node titles and card content. '
            + 'Searches by meaning rather than keyword — use this to find content conceptually related to your query. '
            + 'Results include a similarity `score` (0–1) and the matched text snippet. '
            + 'Use `kind` to restrict to "node" (headings only) or "card" (content only); omit for both.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural language query — describe what you are looking for (required).' },
                limit: { type: 'number', description: 'Max results to return. Default 15, max 50.' },
                kind: { type: 'string', description: 'Restrict to "node" (headings) or "card" (content). Omit to search both.' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_list',
        expose: 'base_problem_list',
        description: 'Problem = a practice exercise attached to a card (quiz, flip card, matching table, etc.). '
            + 'Lists every problem on one card: pid, type, title, and a short content preview. Use cardId.',
        inputSchema: {
            type: 'object',
            properties: { cardId: { type: 'string', description: 'Card docId (hex).' } },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_get',
        expose: 'base_problem_get',
        description: 'Read one practice problem in full by cardId + pid. Use pid from problem_list.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex).' },
                pid: { type: 'string', description: 'Problem id from problem_list.' },
            },
            required: ['cardId', 'pid'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_create',
        expose: 'base_problem_create',
        description: 'Add a practice problem to a card. Pass `problem` as a JSON object. '
            + 'Common fields: title (short sidebar label), stem, analysis, tags. '
            + 'type: single (default) | multi | true_false | flip | fill_blank | matching | super_flip | chain | ai_eval. '
            + 'single/multi: options[] + answer (index or index array). true_false: stem + answer 0|1. '
            + 'flip: faceA, faceB, optional hint. fill_blank: stem with ___ + answers[]. '
            + 'matching: columns[][] (≥2 cols, ≥2 rows) or legacy left/right. '
            + 'super_flip: headers[] + columns[][] (allows 1×1). chain: rows[] of {rowType:"flip"|"text", content:string}. ai_eval: stem + points[].',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex).' },
                problem: {
                    type: 'object',
                    description: 'Problem payload. `type` defaults to single choice when omitted.',
                },
            },
            required: ['cardId', 'problem'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_update',
        expose: 'base_problem_update',
        description: 'Update an existing problem by pid. Pass `problem` with fields to change (merged with the stored row, then normalized). '
            + 'Include `type` only when changing the problem kind.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex).' },
                pid: { type: 'string', description: 'Problem id from problem_list.' },
                problem: { type: 'object', description: 'Fields to update.' },
            },
            required: ['cardId', 'pid', 'problem'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_delete',
        expose: 'base_problem_delete',
        description: 'Delete a practice problem from a card by pid. Use pid from problem_list.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex).' },
                pid: { type: 'string', description: 'Problem id from problem_list.' },
            },
            required: ['cardId', 'pid'],
            additionalProperties: false,
        },
    },
    {
        name: 'git_status',
        expose: 'base_git_status',
        description: 'Get git sync status for this base: local/remote ref, ahead/behind, uncommitted changes, and file change lists. '
            + 'Requires a local git repo (created on first commit/push).',
        inputSchema: {
            type: 'object',
            properties: {
                githubToken: { type: 'string', description: 'GitHub PAT override for remote fetch (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_commit',
        expose: 'base_git_commit',
        description: 'Export the current base to the local git working tree and commit (does not push). '
            + 'Use after editing nodes/cards/problems when you want a local snapshot.',
        inputSchema: {
            type: 'object',
            properties: {
                commitMessage: { type: 'string', description: 'Commit message body (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_push',
        expose: 'base_git_push',
        description: 'Commit local changes and push to the configured GitHub remote (`git_config_get`). '
            + 'Requires githubRepo on the base and a GitHub token (user profile or system setting).',
        inputSchema: {
            type: 'object',
            properties: {
                commitMessage: { type: 'string', description: 'Commit message (optional).' },
                githubToken: { type: 'string', description: 'GitHub PAT override (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_pull',
        expose: 'base_git_pull',
        description: 'Pull from GitHub and import the remote content into this base. '
            + 'Destructive: replaces nodes/cards from the git tree. Requires githubRepo and token.',
        inputSchema: {
            type: 'object',
            properties: {
                githubToken: { type: 'string', description: 'GitHub PAT override (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_config_get',
        expose: 'base_git_config_get',
        description: 'Read the GitHub repository URL/path configured for this base (used by git_push / git_pull).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'git_config_set',
        expose: 'base_git_config_set',
        description: 'Set or clear the GitHub repository for this base. Pass `githubRepo` as owner/repo, full https URL, or null/empty to clear.',
        inputSchema: {
            type: 'object',
            properties: {
                githubRepo: {
                    type: 'string',
                    description: 'e.g. org/repo, https://github.com/org/repo, or empty string to clear.',
                },
            },
            required: ['githubRepo'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_file_list',
        expose: 'base_node_file_list',
        description: 'List file-cards under a node. File-cards are cards with cardType="file" that represent uploaded files. Returns card id, title, fileName, fileType, fileSize for each.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Node id to list file-cards from.' },
            },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_file_get',
        expose: 'base_node_file_get',
        description: 'Get file-card metadata by cardId. Returns title, fileName, fileType, fileSize, nodeId, and download URL.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'File-card docId (hex).' },
            },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_file_delete',
        expose: 'base_node_file_delete',
        description: 'Delete a file-card and its underlying file. Both the card record and the physical file in storage are removed.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'File-card docId (hex).' },
            },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_file_create',
        expose: 'base_node_file_create',
        description: 'Upload a file from a URL and create a file-card under a node. Downloads the file from the given URL, stores it on the node, and creates a file-card (cardType="file") referencing it.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Existing node id to attach the file-card to.' },
                fileName: { type: 'string', description: 'Filename (e.g. report.pdf, photo.png). Used to infer file type from extension.' },
                fileUrl: { type: 'string', description: 'Public URL to download the file from.' },
                title: { type: 'string', description: 'Optional card title (defaults to fileName).' },
            },
            required: ['nodeId', 'fileName', 'fileUrl'],
            additionalProperties: false,
        },
    },
];

export const SESSION_TOOLS_CATALOG: SessionToolDef[] = [
    {
        name: 'base_context',
        description: 'Get the current Ejunz Base domain context and scope.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'base_select',
        description: 'Switch the current Agent session to an Ejunz Base by baseId.',
        inputSchema: {
            type: 'object',
            properties: { baseId: { type: 'integer', description: 'Existing Base id.' } },
            required: ['baseId'],
            additionalProperties: false,
        },
    },
];

export const SCHEDULE_TOOLS_CATALOG: ScheduleToolDef[] = [
    {
        name: 'schedule_create',
        description: 'Create an Agent schedule that runs one command at a time you set. A "once" schedule requires executeAt; an "interval" schedule repeats every intervalCount intervalUnit, optionally bounded by maxRuns or endAt. The schedule belongs to the calling user and runs the command as the Agent named by agentId.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Id of the Agent that runs the command (required).' },
                command: { type: 'string', description: 'The message the Agent runs on each trigger (required).' },
                scheduleType: { type: 'string', enum: ['once', 'interval'], description: '"once" runs at executeAt; "interval" repeats.' },
                title: { type: 'string', description: 'Optional schedule title (defaults to the command text).' },
                executeAt: { type: 'string', description: 'When a "once" schedule runs, as an ISO-8601 timestamp.' },
                intervalCount: { type: 'integer', description: 'How many intervalUnit units apart an "interval" schedule runs (default 1).' },
                intervalUnit: { type: 'string', enum: ['minute', 'hour', 'day', 'week', 'month'], description: 'Unit of an "interval" schedule (default "day").' },
                maxRuns: { type: 'integer', description: 'Optional run limit of an "interval" schedule.' },
                endAt: { type: 'string', description: 'Optional ISO-8601 timestamp after which an "interval" schedule stops.' },
                timezone: { type: 'string', description: 'IANA time zone the times are read in (default "UTC").' },
                enabled: { type: 'boolean', description: 'Whether the schedule starts enabled (default true).' },
                description: { type: 'string', description: 'Optional note kept with the schedule.' },
            },
            required: ['agentId', 'command', 'scheduleType'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_get',
        description: 'Read one Agent schedule the calling user owns, including its next run time and last run status.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string', description: 'Existing schedule id (required).' },
            },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_list',
        description: 'List the Agent schedules the calling user owns, most recently updated first, at most 100 per page.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Only schedules that run as this Agent.' },
                enabled: { type: 'boolean', description: 'Only enabled, or only paused, schedules.' },
                includeEnded: { type: 'boolean', description: 'Include schedules that already ended (default false).' },
                includeDeleted: { type: 'boolean', description: 'Include deleted schedules (default false).' },
                page: { type: 'integer', description: 'Page number, starting at 1 (default 1).' },
                limit: { type: 'integer', description: 'Page size, at most 100 (default 20).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_update',
        description: 'Change one Agent schedule the calling user owns. Only the arguments you pass change; a deleted or already ended schedule cannot be updated.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string', description: 'Existing schedule id (required).' },
                agentId: { type: 'string', description: 'Id of the Agent that runs the command.' },
                command: { type: 'string', description: 'The message the Agent runs on each trigger.' },
                title: { type: 'string', description: 'Schedule title.' },
                scheduleType: { type: 'string', enum: ['once', 'interval'], description: 'Schedule kind to switch to.' },
                executeAt: { type: 'string', description: 'When a "once" schedule runs, as an ISO-8601 timestamp.' },
                intervalCount: { type: 'integer', description: 'How many intervalUnit units apart an "interval" schedule runs.' },
                intervalUnit: { type: 'string', enum: ['minute', 'hour', 'day', 'week', 'month'], description: 'Unit of an "interval" schedule.' },
                maxRuns: { type: 'integer', description: 'Run limit of an "interval" schedule, at least 1.' },
                endAt: { type: 'string', description: 'ISO-8601 timestamp after which an "interval" schedule stops; pass an empty string to clear it.' },
                timezone: { type: 'string', description: 'IANA time zone the times are read in.' },
                enabled: { type: 'boolean', description: 'Whether the schedule runs.' },
                description: { type: 'string', description: 'Note kept with the schedule.' },
            },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_delete',
        description: 'Delete one Agent schedule the calling user owns. The schedule stops running and disappears from later listings; the runs it already recorded are kept.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string', description: 'Existing schedule id (required).' },
            },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_pause',
        description: 'Pause one Agent schedule the calling user owns so that it stops running until it is resumed.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string', description: 'Existing schedule id (required).' },
            },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_resume',
        description: 'Resume a paused Agent schedule the calling user owns, from its next future run time.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string', description: 'Existing schedule id (required).' },
            },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_history',
        description: 'List the recorded runs of the Agent schedules the calling user owns, newest first, at most 100 per page. Each run reports its status and links to the Agent session it produced.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string', description: 'Only runs of this schedule.' },
                agentId: { type: 'string', description: 'Only runs of schedules that run as this Agent.' },
                status: { type: 'string', enum: ['queued', 'running', 'success', 'error', 'skipped'], description: 'Only runs in this state.' },
                page: { type: 'integer', description: 'Page number, starting at 1 (default 1).' },
                limit: { type: 'integer', description: 'Page size, at most 100 (default 20).' },
            },
            additionalProperties: false,
        },
    },
];

const BUILTIN_MUTATING_TOOLS = new Set([
    'base_create', 'base_update', 'base_delete',
    'node_create', 'node_update', 'node_delete',
    'card_create', 'card_update', 'card_delete',
    'node_file_create', 'node_file_delete',
    'problem_create', 'problem_update', 'problem_delete',
    'git_pull', 'git_config_set',
]);

const SCHEDULE_MUTATING_TOOLS = new Set([
    'schedule_create', 'schedule_update', 'schedule_delete',
    'schedule_pause', 'schedule_resume',
]);

export function isBuiltinTool(name: string): boolean {
    return BUILTIN_TOOLS_CATALOG.some((t) => t.name === name);
}

export function isBuiltinMutatingTool(name: string): boolean {
    return BUILTIN_MUTATING_TOOLS.has(name);
}

export function isScheduleMutatingTool(name: string): boolean {
    return SCHEDULE_MUTATING_TOOLS.has(name);
}

export function defaultToolDescriptions(): { name: string; description: string }[] {
    return BUILTIN_TOOLS_CATALOG.map((t) => ({ name: t.name, description: t.description }));
}

export function resolveTools(overrides?: { name: string; description: string }[]): ToolDef[] {
    if (!overrides || !overrides.length) return BUILTIN_TOOLS_CATALOG;
    const map = new Map(overrides.map((o) => [o.name, o.description]));
    return BUILTIN_TOOLS_CATALOG.map((t) => ({
        ...t,
        description: map.has(t.name) && map.get(t.name) ? (map.get(t.name) as string) : t.description,
    }));
}

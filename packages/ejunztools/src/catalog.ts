/**
 * The built-in Base tool catalog: the model-facing definitions, the set of
 * mutating operations, and the name lookups derived from them.
 *
 * Pure data with no imports and no side effects, so a consumer outside the Ejunz
 * application reads one definition list instead of keeping a copy: the Ejunz Agent
 * bridge (`plugins/agent/base-tools.ts`) maps these operations to model-visible
 * names, and the Agent package that registers tools in the Agent process
 * (`plugins/agent/ejunz-agent/packages/ejunz/tool-ejunz-base`) registers the bridge
 * catalog it receives. This module is their single source.
 * @module
 */

export interface ToolDef {
    /** Dispatcher operation name: what `executeBuiltinTool` accepts. */
    name: string;
    /** Model-visible tool name: what the registry publishes and the model calls. */
    expose: string;
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

const BUILTIN_MUTATING_TOOLS = new Set([
    'base_create', 'base_update', 'base_delete',
    'node_create', 'node_update', 'node_delete',
    'card_create', 'card_update', 'card_delete',
    'node_file_create', 'node_file_delete',
    'problem_create', 'problem_update', 'problem_delete',
    'git_pull', 'git_config_set',
]);

/** Whether `name` is an operation this catalog defines. */
export function isBuiltinTool(name: string): boolean {
    return BUILTIN_TOOLS_CATALOG.some((t) => t.name === name);
}

/** Whether `name` changes Base content, so its callers broadcast `base/update`. */
export function isBuiltinMutatingTool(name: string): boolean {
    return BUILTIN_MUTATING_TOOLS.has(name);
}

/** The catalog as `{ name, description }` pairs, for consumers that override descriptions. */
export function defaultToolDescriptions(): { name: string; description: string }[] {
    return BUILTIN_TOOLS_CATALOG.map((t) => ({ name: t.name, description: t.description }));
}

/** The catalog in declaration order, with per-name description overrides applied. */
export function resolveTools(overrides?: { name: string; description: string }[]): ToolDef[] {
    if (!overrides || !overrides.length) return BUILTIN_TOOLS_CATALOG;
    const map = new Map(overrides.map((o) => [o.name, o.description]));
    return BUILTIN_TOOLS_CATALOG.map((t) => ({
        ...t,
        description: map.has(t.name) && map.get(t.name) ? (map.get(t.name) as string) : t.description,
    }));
}

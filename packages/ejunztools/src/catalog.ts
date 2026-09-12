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

export const MAX_NODES_PER_CALL = 500;
export const MAX_FILE_CREATES_PER_CALL = 50;
export const MAX_FILE_DOWNLOADS_IN_FLIGHT = 5;
export const MAX_CARDS_PER_CALL = 500;
export const MAX_PROBLEMS_PER_CALL = 500;

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
    {
        name: 'embedding_status',
        expose: 'base_embedding_status',
        description: 'Report the vector (embedding) index of a Base: the queue state, how many vectors are stored and which model stamped them, '
            + 'and the gap against live nodes and cards (missing, stale, detached, orphaned). While a rebuild runs, `state.progress` gives its live phase '
            + 'and percentage. Use it before and after base_embedding_reindex, or to find content that semantic search cannot see. Defaults to the '
            + 'session\'s Base; pass `baseId` for another Base in the domain.',
        inputSchema: {
            type: 'object',
            properties: {
                baseId: { type: 'integer', description: 'Base to inspect (optional; defaults to the session\'s Base).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'embedding_reindex',
        expose: 'base_embedding_reindex',
        description: 'Queue a vector (embedding) rebuild for a Base and return as soon as it is queued; the rebuild then runs for as long as it needs, '
            + 'with no deadline, and base_embedding_status reports its live progress. `mode: "full_rebuild"` (the default) re-embeds every node title and '
            + 'card chunk and drops vectors whose content is gone; `mode: "incremental"` re-embeds only the given `nodeIds` / `cardIds`. Defaults to the '
            + 'session\'s Base; pass `baseId` for another Base in the domain.',
        inputSchema: {
            type: 'object',
            properties: {
                baseId: { type: 'integer', description: 'Base to re-index (optional; defaults to the session\'s Base).' },
                mode: { type: 'string', enum: ['full_rebuild', 'incremental'], description: 'Rebuild scope (default "full_rebuild").' },
                nodeIds: { type: 'array', items: { type: 'string' }, description: 'Node ids to re-embed; required for mode "incremental" unless cardIds are given.' },
                cardIds: { type: 'array', items: { type: 'string' }, description: 'Card docIds to re-embed; required for mode "incremental" unless nodeIds are given.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'node_create_many',
        expose: 'base_node_create_many',
        description: 'Create several nodes at once, in one read and one write of the Base. `nodes` is an array of '
            + '`{ text, ref?, parentId?, parentRef? }`. A `ref` names an entry so a later entry can use it as its `parentRef`, which builds a whole '
            + 'tree in one call; an entry with neither parent attaches to the call\'s `parentId`, or to the Base\'s root node. The Base is read once, '
            + 'every node and edge is built in memory, and one update writes them all, so the call is atomic: either every node arrives or nothing '
            + 'changes. Refused for a missing text, a duplicate or dangling reference, or too many entries, and it writes nothing in that case. '
            + 'Use it instead of calling `base_node_create` once per node. One call creates at most ' + MAX_NODES_PER_CALL + ' nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                parentId: { type: 'string', description: 'Node that every entry without a parent attaches to (optional; defaults to the Base\'s root node). The node must already exist.' },
                nodes: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_NODES_PER_CALL,
                    description: 'Nodes to create, in order: a parent must come before the entries that name it.',
                    items: {
                        type: 'object',
                        properties: {
                            text: { type: 'string', description: 'Node text (required).' },
                            ref: { type: 'string', description: 'Optional name for this entry, for a later entry\'s parentRef.' },
                            parentId: { type: 'string', description: 'Existing node of this Base to attach to (optional).' },
                            parentRef: { type: 'string', description: 'ref of an earlier entry to attach to (optional; keep one of parentId and parentRef).' },
                        },
                        required: ['text'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['nodes'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_create_many',
        expose: 'base_card_create_many',
        description: 'Create several cards at once. `cards` is an array of `{ nodeId, title, content?, tags?, problems? }`, where `problems` holds the '
            + 'payloads `base_problem_create` takes, stored with the card as it is created. The Base is read once and every card is checked before the '
            + 'first insert, so a refused call inserts nothing. Each card is its own document and therefore one insert that carries its own problems, so '
            + 'no card is ever half-created; a failure the database itself reports part way through is named in `refusedCards` and `ok` is false. Use it '
            + 'instead of calling `base_card_create` once per card. One call creates at most ' + MAX_CARDS_PER_CALL + ' cards.',
        inputSchema: {
            type: 'object',
            properties: {
                cards: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_CARDS_PER_CALL,
                    description: 'Cards to create, in order.',
                    items: {
                        type: 'object',
                        properties: {
                            nodeId: { type: 'string', description: 'Existing node to attach the card to (required).' },
                            title: { type: 'string', description: 'Card title (required).' },
                            content: { type: 'string', description: 'Card markdown body (optional).' },
                            tags: { type: 'array', items: { type: 'string' }, description: 'Optional card tags.' },
                            problems: {
                                type: 'array',
                                description: 'Practice problems stored on the card as it is created, each the same payload `base_problem_create` takes.',
                                items: { type: 'object' },
                            },
                        },
                        required: ['nodeId', 'title'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['cards'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_create_many',
        expose: 'base_problem_create_many',
        description: 'Add problems to cards, several at once. `entries` is an array of `{ cardId, problems }`, where `problems` holds the payloads '
            + '`base_problem_create` takes. All the problems of one card land in one write of that card, so many problems cost one read and one write '
            + 'instead of one of each per problem, and a card never holds a partial set of what an entry sent it. Every problem is validated and every '
            + 'card is read before the first write, so a refused call changes nothing; a card the database itself refuses is named in `refusedEntries` '
            + 'and `ok` is false. Use it instead of calling `base_problem_create` once per problem. One call adds at most ' + MAX_PROBLEMS_PER_CALL + ' problems.',
        inputSchema: {
            type: 'object',
            properties: {
                entries: {
                    type: 'array',
                    minItems: 1,
                    description: 'One entry per card, each naming every problem that card receives.',
                    items: {
                        type: 'object',
                        properties: {
                            cardId: { type: 'string', description: 'Existing card of this Base (required).' },
                            problems: {
                                type: 'array',
                                minItems: 1,
                                description: 'Problems to append to that card, each the payload `base_problem_create` takes.',
                                items: { type: 'object' },
                            },
                        },
                        required: ['cardId', 'problems'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['entries'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_get_many',
        expose: 'base_node_get_many',
        description: 'Read several nodes of one Base in a single call, each reported exactly as `base_node_get` reports one: its title, its child nodes '
            + 'and its cards. The Base document is read once and the cards of every named node come from one further read, so the call costs two reads '
            + 'however many nodes it names, instead of two reads per node. A read changes nothing, so a node this Base does not hold is listed in '
            + '`missingNodeIds` and `ok` is false. Use it instead of calling `base_node_get` once per node. One call reads at most ' + MAX_NODES_PER_CALL + ' nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_NODES_PER_CALL,
                    items: { type: 'string' },
                    description: 'Node ids to read, in order.',
                },
            },
            required: ['nodeIds'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_get_many',
        expose: 'base_card_get_many',
        description: 'Read several cards of one Base in a single call, each reported exactly as `base_card_get` reports one. The cards come from one '
            + 'read of the card collection, so the call costs one read however many cards it names, instead of one read per card. A read changes '
            + 'nothing, so a card this Base does not hold is listed in `missingCardIds` and `ok` is false. Use it instead of calling `base_card_get` '
            + 'once per card. One call reads at most ' + MAX_CARDS_PER_CALL + ' cards.',
        inputSchema: {
            type: 'object',
            properties: {
                cardIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_CARDS_PER_CALL,
                    items: { type: 'string' },
                    description: 'Card docIds to read, in order.',
                },
            },
            required: ['cardIds'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_get_many',
        expose: 'base_problem_get_many',
        description: 'Read several practice problems in a single call, each reported exactly as `base_problem_get` reports one. The cards holding them '
            + 'come from one read, so the call costs one read however many problems it names, instead of one read per problem. A read changes nothing, '
            + 'so a card or a problem this Base does not hold is listed in `missing` with its reason and `ok` is false. Use it instead of calling '
            + '`base_problem_get` once per problem.',
        inputSchema: {
            type: 'object',
            properties: {
                entries: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_PROBLEMS_PER_CALL,
                    description: 'One entry per problem to read.',
                    items: {
                        type: 'object',
                        properties: {
                            cardId: { type: 'string', description: 'Card holding the problem (required).' },
                            pid: { type: 'string', description: 'Problem id (required).' },
                        },
                        required: ['cardId', 'pid'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['entries'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_update_many',
        expose: 'base_node_update_many',
        description: 'Update several nodes of one Base in a single call: `entries` is an array of `{ nodeId, text?, parentId? }`, and an entry changes '
            + 'what it names. Node text and place in the tree live in the Base document, so one read and one write apply every entry, instead of one of '
            + 'each per node, and the call is atomic: either every entry lands or the document is unchanged. An entry the move rules refuse (an absent '
            + 'node or parent, a move under itself or under one of its descendants) refuses the whole call and writes nothing. Renaming the root node '
            + 'renames the Base, as `base_node_update` does. Use it instead of calling `base_node_update` once per node. One call updates at most '
            + MAX_NODES_PER_CALL + ' nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                entries: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_NODES_PER_CALL,
                    description: 'One entry per node, in the order the updates apply.',
                    items: {
                        type: 'object',
                        properties: {
                            nodeId: { type: 'string', description: 'Node to change (required).' },
                            text: { type: 'string', description: 'New node text (optional).' },
                            parentId: { type: 'string', description: 'Existing node to move this node under (optional).' },
                        },
                        required: ['nodeId'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['entries'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_update_many',
        expose: 'base_card_update_many',
        description: 'Update several cards of one Base in a single call: `entries` is an array of `{ cardId, title?, content? }`, and an entry must name '
            + 'at least one field. A card is its own document, so each card that changes is one write, and the call saves the reading and the checks: '
            + 'the cards are read once and an id that names no card of this Base refuses the whole call, so a refused call writes nothing. A failure the '
            + 'database itself reports is named in `refusedCards` and `ok` is false. Use it instead of calling `base_card_update` once per card. One '
            + 'call updates at most ' + MAX_CARDS_PER_CALL + ' cards.',
        inputSchema: {
            type: 'object',
            properties: {
                entries: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_CARDS_PER_CALL,
                    description: 'One entry per card.',
                    items: {
                        type: 'object',
                        properties: {
                            cardId: { type: 'string', description: 'Card to change (required).' },
                            title: { type: 'string', description: 'New card title (optional).' },
                            content: { type: 'string', description: 'New card markdown body (optional).' },
                        },
                        required: ['cardId'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['entries'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_update_many',
        expose: 'base_problem_update_many',
        description: 'Update several practice problems in a single call: `entries` is an array of `{ cardId, pid, problem }`, where `problem` holds the '
            + 'fields to change, as `base_problem_update` takes them. A card holds its problems, so every problem that changes on one card is written '
            + 'once: n problems over k cards cost one read and k writes instead of one of each per problem. Every payload is read and every named '
            + 'problem is checked before the first write, so a refused call changes nothing; a card the database itself refuses is named in '
            + '`refusedEntries`. Use it instead of calling `base_problem_update` once per problem. One call updates at most ' + MAX_PROBLEMS_PER_CALL + ' problems.',
        inputSchema: {
            type: 'object',
            properties: {
                entries: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_PROBLEMS_PER_CALL,
                    description: 'One entry per problem.',
                    items: {
                        type: 'object',
                        properties: {
                            cardId: { type: 'string', description: 'Card holding the problem (required).' },
                            pid: { type: 'string', description: 'Problem id (required).' },
                            problem: { type: 'object', description: 'Fields to change on that problem, merged into it (required).' },
                        },
                        required: ['cardId', 'pid', 'problem'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['entries'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_delete_many',
        expose: 'base_node_delete_many',
        description: 'Delete several nodes of one Base in a single call: `nodeIds` names the nodes, and each one takes its descendants with it exactly '
            + 'as `base_node_delete` does. The whole graph change is one read and one write of the Base document, so n subtrees cost one of each instead '
            + 'of one per node, and the node and edge removal is atomic. The cards on the removed nodes, and the files stored on those nodes and cards, '
            + 'follow their nodes one operation each. The root node cannot be removed: naming it refuses the whole call and writes nothing. An id this '
            + 'Base does not hold is listed in `missingNodeIds` and `ok` is false. Use it instead of calling `base_node_delete` once per node. One call '
            + 'removes at most ' + MAX_NODES_PER_CALL + ' nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_NODES_PER_CALL,
                    items: { type: 'string' },
                    description: 'Nodes to remove; a node already removed as a descendant of another is ignored.',
                },
            },
            required: ['nodeIds'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_delete_many',
        expose: 'base_card_delete_many',
        description: 'Delete several cards of one Base in a single call. A card is its own document, so every named card goes with one delete of the '
            + 'card collection and one delete of its status rows, instead of two statements per card. The cards are read once first, and an id that '
            + 'names no card of this Base refuses the whole call, so a refused call deletes nothing. It removes what `base_card_delete` removes and '
            + 'nothing else. Use it instead of calling `base_card_delete` once per card. One call removes at most ' + MAX_CARDS_PER_CALL + ' cards.',
        inputSchema: {
            type: 'object',
            properties: {
                cardIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_CARDS_PER_CALL,
                    items: { type: 'string' },
                    description: 'Cards to remove.',
                },
            },
            required: ['cardIds'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_delete_many',
        expose: 'base_problem_delete_many',
        description: 'Delete several practice problems in a single call: `entries` is an array of `{ cardId, pids }`. A card holds its problems, so every '
            + 'problem removed from one card is written once: n problems over k cards cost one read and k writes instead of one of each per problem. '
            + 'Every card is read and every named problem is found before the first write, so a refused call changes nothing; a card the database itself '
            + 'refuses is named in `refusedEntries`. Use it instead of calling `base_problem_delete` once per problem. One call removes at most '
            + MAX_PROBLEMS_PER_CALL + ' problems.',
        inputSchema: {
            type: 'object',
            properties: {
                entries: {
                    type: 'array',
                    minItems: 1,
                    description: 'One entry per card, naming every problem that card loses.',
                    items: {
                        type: 'object',
                        properties: {
                            cardId: { type: 'string', description: 'Card to change (required).' },
                            pids: {
                                type: 'array',
                                minItems: 1,
                                items: { type: 'string' },
                                description: 'Problem ids to remove from that card (required).',
                            },
                        },
                        required: ['cardId', 'pids'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['entries'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_file_create_many',
        expose: 'base_node_file_create_many',
        description: 'Store several files on nodes of one Base in a single call, each becoming a file-card, as `base_node_file_create` makes one. '
            + '`files` is an array of `{ nodeId, fileName, fileUrl, title? }`. The Base is read once to check every node and the whole list is validated '
            + 'before the first download, so a refused call stores nothing. The downloads run a few at a time, and every entry is reported on its own: a '
            + 'download or a card the server refuses is named in `refusedFiles` and `ok` is false, while the files that arrived stay. One call stores at '
            + 'most ' + MAX_FILE_CREATES_PER_CALL + ' files.',
        inputSchema: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_FILE_CREATES_PER_CALL,
                    description: 'Files to download and store, in order.',
                    items: {
                        type: 'object',
                        properties: {
                            nodeId: { type: 'string', description: 'Existing node to attach the file-card to (required).' },
                            fileName: { type: 'string', description: 'Filename (required); it also sets the stored path, so one file per node.' },
                            fileUrl: { type: 'string', description: 'Public URL to download the file from (required).' },
                            title: { type: 'string', description: 'Optional card title (defaults to fileName).' },
                        },
                        required: ['nodeId', 'fileName', 'fileUrl'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['files'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_file_list_many',
        expose: 'base_node_file_list_many',
        description: 'List the files of several nodes in a single call, each node reported as `base_node_file_list` reports it. The Base document is read '
            + 'once and the cards of every named node come from one further read, so the call costs two reads however many nodes it names. A read changes '
            + 'nothing, so a node this Base does not hold is listed in `missingNodeIds` and `ok` is false. One call lists at most ' + MAX_NODES_PER_CALL + ' nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_NODES_PER_CALL,
                    items: { type: 'string' },
                    description: 'Nodes whose files are wanted.',
                },
            },
            required: ['nodeIds'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_file_get_many',
        expose: 'base_node_file_get_many',
        description: 'Read several file-cards in a single call, each reported as `base_node_file_get` reports one: its name, type, size, node, content and '
            + 'the URL its file is served at. The cards come from one read, so the call costs one read however many it names. A read changes nothing, so a '
            + 'card this Base does not hold, or one that is not a file-card, is listed in `missing` with its reason and `ok` is false. One call reads at '
            + 'most ' + MAX_CARDS_PER_CALL + ' cards.',
        inputSchema: {
            type: 'object',
            properties: {
                cardIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_CARDS_PER_CALL,
                    items: { type: 'string' },
                    description: 'File-cards to read.',
                },
            },
            required: ['cardIds'],
            additionalProperties: false,
        },
    },
    {
        name: 'node_file_delete_many',
        expose: 'base_node_file_delete_many',
        description: 'Delete several file-cards of one Base in a single call, with the file each one holds. Each card is removed as '
            + '`base_node_file_delete` removes one: the stored body first, then the card. The cards are read once, and a card this Base does not hold, or '
            + 'one that is not a file-card, refuses the whole call before anything is removed. Use it instead of calling `base_node_file_delete` once per '
            + 'card. One call removes at most ' + MAX_CARDS_PER_CALL + ' cards.',
        inputSchema: {
            type: 'object',
            properties: {
                cardIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_CARDS_PER_CALL,
                    items: { type: 'string' },
                    description: 'File-cards to remove.',
                },
            },
            required: ['cardIds'],
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
    'node_create_many', 'card_create_many', 'problem_create_many',
    'node_update_many', 'card_update_many', 'problem_update_many',
    'node_delete_many', 'card_delete_many', 'problem_delete_many',
    'node_file_create_many', 'node_file_delete_many',
    'node_create', 'node_update', 'node_delete',
    'card_create', 'card_update', 'card_delete',
    'node_file_create', 'node_file_delete',
    'problem_create', 'problem_update', 'problem_delete',
    'embedding_reindex',
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

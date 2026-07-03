import { ObjectId } from 'mongodb';
import { SYSTEM_TOOLS_CATALOG, executeSystemTool as executeEjunzMarketMcpTool, executeSystemTool as executeEjunzToolsSystemTool } from '@ejunz/ejunztools';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import type { ToolDoc, CardDoc, BaseNode, BaseEdge, Problem, ProblemKind } from '../interface';
import EdgeModel from './edge';
import DomainMarketToolModel from './domain_market_tool';
import { BaseModel, CardModel, getBranchData, applyDetailExplorerUrlFilters, type DetailExplorerFilters } from './base';
import { migrateRawProblem } from './problem';
import type { AgentScheduleDoc, AgentScheduleRunDoc } from './agent_schedule';
import type { McpBaseGitInput } from '../handler/base';
import type { EmbeddingService } from '../service/embedding';

const logger = new Logger('model/tool');

class ToolModel {
    static async generateNextToolId(domainId: string, token: string, mcpId?: number): Promise<number> {
        const query = token ? { token } : { mcpId };
        const lastTool = await document.getMulti(domainId, document.TYPE_TOOL, query as any)
            .sort({ tid: -1 })
            .limit(1)
            .project({ tid: 1 })
            .toArray();
        return (lastTool[0]?.tid || 0) + 1;
    }

    static async add(
        tool: Partial<ToolDoc> & {
            domainId: string;
            token?: string;
            edgeDocId?: ObjectId;
            name: string;
            description: string;
            inputSchema: ToolDoc['inputSchema'];
            owner: number;
        },
    ): Promise<ToolDoc> {
        const tid = await this.generateNextToolId(tool.domainId, tool.token || '', tool.mcpId);
        const now = new Date();
        
        const payload: Partial<ToolDoc> = {
            domainId: tool.domainId,
            token: tool.token,
            edgeDocId: tool.edgeDocId,
            mcpId: tool.mcpId,
            source: tool.source,
            tid,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            createdAt: now,
            updatedAt: now,
            owner: tool.owner,
        };

        await document.add(
            tool.domainId,
            tool.name, // content
            tool.owner,
            document.TYPE_TOOL,
            null,
            null,
            null,
            payload,
        );

        // 更新 Edge 的工具数量
        if (tool.token) {
            const edge = await EdgeModel.getByToken(tool.domainId, tool.token);
            if (edge) {
                const toolsCount = await this.countByToken(tool.domainId, tool.token);
                await EdgeModel.update(tool.domainId, edge.eid, { toolsCount });
            }
        }

        if (tool.token) return await this.getByToolId(tool.domainId, tool.token, tid) as ToolDoc;
        const list = await document.getMulti(tool.domainId, document.TYPE_TOOL, { mcpId: tool.mcpId, tid }).limit(1).toArray();
        return list[0] as ToolDoc;
    }

    static async get(_id: ObjectId): Promise<ToolDoc | null> {
        const doc = await document.coll.findOne({ _id });
        if (!doc) return null;
        return await this.getByToolId(doc.domainId, doc.token, doc.tid);
    }

    static async getByToken(domainId: string, token: string): Promise<ToolDoc[]> {
        return await document.getMulti(domainId, document.TYPE_TOOL, { token }).toArray() as ToolDoc[];
    }

    static async getByEdgeDocId(domainId: string, edgeDocId: ObjectId): Promise<ToolDoc[]> {
        return await document.getMulti(domainId, document.TYPE_TOOL, { edgeDocId }).toArray() as ToolDoc[];
    }

    static async update(domainId: string, token: string, tid: number, update: Partial<ToolDoc>): Promise<ToolDoc> {
        const tool = await this.getByToolId(domainId, token, tid);
        if (!tool) throw new Error('Tool not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_TOOL, tool.docId, $set) as ToolDoc;
    }

    static async del(domainId: string, token: string, tid: number) {
        const tool = await this.getByToolId(domainId, token, tid);
        if (!tool) return;
        await document.deleteOne(domainId, document.TYPE_TOOL, tool.docId);
        
        // 更新 Edge 的工具数量
        const edge = await EdgeModel.getByToken(domainId, token);
        if (edge) {
            const toolsCount = await this.countByToken(domainId, token);
            await EdgeModel.update(domainId, edge.eid, { toolsCount });
        }
    }

    static async deleteByToken(domainId: string, token: string) {
        return await document.deleteMulti(domainId, document.TYPE_TOOL, { token });
    }

    static async getByMcpId(domainId: string, mcpId: number): Promise<ToolDoc[]> {
        return await document.getMulti(domainId, document.TYPE_TOOL, { mcpId }).toArray() as ToolDoc[];
    }

    static async deleteByMcpId(domainId: string, mcpId: number) {
        return await document.deleteMulti(domainId, document.TYPE_TOOL, { mcpId });
    }

    static async getByToolId(domainId: string, token: string, tid: number): Promise<ToolDoc | null> {
        const tools = await document.getMulti(domainId, document.TYPE_TOOL, { token, tid })
            .limit(1)
            .toArray();
        return (tools[0] as ToolDoc) || null;
    }

    static async countByToken(domainId: string, token: string): Promise<number> {
        return await document.count(domainId, document.TYPE_TOOL, { token });
    }

    // Clean up duplicate tools (keep only the one with smallest tid for each tool name)
    static async cleanupDuplicates(domainId: string, token: string): Promise<number> {
        const existingTools = await this.getByToken(domainId, token);
        
        const sortedTools = existingTools.sort((a, b) => a.tid - b.tid);
        
        const toolNameToFirstId = new Map<string, number>();
        const duplicateToolIds: number[] = [];
        
        for (const tool of sortedTools) {
            if (!toolNameToFirstId.has(tool.name)) {
                toolNameToFirstId.set(tool.name, tool.tid);
            } else {
                duplicateToolIds.push(tool.tid);
                logger.warn('Found duplicate tool: %s (tid: %d), will be removed (keeping tid: %d)', 
                    tool.name, tool.tid, toolNameToFirstId.get(tool.name));
            }
        }
        
        let deletedCount = 0;
        for (const tid of duplicateToolIds) {
            await this.del(domainId, token, tid);
            deletedCount++;
        }
        
        if (deletedCount > 0) {
            logger.info('Cleaned up %d duplicate tools: token=%s', deletedCount, token);
            const toolsCount = await this.countByToken(domainId, token);
            const edge = await EdgeModel.getByToken(domainId, token);
            if (edge) {
                await EdgeModel.update(domainId, edge.eid, { toolsCount });
            }
        }
        
        return deletedCount;
    }

    static async syncToolsFromEdge(
        domainId: string,
        token: string,
        edgeDocId: ObjectId,
        tools: Array<{ name: string; description: string; inputSchema: ToolDoc['inputSchema'] }>,
        owner: number,
    ): Promise<void> {
        // Step 1: Clean up existing duplicate tools first
        await this.cleanupDuplicates(domainId, token);
        
        // Re-fetch tool list (duplicates cleaned)
        const existingTools = await this.getByToken(domainId, token);
        const existingToolMap = new Map<string, ToolDoc>();
        for (const tool of existingTools) {
            // Ensure only one tool per name in the map
            if (!existingToolMap.has(tool.name)) {
                existingToolMap.set(tool.name, tool);
            }
        }
        
        const newToolNames = new Set(tools.map(t => t.name));

        // Step 2: Process each tool: add new or update existing
        for (const tool of tools) {
            const existingTool = existingToolMap.get(tool.name);
            if (!existingTool) {
                // Double-check if tool exists before adding (prevent concurrency issues)
                const duplicateCheck = await document.getMulti(domainId, document.TYPE_TOOL, { 
                    token, 
                    name: tool.name 
                }).limit(1).toArray();
                
                if (duplicateCheck.length > 0) {
                    // If duplicate found, update existing tool instead of creating new
                    const existing = duplicateCheck[0] as ToolDoc;
                    logger.warn('Tool %s already exists (tid: %d), updating instead of creating', tool.name, existing.tid);
                    await this.update(domainId, token, existing.tid, {
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                    });
                    // Update map
                    existingToolMap.set(tool.name, existing);
                    continue;
                }
                
                // Add new tool
                const newTool = await this.add({
                    domainId,
                    token,
                    edgeDocId,
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    owner,
                });
                // Update map
                existingToolMap.set(tool.name, newTool);
            } else {
                // Update existing tool if description or input schema changed
                const needsUpdate = 
                    existingTool.description !== tool.description ||
                    JSON.stringify(existingTool.inputSchema) !== JSON.stringify(tool.inputSchema);
                
                if (needsUpdate) {
                    await this.update(domainId, token, existingTool.tid, {
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                    });
                }
            }
        }

        // Step 3: Delete tools that no longer exist
        const finalTools = await this.getByToken(domainId, token);
        for (const existingTool of finalTools) {
            if (!newToolNames.has(existingTool.name)) {
                // Tool no longer exists in server list, delete it
                logger.info('Removing tool that no longer exists: %s (tid: %d)', existingTool.name, existingTool.tid);
                await this.del(domainId, token, existingTool.tid);
            }
        }

        // Step 4: Final cleanup - ensure no duplicates (defensive check)
        const finalDeleted = await this.cleanupDuplicates(domainId, token);
        if (finalDeleted > 0) {
            logger.warn('Final cleanup removed %d duplicate tools after sync', finalDeleted);
        }

        const toolsCount = await this.countByToken(domainId, token);
        const edge = await EdgeModel.getByToken(domainId, token);
        if (edge) {
            await EdgeModel.update(domainId, edge.eid, { toolsCount });
        }
        
        logger.info('Tools sync completed: token=%s, toolsCount=%d', token, toolsCount);
    }

    static async syncToolsFromPluginMcp(
        domainId: string,
        mcpId: number,
        source: NonNullable<ToolDoc['source']>,
        tools: Array<{ name: string; description?: string; inputSchema?: ToolDoc['inputSchema'] }>,
        owner: number,
    ): Promise<void> {
        const existingTools = await this.getByMcpId(domainId, mcpId);
        const existingToolMap = new Map<string, ToolDoc>();
        for (const tool of existingTools) {
            if (!existingToolMap.has(tool.name)) existingToolMap.set(tool.name, tool);
        }

        const newToolNames = new Set(tools.map((t) => t.name));
        for (const tool of tools) {
            const existing = existingToolMap.get(tool.name);
            const description = tool.description || '';
            const inputSchema = tool.inputSchema || { type: 'object', properties: {} };
            if (!existing) {
                await this.add({
                    domainId,
                    mcpId,
                    source,
                    name: tool.name,
                    description,
                    inputSchema,
                    owner,
                });
            } else if (existing.description !== description || JSON.stringify(existing.inputSchema) !== JSON.stringify(inputSchema)) {
                await document.set(domainId, document.TYPE_TOOL, existing.docId, {
                    description,
                    inputSchema,
                    updatedAt: new Date(),
                } as Partial<ToolDoc>);
            }
        }

        for (const existing of existingTools) {
            if (!newToolNames.has(existing.name)) await document.deleteOne(domainId, document.TYPE_TOOL, existing.docId);
        }
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', async (domainId) => {
        // Tools are automatically deleted when domain is deleted
    });

    if (process.env.NODE_APP_INSTANCE !== '0') return;
}

export default ToolModel;

(global.Ejunz.model as any).tool = ToolModel;

// ---- mcpBuiltinTools ----
export interface McpToolContext {
    domainId: string;
    baseDocId: number;
    branch: string;
    owner: number;
    setting?: { get: (k: string) => unknown };
    embedding?: EmbeddingService;
}

export interface McpToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

export const MCP_BUILTIN_TOOLS_CATALOG: McpToolDef[] = [
    {
        name: 'detail_list_nodes',
        description: 'Node = a section/topic in this base\'s node tree (hierarchical). '
            + 'Returns every node of the bound base: id, text (title), parentId (null at root), level (depth), order. '
            + 'Call this first to understand the structure before reading or editing cards.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'detail_create_node',
        description: 'Create a new node (section/topic). '
            + 'Pass parentId to nest it under an existing node; omit parentId to create it under the bound base root node.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Node title/text.' },
                parentId: { type: 'string', description: 'Parent node id from detail_list_nodes (optional; omit to place under the base root node).' },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
    {
        name: 'detail_update_node',
        description: 'Rename a node (change its title/text). Use nodeId from detail_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Node id from detail_list_nodes.' },
                text: { type: 'string', description: 'New node title/text.' },
            },
            required: ['nodeId', 'text'],
            additionalProperties: false,
        },
    },
    {
        name: 'detail_delete_node',
        description: 'Delete a node by id (and its cards). Use nodeId from detail_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Node id from detail_list_nodes.' } },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_list',
        description: 'Card = a content block (title + markdown body) attached to a node; a node can hold several ordered cards. '
            + 'Lists the cards under one node: cardId, title, order. Use nodeId from detail_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Node id from detail_list_nodes.' } },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_get',
        description: 'Read a single card\'s full content (title + markdown body) by cardId. Use cardId from card_list.',
        inputSchema: {
            type: 'object',
            properties: { cardId: { type: 'string', description: 'Card docId (hex) from card_list.' } },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_create',
        description: 'Create a new card (content block) under a node. Use nodeId from detail_list_nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Owning node id from detail_list_nodes.' },
                title: { type: 'string', description: 'Card title.' },
                content: { type: 'string', description: 'Markdown body (optional).' },
            },
            required: ['nodeId', 'title'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_update',
        description: 'Update a card\'s title and/or markdown content by cardId. Use cardId from card_list.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
                title: { type: 'string', description: 'New title (optional).' },
                content: { type: 'string', description: 'New markdown body (optional).' },
            },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'card_delete',
        description: 'Delete a card by cardId. Use cardId from card_list.',
        inputSchema: {
            type: 'object',
            properties: { cardId: { type: 'string', description: 'Card docId (hex) from card_list.' } },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'detail_tree',
        description: 'Return the whole node tree as a nested tree (overview/table of contents). '
            + 'Each node carries only its id and text (title) and its cards (cardId + title); card content is NOT included. '
            + 'Use this to grasp the full structure at a glance, then call card_get to read specific cards.',
        inputSchema: {
            type: 'object',
            properties: {
                includeCards: {
                    type: 'boolean',
                    description: 'Include each node\'s cards (id + title) in the tree. Default true; set false for nodes only.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'detail_search',
        description: 'Search and/or filter the node tree (same semantics as the base detail page). '
            + 'Provide `query` to match a keyword or an exact id against node titles/ids and card titles/ids. '
            + 'Provide any of `filterNode` / `filterCard` / `filterProblem` to narrow by node title, card title, or problem content. '
            + 'You may combine `query` with the filters; all supplied conditions are applied together (intersection). '
            + 'Returns matching nodes and cards with id, title and the node path; card content is NOT included.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Keyword or exact id to match against node text/id and card title/id (case-insensitive).' },
                filterNode: { type: 'string', description: 'Keep only nodes whose title contains this text (like the detail page filterNode).' },
                filterCard: { type: 'string', description: 'Keep only nodes that have a card whose title contains this text (filterCard).' },
                filterProblem: { type: 'string', description: 'Keep only nodes that have a card with a problem matching this text (filterProblem).' },
                limit: { type: 'number', description: 'Max results to return per kind (nodes/cards). Default 50.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'semantic_search',
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
        description: 'Problem = a practice exercise attached to a card (quiz, flip card, matching table, etc.). '
            + 'Lists every problem on one card: pid, type, title, and a short content preview. Use cardId from card_list.',
        inputSchema: {
            type: 'object',
            properties: { cardId: { type: 'string', description: 'Card docId (hex) from card_list.' } },
            required: ['cardId'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_get',
        description: 'Read one practice problem in full by cardId + pid. Use pid from problem_list.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
                pid: { type: 'string', description: 'Problem id from problem_list.' },
            },
            required: ['cardId', 'pid'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_create',
        description: 'Add a practice problem to a card. Pass `problem` as a JSON object. '
            + 'Common fields: title (short sidebar label), stem, analysis, tags. '
            + 'type: single (default) | multi | true_false | flip | fill_blank | matching | super_flip | ai_eval. '
            + 'single/multi: options[] + answer (index or index array). true_false: stem + answer 0|1. '
            + 'flip: faceA, faceB, optional hint. fill_blank: stem with ___ + answers[]. '
            + 'matching: columns[][] (≥2 cols, ≥2 rows) or legacy left/right. '
            + 'super_flip: headers[] + columns[][] (allows 1×1). ai_eval: stem + points[].',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
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
        description: 'Update an existing problem by pid. Pass `problem` with fields to change (merged with the stored row, then normalized). '
            + 'Include `type` only when changing the problem kind.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
                pid: { type: 'string', description: 'Problem id from problem_list.' },
                problem: { type: 'object', description: 'Fields to update.' },
            },
            required: ['cardId', 'pid', 'problem'],
            additionalProperties: false,
        },
    },
    {
        name: 'problem_delete',
        description: 'Delete a practice problem from a card by pid. Use pid from problem_list.',
        inputSchema: {
            type: 'object',
            properties: {
                cardId: { type: 'string', description: 'Card docId (hex) from card_list.' },
                pid: { type: 'string', description: 'Problem id from problem_list.' },
            },
            required: ['cardId', 'pid'],
            additionalProperties: false,
        },
    },
    {
        name: 'git_status',
        description: 'Get git sync status for this base: local/remote branch, ahead/behind, uncommitted changes, and file change lists. '
            + 'Requires a local git repo (created on first commit/push). Optionally pass `branch` (defaults to MCP-bound branch).',
        inputSchema: {
            type: 'object',
            properties: {
                branch: { type: 'string', description: 'Git branch to inspect (optional; defaults to bound branch).' },
                githubToken: { type: 'string', description: 'GitHub PAT override for remote fetch (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_commit',
        description: 'Export the current base/branch to the local git working tree and commit (does not push). '
            + 'Use after editing nodes/cards/problems when you want a local snapshot.',
        inputSchema: {
            type: 'object',
            properties: {
                branch: { type: 'string', description: 'Branch to commit on (optional).' },
                commitMessage: { type: 'string', description: 'Commit message body (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_push',
        description: 'Commit local changes and push to the configured GitHub remote (`git_config_get`). '
            + 'Requires githubRepo on the base and a GitHub token (user profile or system setting).',
        inputSchema: {
            type: 'object',
            properties: {
                branch: { type: 'string', description: 'Branch to push (optional).' },
                commitMessage: { type: 'string', description: 'Commit message (optional).' },
                githubToken: { type: 'string', description: 'GitHub PAT override (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_pull',
        description: 'Pull from GitHub and import the remote branch into this base (overwrites local branch data from remote). '
            + 'Destructive: replaces nodes/cards from the git tree. Requires githubRepo and token.',
        inputSchema: {
            type: 'object',
            properties: {
                branch: { type: 'string', description: 'Branch to pull (optional).' },
                githubToken: { type: 'string', description: 'GitHub PAT override (optional).' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'git_config_get',
        description: 'Read the GitHub repository URL/path configured for this base (used by git_push / git_pull).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'git_config_set',
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
];

export async function buildMcpInstructions(
    ctx: { domainId: string; baseDocId?: number; branch?: string },
): Promise<string> {
    const lines: string[] = [
        'This MCP server is bound to a single Ejunz "base" — a knowledge base organized as an node tree.',
        '',
        'Concepts:',
        '- Node: a section/topic in the base\'s node tree. Nodes form a hierarchy via parentId/level. Each node has an id and text (title).',
        '- Card: a content block (title + markdown body) attached to a node. One node can hold multiple ordered cards.',
        '- Problem: a practice exercise (quiz, flip card, matching, etc.) attached to a card. Types: single, multi, true_false, flip, fill_blank, matching, super_flip, ai_eval.',
        '',
        'Relationship: base → nodes (tree) → cards (content) → problems (exercises on each card).',
    ];
    if (ctx.baseDocId) {
        let title = '';
        try {
            const base = await BaseModel.get(ctx.domainId, ctx.baseDocId, document.TYPE_BASE);
            title = (base as any)?.title || '';
        } catch { /* ignore */ }
        lines.push(
            '',
            `This endpoint is bound to base #${ctx.baseDocId}${title ? ` "${title}"` : ''} on branch "${ctx.branch || 'main'}". `
            + 'All tools operate only within this base/branch.',
        );
    }
    lines.push(
        '',
        'Typical workflow:',
        '1. detail_tree — get the whole node tree (nodes + cards, titles only) at a glance.',
        '2. semantic_search(query) — find content by meaning (vector/embedding search across node titles and card content).',
        '3. detail_search(query/filterNode/filterCard/filterProblem) — find nodes/cards by keyword, id or filters.',
        '4. detail_list_nodes — flat list of nodes; card_list(nodeId) — cards under a node.',
        '5. card_get(cardId) — read a card\'s full content.',
        '6. problem_list(cardId) / problem_get(cardId, pid) — list or read practice problems on a card.',
        '7. git_status — check local/remote sync; git_commit / git_push / git_pull — sync with GitHub (configure repo via git_config_set).',
        '8. Use the create/update/delete tools to modify nodes, cards, and problems.',
    );
    return lines.join('\n');
}

const MCP_BUILTIN_MUTATING_TOOLS = new Set([
    'detail_create_node', 'detail_update_node', 'detail_delete_node',
    'card_create', 'card_update', 'card_delete',
    'problem_create', 'problem_update', 'problem_delete',
    'git_pull', 'git_config_set',
]);

export function isMcpBuiltinTool(name: string): boolean {
    return MCP_BUILTIN_TOOLS_CATALOG.some((t) => t.name === name);
}

export function isMcpBuiltinMutatingTool(name: string): boolean {
    return MCP_BUILTIN_MUTATING_TOOLS.has(name);
}

export function defaultMcpToolDescriptions(): { name: string; description: string }[] {
    return MCP_BUILTIN_TOOLS_CATALOG.map((t) => ({ name: t.name, description: t.description }));
}

export function resolveMcpTools(overrides?: { name: string; description: string }[]): McpToolDef[] {
    if (!overrides || !overrides.length) return MCP_BUILTIN_TOOLS_CATALOG;
    const map = new Map(overrides.map((o) => [o.name, o.description]));
    return MCP_BUILTIN_TOOLS_CATALOG.map((t) => ({
        ...t,
        description: map.has(t.name) && map.get(t.name) ? (map.get(t.name) as string) : t.description,
    }));
}

function toObjectId(value: unknown): ObjectId {
    const s = String(value || '').trim();
    if (!ObjectId.isValid(s)) throw new Error(`Invalid cardId: ${s}`);
    return new ObjectId(s);
}

function cardMatchesBranch(card: CardDoc, branch: string): boolean {
    const cardBranch = (card as CardDoc & { branch?: string }).branch || 'main';
    if (branch === 'main') return cardBranch === 'main' || !cardBranch;
    return cardBranch === branch;
}

async function requireCard(ctx: McpToolContext, cardId: unknown): Promise<CardDoc> {
    const card = await CardModel.get(ctx.domainId, toObjectId(cardId));
    if (!card) throw new Error('Card not found');
    if (String(card.baseDocId) !== String(ctx.baseDocId)) {
        throw new Error('Card does not belong to this base');
    }
    if (!cardMatchesBranch(card, ctx.branch)) {
        throw new Error(`Card is on branch "${(card as CardDoc & { branch?: string }).branch || 'main'}", not "${ctx.branch}"`);
    }
    return card;
}

function parseProblemPayload(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch { /* fall through */ }
    }
    throw new Error('problem must be a JSON object');
}

function normalizeProblemKind(raw: unknown): ProblemKind | undefined {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return undefined;
    const kinds: ProblemKind[] = [
        'single', 'multi', 'true_false', 'flip', 'fill_blank', 'matching', 'super_flip', 'ai_eval',
    ];
    return kinds.includes(s as ProblemKind) ? (s as ProblemKind) : undefined;
}

function buildProblemRaw(payload: Record<string, unknown>, pid: string): Record<string, unknown> {
    const raw: Record<string, unknown> = { ...payload, pid };
    const kind = normalizeProblemKind(payload.type ?? payload.problemKind ?? payload.kind);
    if (kind) raw.type = kind;
    return raw;
}

function newProblemPid(): string {
    return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function problemPreview(p: Problem): string {
    const type = (p as Problem & { type?: string }).type || 'single';
    let text = '';
    if (type === 'flip') {
        text = String((p as { faceA?: string }).faceA || '');
    } else if ('stem' in p) {
        text = String((p as { stem?: string }).stem || '');
    } else if (type === 'matching' || type === 'super_flip') {
        const cols = (p as { columns?: string[][] }).columns;
        if (Array.isArray(cols) && cols[0]?.length) text = cols[0].join(' | ');
    }
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function summarizeProblem(p: Problem) {
    const type = (p as Problem & { type?: string }).type || 'single';
    return {
        pid: p.pid,
        type,
        title: p.title || '',
        preview: problemPreview(p),
        tags: Array.isArray(p.tags) ? p.tags : [],
    };
}

async function saveCardProblems(domainId: string, card: CardDoc, problems: Problem[]): Promise<void> {
    await CardModel.update(domainId, card.docId, { problems });
}

function findProblemIndex(problems: Problem[], pid: string): number {
    return problems.findIndex((p) => String(p.pid) === pid);
}

function toMcpGitInput(ctx: McpToolContext, args: Record<string, any>): McpBaseGitInput {
    const branchArg = args.branch != null ? String(args.branch).trim() : '';
    return {
        domainId: ctx.domainId,
        baseDocId: ctx.baseDocId,
        branch: branchArg || ctx.branch,
        owner: ctx.owner,
        setting: ctx.setting,
        githubToken: typeof args.githubToken === 'string' && args.githubToken.trim()
            ? args.githubToken.trim()
            : undefined,
        commitMessage: typeof args.commitMessage === 'string' ? args.commitMessage : undefined,
    };
}

function summarizeNode(n: any) {
    return { id: n.id, text: n.text, parentId: n.parentId || null, level: n.level ?? 0, order: n.order ?? 0 };
}

function summarizeCard(c: CardDoc) {
    return { cardId: String(c.docId), title: c.title, order: c.order ?? 0, nodeId: c.nodeId };
}

/** Loads all cards of the base/branch grouped by their owning node id. */
async function loadNodeCardsMap(
    domainId: string,
    baseDocId: number,
    branch: string,
    nodes: BaseNode[],
): Promise<Record<string, CardDoc[]>> {
    const map: Record<string, CardDoc[]> = {};
    await Promise.all((nodes || []).map(async (n) => {
        map[n.id] = await CardModel.getByNodeId(domainId, baseDocId, n.id, branch);
    }));
    return map;
}

/** target -> source (child -> parent) map derived from edges. */
function buildParentMap(edges: BaseEdge[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const e of edges || []) m.set(e.target, e.source);
    return m;
}

function findRootNodeId(nodes: BaseNode[] = [], edges: BaseEdge[] = []): string | undefined {
    if (!nodes.length) return undefined;
    const levelRoot = nodes.find((n) => n.level === 0);
    if (levelRoot?.id) return levelRoot.id;
    const parentMap = buildParentMap(edges);
    return nodes.find((n) => !parentMap.has(n.id))?.id || nodes[0]?.id;
}

/** Builds the " › " separated node-title path for a node, root first. */
function pathLabelFor(nodeId: string, parentMap: Map<string, string>, nodeById: Map<string, BaseNode>): string {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = nodeId;
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        const n = nodeById.get(cur);
        chain.push((n?.text || '').trim() || 'Untitled');
        cur = parentMap.get(cur);
    }
    return chain.reverse().join(' › ');
}

interface DetailTreeNode {
    id: string;
    text: string;
    cards?: { cardId: string; title: string; order: number }[];
    children: DetailTreeNode[];
}

/** Builds nested node tree (id + text only; cards as id + title when requested). */
function buildDetailTree(
    nodes: BaseNode[],
    edges: BaseEdge[],
    nodeCardsMap: Record<string, CardDoc[]>,
    includeCards: boolean,
): DetailTreeNode[] {
    const parentMap = buildParentMap(edges);
    const childrenMap = new Map<string, string[]>();
    for (const e of edges || []) {
        if (!childrenMap.has(e.source)) childrenMap.set(e.source, []);
        childrenMap.get(e.source)!.push(e.target);
    }
    const nodeById = new Map((nodes || []).map((n) => [n.id, n]));
    const orderOf = (id: string) => nodeById.get(id)?.order ?? 0;

    const build = (id: string, seen: Set<string>): DetailTreeNode | null => {
        if (seen.has(id)) return null;
        seen.add(id);
        const n = nodeById.get(id);
        if (!n) return null;
        const childIds = (childrenMap.get(id) || []).slice().sort((a, b) => orderOf(a) - orderOf(b));
        const out: DetailTreeNode = {
            id,
            text: n.text || '',
            children: childIds.map((c) => build(c, seen)).filter(Boolean) as DetailTreeNode[],
        };
        if (includeCards) {
            out.cards = (nodeCardsMap[id] || [])
                .slice()
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                .map((c) => ({ cardId: String(c.docId), title: c.title || '', order: c.order ?? 0 }));
        }
        return out;
    };

    const roots = (nodes || [])
        .filter((n) => !parentMap.has(n.id))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const seen = new Set<string>();
    return roots.map((r) => build(r.id, seen)).filter(Boolean) as DetailTreeNode[];
}

export async function executeMcpBuiltinTool(
    ctx: McpToolContext,
    name: string,
    args: Record<string, any>,
): Promise<unknown> {
    const { domainId, baseDocId, branch, owner } = ctx;
    if (!baseDocId) throw new Error('This MCP endpoint is not bound to a base.');
    const base = await BaseModel.get(domainId, baseDocId, document.TYPE_BASE);
    if (!base) throw new Error(`Base not found: ${baseDocId}`);

    switch (name) {
    case 'detail_list_nodes': {
        const { nodes, edges } = getBranchData(base, branch);
        const parentMap = buildParentMap(edges);
        return (nodes || []).map((n) => ({
            ...summarizeNode(n),
            parentId: parentMap.get(n.id) || n.parentId || null,
        }));
    }
    case 'detail_create_node': {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('text is required');
        const { nodes, edges } = getBranchData(base, branch);
        const parentId = args.parentId
            ? String(args.parentId).trim()
            : findRootNodeId(nodes || [], edges || []);
        if (parentId && !(nodes || []).some((n) => n.id === parentId)) {
            throw new Error(`Parent node not found: ${parentId}`);
        }
        const res = await BaseModel.addNode(
            domainId, baseDocId, { text } as any, parentId, branch, parentId,
        );
        return { ok: true, nodeId: res.nodeId, edgeId: res.edgeId, parentId: parentId ?? null };
    }
    case 'detail_update_node': {
        const nodeId = String(args.nodeId || '');
        const text = String(args.text || '');
        if (!nodeId) throw new Error('nodeId is required');
        await BaseModel.updateNode(domainId, baseDocId, nodeId, { text } as any, branch);
        return { ok: true, nodeId };
    }
    case 'detail_delete_node': {
        const nodeId = String(args.nodeId || '');
        if (!nodeId) throw new Error('nodeId is required');
        await BaseModel.deleteNode(domainId, baseDocId, nodeId, branch);
        return { ok: true, nodeId };
    }
    case 'card_list': {
        const nodeId = String(args.nodeId || '');
        if (!nodeId) throw new Error('nodeId is required');
        const cards = await CardModel.getByNodeId(domainId, baseDocId, nodeId, branch);
        return cards.map(summarizeCard);
    }
    case 'card_get': {
        const card = await CardModel.get(domainId, toObjectId(args.cardId));
        if (!card) throw new Error('Card not found');
        return { cardId: String(card.docId), title: card.title, content: card.content, nodeId: card.nodeId };
    }
    case 'card_create': {
        const nodeId = String(args.nodeId || '');
        const title = String(args.title || '').trim();
        if (!nodeId) throw new Error('nodeId is required');
        if (!title) throw new Error('title is required');
        const docId = await CardModel.create(
            domainId, baseDocId, nodeId, owner, title, String(args.content || ''),
            undefined, undefined, undefined, branch,
        );
        return { ok: true, cardId: String(docId) };
    }
    case 'card_update': {
        const updates: Record<string, any> = {};
        if (typeof args.title === 'string') updates.title = args.title;
        if (typeof args.content === 'string') updates.content = args.content;
        if (!Object.keys(updates).length) throw new Error('Nothing to update (title or content required)');
        await CardModel.update(domainId, toObjectId(args.cardId), updates);
        return { ok: true, cardId: String(args.cardId) };
    }
    case 'card_delete': {
        await CardModel.delete(domainId, toObjectId(args.cardId));
        return { ok: true, cardId: String(args.cardId) };
    }
    case 'detail_tree': {
        const includeCards = args.includeCards === undefined ? true : !!args.includeCards;
        const { nodes, edges } = getBranchData(base, branch);
        const nodeCardsMap = includeCards
            ? await loadNodeCardsMap(domainId, baseDocId, branch, nodes || [])
            : {};
        const tree = buildDetailTree(nodes || [], edges || [], nodeCardsMap, includeCards);
        return { nodeCount: (nodes || []).length, tree };
    }
    case 'detail_search': {
        const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));
        const filters: DetailExplorerFilters = {
            filterNode: String(args.filterNode || ''),
            filterCard: String(args.filterCard || ''),
            filterProblem: String(args.filterProblem || ''),
        };
        const raw = getBranchData(base, branch);
        const allNodes = raw.nodes || [];
        const allEdges = raw.edges || [];
        const nodeCardsMap = await loadNodeCardsMap(domainId, baseDocId, branch, allNodes);

        const filtered = applyDetailExplorerUrlFilters(allNodes, allEdges, nodeCardsMap, filters);
        const scopeNodes = filtered.nodes;
        const scopeEdges = filtered.edges;
        const scopeCardsMap = filtered.nodeCardsMap;

        const parentMap = buildParentMap(scopeEdges);
        const nodeById = new Map(scopeNodes.map((n) => [n.id, n]));
        const q = String(args.query || '').trim().toLowerCase();
        const matchText = (s: string | undefined) => !q || (s || '').toLowerCase().includes(q);

        const nodeMatches: any[] = [];
        for (const n of scopeNodes) {
            if (matchText(n.text) || matchText(n.id)) {
                nodeMatches.push({
                    type: 'node',
                    id: n.id,
                    text: n.text || '',
                    path: pathLabelFor(n.id, parentMap, nodeById),
                });
                if (nodeMatches.length >= limit) break;
            }
        }

        const cardMatches: any[] = [];
        outer: for (const nodeId of Object.keys(scopeCardsMap)) {
            for (const c of scopeCardsMap[nodeId] || []) {
                const cid = String(c.docId);
                if (matchText(c.title) || matchText(cid)) {
                    cardMatches.push({
                        type: 'card',
                        cardId: cid,
                        title: c.title || '',
                        nodeId: c.nodeId || nodeId,
                        path: pathLabelFor(c.nodeId || nodeId, parentMap, nodeById),
                    });
                    if (cardMatches.length >= limit) break outer;
                }
            }
        }

        return {
            query: q || null,
            filters,
            matchedNodeCount: nodeMatches.length,
            matchedCardCount: cardMatches.length,
            nodes: nodeMatches,
            cards: cardMatches,
        };
    }
    case 'semantic_search': {
        const q = String(args.query || '').trim();
        if (!q) throw new Error('query is required');
        if (!ctx.embedding) throw new Error('Semantic search is not available (embedding service not loaded)');
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
        const kind = String(args.kind || '').trim().toLowerCase();
        const requested = kind && (kind === 'node' || kind === 'card') ? Math.min(50, limit * 3) : limit;
        const raw = await ctx.embedding.searchSimilar(domainId, baseDocId, branch, q, requested);
        const results = (kind && (kind === 'node' || kind === 'card')
            ? raw.filter((r) => r.kind === kind)
            : raw).slice(0, limit);
        const rawBranch = getBranchData(base, branch);
        const parentMap = buildParentMap(rawBranch.edges || []);
        const nodeById = new Map((rawBranch.nodes || []).map((n) => [n.id, n]));
        return {
            query: q,
            kind: kind || null,
            matchedCount: results.length,
            results: results.map((r, index) => ({
                rank: r.rank || index + 1,
                nodeId: r.nodeId,
                kind: r.kind,
                cardDocId: r.cardDocId || null,
                cardTitle: r.cardTitle || null,
                chunkIndex: r.chunkIndex ?? 0,
                path: pathLabelFor(r.nodeId, parentMap, nodeById) || null,
                text: r.text,
                score: Math.round(r.score * 10000) / 10000,
                semanticScore: Math.round((r.semanticScore ?? r.score) * 10000) / 10000,
                keywordScore: Math.round((r.keywordScore || 0) * 10000) / 10000,
                matchedTerms: Array.isArray(r.matchedTerms) ? r.matchedTerms : [],
            })),
        };
    }
    case 'problem_list': {
        const card = await requireCard(ctx, args.cardId);
        const problems = card.problems || [];
        return {
            cardId: String(card.docId),
            count: problems.length,
            problems: problems.map(summarizeProblem),
        };
    }
    case 'problem_get': {
        const card = await requireCard(ctx, args.cardId);
        const pid = String(args.pid || '').trim();
        if (!pid) throw new Error('pid is required');
        const problems = card.problems || [];
        const idx = findProblemIndex(problems, pid);
        if (idx < 0) throw new Error(`Problem not found: ${pid}`);
        return { cardId: String(card.docId), problem: problems[idx] };
    }
    case 'problem_create': {
        const card = await requireCard(ctx, args.cardId);
        const payload = parseProblemPayload(args.problem);
        const pid = newProblemPid();
        const problem = migrateRawProblem(buildProblemRaw(payload, pid));
        const problems = [...(card.problems || []), problem];
        await saveCardProblems(domainId, card, problems);
        return { ok: true, cardId: String(card.docId), pid: problem.pid, problem };
    }
    case 'problem_update': {
        const card = await requireCard(ctx, args.cardId);
        const pid = String(args.pid || '').trim();
        if (!pid) throw new Error('pid is required');
        const payload = parseProblemPayload(args.problem);
        const problems = [...(card.problems || [])];
        const idx = findProblemIndex(problems, pid);
        if (idx < 0) throw new Error(`Problem not found: ${pid}`);
        const merged = { ...(problems[idx] as unknown as Record<string, unknown>), ...payload, pid };
        const problem = migrateRawProblem(buildProblemRaw(merged, pid));
        problems[idx] = problem;
        await saveCardProblems(domainId, card, problems);
        return { ok: true, cardId: String(card.docId), pid, problem };
    }
    case 'problem_delete': {
        const card = await requireCard(ctx, args.cardId);
        const pid = String(args.pid || '').trim();
        if (!pid) throw new Error('pid is required');
        const problems = card.problems || [];
        const idx = findProblemIndex(problems, pid);
        if (idx < 0) throw new Error(`Problem not found: ${pid}`);
        const next = problems.filter((_, i) => i !== idx);
        await saveCardProblems(domainId, card, next);
        return { ok: true, cardId: String(card.docId), pid };
    }
    case 'git_status': {
        const { mcpBaseGitStatus } = await import('../handler/base');
        return mcpBaseGitStatus(toMcpGitInput(ctx, args));
    }
    case 'git_commit': {
        const { mcpBaseGitCommit } = await import('../handler/base');
        return mcpBaseGitCommit(toMcpGitInput(ctx, args));
    }
    case 'git_push': {
        const { mcpBaseGitPush } = await import('../handler/base');
        return mcpBaseGitPush(toMcpGitInput(ctx, args));
    }
    case 'git_pull': {
        const { mcpBaseGitPull } = await import('../handler/base');
        return mcpBaseGitPull(toMcpGitInput(ctx, args));
    }
    case 'git_config_get': {
        const { mcpBaseGitConfigGet } = await import('../handler/base');
        return mcpBaseGitConfigGet({ domainId: ctx.domainId, baseDocId: ctx.baseDocId });
    }
    case 'git_config_set': {
        const { mcpBaseGitConfigSet } = await import('../handler/base');
        const raw = args.githubRepo;
        const githubRepo = raw == null ? null : String(raw).trim();
        return mcpBaseGitConfigSet({
            ...toMcpGitInput(ctx, args),
            githubRepo: githubRepo || null,
        });
    }
    default:
        throw new Error(`Unknown tool: ${name}`);
    }
}


// ---- systemTools ----
/**
 * System-tool adapter: core delegates to plugins (e.g. @ejunz/ejunztools) for catalog + executor.
 * Core does not hard-code packages; getSystemToolCatalog / executeSystemTool / tryExecuteSystemTool use registration.
 */

const systemToolsLogger = new Logger('systemTools');

export type SystemToolCatalogEntry = { name: string; description: string; inputSchema: any };
export interface SystemToolExecutionContext {
    domainId?: string;
    baseDocId?: number;
    branch?: string;
    owner?: number;
    setting?: { get: (k: string) => unknown };
}
export type SystemToolExecutor = (name: string, args: Record<string, unknown>, context?: SystemToolExecutionContext) => Promise<unknown>;

let registeredCatalog: SystemToolCatalogEntry[] = [];
let registeredExecutor: SystemToolExecutor | null = null;

/** Plugin: register executable system tools (name/description/inputSchema). */
export function registerSystemToolCatalog(catalog: SystemToolCatalogEntry[]): void {
    registeredCatalog = Array.isArray(catalog) ? catalog.map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
    })) : [];
    systemToolsLogger.info('[tool] systemTools: registerSystemToolCatalog count=%d names=%s', registeredCatalog.length, registeredCatalog.map(t => t.name).join(','));
}

/** Plugin: register system-tool executor. */
export function registerSystemToolExecutor(fn: SystemToolExecutor): void {
    registeredExecutor = typeof fn === 'function' ? fn : null;
    systemToolsLogger.info('[tool] systemTools: registerSystemToolExecutor hasExecutor=%s', !!registeredExecutor);
}

/** Executable system tools; [] if unregistered. */
export function getSystemToolCatalog(): SystemToolCatalogEntry[] {
    return registeredCatalog;
}

/** Run a system tool via plugin executor; throws if not registered. */
export async function executeSystemTool(name: string, args: Record<string, unknown>, context?: SystemToolExecutionContext): Promise<unknown> {
    systemToolsLogger.info('[tool] systemTools: executeSystemTool name=%s hasExecutor=%s', name, !!registeredExecutor);
    if (!registeredExecutor) {
        throw new Error('System tool executor not registered (plugin not loaded)');
    }
    const result = await registeredExecutor(name, args || {}, context);
    systemToolsLogger.info('[tool] systemTools: executeSystemTool name=%s done', name);
    return result;
}

/**
 * If name is in the registered system-tool list, run it and return the result; else null.
 * callTool fallback when no edge metadata is available.
 */
export async function tryExecuteSystemTool(name: string, args: Record<string, unknown>, context?: SystemToolExecutionContext): Promise<unknown | null> {
    const inCatalog = registeredCatalog.some(t => t.name === name);
    systemToolsLogger.info('[tool] systemTools: tryExecuteSystemTool name=%s inCatalog=%s hasExecutor=%s', name, inCatalog, !!registeredExecutor);
    if (!registeredExecutor || !inCatalog) return null;
    try {
        const result = await registeredExecutor(name, args || {}, context);
        systemToolsLogger.info('[tool] systemTools: tryExecuteSystemTool name=%s done ok', name);
        return result;
    } catch (e) {
        systemToolsLogger.warn('[tool] systemTools: tryExecuteSystemTool name=%s caught %s', name, (e as Error)?.message);
        return null;
    }
}


// ---- scheduleSystemTools ----
type AgentScheduleModelStatic = typeof import('./agent_schedule').default;

function AgentScheduleModel(): AgentScheduleModelStatic {
    return require('./agent_schedule').default;
}

export const SCHEDULE_SYSTEM_TOOL_NAMES = new Set([
    'schedule_create',
    'schedule_get',
    'schedule_list',
    'schedule_update',
    'schedule_delete',
    'schedule_pause',
    'schedule_resume',
    'schedule_history',
]);

export const SCHEDULE_SYSTEM_TOOLS_CATALOG: SystemToolCatalogEntry[] = [
    {
        name: 'schedule_create',
        description: 'Create a domain-scoped scheduled task that sends a clear prompt/message to an agent at a future time or interval. When creating a schedule from a user request, rewrite the user intent into a self-contained instruction that the future agent can execute directly.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Agent aid or numeric docId. Optional; defaults to the current executing agent when called by an agent.' },
                title: { type: 'string' },
                command: { type: 'string', description: 'Self-contained prompt/message to send to the agent when the schedule fires. The caller should rewrite the user request into an explicit future instruction, including which tool to use when relevant (for example: "请调用 bot_notify_send_message 发送消息：..."), rather than storing a terse slash command or ambiguous user wording. Leading slashes are treated as normal message text by default.' },
                scheduleType: { type: 'string', enum: ['once', 'interval'] },
                executeAt: { type: 'string', description: 'ISO datetime for one-shot schedules.' },
                intervalCount: { type: 'number' },
                intervalUnit: { type: 'string', enum: ['minute', 'hour', 'day', 'week', 'month'] },
                maxRuns: { type: 'number', description: 'Maximum number of executions for interval schedules.' },
                endAt: { type: 'string', description: 'ISO datetime after which interval schedules stop.' },
                timezone: { type: 'string' },
                enabled: { type: 'boolean' },
                description: { type: 'string' },
            },
            required: ['command', 'scheduleType'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_get',
        description: 'Get a scheduled agent task by id.',
        inputSchema: {
            type: 'object',
            properties: { scheduleId: { type: 'string' } },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_list',
        description: 'List scheduled agent tasks in the current domain.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                enabled: { type: 'boolean' },
                includeDeleted: { type: 'boolean' },
                includeEnded: { type: 'boolean' },
                page: { type: 'number' },
                limit: { type: 'number' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_update',
        description: 'Update a scheduled agent task.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string' },
                agentId: { type: 'string' },
                title: { type: 'string' },
                command: { type: 'string', description: 'Self-contained prompt/message to send to the agent when the schedule fires. The caller should rewrite the user request into an explicit future instruction, including which tool to use when relevant (for example: "请调用 bot_notify_send_message 发送消息：..."), rather than storing a terse slash command or ambiguous user wording. Leading slashes are treated as normal message text by default.' },
                scheduleType: { type: 'string', enum: ['once', 'interval'] },
                executeAt: { type: 'string' },
                intervalCount: { type: 'number' },
                intervalUnit: { type: 'string', enum: ['minute', 'hour', 'day', 'week', 'month'] },
                maxRuns: { type: 'number', description: 'Maximum number of executions for interval schedules.' },
                endAt: { type: 'string', description: 'ISO datetime after which interval schedules stop.' },
                timezone: { type: 'string' },
                enabled: { type: 'boolean' },
                description: { type: 'string' },
            },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_delete',
        description: 'Soft-delete a scheduled agent task and remove its pending trigger.',
        inputSchema: {
            type: 'object',
            properties: { scheduleId: { type: 'string' } },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_pause',
        description: 'Pause a scheduled agent task and remove its pending trigger.',
        inputSchema: {
            type: 'object',
            properties: { scheduleId: { type: 'string' } },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_resume',
        description: 'Resume a paused scheduled agent task and enqueue its next trigger.',
        inputSchema: {
            type: 'object',
            properties: { scheduleId: { type: 'string' } },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_history',
        description: 'List scheduled agent task execution history with links to record/session details when available.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string' },
                agentId: { type: 'string' },
                status: { type: 'string', enum: ['queued', 'running', 'success', 'error', 'skipped'] },
                page: { type: 'number' },
                limit: { type: 'number' },
            },
            additionalProperties: false,
        },
    },
];

export function isScheduleSystemTool(name: string): boolean {
    return SCHEDULE_SYSTEM_TOOL_NAMES.has(name);
}

export function isScheduleSystemToolMutating(name: string): boolean {
    return new Set(['schedule_create', 'schedule_update', 'schedule_delete', 'schedule_pause', 'schedule_resume']).has(name);
}

function requireContext(context?: SystemToolExecutionContext): { domainId: string; owner: number } {
    if (!context?.domainId) throw new Error('Schedule tool requires a domain execution context.');
    const owner = Number(context.owner);
    if (!Number.isFinite(owner) || owner <= 0) throw new Error('Schedule tool requires a positive caller/owner context.');
    return { domainId: context.domainId, owner };
}

function scheduleUrl(domainId: string, path = '/schedule'): string {
    return `/d/${domainId}${path}`;
}

function objectIdString(id?: ObjectId): string | undefined {
    return id?.toHexString?.();
}

function scheduleToWire(domainId: string, doc: AgentScheduleDoc) {
    return {
        id: doc._id.toHexString(),
        scheduleId: doc._id.toHexString(),
        domainId: doc.domainId,
        uid: doc.uid,
        agentId: doc.agentId,
        title: doc.title,
        command: doc.command,
        enabled: doc.enabled,
        scheduleType: doc.scheduleType,
        executeAt: doc.executeAt?.toISOString?.(),
        intervalCount: doc.intervalCount,
        intervalUnit: doc.intervalUnit,
        maxRuns: doc.maxRuns,
        endAt: doc.endAt?.toISOString?.(),
        timezone: doc.timezone,
        nextRunAt: doc.nextRunAt?.toISOString?.(),
        lastRunAt: doc.lastRunAt?.toISOString?.(),
        lastRunStatus: doc.lastRunStatus,
        lastRunId: objectIdString(doc.lastRunId),
        runCount: doc.runCount,
        endedAt: doc.endedAt?.toISOString?.(),
        endReason: doc.endReason,
        deletedAt: doc.deletedAt?.toISOString?.(),
        scheduleUrl: scheduleUrl(domainId, `/schedule?scheduleId=${encodeURIComponent(doc._id.toHexString())}`),
        historyUrl: scheduleUrl(domainId, `/schedule/history?scheduleId=${encodeURIComponent(doc._id.toHexString())}`),
    };
}

function runToWire(domainId: string, run: AgentScheduleRunDoc) {
    const rid = run.recordId?.toHexString?.();
    const sid = run.agentChatSessionId?.toHexString?.();
    return {
        id: run._id.toHexString(),
        runId: run._id.toHexString(),
        scheduleId: run.scheduleId.toHexString(),
        domainId: run.domainId,
        uid: run.uid,
        agentId: run.agentId,
        command: run.command,
        plannedAt: run.plannedAt?.toISOString?.(),
        queuedAt: run.queuedAt?.toISOString?.(),
        completedAt: run.completedAt?.toISOString?.(),
        status: run.status,
        taskId: objectIdString(run.taskId),
        recordId: rid,
        agentChatSessionId: sid,
        error: run.error,
        recordUrl: rid ? scheduleUrl(domainId, `/record/${encodeURIComponent(rid)}`) : undefined,
        sessionUrl: sid ? scheduleUrl(domainId, `/session/chat/${encodeURIComponent(sid)}`) : undefined,
    };
}

function listFilter(args: Record<string, unknown>, owner: number) {
    const filter: Record<string, unknown> = { uid: owner };
    if (typeof args.agentId === 'string' && args.agentId.trim()) filter.agentId = args.agentId.trim();
    if (typeof args.enabled === 'boolean') filter.enabled = args.enabled;
    return filter;
}

function historyFilter(args: Record<string, unknown>, owner: number) {
    const filter: Record<string, unknown> = { uid: owner };
    if (typeof args.scheduleId === 'string' && ObjectId.isValid(args.scheduleId)) filter.scheduleId = new ObjectId(args.scheduleId);
    if (typeof args.agentId === 'string' && args.agentId.trim()) filter.agentId = args.agentId.trim();
    if (typeof args.status === 'string' && args.status.trim()) filter.status = args.status.trim();
    return filter;
}

export async function executeScheduleSystemTool(
    name: string,
    args: Record<string, unknown> = {},
    context?: SystemToolExecutionContext,
): Promise<unknown> {
    const { domainId, owner } = requireContext(context);
    const a = args || {};
    if (name === 'schedule_create') {
        const doc = await AgentScheduleModel().create(domainId, {
            uid: owner,
            agentId: String(a.agentId || (a as any).__agentId || ''),
            title: typeof a.title === 'string' ? a.title : undefined,
            command: String(a.command || ''),
            scheduleType: a.scheduleType as any,
            executeAt: a.executeAt as any,
            intervalCount: Number(a.intervalCount || 1),
            intervalUnit: a.intervalUnit as any,
            maxRuns: a.maxRuns === undefined ? undefined : Number(a.maxRuns),
            endAt: a.endAt as any,
            timezone: typeof a.timezone === 'string' ? a.timezone : undefined,
            enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined,
            description: typeof a.description === 'string' ? a.description : undefined,
            source: 'system_tool',
        });
        return { ok: true, schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_get') {
        const doc = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!doc || doc.uid !== owner) throw new Error('Schedule not found');
        return { schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_list') {
        const res = await AgentScheduleModel().list(domainId, listFilter(a, owner), {
            page: Number(a.page || 1),
            limit: Number(a.limit || 20),
            includeDeleted: a.includeDeleted === true,
            includeEnded: a.includeEnded === true,
        });
        return {
            schedules: res.rows.map((doc) => scheduleToWire(domainId, doc)),
            count: res.count,
            page: res.page,
            limit: res.limit,
            scheduleUrl: scheduleUrl(domainId),
            historyUrl: scheduleUrl(domainId, '/schedule/history'),
        };
    }
    if (name === 'schedule_update') {
        const cur = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!cur || cur.uid !== owner) throw new Error('Schedule not found');
        const doc = await AgentScheduleModel().update(domainId, cur._id, a as any);
        return { ok: true, schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_delete') {
        const cur = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!cur || cur.uid !== owner) throw new Error('Schedule not found');
        await AgentScheduleModel().softDelete(domainId, cur._id);
        return { ok: true, scheduleId: cur._id.toHexString() };
    }
    if (name === 'schedule_pause') {
        const cur = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!cur || cur.uid !== owner) throw new Error('Schedule not found');
        const doc = await AgentScheduleModel().pause(domainId, cur._id);
        return { ok: true, schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_resume') {
        const cur = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!cur || cur.uid !== owner) throw new Error('Schedule not found');
        const doc = await AgentScheduleModel().resume(domainId, cur._id);
        return { ok: true, schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_history') {
        const res = await AgentScheduleModel().history(domainId, historyFilter(a, owner), {
            page: Number(a.page || 1),
            limit: Number(a.limit || 20),
        });
        return {
            runs: res.rows.map((run) => runToWire(domainId, run)),
            count: res.count,
            page: res.page,
            limit: res.limit,
            historyUrl: scheduleUrl(domainId, '/schedule/history'),
        };
    }
    throw new Error(`Unknown schedule tool: ${name}`);
}


// ---- localSystemTools ----
export type LocalMcpToolSource = 'system' | 'schedule' | 'market_mcp';

export interface LocalMcpToolEntry extends SystemToolCatalogEntry {
    id: string;
    source: LocalMcpToolSource;
    defaultEnabled: boolean;
    requiresBaseContext?: boolean;
    mutating?: boolean;
}

const defaultSystemToolEntries: LocalMcpToolEntry[] = MCP_BUILTIN_TOOLS_CATALOG.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: `${tool.description}\n\nRequires an Ejunz base-bound execution context.`,
    inputSchema: tool.inputSchema,
    source: 'system',
    defaultEnabled: true,
    requiresBaseContext: true,
    mutating: isMcpBuiltinMutatingTool(tool.name),
}));

const scheduleSystemToolEntries: LocalMcpToolEntry[] = SCHEDULE_SYSTEM_TOOLS_CATALOG.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: `${tool.description}\n\nRequires a domain execution context.`,
    inputSchema: tool.inputSchema,
    source: 'system',
    defaultEnabled: true,
    requiresBaseContext: false,
    mutating: isScheduleSystemToolMutating(tool.name),
}));

const marketMcpToolEntries: LocalMcpToolEntry[] = SYSTEM_TOOLS_CATALOG.map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    source: 'market_mcp',
    defaultEnabled: false,
}));

const localMcpToolCatalog: LocalMcpToolEntry[] = (() => {
    const out: LocalMcpToolEntry[] = [];
    const seen = new Set<string>();
    for (const tool of [...defaultSystemToolEntries, ...scheduleSystemToolEntries, ...marketMcpToolEntries]) {
        const key = tool.id || tool.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(tool);
    }
    return out;
})();

export function getLocalSystemToolCatalog(): LocalMcpToolEntry[] {
    return [...defaultSystemToolEntries, ...scheduleSystemToolEntries];
}

export function getLocalMcpToolCatalog(): LocalMcpToolEntry[] {
    return localMcpToolCatalog;
}

export function getMarketMcpTools(): LocalMcpToolEntry[] {
    return marketMcpToolEntries;
}

export function findLocalMcpToolByIdOrName(idOrName: string): LocalMcpToolEntry | undefined {
    return localMcpToolCatalog.find((tool) => tool.id === idOrName || tool.name === idOrName);
}

export function findLocalSystemToolByIdOrName(idOrName: string): LocalMcpToolEntry | undefined {
    return getLocalSystemToolCatalog().find((tool) => tool.id === idOrName || tool.name === idOrName);
}

export function isDefaultLocalSystemTool(toolKey: string): boolean {
    return findLocalSystemToolByIdOrName(toolKey)?.defaultEnabled === true;
}

export async function isLocalMcpToolAvailableInDomain(domainId: string, toolKeyOrName: string): Promise<boolean> {
    const entry = findLocalMcpToolByIdOrName(toolKeyOrName);
    if (!entry) return false;
    if (entry.source === 'system') return true;
    return DomainMarketToolModel.has(domainId, entry.id);
}

export async function isLocalSystemToolAvailableInDomain(_domainId: string, toolKeyOrName: string): Promise<boolean> {
    return !!findLocalSystemToolByIdOrName(toolKeyOrName);
}

function requireMcpToolContext(entry: LocalMcpToolEntry, context?: SystemToolExecutionContext): McpToolContext {
    if (!context?.domainId) {
        throw new Error(`Editor MCP tool requires a domain execution context: ${entry.name}`);
    }
    if (!context?.baseDocId) {
        throw new Error(`Editor MCP tool requires an agent knowledge-base binding: ${entry.name}`);
    }
    if (!context?.owner) {
        throw new Error(`Editor MCP tool requires a positive caller/owner context: ${entry.name}`);
    }
    return {
        domainId: context.domainId,
        baseDocId: context.baseDocId,
        branch: context.branch || 'main',
        owner: context.owner,
        setting: context.setting,
    };
}

export async function executeLocalSystemTool(
    name: string,
    args: Record<string, unknown>,
    context?: SystemToolExecutionContext,
): Promise<unknown> {
    const entry = findLocalSystemToolByIdOrName(name);
    if (!entry) throw new Error(`Unknown system tool: ${name}`);
    if (entry.source === 'schedule' || isScheduleSystemTool(entry.name)) {
        return executeScheduleSystemTool(entry.name, args || {}, context);
    }
    return executeMcpBuiltinTool(requireMcpToolContext(entry, context), entry.name, args || {});
}

export async function executeLocalMcpTool(
    name: string,
    args: Record<string, unknown>,
    context?: SystemToolExecutionContext,
): Promise<unknown> {
    const entry = findLocalMcpToolByIdOrName(name);
    if (!entry) throw new Error(`Unknown System Tools tool: ${name}`);
    if (entry.source === 'system') return executeLocalSystemTool(entry.name, args, context);
    if (!context?.domainId || !(await DomainMarketToolModel.has(context.domainId, entry.id))) {
        const err = new Error(`Tool not added: ${entry.name}. Please add it from the MCP Market for this domain.`);
        (err as any).code = 'TOOL_NOT_ADDED';
        throw err;
    }
    return executeEjunzMarketMcpTool(entry.id, args || {});
}


// ---- ejunzToolsMcp ----
export interface EjunzToolsRuntimeInfo {
    packageName?: string;
    provider?: 'ejunztools';
    mode?: 'builtin' | 'ws';
    version?: string;
    label?: string;
    toolCount?: number;
    startedAt?: Date;
}

const PACKAGE_NAME = '@ejunz/ejunztools';
const DEFAULT_LABEL = 'Ejunz Tools';

let builtinRuntime: EjunzToolsRuntimeInfo | null = null;

function packageVersion() {
    try {
        return require('@ejunz/ejunztools/package.json').version;
    } catch {
        return 'unknown';
    }
}

export function registerBuiltinEjunzToolsRuntime(runtime: EjunzToolsRuntimeInfo) {
    builtinRuntime = {
        packageName: PACKAGE_NAME,
        provider: 'ejunztools',
        mode: 'builtin',
        label: DEFAULT_LABEL,
        version: packageVersion(),
        toolCount: SYSTEM_TOOLS_CATALOG.length,
        ...runtime,
    };
    (globalThis as any).__ejunzToolsRuntime = builtinRuntime;
    return builtinRuntime;
}

export function getBuiltinEjunzToolsRuntime(): EjunzToolsRuntimeInfo | null {
    const globalRuntime = (globalThis as any).__ejunzToolsRuntime
        || (global as any).Ejunz?.ejunzToolsRuntime;
    if (globalRuntime?.provider === 'ejunztools' || globalRuntime?.packageName === PACKAGE_NAME) {
        return registerBuiltinEjunzToolsRuntime(globalRuntime);
    }
    return builtinRuntime;
}

export function getBuiltinEjunzToolsVersion() {
    return getBuiltinEjunzToolsRuntime()?.version || process.env.EJUNZ_TOOLS_VERSION || packageVersion();
}

export function getBuiltinEjunzToolsLabel() {
    return getBuiltinEjunzToolsRuntime()?.label || DEFAULT_LABEL;
}

export function getEjunzToolsCatalog() {
    return SYSTEM_TOOLS_CATALOG;
}

export async function executeBuiltinEjunzToolsTool(name: string, args: Record<string, unknown>) {
    return executeEjunzToolsSystemTool(name, args || {});
}

export function applyEjunzToolsMcpRuntime(ctx: any) {
    (ctx as any).on?.('ejunztools/runtime/register', (runtime: EjunzToolsRuntimeInfo) => {
        registerBuiltinEjunzToolsRuntime(runtime);
    });
}


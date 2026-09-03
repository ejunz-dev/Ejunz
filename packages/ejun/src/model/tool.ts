import { ObjectId } from 'mongodb';
import { SYSTEM_TOOLS_CATALOG, executeSystemTool as executeEjunzMarketMcpTool, executeSystemTool as executeEjunzToolsSystemTool } from '@ejunz/ejunztools';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import type { ToolDoc } from '../interface';
import EdgeModel from './edge';
import DomainMarketToolModel from './domain_market_tool';
import { BaseModel } from './base';
import type { EmbeddingService } from '../service/embedding';
import type { ToolContext, SystemToolExecutionContext, ToolArgs } from '../tool/types';
import * as baseCreateTool from '../tool/base/create';
import * as baseDeleteTool from '../tool/base/delete';
import * as baseGetTool from '../tool/base/get';
import * as baseListTool from '../tool/base/list';
import * as baseSearchTool from '../tool/base/search';
import * as baseUpdateTool from '../tool/base/update';
import * as baseSemanticSearchTool from '../tool/base/semantic-search';
import * as cardCreateTool from '../tool/base/card/create';
import * as cardDeleteTool from '../tool/base/card/delete';
import * as cardGetTool from '../tool/base/card/get';
import * as cardUpdateTool from '../tool/base/card/update';
import * as fileCreateTool from '../tool/base/file/create';
import * as fileDeleteTool from '../tool/base/file/delete';
import * as fileGetTool from '../tool/base/file/get';
import * as fileListTool from '../tool/base/file/list';
import * as gitCommitTool from '../tool/base/git/commit';
import * as gitConfigGetTool from '../tool/base/git/config-get';
import * as gitConfigSetTool from '../tool/base/git/config-set';
import * as gitPullTool from '../tool/base/git/pull';
import * as gitPushTool from '../tool/base/git/push';
import * as gitStatusTool from '../tool/base/git/status';
import * as nodeCreateTool from '../tool/base/node/create';
import * as nodeDeleteTool from '../tool/base/node/delete';
import * as nodeGetTool from '../tool/base/node/get';
import * as nodeUpdateTool from '../tool/base/node/update';
import * as problemCreateTool from '../tool/base/problem/create';
import * as problemDeleteTool from '../tool/base/problem/delete';
import * as problemGetTool from '../tool/base/problem/get';
import * as problemListTool from '../tool/base/problem/list';
import * as problemUpdateTool from '../tool/base/problem/update';
import * as scheduleCreateTool from '../tool/schedule/create';
import * as scheduleDeleteTool from '../tool/schedule/delete';
import * as scheduleGetTool from '../tool/schedule/get';
import * as scheduleHistoryTool from '../tool/schedule/history';
import * as scheduleListTool from '../tool/schedule/list';
import * as schedulePauseTool from '../tool/schedule/pause';
import * as scheduleResumeTool from '../tool/schedule/resume';
import * as scheduleUpdateTool from '../tool/schedule/update';

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
export type { ToolContext } from '../tool/types';

export interface ToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

export const BUILTIN_TOOLS_CATALOG: ToolDef[] = [
    {
        name: 'base_create',
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
        description: 'List all Ejunz Bases in the current domain.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'base_search',
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
    {
        name: 'node_file_list',
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

export async function buildMcpInstructions(
    ctx: { domainId: string; baseDocId?: number },
): Promise<string> {
    const lines: string[] = [
        'This MCP server operates in the current Ejunz domain. Base content tools use a selected Base, while base_list and base_search discover Bases in the domain.',
        '',
        'Concepts:',
        '- Node: a section/topic in the base\'s node tree. Nodes form a hierarchy via parentId/level. Each node has an id and text (title).',
        '- Card: a content block (title + markdown body) attached to a node. One node can hold multiple ordered cards.',
        '- Problem: a practice exercise (quiz, flip card, matching, etc.) attached to a card. Types: single, multi, true_false, flip, fill_blank, matching, super_flip, chain, ai_eval.',
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
            `This endpoint is bound to base #${ctx.baseDocId}${title ? ` "${title}"` : ''}. `
            + 'Node, card, problem, file, and Git tools operate within this base unless documented otherwise. '
            + 'base_get, base_update, and base_delete take an explicit baseId.',
        );
    }
    lines.push(
        '',
        'Typical workflow:',
        '1. base_list() or base_search(query) — find a Base in the current domain.',
        '2. base_get(baseId) — inspect the selected Base before modifying it.',
        '3. semantic_search(query) — find content by meaning (vector/embedding search across node titles and card content).',
        '4. Use create/update/delete tools to modify nodes, cards, and problems when you already know their ids.',
        '5. git_status — check local/remote sync; git_commit / git_push / git_pull — sync with GitHub (configure repo via git_config_set).',
    );
    return lines.join('\n');
}

const BUILTIN_MUTATING_TOOLS = new Set([
    'base_create', 'base_update', 'base_delete',
    'node_create', 'node_update', 'node_delete',
    'card_create', 'card_update', 'card_delete',
    'node_file_create', 'node_file_delete',
    'problem_create', 'problem_update', 'problem_delete',
    'git_pull', 'git_config_set',
]);

export function isBuiltinTool(name: string): boolean {
    return BUILTIN_TOOLS_CATALOG.some((t) => t.name === name);
}

export function isBuiltinMutatingTool(name: string): boolean {
    return BUILTIN_MUTATING_TOOLS.has(name);
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

export async function executeBuiltinTool(
    ctx: ToolContext,
    name: string,
    args: ToolArgs,
): Promise<unknown> {
    if (name === 'base_create') return baseCreateTool.execute(ctx, args);
    if (name === 'base_list') return baseListTool.execute(ctx, args);
    if (name === 'base_search') return baseSearchTool.execute(ctx, args);

    const requestedBaseId = ['base_get', 'base_update', 'base_delete'].includes(name) ? Number(args.baseId) : ctx.baseDocId;
    const baseDocId = Number.isSafeInteger(requestedBaseId) && requestedBaseId > 0 ? requestedBaseId : 0;
    if (!baseDocId) throw new Error(['base_get', 'base_update', 'base_delete'].includes(name) ? 'baseId is required' : 'This MCP endpoint is not bound to a base.');
    const toolContext = baseDocId === ctx.baseDocId ? ctx : { ...ctx, baseDocId };

    switch (name) {
    case 'base_get': return baseGetTool.execute(toolContext, args);
    case 'base_update': return baseUpdateTool.execute(toolContext, args);
    case 'base_delete': return baseDeleteTool.execute(toolContext, args);
    case 'node_create': return nodeCreateTool.execute(toolContext, args);
    case 'node_update': return nodeUpdateTool.execute(toolContext, args);
    case 'node_get': return nodeGetTool.execute(toolContext, args);
    case 'node_delete': return nodeDeleteTool.execute(toolContext, args);
    case 'card_create': return cardCreateTool.execute(toolContext, args);
    case 'card_get': return cardGetTool.execute(toolContext, args);
    case 'card_update': return cardUpdateTool.execute(toolContext, args);
    case 'card_delete': return cardDeleteTool.execute(toolContext, args);
    case 'semantic_search': return baseSemanticSearchTool.execute(toolContext, args);
    case 'problem_list': return problemListTool.execute(toolContext, args);
    case 'problem_get': return problemGetTool.execute(toolContext, args);
    case 'problem_create': return problemCreateTool.execute(toolContext, args);
    case 'problem_update': return problemUpdateTool.execute(toolContext, args);
    case 'problem_delete': return problemDeleteTool.execute(toolContext, args);
    case 'git_status': return gitStatusTool.execute(toolContext, args);
    case 'git_commit': return gitCommitTool.execute(toolContext, args);
    case 'git_push': return gitPushTool.execute(toolContext, args);
    case 'git_pull': return gitPullTool.execute(toolContext, args);
    case 'git_config_get': return gitConfigGetTool.execute(toolContext, args);
    case 'git_config_set': return gitConfigSetTool.execute(toolContext, args);
    case 'node_file_list': return fileListTool.execute(toolContext, args);
    case 'node_file_get': return fileGetTool.execute(toolContext, args);
    case 'node_file_delete': return fileDeleteTool.execute(toolContext, args);
    case 'node_file_create': return fileCreateTool.execute(toolContext, args);
    default: throw new Error(`Unknown tool: ${name}`);
    }
}

export const executeBaseTool = executeBuiltinTool

// ---- systemTools ----
/**
 * System-tool adapter: core delegates to plugins (e.g. @ejunz/ejunztools) for catalog + executor.
 * Core does not hard-code packages; getSystemToolCatalog / executeSystemTool / tryExecuteSystemTool use registration.
 */

const systemToolsLogger = new Logger('systemTools');

export type SystemToolCatalogEntry = { name: string; description: string; inputSchema: any };
export type { SystemToolExecutionContext } from '../tool/types';
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
    systemToolsLogger.info('[diag] executeSystemTool context: name=%s hasContext=%s domainId=%s baseDocId=%s owner=%s hasEmbedding=%s pid=%d NODE_APP_INSTANCE=%s',
        name,
        !!context,
        context?.domainId || '',
        context?.baseDocId || '',
        context?.owner || '',
        !!context?.embedding,
        process.pid,
        process.env.NODE_APP_INSTANCE || '',
    );
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
    systemToolsLogger.info('[diag] tryExecuteSystemTool context: name=%s hasContext=%s domainId=%s baseDocId=%s owner=%s hasEmbedding=%s pid=%d NODE_APP_INSTANCE=%s',
        name,
        !!context,
        context?.domainId || '',
        context?.baseDocId || '',
        context?.owner || '',
        !!context?.embedding,
        process.pid,
        process.env.NODE_APP_INSTANCE || '',
    );
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

export async function executeScheduleSystemTool(
    name: string,
    args: Record<string, unknown> = {},
    context?: SystemToolExecutionContext,
): Promise<unknown> {
    switch (name) {
    case 'schedule_create': return scheduleCreateTool.execute(args, context);
    case 'schedule_get': return scheduleGetTool.execute(args, context);
    case 'schedule_list': return scheduleListTool.execute(args, context);
    case 'schedule_update': return scheduleUpdateTool.execute(args, context);
    case 'schedule_delete': return scheduleDeleteTool.execute(args, context);
    case 'schedule_pause': return schedulePauseTool.execute(args, context);
    case 'schedule_resume': return scheduleResumeTool.execute(args, context);
    case 'schedule_history': return scheduleHistoryTool.execute(args, context);
    default: throw new Error(`Unknown schedule tool: ${name}`);
    }
}


// ---- localSystemTools ----
export type LocalToolSource = 'system' | 'schedule' | 'market_mcp';

export interface LocalToolEntry extends SystemToolCatalogEntry {
    id: string;
    source: LocalToolSource;
    defaultEnabled: boolean;
    requiresBaseContext?: boolean;
    mutating?: boolean;
}

const defaultSystemToolEntries: LocalToolEntry[] = BUILTIN_TOOLS_CATALOG.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: `${tool.description}\n\nRequires an Ejunz base-bound execution context.`,
    inputSchema: tool.inputSchema,
    source: 'system',
    defaultEnabled: true,
    requiresBaseContext: true,
    mutating: isBuiltinMutatingTool(tool.name),
}));

const scheduleSystemToolEntries: LocalToolEntry[] = SCHEDULE_SYSTEM_TOOLS_CATALOG.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: `${tool.description}\n\nRequires a domain execution context.`,
    inputSchema: tool.inputSchema,
    source: 'system',
    defaultEnabled: true,
    requiresBaseContext: false,
    mutating: isScheduleSystemToolMutating(tool.name),
}));

const marketMcpToolEntries: LocalToolEntry[] = SYSTEM_TOOLS_CATALOG.map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    source: 'market_mcp',
    defaultEnabled: false,
}));

const localToolCatalog: LocalToolEntry[] = (() => {
    const out: LocalToolEntry[] = [];
    const seen = new Set<string>();
    for (const tool of [...defaultSystemToolEntries, ...scheduleSystemToolEntries, ...marketMcpToolEntries]) {
        const key = tool.id || tool.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(tool);
    }
    return out;
})();

export function getLocalSystemToolCatalog(): LocalToolEntry[] {
    return [...defaultSystemToolEntries, ...scheduleSystemToolEntries];
}

export function getLocalToolCatalog(): LocalToolEntry[] {
    return localToolCatalog;
}

export function getMarketTools(): LocalToolEntry[] {
    return marketMcpToolEntries;
}

export function findLocalToolByIdOrName(idOrName: string): LocalToolEntry | undefined {
    return localToolCatalog.find((tool) => tool.id === idOrName || tool.name === idOrName);
}

export function findLocalSystemToolByIdOrName(idOrName: string): LocalToolEntry | undefined {
    return getLocalSystemToolCatalog().find((tool) => tool.id === idOrName || tool.name === idOrName);
}

export function isDefaultLocalSystemTool(toolKey: string): boolean {
    return findLocalSystemToolByIdOrName(toolKey)?.defaultEnabled === true;
}

export async function isLocalToolAvailableInDomain(domainId: string, toolKeyOrName: string): Promise<boolean> {
    const entry = findLocalToolByIdOrName(toolKeyOrName);
    if (!entry) return false;
    if (entry.source === 'system') return true;
    return DomainMarketToolModel.has(domainId, entry.id);
}

export async function isLocalSystemToolAvailableInDomain(_domainId: string, toolKeyOrName: string): Promise<boolean> {
    return !!findLocalSystemToolByIdOrName(toolKeyOrName);
}

function requireToolContext(entry: LocalToolEntry, context?: SystemToolExecutionContext): ToolContext {
    if (!context?.domainId) {
        throw new Error(`Editor MCP tool requires a domain execution context: ${entry.name}`);
    }
    if (!context?.baseDocId) {
        throw new Error(`Editor MCP tool requires an agent knowledge-base binding: ${entry.name}`);
    }
    if (!context?.owner) {
        throw new Error(`Editor MCP tool requires a positive caller/owner context: ${entry.name}`);
    }
    const fallbackEmbedding = require('../service/embedding').getEmbeddingService?.();
    const embedding = context.embedding || fallbackEmbedding;
    systemToolsLogger.info('[diag] requireToolContext: tool=%s hasContextEmbedding=%s hasFallbackEmbedding=%s finalHasEmbedding=%s domainId=%s baseDocId=%s owner=%s pid=%d NODE_APP_INSTANCE=%s',
        entry.name,
        !!context.embedding,
        !!fallbackEmbedding,
        !!embedding,
        context.domainId,
        context.baseDocId,
        context.owner,
        process.pid,
        process.env.NODE_APP_INSTANCE || '',
    );
    return {
        domainId: context.domainId,
        baseDocId: context.baseDocId,
        owner: context.owner,
        setting: context.setting,
        embedding,
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
    return executeBuiltinTool(requireToolContext(entry, context), entry.name, args || {});
}

export async function executeLocalTool(
    name: string,
    args: Record<string, unknown>,
    context?: SystemToolExecutionContext,
): Promise<unknown> {
    const entry = findLocalToolByIdOrName(name);
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


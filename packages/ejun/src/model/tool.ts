import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { Logger } from '../logger';
import * as document from './document';
import type { ToolDoc } from '../interface';
import EdgeModel from './edge';

const logger = new Logger('model/tool');

class ToolModel {
    static async generateNextToolId(domainId: string, token: string): Promise<number> {
        const lastTool = await document.getMulti(domainId, document.TYPE_TOOL, { token })
            .sort({ toolId: -1 })
            .limit(1)
            .project({ toolId: 1 })
            .toArray();
        return (lastTool[0]?.toolId || 0) + 1;
    }

    static async add(
        tool: Partial<ToolDoc> & {
            domainId: string;
            token: string;
            edgeDocId: ObjectId;
            name: string;
            description: string;
            inputSchema: ToolDoc['inputSchema'];
            owner: number;
        },
    ): Promise<ToolDoc> {
        const toolId = await this.generateNextToolId(tool.domainId, tool.token);
        const now = new Date();
        
        const payload: Partial<ToolDoc> = {
            domainId: tool.domainId,
            token: tool.token,
            edgeDocId: tool.edgeDocId,
            toolId,
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
        const edge = await EdgeModel.getByToken(tool.domainId, tool.token);
        if (edge) {
            const toolsCount = await this.countByToken(tool.domainId, tool.token);
            await EdgeModel.update(tool.domainId, edge.edgeId, { toolsCount });
        }

        return await this.getByToolId(tool.domainId, tool.token, toolId) as ToolDoc;
    }

    static async get(_id: ObjectId): Promise<ToolDoc | null> {
        const doc = await document.coll.findOne({ _id });
        if (!doc) return null;
        return await this.getByToolId(doc.domainId, doc.token, doc.toolId);
    }

    static async getByToken(domainId: string, token: string): Promise<ToolDoc[]> {
        return await document.getMulti(domainId, document.TYPE_TOOL, { token }).toArray() as ToolDoc[];
    }

    static async getByEdgeDocId(domainId: string, edgeDocId: ObjectId): Promise<ToolDoc[]> {
        return await document.getMulti(domainId, document.TYPE_TOOL, { edgeDocId }).toArray() as ToolDoc[];
    }

    static async update(domainId: string, token: string, toolId: number, update: Partial<ToolDoc>): Promise<ToolDoc> {
        const tool = await this.getByToolId(domainId, token, toolId);
        if (!tool) throw new Error('Tool not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_TOOL, tool.docId, $set) as ToolDoc;
    }

    static async del(domainId: string, token: string, toolId: number) {
        const tool = await this.getByToolId(domainId, token, toolId);
        if (!tool) return;
        await document.deleteOne(domainId, document.TYPE_TOOL, tool.docId);
        
        // 更新 Edge 的工具数量
        const edge = await EdgeModel.getByToken(domainId, token);
        if (edge) {
            const toolsCount = await this.countByToken(domainId, token);
            await EdgeModel.update(domainId, edge.edgeId, { toolsCount });
        }
    }

    static async deleteByToken(domainId: string, token: string) {
        return await document.deleteMulti(domainId, document.TYPE_TOOL, { token });
    }

    static async getByToolId(domainId: string, token: string, toolId: number): Promise<ToolDoc | null> {
        const tools = await document.getMulti(domainId, document.TYPE_TOOL, { token, toolId })
            .limit(1)
            .toArray();
        return (tools[0] as ToolDoc) || null;
    }

    static async countByToken(domainId: string, token: string): Promise<number> {
        return await document.count(domainId, document.TYPE_TOOL, { token });
    }

    // Clean up duplicate tools (keep only the one with smallest toolId for each tool name)
    static async cleanupDuplicates(domainId: string, token: string): Promise<number> {
        const existingTools = await this.getByToken(domainId, token);
        
        const sortedTools = existingTools.sort((a, b) => a.toolId - b.toolId);
        
        const toolNameToFirstId = new Map<string, number>();
        const duplicateToolIds: number[] = [];
        
        for (const tool of sortedTools) {
            if (!toolNameToFirstId.has(tool.name)) {
                toolNameToFirstId.set(tool.name, tool.toolId);
            } else {
                duplicateToolIds.push(tool.toolId);
                logger.warn('Found duplicate tool: %s (toolId: %d), will be removed (keeping toolId: %d)', 
                    tool.name, tool.toolId, toolNameToFirstId.get(tool.name));
            }
        }
        
        let deletedCount = 0;
        for (const toolId of duplicateToolIds) {
            await this.del(domainId, token, toolId);
            deletedCount++;
        }
        
        if (deletedCount > 0) {
            logger.info('Cleaned up %d duplicate tools: token=%s', deletedCount, token);
            const toolsCount = await this.countByToken(domainId, token);
            const edge = await EdgeModel.getByToken(domainId, token);
            if (edge) {
                await EdgeModel.update(domainId, edge.edgeId, { toolsCount });
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
                    logger.warn('Tool %s already exists (toolId: %d), updating instead of creating', tool.name, existing.toolId);
                    await this.update(domainId, token, existing.toolId, {
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
                    await this.update(domainId, token, existingTool.toolId, {
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
                logger.info('Removing tool that no longer exists: %s (toolId: %d)', existingTool.name, existingTool.toolId);
                await this.del(domainId, token, existingTool.toolId);
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
            await EdgeModel.update(domainId, edge.edgeId, { toolsCount });
        }
        
        logger.info('Tools sync completed: token=%s, toolsCount=%d', token, toolsCount);
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


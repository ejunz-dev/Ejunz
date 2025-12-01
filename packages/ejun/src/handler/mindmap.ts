import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import { Handler, param, route, post, Types, ConnectionHandler } from '../service/server';
import { NotFoundError, ForbiddenError, BadRequestError, ValidationError } from '../error';
import { PRIV, PERM } from '../model/builtin';
import { MindMapModel, CardModel, TYPE_CARD } from '../model/mindmap';
import type { MindMapDoc, MindMapNode, MindMapEdge, CardDoc, MindMapHistoryEntry } from '../interface';
import * as document from '../model/document';
import { exec as execCb } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import system from '../model/system';
import https from 'https';
import parser from '@ejunz/utils/lib/search';
import { Logger } from '../utils';

const exec = promisify(execCb);
const logger = new Logger('mindmap');

/**
 * MindMap Detail Handler
 */
class MindMapDetailHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: ObjectId, mmid: number) {
        const path = this.request.path || '';
        if (path.endsWith('.css.map') || path.endsWith('.js.map') || path.endsWith('.map')) {
            throw new NotFoundError('Static resource');
        }
        
        if (docId) {
            this.mindMap = await MindMapModel.get(domainId, docId);
            if (!this.mindMap && mmid) {
                // 如果通过 docId 找不到，尝试通过 mmid 查找
                console.log(`[MindMap Detail] Not found by docId ${docId.toString()}, trying mmid ${mmid}`);
                this.mindMap = await MindMapModel.getByMmid(domainId, mmid);
            }
        } else if (mmid) {
            this.mindMap = await MindMapModel.getByMmid(domainId, mmid);
        }
        
        if (!this.mindMap) {
            // 尝试在所有 domain 中查找（用于调试）
            if (docId) {
                console.log(`[MindMap Detail] Searching in all domains for docId: ${docId.toString()}`);
                try {
                    const allDomains = await document.getMulti('system', document.TYPE_MINDMAP, { docId }).limit(10).toArray();
                    if (allDomains.length > 0) {
                        console.log(`[MindMap Detail] Found mindmap in domains: ${allDomains.map((d: any) => d.domainId).join(', ')}`);
                    }
                } catch (err) {
                    console.error(`[MindMap Detail] Error searching all domains:`, err);
                }
            }
            
            const errorMsg = docId 
                ? `MindMap not found with docId: ${docId.toString()}${mmid ? ` or mmid: ${mmid}` : ''} in domain: ${domainId}`
                : `MindMap not found with mmid: ${mmid} in domain: ${domainId}`;
            console.error(errorMsg);
            throw new NotFoundError('MindMap not found');
        }
        
        await MindMapModel.incrementViews(domainId, this.mindMap.docId);
    }

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, mmid: number, branch?: string) {
        // If no branch parameter, redirect to branch URL
        if (!branch || !String(branch).trim()) {
            const target = this.url('mindmap_detail_branch', { 
                domainId, 
                docId: docId || this.mindMap!.docId, 
                branch: 'main' 
            });
            this.response.redirect = target;
            return;
        }
        
        this.response.template = 'mindmap_detail.html';
        
        // Handle branch parameter
        const requestedBranch = branch;
        const currentMindMapBranch = (this.mindMap as any)?.currentBranch || 'main';
        
        // Update currentBranch if different and checkout git branch
        if (requestedBranch !== currentMindMapBranch) {
            await document.set(domainId, document.TYPE_MINDMAP, this.mindMap!.docId, { 
                currentBranch: requestedBranch 
            });
            (this.mindMap as any).currentBranch = requestedBranch;
            
            // Checkout to the requested branch in git
            try {
                const repoGitPath = getMindMapGitPath(domainId, this.mindMap!.mmid);
                try {
                    await exec('git rev-parse --git-dir', { cwd: repoGitPath });
                    // Git repo exists, checkout to the branch
                    try {
                        await exec(`git checkout ${requestedBranch}`, { cwd: repoGitPath });
                    } catch {
                        // Branch doesn't exist, ensure main exists first, then create it from main
                        try {
                            // Ensure main branch exists
                            try {
                                await exec(`git checkout main`, { cwd: repoGitPath });
                            } catch {
                                try {
                                    await exec(`git checkout -b main`, { cwd: repoGitPath });
                                } catch {
                                    try {
                                        const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
                                        const baseBranch = currentBranch.trim() || 'main';
                                        if (baseBranch !== 'main') {
                                            await exec(`git checkout -b main`, { cwd: repoGitPath });
                                        }
                                    } catch {
                                        // If all else fails, just try to create main branch
                                        await exec(`git checkout -b main`, { cwd: repoGitPath });
                                    }
                                }
                            }
                            // Now create the requested branch from main
                            await exec(`git checkout main`, { cwd: repoGitPath });
                            await exec(`git checkout -b ${requestedBranch}`, { cwd: repoGitPath });
                        } catch {}
                    }
                } catch {
                    // Git repo not initialized, skip
                }
            } catch (err) {
                console.error('Failed to checkout branch:', err);
            }
        }
        
        // Get branches list
        const branches = Array.isArray((this.mindMap as any)?.branches) 
            ? (this.mindMap as any).branches 
            : ['main'];
        if (!branches.includes('main')) {
            branches.unshift('main');
        }
        
        // Get git status
        let gitStatus: any = null;
        const githubRepo = (this.mindMap?.githubRepo || '') as string;
        
        if (githubRepo && githubRepo.trim()) {
            try {
                const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
                const systemValue = system.get('ejunzrepo.github_token');
                const GH_TOKEN = settingValue || systemValue || '';
                
                let REPO_URL = githubRepo;
                if (githubRepo.startsWith('git@')) {
                    REPO_URL = githubRepo;
                } else {
                    if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                        if (!githubRepo.includes('@github.com')) {
                            REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                                .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                        } else {
                            REPO_URL = githubRepo;
                        }
                    } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                        const repoPath = githubRepo.replace('.git', '');
                        REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
                    }
                }
                
                gitStatus = await getMindMapGitStatus(domainId, this.mindMap!.mmid, requestedBranch, REPO_URL);
            } catch (err) {
                console.error('Failed to get git status:', err);
                gitStatus = null;
            }
        } else {
            try {
                gitStatus = await getMindMapGitStatus(domainId, this.mindMap!.mmid, requestedBranch);
            } catch (err) {
                console.error('Failed to get local git status:', err);
                gitStatus = null;
            }
        }
        
        // 获取当前分支的数据
        const branchData = getBranchData(this.mindMap!, requestedBranch);
        
        // 获取所有节点的卡片数据（按节点ID分组）
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        if (branchData.nodes && branchData.nodes.length > 0) {
            for (const node of branchData.nodes) {
                try {
                    const cards = await CardModel.getByNodeId(domainId, this.mindMap!.mmid, node.id);
                    if (cards && cards.length > 0) {
                        nodeCardsMap[node.id] = cards;
                    }
                } catch (err) {
                    console.error(`Failed to get cards for node ${node.id}:`, err);
                }
            }
        }
        
        this.response.body = {
            mindMap: {
                ...this.mindMap,
                nodes: branchData.nodes,
                edges: branchData.edges,
            },
            gitStatus,
            currentBranch: requestedBranch,
            branches,
            nodeCardsMap, // 添加节点卡片映射
        };
    }

}

/**
 * Helper functions for branch data management
 */
function getBranchData(mindMap: MindMapDoc, branch: string): { nodes: MindMapNode[]; edges: MindMapEdge[] } {
    const branchName = branch || 'main';
    
    // 如果存在 branchData，优先使用
    if (mindMap.branchData && mindMap.branchData[branchName]) {
        return {
            nodes: mindMap.branchData[branchName].nodes || [],
            edges: mindMap.branchData[branchName].edges || [],
        };
    }
    
    // 向后兼容：如果 branchData 不存在，使用根节点的 nodes/edges（仅对 main 分支）
    if (branchName === 'main') {
        return {
            nodes: mindMap.nodes || [],
            edges: mindMap.edges || [],
        };
    }
    
    // 其他分支如果没有数据，返回空数组
    return { nodes: [], edges: [] };
}

function setBranchData(mindMap: MindMapDoc, branch: string, nodes: MindMapNode[], edges: MindMapEdge[]): void {
    const branchName = branch || 'main';
    
    if (!mindMap.branchData) {
        mindMap.branchData = {};
    }
    
    mindMap.branchData[branchName] = { nodes, edges };
    
    // 向后兼容：main 分支的数据也保存到根节点
    if (branchName === 'main') {
        mindMap.nodes = nodes;
        mindMap.edges = edges;
    }
}

/**
 * MindMap Study Handler
 */
class MindMapStudyHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: ObjectId, mmid: number) {
        if (docId) {
            this.mindMap = await MindMapModel.get(domainId, docId);
        } else if (mmid) {
            this.mindMap = await MindMapModel.getByMmid(domainId, mmid);
        }
        if (!this.mindMap) throw new NotFoundError('MindMap not found');
    }

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async get(domainId: string, docId: ObjectId, mmid: number) {
        this.response.template = 'mindmap_study.html';
        this.response.body = {
            mindMap: this.mindMap,
        };
    }
}

/**
 * MindMap Create Handler
 */
class MindMapCreateHandler extends Handler {
    async get() {
        this.response.template = 'mindmap_create.html';
        this.response.body = {};
    }

    @param('title', Types.String)
    @param('content', Types.String, true)
    @param('rpid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(
        domainId: string,
        title: string,
        content: string = '',
        rpid?: number,
        branch?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 确保使用正确的 domainId（优先使用 this.args.domainId，因为它来自 ctx.domainId，是最准确的）
        const actualDomainId = this.args.domainId || domainId || 'system';
        console.log(`[MindMap Create] domainId param: ${domainId}, this.args.domainId: ${this.args.domainId}, actualDomainId: ${actualDomainId}`);
        
        const { docId, mmid } = await MindMapModel.create(
            actualDomainId,
            this.user._id,
            title,
            content,
            rpid,
            branch,
            this.request.ip
        );

        console.log(`[MindMap Create] Created mindmap with docId: ${docId.toString()}, mmid: ${mmid}, domainId: ${actualDomainId}`);

        // 验证 mindmap 是否已成功创建
        let createdMindMap = await MindMapModel.get(actualDomainId, docId);
        if (!createdMindMap) {
            // 如果通过 docId 找不到，尝试通过 mmid 查找
            console.log(`[MindMap Create] Not found by docId, trying mmid: ${mmid}`);
            createdMindMap = await MindMapModel.getByMmid(actualDomainId, mmid);
        }
        
        if (!createdMindMap) {
            // 再等待一下，可能是数据库同步延迟
            await new Promise(resolve => setTimeout(resolve, 200));
            createdMindMap = await MindMapModel.get(actualDomainId, docId) || await MindMapModel.getByMmid(actualDomainId, mmid);
        }
        
        if (!createdMindMap) {
            console.error(`[MindMap Create] Failed to find mindmap after creation: docId=${docId.toString()}, mmid=${mmid}, domainId=${actualDomainId}`);
            throw new Error(`Failed to create mindmap: record not found after creation (docId: ${docId.toString()}, mmid: ${mmid}, domainId: ${actualDomainId})`);
        }
        
        console.log(`[MindMap Create] Successfully verified mindmap: docId=${createdMindMap.docId.toString()}, mmid=${createdMindMap.mmid}`);

        // 自动创建 GitHub 仓库（异步处理，不阻塞重定向）
        try {
            await ensureMindMapGitRepo(actualDomainId, mmid);
            
            try {
                await createAndPushToGitHubOrgForMindMap(this, actualDomainId, mmid, title, this.user);
            } catch (err) {
                console.error('Failed to create remote GitHub repo:', err);
                // 即使 GitHub 仓库创建失败，也不影响 mindmap 的使用
            }
        } catch (err) {
            console.error('Failed to create git repo:', err);
            // 即使 git repo 创建失败，也不影响 mindmap 的使用
        }

        this.response.body = { docId, mmid };
        this.response.redirect = this.url('mindmap_detail', { domainId: actualDomainId, docId: docId.toString() });
    }
}

/**
 * MindMap Edit Handler
 */
class MindMapEditHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId)
    async _prepare(domainId: string, docId: ObjectId) {
        this.mindMap = await MindMapModel.get(domainId, docId);
        if (!this.mindMap) throw new NotFoundError('MindMap not found');
        
        if (!this.user.own(this.mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    async get() {
        this.response.template = 'mindmap_edit.html';
        this.response.body = { mindMap: this.mindMap };
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    async postUpdate(
        domainId: string,
        docId: ObjectId,
        title?: string,
        content?: string
    ) {
        const updates: any = {};
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;

        await MindMapModel.update(domainId, docId, updates);
        this.response.body = { docId };
        this.response.redirect = this.url('mindmap_detail', { docId: docId.toString() });
    }

    @param('docId', Types.ObjectId)
    async postDelete(domainId: string, docId: ObjectId) {
        // 检查权限
        if (!this.user.own(this.mindMap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }
        
        await MindMapModel.delete(domainId, docId);
        this.response.body = { success: true };
        this.response.redirect = this.url('mindmap_list');
    }
}

/**
 * MindMap Node Handler
 * 节点操作API
 */
class MindMapNodeHandler extends Handler {
    @param('docId', Types.ObjectId)
    @param('text', Types.String)
    @param('x', Types.Float, true)
    @param('y', Types.Float, true)
    @param('parentId', Types.String, true)
    @param('siblingId', Types.String, true)
    async postAdd(
        domainId: string,
        docId: ObjectId,
        text: string,
        x?: number,
        y?: number,
        parentId?: string,
        siblingId?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        let effectiveParentId: string | undefined = parentId;

        if (siblingId && !parentId) {
            const siblingNode = mindMap.nodes.find(n => n.id === siblingId);
            if (!siblingNode) {
                throw new NotFoundError(`Sibling node not found: ${siblingId}`);
            }
            effectiveParentId = siblingNode.parentId;
        }

        const node: Omit<MindMapNode, 'id'> = {
            text,
            x,
            y,
            parentId: effectiveParentId,
        };

        const newNodeId = await MindMapModel.addNode(
            domainId,
            docId,
            node,
            effectiveParentId
        );

        let edgeSourceId: string;
        let edgeTargetId: string;

        if (siblingId && !parentId) {
            if (!effectiveParentId) {
                this.response.body = { nodeId: newNodeId };
                return;
            }
            edgeSourceId = effectiveParentId;
            edgeTargetId = newNodeId;
        } else if (parentId) {
            edgeSourceId = parentId;
            edgeTargetId = newNodeId;
        } else {
            this.response.body = { nodeId: newNodeId };
            return;
        }

        let edgeId: string | undefined;
        try {
            edgeId = await MindMapModel.addEdge(domainId, docId, {
                source: edgeSourceId,
                target: edgeTargetId,
            });
        } catch (error: any) {
            if (error.message?.includes('already exists')) {
                const mindMapAfter = await MindMapModel.get(domainId, docId);
                const existingEdge = mindMapAfter?.edges.find(
                    e => e.source === edgeSourceId && e.target === edgeTargetId
                );
                if (existingEdge) {
                    edgeId = existingEdge.id;
                }
            } else {
                throw error;
            }
        }

        this.response.body = { 
            nodeId: newNodeId,
            edgeId: edgeId,
            edgeSource: edgeSourceId,
            edgeTarget: edgeTargetId,
        };
    }

    @param('docId', Types.ObjectId)
    @param('nodeId', Types.String)
    @param('text', Types.String, true)
    @param('color', Types.String, true)
    @param('backgroundColor', Types.String, true)
    @param('fontSize', Types.Int, true)
    @param('x', Types.Float, true)
    @param('y', Types.Float, true)
    @param('expanded', Types.Boolean, true)
    async postUpdate(
        domainId: string,
        docId: ObjectId,
        nodeId: string,
        text?: string,
        color?: string,
        backgroundColor?: string,
        fontSize?: number,
        x?: number,
        y?: number,
        expanded?: boolean
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const updates: Partial<MindMapNode> = {};
        if (text !== undefined) updates.text = text;
        if (color !== undefined) updates.color = color;
        if (backgroundColor !== undefined) updates.backgroundColor = backgroundColor;
        if (fontSize !== undefined) updates.fontSize = fontSize;
        if (x !== undefined) updates.x = x;
        if (y !== undefined) updates.y = y;
        if (expanded !== undefined) updates.expanded = expanded;

        await MindMapModel.updateNode(domainId, docId, nodeId, updates);
        this.response.body = { success: true };
    }

    @param('docId', Types.ObjectId)
    @param('nodeId', Types.String)
    async postDelete(domainId: string, docId: ObjectId, nodeId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }

        await MindMapModel.deleteNode(domainId, docId, nodeId);
        this.response.body = { success: true };
    }
}

/**
 * MindMap Edge Handler
 */
class MindMapEdgeHandler extends Handler {
    @param('docId', Types.ObjectId)
    @param('source', Types.String)
    @param('target', Types.String)
    @param('label', Types.String, true)
    async postAdd(
        domainId: string,
        docId: ObjectId,
        source: string,
        target: string,
        label?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const edge: Omit<MindMapEdge, 'id'> = {
            source,
            target,
            label,
        };

        const newEdgeId = await MindMapModel.addEdge(
            domainId,
            docId,
            edge
        );

        this.response.body = { edgeId: newEdgeId };
    }

    @param('docId', Types.ObjectId)
    @param('edgeId', Types.String)
    async postDelete(domainId: string, docId: ObjectId, edgeId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }

        await MindMapModel.deleteEdge(domainId, docId, edgeId);
        this.response.body = { success: true };
    }
}

/**
 * MindMap Save Handler
 */
class MindMapSaveHandler extends Handler {
    @param('docId', Types.ObjectId)
    async post(domainId: string, docId: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = await MindMapModel.get(domainId, docId);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const data = this.request.body || {};
        const { nodes, edges, layout, viewport, theme, operationDescription } = data;
        
        // 获取当前分支
        const currentBranch = (mindMap as any).currentBranch || 'main';
        
        // 获取当前分支的数据用于比较
        const currentBranchData = getBranchData(mindMap, currentBranch);

        // 检测是否有非位置改变（用于commit检测）
        const hasNonPositionChanges = this.detectNonPositionChanges(
            { ...mindMap, nodes: currentBranchData.nodes, edges: currentBranchData.edges },
            nodes,
            edges
        );

        // 记录操作历史
        const historyEntry: MindMapHistoryEntry = {
            id: `hist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: 'save',
            timestamp: new Date(),
            userId: this.user._id,
            username: this.user.uname || 'unknown',
            description: operationDescription || '自动保存',
            snapshot: {
                nodes: JSON.parse(JSON.stringify(nodes || currentBranchData.nodes)),
                edges: JSON.parse(JSON.stringify(edges || currentBranchData.edges)),
                viewport: viewport || mindMap.viewport,
            },
        };

        // 更新历史记录（最多保留50条）
        const history = mindMap.history || [];
        history.unshift(historyEntry);
        if (history.length > 50) {
            history.splice(50);
        }

        // 更新当前分支的数据
        setBranchData(mindMap, currentBranch, nodes || [], edges || []);

        await MindMapModel.updateFull(domainId, docId, {
            branchData: mindMap.branchData,
            nodes: mindMap.nodes, // 向后兼容
            edges: mindMap.edges, // 向后兼容
            layout,
            viewport,
            theme,
            history,
        });
        
        // 如果有非位置改变，立即同步到git（这样git status可以立即检测到）
        if (hasNonPositionChanges) {
            try {
                const updatedMindMap = await MindMapModel.get(domainId, docId);
                if (updatedMindMap) {
                    const branch = updatedMindMap.currentBranch || 'main';
                    await syncMindMapToGit(domainId, updatedMindMap.mmid, branch);
                }
            } catch (err) {
                console.error('Failed to sync to git after save:', err);
                // 不抛出错误，保存仍然成功
            }
        }
        
        // 触发更新事件，通知所有连接的 WebSocket 客户端
        (this.ctx.emit as any)('mindmap/update', docId, mindMap.mmid);
        (this.ctx.emit as any)('mindmap/git/status/update', docId, mindMap.mmid);
        (this.ctx.emit as any)('mindmap/history/update', docId, mindMap.mmid);
        
        this.response.body = { success: true, hasNonPositionChanges };
    }

    /**
     * 检测是否有非位置改变
     */
    private detectNonPositionChanges(
        oldMindMap: MindMapDoc,
        newNodes?: MindMapNode[],
        newEdges?: MindMapEdge[]
    ): boolean {
        if (!newNodes && !newEdges) return false;

        // 检查节点数量变化
        if (newNodes && newNodes.length !== oldMindMap.nodes.length) {
            return true;
        }

        // 检查边数量变化
        if (newEdges && newEdges.length !== oldMindMap.edges.length) {
            return true;
        }

        // 检查节点内容变化（除了位置）
        if (newNodes) {
            for (const newNode of newNodes) {
                const oldNode = oldMindMap.nodes.find(n => n.id === newNode.id);
                if (!oldNode) return true; // 新节点

                // 比较非位置属性
                if (
                    oldNode.text !== newNode.text ||
                    oldNode.color !== newNode.color ||
                    oldNode.backgroundColor !== newNode.backgroundColor ||
                    oldNode.fontSize !== newNode.fontSize ||
                    oldNode.expanded !== newNode.expanded ||
                    oldNode.shape !== newNode.shape
                ) {
                    return true;
                }
            }
        }

        // 检查边的变化
        if (newEdges) {
            const oldEdgeSet = new Set(oldMindMap.edges.map(e => `${e.source}-${e.target}`));
            const newEdgeSet = new Set(newEdges.map(e => `${e.source}-${e.target}`));
            if (oldEdgeSet.size !== newEdgeSet.size) return true;
            for (const edgeKey of newEdgeSet) {
                if (!oldEdgeSet.has(edgeKey)) return true;
            }
        }

        return false;
    }
}

/**
 * MindMap List Handler
 */
class MindMapListHandler extends Handler {
    @param('rpid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, rpid?: number, branch?: string) {
        let mindMaps: MindMapDoc[];
        
        if (rpid) {
            mindMaps = await MindMapModel.getByRepo(domainId, rpid, branch);
        } else {
            mindMaps = await MindMapModel.getAll(domainId);
        }

        this.response.template = 'mindmap_list.html';
        this.response.body = { mindMaps, rpid, branch };
    }
}

/**
 * MindMap Domain Handler
 */
class MindMapDomainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('pjax', Types.Boolean)
    async get(domainId: string, page = 1, q = '', pjax = false) {
        const limit = 20;
        const skip = (page - 1) * limit;
        
        let allMindMaps = await MindMapModel.getAll(domainId);
        
        // 使用 SearchParser 解析搜索查询
        const parsed = parser.parse(q || '', {
            keywords: ['category'],
            offsets: false,
            alwaysArray: true,
            tokenize: true,
        });
        
        const category = parsed.category || [];
        const text = (parsed.text || []).join(' ').trim();
        
        // 搜索过滤
        if (text || category.length > 0) {
            if (text) {
                const searchTerm = text.toLowerCase();
                allMindMaps = allMindMaps.filter(mindMap => 
                    mindMap.title.toLowerCase().includes(searchTerm) ||
                    (mindMap.content && mindMap.content.toLowerCase().includes(searchTerm)) ||
                    String(mindMap.mmid).includes(searchTerm)
                );
            }
            
            // TODO: 如果将来需要支持 category 过滤，可以在这里添加
            // if (category.length > 0) {
            //     allMindMaps = allMindMaps.filter(mindMap => 
            //         category.some(cat => mindMap.category === cat)
            //     );
            // }
        }
        
        // 按 mmid 排序
        allMindMaps.sort((a, b) => (a.mmid || 0) - (b.mmid || 0));
        
        // 分页
        const total = allMindMaps.length;
        const totalPages = Math.ceil(total / limit);
        const mindMaps = allMindMaps.slice(skip, skip + limit);
        
        // 计算统计信息
        const totalNodes = allMindMaps.reduce((sum, mm) => sum + (mm.nodes?.length || 0), 0);
        const totalViews = allMindMaps.reduce((sum, mm) => sum + (mm.views || 0), 0);
        
        if (pjax) {
            const html = await this.renderHTML('partials/mindmap_list.html', {
                page, totalPages, total, mindMaps, qs: q ? q.trim() : '', domainId,
            });
            this.response.body = {
                title: this.renderTitle(this.translate('MindMap Domain')),
                fragments: [{ html: html || '' }],
            };
        } else {
            this.response.template = 'mindmap_domain.html';
            this.response.body = { 
                mindMaps, 
                domainId,
                page,
                totalPages,
                total,
                qs: q ? q.trim() : '',
                totalNodes,
                totalViews,
            };
        }
    }
}

class MindMapDataHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async _prepare(domainId: string, docId: ObjectId, mmid: number) {
        if (docId) {
            this.mindMap = await MindMapModel.get(domainId, docId);
        } else if (mmid) {
            this.mindMap = await MindMapModel.getByMmid(domainId, mmid);
        }
        if (!this.mindMap) throw new NotFoundError('MindMap not found');
    }

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, mmid: number, branch?: string) {
        const currentBranch = branch || (this.mindMap as any)?.currentBranch || 'main';
        const branchData = getBranchData(this.mindMap!, currentBranch);
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        if (branchData.nodes && branchData.nodes.length > 0) {
            for (const node of branchData.nodes) {
                try {
                    const cards = await CardModel.getByNodeId(domainId, this.mindMap!.mmid, node.id);
                    if (cards && cards.length > 0) {
                        nodeCardsMap[node.id] = cards;
                    }
                } catch (err) {
                    console.error(`Failed to get cards for node ${node.id}:`, err);
                }
            }
        }
        // 返回当前分支的数据
        this.response.body = {
            ...this.mindMap,
            nodes: branchData.nodes,
            edges: branchData.edges,
            currentBranch,
            nodeCardsMap,
        };
    }
}

/**
 * Get git repository path for mindmap
 */
function getMindMapGitPath(domainId: string, mmid: number): string {
    return path.join('/data/git/ejunz', domainId, 'mindmap', String(mmid));
}

/**
 * Initialize or get git repository for mindmap
 */
async function ensureMindMapGitRepo(domainId: string, mmid: number, remoteUrl?: string): Promise<string> {
    const repoPath = getMindMapGitPath(domainId, mmid);
    
    await fs.promises.mkdir(repoPath, { recursive: true });
    let isNewRepo = false;
    try {
        await exec('git rev-parse --git-dir', { cwd: repoPath });
    } catch {
        isNewRepo = true;
        await exec('git init', { cwd: repoPath });
        
        if (remoteUrl) {
            await exec(`git remote add origin ${remoteUrl}`, { cwd: repoPath });
        }
    }
    
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await exec(`git config user.name "${botName}"`, { cwd: repoPath });
    await exec(`git config user.email "${botEmail}"`, { cwd: repoPath });
    
    if (!isNewRepo && remoteUrl) {
        try {
            await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoPath });
        } catch {
            try {
                await exec(`git remote add origin ${remoteUrl}`, { cwd: repoPath });
            } catch {
            }
        }
    }
    
    return repoPath;
}

/**
 * Export mindmap to file structure (node as folder, card as md file)
 * Root node is NOT exported as folder, only its children are exported
 */
async function exportMindMapToFile(mindMap: MindMapDoc, outputDir: string, branch?: string): Promise<void> {
    await fs.promises.mkdir(outputDir, { recursive: true });
    
    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
    
    // Get branch-specific data
    const currentBranch = branch || (mindMap as any).currentBranch || 'main';
    const branchData = getBranchData(mindMap, currentBranch);
    const nodes = branchData.nodes;
    const edges = branchData.edges;
    
    // Create README.md for mindmap root (only contains the content, no metadata)
    const readmePath = path.join(outputDir, 'README.md');
    const contentText = mindMap.content || '';
    await fs.promises.writeFile(readmePath, contentText, 'utf-8');
    
    // Build node tree structure
    const nodeMap = new Map<string, MindMapNode>();
    
    for (const node of nodes || []) {
        nodeMap.set(node.id, node);
    }
    
    // Find root node (node with no incoming edges)
    const rootNode = (nodes || []).find(node => 
        !(edges || []).some(edge => edge.target === node.id)
    );
    
    // Recursively export nodes as folders
    async function exportNode(node: MindMapNode, parentPath: string): Promise<void> {
        const dirName = sanitize(node.text);
        const nodeDir = path.join(parentPath, dirName);
        await fs.promises.mkdir(nodeDir, { recursive: true });
        
        // Get all cards for this node
        const cards = await CardModel.getByNodeId(mindMap.domainId, mindMap.mmid, node.id);
        
        // Export cards as md files
        for (const card of cards) {
            const cardFileName = `${sanitize(card.title)}.md`;
            const cardFilePath = path.join(nodeDir, cardFileName);
            await fs.promises.writeFile(cardFilePath, card.content || '', 'utf-8');
        }
        
        // If node has no cards, create .keep file
        if (cards.length === 0) {
            const keepPath = path.join(nodeDir, '.keep');
            await fs.promises.writeFile(keepPath, '', 'utf-8');
        }
        
        // Recursively export child nodes (find children through edges)
        const childEdges = (edges || []).filter(edge => edge.source === node.id);
        for (const edge of childEdges) {
            const childNode = nodeMap.get(edge.target);
            if (childNode) {
                await exportNode(childNode, nodeDir);
            }
        }
    }
    
    // Export only root node's children (not the root node itself)
    if (rootNode) {
        const rootChildEdges = (edges || []).filter(edge => edge.source === rootNode.id);
        for (const edge of rootChildEdges) {
            const childNode = nodeMap.get(edge.target);
            if (childNode) {
                await exportNode(childNode, outputDir);
            }
        }
    }
}

/**
 * Create repository in organization using GitHub API
 */
async function createGitHubRepoForMindMap(
    orgName: string,
    repoName: string,
    description: string,
    token: string,
    isPrivate: boolean = false
): Promise<string> {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            name: repoName,
            description: description || '',
            private: isPrivate,
            auto_init: false,
        });

        const options = {
            hostname: 'api.github.com',
            port: 443,
            path: `/orgs/${orgName}/repos`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': `token ${token}`,
                'User-Agent': 'ejunz',
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode === 201) {
                    try {
                        const response = JSON.parse(data);
                        resolve(response.clone_url || response.ssh_url || '');
                    } catch (err) {
                        reject(new Error(`Failed to parse GitHub API response: ${err}`));
                    }
                } else if (res.statusCode === 422) {
                    https.get({
                        hostname: 'api.github.com',
                        port: 443,
                        path: `/repos/${orgName}/${repoName}`,
                        method: 'GET',
                        headers: {
                            'Authorization': `token ${token}`,
                            'User-Agent': 'ejunz',
                        },
                    }, (getRes) => {
                        let getData = '';
                        getRes.on('data', (chunk) => {
                            getData += chunk;
                        });
                        getRes.on('end', () => {
                            if (getRes.statusCode === 200) {
                                try {
                                    const response = JSON.parse(getData);
                                    resolve(response.clone_url || response.ssh_url || '');
                                } catch (err) {
                                    reject(new Error(`Repository already exists but failed to get info: ${err}`));
                                }
                            } else {
                                reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
                            }
                        });
                    }).on('error', reject);
                } else {
                    reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Create repository in GitHub organization and push local content
 */
async function createAndPushToGitHubOrgForMindMap(
    handler: any,
    domainId: string,
    mmid: number,
    mindMapTitle: string,
    user: any
): Promise<void> {
    const githubOrg = system.get('ejunzrepo.github_org') || '';
    if (!githubOrg || !githubOrg.trim()) {
        return;
    }
    let orgName = githubOrg.trim();
    if (orgName.startsWith('https://github.com/')) {
        orgName = orgName.replace('https://github.com/', '').replace(/\/$/, '');
    } else if (orgName.startsWith('http://github.com/')) {
        orgName = orgName.replace('http://github.com/', '').replace(/\/$/, '');
    } else if (orgName.startsWith('@')) {
        orgName = orgName.substring(1);
    }
    orgName = orgName.split('/')[0];

    if (!orgName) {
        return;
    }

    const settingValue = handler.ctx.setting.get('ejunzrepo.github_token');
    const systemValue = system.get('ejunzrepo.github_token');
    const GH_TOKEN = settingValue || systemValue || '';
    if (!GH_TOKEN) {
        console.warn('GitHub token not configured, skipping remote repo creation');
        return;
    }

    const repoName = mindMapTitle
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || `mindmap-${mmid}`;

    try {
        const remoteUrl = await createGitHubRepoForMindMap(orgName, repoName, mindMapTitle, GH_TOKEN, false);
        
        if (!remoteUrl) {
            throw new Error('Failed to get remote repository URL');
        }

        let REPO_URL = remoteUrl;
        if (remoteUrl.startsWith('git@')) {
            REPO_URL = remoteUrl;
        } else if (remoteUrl.startsWith('https://')) {
            if (!remoteUrl.includes('@github.com')) {
                REPO_URL = remoteUrl.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`);
            }
        }

        // 重试获取 mindmap，因为可能刚创建，需要等待数据库同步
        let mindMap = await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) {
            // 如果第一次获取失败，等待一小段时间后重试
            await new Promise(resolve => setTimeout(resolve, 100));
            mindMap = await MindMapModel.getByMmid(domainId, mmid);
        }
        
        if (mindMap) {
            await document.set(domainId, document.TYPE_MINDMAP, mindMap.docId, {
                githubRepo: REPO_URL,
            });
        } else {
            console.warn(`MindMap with mmid ${mmid} not found, skipping GitHub repo setup`);
            return;
        }

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-mindmap-create-'));
        try {
            const mindMapForExport = await MindMapModel.getByMmid(domainId, mmid);
            if (mindMapForExport) {
                await exportMindMapToFile(mindMapForExport, tmpDir, 'main');
                const commitMessage = `${domainId}/${user._id}/${user.uname || 'unknown'}: Initial commit`;
                await gitInitAndPushMindMap(domainId, mmid, mindMapForExport, REPO_URL, 'main', commitMessage);
            } else {
                console.warn(`MindMap with mmid ${mmid} not found for export, skipping`);
            }
        } finally {
            try {
                await fs.promises.rm(tmpDir, { recursive: true, force: true });
            } catch {}
        }
    } catch (err) {
        console.error(`Failed to create and push to GitHub org ${orgName}:`, err);
        throw err;
    }
}

/**
 * Git init and push for mindmap
 */
async function gitInitAndPushMindMap(
    domainId: string,
    mmid: number,
    mindMap: MindMapDoc,
    remoteUrlWithAuth: string, 
    branch: string = 'main', 
    commitMessage: string = 'chore: sync mindmap from ejunz'
) {
    const repoGitPath = await ensureMindMapGitRepo(domainId, mmid, remoteUrlWithAuth);
    
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await exec(`git config user.name "${botName}"`, { cwd: repoGitPath });
    await exec(`git config user.email "${botEmail}"`, { cwd: repoGitPath });
    
    let isNewRepo = false;
    
    try {
        try {
            await exec('git rev-parse HEAD', { cwd: repoGitPath });
            isNewRepo = false;
        } catch {
            isNewRepo = true;
        }
        
        if (isNewRepo) {
            try {
                const tmpCloneDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-mindmap-clone-'));
                try {
                    await exec(`git clone ${remoteUrlWithAuth} .`, { cwd: tmpCloneDir });
                    await fs.promises.cp(path.join(tmpCloneDir, '.git'), path.join(repoGitPath, '.git'), { recursive: true });
                    isNewRepo = false;
                } catch {
                } finally {
                    try {
                        await fs.promises.rm(tmpCloneDir, { recursive: true, force: true });
                    } catch {}
                }
            } catch {}
        } else {
            try {
                await exec('git fetch origin', { cwd: repoGitPath });
            } catch {}
        }
        
        try {
            await exec(`git checkout ${branch}`, { cwd: repoGitPath });
        } catch {
            try {
                await exec(`git checkout -b ${branch} origin/${branch}`, { cwd: repoGitPath });
            } catch {
                try {
                    const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
                    const baseBranch = currentBranch.trim() || 'main';
                    await exec(`git checkout -b ${branch} ${baseBranch}`, { cwd: repoGitPath });
                } catch {
                    await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
                }
            }
        }
        
        if (!isNewRepo) {
            try {
                await exec(`git pull origin ${branch}`, { cwd: repoGitPath });
            } catch {
            }
        }
        
        // Export mindmap to files (use the branch parameter from function signature)
        await exportMindMapToFile(mindMap, repoGitPath, branch);
        
        await exec('git add -A', { cwd: repoGitPath });
        
        try {
            const { stdout } = await exec('git status --porcelain', { cwd: repoGitPath });
            if (stdout.trim()) {
                const escapedMessage = commitMessage.replace(/'/g, "'\\''");
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
            }
        } catch (err) {
            const escapedMessage = commitMessage.replace(/'/g, "'\\''");
            try {
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
            } catch {
            }
        }
        
        if (isNewRepo) {
            await exec(`git push -u origin ${branch}`, { cwd: repoGitPath });
        } else {
            try {
                await exec(`git push origin ${branch}`, { cwd: repoGitPath });
            } catch {
                await exec(`git push -u origin ${branch}`, { cwd: repoGitPath });
            }
        }
    } catch (err) {
        throw err;
    }
}

/**
 * MindMap GitHub Push Handler
 */
class MindMapGithubPushHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: ObjectId, mmid: number, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found');
        }
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
        const systemValue = system.get('ejunzrepo.github_token');
        const GH_TOKEN = settingValue || systemValue || '';
        if (!GH_TOKEN) {
            throw new Error('GitHub token not configured. Please configure it in system settings.');
        }
        
        const githubRepo = (mindMap.githubRepo || '') as string;
        if (!githubRepo) {
            throw new Error('GitHub repository not configured. Please configure it in mindmap settings.');
        }
        
        let REPO_URL = githubRepo;
        if (githubRepo.startsWith('git@')) {
            REPO_URL = githubRepo;
        } else {
            if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                if (githubRepo.includes('@github.com')) {
                    REPO_URL = githubRepo;
                } else {
                    REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                        .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || mindMap.branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        // 先 commit 本地更改
        try {
            const commitMessage = this.request.body?.commitMessage || `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}: Update mindmap ${mindMap.mmid}`;
            await commitMindMapChanges(domainId, mindMap.mmid, mindMap, commitMessage, this.user._id, this.user.uname || 'unknown');
        } catch (err: any) {
            console.warn('Commit before push failed (may be no changes):', err?.message || err);
        }
        
        // 然后 push
        const commitMessage = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}: Update mindmap ${mindMap.mmid}`;
        
        try {
            await gitInitAndPushMindMap(domainId, mindMap.mmid, mindMap, REPO_URL, effectiveBranch, commitMessage);
            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Push failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        }
    }

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, mmid: number, branch?: string) {
        return this.post(domainId, docId, mmid, branch);
    }
}

/**
 * MindMap Card Handler
 */
class MindMapCardHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('nodeId', Types.String, true)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('operation', Types.String, true)
    async post(
        domainId: string,
        docId?: ObjectId,
        mmid?: number,
        nodeId?: string,
        title?: string,
        content: string = '',
        operation?: string
    ) {
        // 如果有 operation 参数，应该调用 postUpdate 方法，这里直接返回
        // 参数验证已经通过（因为所有参数都是可选的），所以这里可以安全返回
        if (operation) {
            return;
        }
        
        // 创建新卡片需要这些参数
        if (!nodeId || !title) {
            throw new ValidationError('nodeId and title are required for creating a card');
        }
        
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid!);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const cardDocId = await CardModel.create(
            domainId,
            mindMap.mmid,
            nodeId,
            this.user._id,
            title,
            content,
            this.request.ip
        );
        
        this.response.body = { cardId: cardDocId.toString() };
    }
    
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    async get(domainId: string, docId: ObjectId, mmid: number, nodeId: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        
        const cards = await CardModel.getByNodeId(domainId, mindMap.mmid, nodeId);
        this.response.body = { cards };
    }
    
    @route('cardId', Types.String)
    @param('nodeId', Types.String, true)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('order', Types.PositiveInt, true)
    @param('operation', Types.String, true)
    @param('cid', Types.PositiveInt, true)
    @param('mmid', Types.PositiveInt, true)
    @param('docId', Types.ObjectId, true)
    async postUpdate(
        domainId: string,
        cardIdParam?: string,
        nodeId?: string,
        title?: string,
        content?: string,
        order?: number,
        _operation?: string,
        cidParam?: number,
        mmidParam?: number,
        docIdParam?: ObjectId
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        await this.handleCardMutation('update', domainId, {
            cardIdParam,
            nodeId,
            title,
            content,
            order,
            cidParam,
            mmidParam,
            docIdParam,
        });
    }

    @route('cardId', Types.String)
    @param('nodeId', Types.String, true)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('order', Types.PositiveInt, true)
    @param('operation', Types.String, true)
    @param('cid', Types.PositiveInt, true)
    @param('mmid', Types.PositiveInt, true)
    @param('docId', Types.ObjectId, true)
    async postDelete(
        domainId: string,
        cardIdParam?: string,
        nodeId?: string,
        title?: string,
        content?: string,
        order?: number,
        _operation?: string,
        cidParam?: number,
        mmidParam?: number,
        docIdParam?: ObjectId
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        await this.handleCardMutation('delete', domainId, {
            cardIdParam,
            nodeId,
            title,
            content,
            order,
            cidParam,
            mmidParam,
            docIdParam,
        });
    }

    private async handleCardMutation(
        action: 'update' | 'delete',
        domainId: string,
        params: {
            cardIdParam?: string;
            nodeId?: string;
            title?: string;
            content?: string;
            order?: number;
            cidParam?: number;
            mmidParam?: number;
            docIdParam?: ObjectId;
        },
    ) {
        const { cardIdParam, nodeId, title, content, order, cidParam, mmidParam, docIdParam } = params;

        const parseObjectId = (value?: string): ObjectId | null => {
            if (value && ObjectId.isValid(value)) {
                try {
                    return new ObjectId(value);
                } catch {
                    return null;
                }
            }
            return null;
        };

        const parseCid = (value?: string | number): number | undefined => {
            if (typeof value === 'number' && value > 0) return value;
            if (typeof value === 'string' && /^\d+$/.test(value)) {
                const parsed = Number(value);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    return parsed;
                }
            }
            return undefined;
        };

        const resolvedDocId = parseObjectId(cardIdParam);
        const cidFromPath = parseCid(cardIdParam);
        const resolvedCid = cidParam ?? cidFromPath;

        const getMindMapByArgs = async (): Promise<MindMapDoc | null> => {
            if (docIdParam) {
                return await MindMapModel.get(domainId, docIdParam);
            }
            if (mmidParam) {
                return await MindMapModel.getByMmid(domainId, mmidParam);
            }
            return null;
        };

        let targetCard: CardDoc | null = null;
        if (resolvedDocId) {
            targetCard = await CardModel.get(domainId, resolvedDocId);
        }

        if (!targetCard && resolvedCid !== undefined) {
            if (!nodeId) {
                throw new ValidationError('nodeId is required when using cid to locate a card');
            }
            let effectiveMmid = mmidParam;
            if (!effectiveMmid) {
                const mindMap = await getMindMapByArgs();
                effectiveMmid = mindMap?.mmid;
            }
            targetCard = await CardModel.getByCid(domainId, nodeId, resolvedCid, effectiveMmid);
        }

        if (!targetCard) throw new NotFoundError('Card not found');

        const mindMap = await MindMapModel.getByMmid(domainId, targetCard.mmid);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            const perm = action === 'delete' ? PERM.PERM_DELETE_DISCUSSION : PERM.PERM_EDIT_DISCUSSION;
            this.checkPerm(perm);
        }

        if (action === 'delete') {
            await CardModel.delete(domainId, targetCard.docId);
            this.response.body = { success: true };
            return;
        }

        const updates: any = {};
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;
        if (order !== undefined) updates.order = order;

        await CardModel.update(domainId, targetCard.docId, updates);
        this.response.body = { success: true };
    }
}

/**
 * MindMap Card List Handler
 * 卡片列表页面
 */
class MindMapCardListHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('branch', Types.String, true)
    @param('cardId', Types.ObjectId, true)
    async get(domainId: string, docId: ObjectId, mmid: number, nodeId: string, branch?: string, cardId?: ObjectId) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        
        // 获取节点的所有卡片
        const cards = await CardModel.getByNodeId(domainId, mindMap.mmid, nodeId);
        
        // 获取节点信息（用于显示节点名称）
        const node = mindMap.nodes?.find(n => n.id === nodeId);
        
        // 构建从根节点到当前节点的完整路径
        const nodePath: Array<{ id: string; text: string }> = [];
        const branchData = getBranchData(mindMap, branch || 'main');
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        // 构建节点映射
        const nodeMap = new Map<string, MindMapNode>();
        nodes.forEach(n => nodeMap.set(n.id, n));
        
        // 构建父节点映射
        const parentMap = new Map<string, string>();
        edges.forEach(edge => {
            parentMap.set(edge.target, edge.source);
        });
        
        // 从当前节点向上遍历到根节点
        let currentNodeId: string | undefined = nodeId;
        const pathNodes: Array<{ id: string; text: string }> = [];
        while (currentNodeId) {
            const currentNode = nodeMap.get(currentNodeId);
            if (currentNode) {
                pathNodes.unshift({ id: currentNodeId, text: currentNode.text || '未命名节点' });
            }
            currentNodeId = parentMap.get(currentNodeId);
        }
        
        // 反转路径数组（从当前节点到根节点）
        const reversedPathNodes = pathNodes.slice().reverse();
        
        // 确定当前选中的卡片
        let selectedCard = null;
        if (cardId) {
            selectedCard = cards.find(c => c.docId.toString() === cardId.toString());
        }
        if (!selectedCard && cards.length > 0) {
            selectedCard = cards[0];
        }
        
        const extraTitleContent = `${reversedPathNodes.map(p => p.text).join(' / ')} - ${mindMap.title}`;
        
        this.response.template = 'mindmap_card_list.html';
        this.response.body = {
            mindMap,
            cards,
            nodeId,
            nodeText: node?.text || '节点',
            nodePath: reversedPathNodes, // 使用反转后的路径
            branch: branch || 'main',
            selectedCard,
        };
        this.UiContext.extraTitleContent = extraTitleContent;
    }
}

/**
 * MindMap Card Edit Handler
 * 卡片编辑页面
 */
class MindMapCardEditHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('cardId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, mmid: number, nodeId: string, cardId?: ObjectId, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        
        let card = null;
        if (cardId) {
            card = await CardModel.get(domainId, cardId);
            if (!card) throw new NotFoundError('Card not found');
            if (card.nodeId !== nodeId) throw new NotFoundError('Card does not belong to this node');
        }
        
        this.response.template = 'mindmap_card_edit.html';
        this.response.body = {
            mindMap,
            card,
            nodeId,
            branch: branch || 'main',
        };
        this.UiContext.extraTitleContent = `${card?.title || '卡片'} - ${mindMap.title}`;
    }
    
    // 处理创建新卡片（没有 cardId 的路由）
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('branch', Types.String, true)
    @post('title', Types.String, true)
    @post('content', Types.String, true)
    @post('operation', Types.String, true)
    @post('cardId', Types.ObjectId, true)
    async post(
        domainId: string,
        docId: ObjectId,
        mmid: number,
        nodeId: string,
        branch?: string,
        title?: string,
        content?: string,
        operation?: string,
        cardId?: ObjectId
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const effectiveBranch = branch || 'main';
        
        // 如果有 operation=update 和 cardId，执行更新操作
        if (operation === 'update' && cardId) {
            const updates: any = {};
            if (title !== undefined) updates.title = title;
            if (content !== undefined) updates.content = content;
            await CardModel.update(domainId, cardId, updates);
            // 重定向到更新后的卡片URL
            if (docId) {
                this.response.redirect = this.url('mindmap_card_list_branch', { 
                    docId: docId.toString(), 
                    branch: effectiveBranch, 
                    nodeId 
                }) + `?cardId=${cardId.toString()}`;
            } else {
                this.response.redirect = this.url('mindmap_card_list_branch_mmid', { 
                    mmid: mmid.toString(), 
                    branch: effectiveBranch, 
                    nodeId 
                }) + `?cardId=${cardId.toString()}`;
            }
            return;
        }
        
        // 创建新卡片
        if (!title) {
            throw new ValidationError('title is required');
        }
        const newCardId = await CardModel.create(
            domainId,
            mindMap.mmid,
            nodeId,
            this.user._id,
            title,
            content || '',
            this.request.ip
        );
        // 重定向到新创建的卡片URL
        if (docId) {
            this.response.redirect = this.url('mindmap_card_list_branch', { 
                docId: docId.toString(), 
                branch: effectiveBranch, 
                nodeId 
            }) + `?cardId=${newCardId.toString()}`;
        } else {
            this.response.redirect = this.url('mindmap_card_list_branch_mmid', { 
                mmid: mmid.toString(), 
                branch: effectiveBranch, 
                nodeId 
            }) + `?cardId=${newCardId.toString()}`;
        }
    }
    
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @route('cardId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    @post('title', Types.String, true)
    @post('content', Types.String, true)
    @post('operation', Types.String, true)
    async postUpdate(
        domainId: string,
        docId: ObjectId,
        mmid: number,
        nodeId: string,
        cardId?: ObjectId,
        branch?: string,
        title?: string,
        content?: string,
        operation?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const effectiveBranch = branch || 'main';
        
        if (cardId) {
            // 更新现有卡片
            if (operation === 'delete') {
                const card = await CardModel.get(domainId, cardId);
                if (!card) throw new NotFoundError('Card not found');
                await CardModel.delete(domainId, cardId);
                this.response.redirect = this.url('mindmap_card_list_branch', { 
                    docId: docId.toString(), 
                    branch: effectiveBranch, 
                    nodeId 
                });
                return;
            }
            
            const updates: any = {};
            if (title !== undefined) updates.title = title;
            if (content !== undefined) updates.content = content;
            await CardModel.update(domainId, cardId, updates);
            // 重定向到更新后的卡片URL
            if (docId) {
                this.response.redirect = this.url('mindmap_card_list_branch', { 
                    docId: docId.toString(), 
                    branch: effectiveBranch, 
                    nodeId 
                }) + `?cardId=${cardId.toString()}`;
            } else {
                this.response.redirect = this.url('mindmap_card_list_branch_mmid', { 
                    mmid: mmid.toString(), 
                    branch: effectiveBranch, 
                    nodeId 
                }) + `?cardId=${cardId.toString()}`;
            }
        } else {
            throw new BadRequestError('cardId is required for update operation');
        }
    }
}

/**
 * MindMap Card Detail Handler
 * 卡片详情页面
 */
class MindMapCardDetailHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('cardId', Types.ObjectId)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, mmid: number, nodeId: string, cardId: ObjectId, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        
        const card = await CardModel.get(domainId, cardId);
        if (!card) throw new NotFoundError('Card not found');
        if (card.nodeId !== nodeId) throw new NotFoundError('Card does not belong to this node');
        
        // 获取同一节点的所有卡片
        const cards = await CardModel.getByNodeId(domainId, mindMap.mmid, nodeId);
        const currentIndex = cards.findIndex(c => c.docId.toString() === cardId.toString());
        
        this.response.template = 'mindmap_card_detail.html';
        this.response.body = {
            mindMap,
            card,
            cards,
            currentIndex: currentIndex >= 0 ? currentIndex : 0,
            nodeId,
            branch: branch || 'main',
        };
    }
    
    @route('cardId', Types.ObjectId)
    @param('nodeId', Types.String, true)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('order', Types.PositiveInt, true)
    @param('operation', Types.String, true)
    async postUpdate(
        domainId: string,
        cardId: ObjectId,
        nodeId?: string,
        title?: string,
        content?: string,
        order?: number,
        operation?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 如果 operation 是 'delete'，则执行删除操作
        if (operation === 'delete') {
            const card = await CardModel.get(domainId, cardId);
            if (!card) throw new NotFoundError('Card not found');
            
            const mindMap = await MindMapModel.getByMmid(domainId, card.mmid);
            if (!mindMap) throw new NotFoundError('MindMap not found');
            if (!this.user.own(mindMap)) {
                this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
            }
            
            await CardModel.delete(domainId, cardId);
            this.response.body = { success: true };
            return;
        }
        
        // 否则执行更新操作
        const card = await CardModel.get(domainId, cardId);
        if (!card) throw new NotFoundError('Card not found');
        
        const mindMap = await MindMapModel.getByMmid(domainId, card.mmid);
        if (!mindMap) throw new NotFoundError('MindMap not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const updates: any = {};
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;
        if (order !== undefined) updates.order = order;
        
        await CardModel.update(domainId, cardId, updates);
        this.response.body = { success: true };
    }
}

/**
 * Sync mindmap data to git repository (without committing)
 */
async function syncMindMapToGit(domainId: string, mmid: number, branch: string): Promise<void> {
    const mindMap = await MindMapModel.getByMmid(domainId, mmid);
    if (!mindMap) {
        return;
    }
    
    const repoGitPath = getMindMapGitPath(domainId, mmid);
    
    try {
        await exec('git rev-parse --git-dir', { cwd: repoGitPath });
    } catch {
        // Git repo not initialized, skip sync
        return;
    }
    
    try {
        await exec(`git checkout ${branch}`, { cwd: repoGitPath });
    } catch {
        // Branch doesn't exist, skip sync
        return;
    }
    
    // Export to temp directory first
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-mindmap-sync-'));
    try {
        const branch = (mindMap as any).currentBranch || 'main';
        await exportMindMapToFile(mindMap, tmpDir, branch);
        
        // Copy files to git repository and remove extra files
        const copyDirAndCleanup = async (src: string, dest: string) => {
            await fs.promises.mkdir(dest, { recursive: true });
            
            // Get all entries from source
            const srcEntries = await fs.promises.readdir(src, { withFileTypes: true });
            const srcNames = new Set(srcEntries.map(e => e.name).filter(name => name !== '.git'));
            
            // Get all entries from destination (excluding .git)
            let destEntries: fs.Dirent[] = [];
            try {
                destEntries = await fs.promises.readdir(dest, { withFileTypes: true });
            } catch (err: any) {
                // dest might not exist, that's ok
                if (err.code !== 'ENOENT') throw err;
            }
            const destNames = new Set(destEntries.map(e => e.name).filter(name => name !== '.git'));
            
            // Remove files/directories in dest that don't exist in src
            for (const destName of destNames) {
                if (!srcNames.has(destName)) {
                    const destPath = path.join(dest, destName);
                    try {
                        const stat = await fs.promises.stat(destPath);
                        if (stat.isDirectory()) {
                            await fs.promises.rm(destPath, { recursive: true, force: true });
                            console.log(`[syncMindMapToGit] Removed directory: ${destPath}`);
                        } else {
                            await fs.promises.unlink(destPath);
                            console.log(`[syncMindMapToGit] Removed file: ${destPath}`);
                        }
                    } catch (err: any) {
                        console.warn(`[syncMindMapToGit] Failed to remove ${destPath}:`, err.message);
                    }
                }
            }
            
            // Copy files and directories from src to dest
            for (const entry of srcEntries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                    await copyDirAndCleanup(srcPath, destPath);
                } else {
                    await fs.promises.copyFile(srcPath, destPath);
                }
            }
        };
        await copyDirAndCleanup(tmpDir, repoGitPath);
    } finally {
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {}
    }
}

/**
 * Get git status for mindmap
 */
async function getMindMapGitStatus(
    domainId: string,
    mmid: number,
    branch: string,
    remoteUrl?: string
): Promise<{
    hasLocalRepo: boolean;
    hasLocalBranch: boolean;
    hasRemote: boolean;
    hasRemoteBranch: boolean;
    localCommits: number;
    remoteCommits: number;
    behind: number;
    ahead: number;
    uncommittedChanges: boolean;
    currentBranch?: string;
    lastCommit?: string;
    lastCommitMessage?: string;
    lastCommitTime?: string;
    changes?: {
        added: string[];
        modified: string[];
        deleted: string[];
    };
} | null> {
    const repoGitPath = getMindMapGitPath(domainId, mmid);
    
    const defaultStatus = {
        hasLocalRepo: false,
        hasLocalBranch: false,
        hasRemote: false,
        hasRemoteBranch: false,
        localCommits: 0,
        remoteCommits: 0,
        behind: 0,
        ahead: 0,
        uncommittedChanges: false,
        changes: {
            added: [],
            modified: [],
            deleted: [],
        },
    };
    
    try {
        try {
            await exec('git rev-parse --git-dir', { cwd: repoGitPath });
        } catch {
            return defaultStatus;
        }
        
        // Sync latest mindmap data to git repository before checking status
        // First checkout to the correct branch
        try {
            const repoGitPath = getMindMapGitPath(domainId, mmid);
            try {
                await exec('git rev-parse --git-dir', { cwd: repoGitPath });
                // Git repo exists, checkout to the branch
                try {
                    await exec(`git checkout ${branch}`, { cwd: repoGitPath });
                } catch {
                    // Branch doesn't exist, create it from main
                    try {
                        await exec(`git checkout main`, { cwd: repoGitPath });
                        await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
                    } catch {}
                }
            } catch {
                // Git repo not initialized, skip
            }
        } catch (err) {
            console.error('Failed to checkout branch:', err);
        }
        
        try {
            await syncMindMapToGit(domainId, mmid, branch);
        } catch (err) {
            console.error('Failed to sync mindmap to git:', err);
            // Continue even if sync fails
        }
        
        const status: any = {
            ...defaultStatus,
            hasLocalRepo: true,
        };
        
        try {
            const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
            status.currentBranch = currentBranch.trim();
        } catch {}
        
        try {
            await exec(`git rev-parse --verify ${branch}`, { cwd: repoGitPath });
            status.hasLocalBranch = true;
            
            try {
                const { stdout: localCount } = await exec(`git rev-list --count ${branch}`, { cwd: repoGitPath });
                status.localCommits = parseInt(localCount.trim()) || 0;
            } catch {}
            
            try {
                const { stdout: lastCommit } = await exec(`git rev-parse ${branch}`, { cwd: repoGitPath });
                const fullCommit = lastCommit.trim();
                status.lastCommit = fullCommit;
                status.lastCommitShort = fullCommit.substring(0, 8);
                
                // Get commit message
                try {
                    const { stdout: commitMessage } = await exec(`git log -1 --pretty=format:'%s' ${branch}`, { cwd: repoGitPath });
                    const fullMessage = commitMessage.trim();
                    if (fullMessage) {
                        status.lastCommitMessage = fullMessage;
                        status.lastCommitMessageShort = fullMessage.length > 50 ? fullMessage.substring(0, 50) : fullMessage;
                    }
                } catch (err) {
                    try {
                        const { stdout: commitMessage } = await exec(`git log -1 --format=%s ${branch}`, { cwd: repoGitPath });
                        const fullMessage = commitMessage.trim();
                        if (fullMessage) {
                            status.lastCommitMessage = fullMessage;
                            status.lastCommitMessageShort = fullMessage.length > 50 ? fullMessage.substring(0, 50) : fullMessage;
                        }
                    } catch {}
                }
                
                // Get commit time
                try {
                    const { stdout: commitTime } = await exec(`git log -1 --pretty=format:"%ci" ${branch}`, { cwd: repoGitPath });
                    status.lastCommitTime = commitTime.trim();
                } catch {}
            } catch {}
        } catch {
            status.hasLocalBranch = false;
        }
        
        // 检查未提交的更改
        try {
            const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
            const changes = statusOutput.trim();
            status.uncommittedChanges = changes.length > 0;
            
            // 解析变更详情
            if (changes) {
                const lines = changes.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    const code = line.substring(0, 2);
                    const file = line.substring(3).trim();
                    if (code.startsWith('??') || code.startsWith('A') || code.startsWith('A ')) {
                        status.changes.added.push(file);
                    } else if (code.startsWith('M') || code.startsWith(' M')) {
                        status.changes.modified.push(file);
                    } else if (code.startsWith('D') || code.startsWith(' D')) {
                        status.changes.deleted.push(file);
                    }
                }
            }
        } catch {
            status.uncommittedChanges = false;
        }
        
        // 检查 remote
        try {
            const { stdout: existingRemote } = await exec('git remote get-url origin', { cwd: repoGitPath });
            if (existingRemote && existingRemote.trim()) {
                status.hasRemote = true;
                if (remoteUrl && remoteUrl.trim() && existingRemote.trim() !== remoteUrl.trim()) {
                    try {
                        await exec(`git remote set-url origin ${remoteUrl}`, { cwd: repoGitPath });
                    } catch {}
                }
            }
        } catch {
            if (remoteUrl) {
                try {
                    await exec(`git remote add origin ${remoteUrl}`, { cwd: repoGitPath });
                    status.hasRemote = true;
                } catch {}
            }
        }
        
        // 检查 remote branch
        if (status.hasRemote) {
            try {
                try {
                    await exec('git fetch origin', { cwd: repoGitPath });
                } catch {
                    await exec(`git fetch origin ${branch}`, { cwd: repoGitPath });
                }
                
                try {
                    await exec(`git rev-parse --verify origin/${branch}`, { cwd: repoGitPath });
                    status.hasRemoteBranch = true;
                    
                    try {
                        const { stdout: remoteCount } = await exec(`git rev-list --count origin/${branch}`, { cwd: repoGitPath });
                        status.remoteCommits = parseInt(remoteCount.trim()) || 0;
                    } catch {}
                    
                    if (status.hasLocalBranch) {
                        try {
                            const { stdout: aheadOutput } = await exec(`git rev-list --left-right --count origin/${branch}...${branch}`, { cwd: repoGitPath });
                            const parts = aheadOutput.trim().split(/\s+/);
                            if (parts.length >= 2) {
                                status.behind = parseInt(parts[0].trim()) || 0;
                                status.ahead = parseInt(parts[1].trim()) || 0;
                            }
                        } catch {}
                    }
                } catch {
                    status.hasRemoteBranch = false;
                }
            } catch {}
        }
        
        return status;
    } catch (err: any) {
        console.error('getMindMapGitStatus error:', err);
        return defaultStatus;
    }
}

/**
 * Commit mindmap changes to git
 */
async function commitMindMapChanges(
    domainId: string,
    mmid: number,
    mindMap: MindMapDoc,
    commitMessage: string,
    userId: number,
    userName: string
): Promise<void> {
    const repoGitPath = getMindMapGitPath(domainId, mmid);
    
    try {
        await exec('git rev-parse --git-dir', { cwd: repoGitPath });
    } catch {
        await ensureMindMapGitRepo(domainId, mmid);
    }
    
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await exec(`git config user.name "${botName}"`, { cwd: repoGitPath });
    await exec(`git config user.email "${botEmail}"`, { cwd: repoGitPath });
    
    const branch = (mindMap as any).currentBranch || mindMap.branch || 'main';
    try {
        await exec(`git checkout ${branch}`, { cwd: repoGitPath });
    } catch {
        // Branch doesn't exist, create it from main
        try {
            await exec(`git checkout main`, { cwd: repoGitPath });
            await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
        } catch {
            // If main doesn't exist either, just create the branch
            await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
        }
    }
    
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-mindmap-commit-'));
    try {
        const branch = (mindMap as any).currentBranch || 'main';
        await exportMindMapToFile(mindMap, tmpDir, branch);
        
        // 复制文件到 git 仓库，并删除多余的文件
        const copyDirAndCleanup = async (src: string, dest: string) => {
            await fs.promises.mkdir(dest, { recursive: true });
            
            // Get all entries from source
            const srcEntries = await fs.promises.readdir(src, { withFileTypes: true });
            const srcNames = new Set(srcEntries.map(e => e.name).filter(name => name !== '.git'));
            
            // Get all entries from destination (excluding .git)
            let destEntries: fs.Dirent[] = [];
            try {
                destEntries = await fs.promises.readdir(dest, { withFileTypes: true });
            } catch (err: any) {
                // dest might not exist, that's ok
                if (err.code !== 'ENOENT') throw err;
            }
            const destNames = new Set(destEntries.map(e => e.name).filter(name => name !== '.git'));
            
            // Remove files/directories in dest that don't exist in src
            for (const destName of destNames) {
                if (!srcNames.has(destName)) {
                    const destPath = path.join(dest, destName);
                    try {
                        const stat = await fs.promises.stat(destPath);
                        if (stat.isDirectory()) {
                            await fs.promises.rm(destPath, { recursive: true, force: true });
                            console.log(`[copyDirAndCleanup] Removed directory: ${destPath}`);
                        } else {
                            await fs.promises.unlink(destPath);
                            console.log(`[copyDirAndCleanup] Removed file: ${destPath}`);
                        }
                    } catch (err: any) {
                        console.warn(`[copyDirAndCleanup] Failed to remove ${destPath}:`, err.message);
                    }
                }
            }
            
            // Copy files and directories from src to dest
            for (const entry of srcEntries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                    await copyDirAndCleanup(srcPath, destPath);
                } else {
                    await fs.promises.copyFile(srcPath, destPath);
                }
            }
        };
        await copyDirAndCleanup(tmpDir, repoGitPath);
        
        await exec('git add -A', { cwd: repoGitPath });
        
        try {
            const { stdout } = await exec('git status --porcelain', { cwd: repoGitPath });
            if (stdout.trim()) {
                const defaultPrefix = `${domainId}/${userId}/${userName || 'unknown'}`;
                const finalMessage = commitMessage && commitMessage.trim() 
                    ? `${defaultPrefix}: ${commitMessage.trim()}`
                    : defaultPrefix;
                const escapedMessage = finalMessage.replace(/'/g, "'\\''");
                await exec(`git commit -m '${escapedMessage}'`, { cwd: repoGitPath });
            }
        } catch (err: any) {
            console.error(`[commitMindMapChanges] Error during commit:`, err);
            throw err;
        }
    } finally {
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {}
    }
}

/**
 * MindMap Branch Create Handler
 */
class MindMapBranchCreateHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: ObjectId, mmid: number, branch?: string) {
        // Support both POST body and URL parameter
        const newBranch = branch || this.request.body?.branch || '';
        if (!newBranch || !newBranch.trim()) {
            throw new Error('Branch name is required');
        }
        
        const branchName = newBranch.trim();
        if (branchName === 'main') {
            throw new ForbiddenError('Cannot create branch named main');
        }
        
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found');
        }
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const currentBranch = (mindMap as any).currentBranch || 'main';
        if (currentBranch !== 'main') {
            throw new ForbiddenError('Branches can only be created from the main branch.');
        }
        
        const branches = Array.isArray((mindMap as any).branches) ? [...(mindMap as any).branches] : ['main'];
        if (!branches.includes(branchName)) {
            branches.push(branchName);
        }
        
        // 复制 main 分支的数据到新分支
        const mainBranchData = getBranchData(mindMap, 'main');
        setBranchData(mindMap, branchName, 
            JSON.parse(JSON.stringify(mainBranchData.nodes)), 
            JSON.parse(JSON.stringify(mainBranchData.edges))
        );
        
        await document.set(domainId, document.TYPE_MINDMAP, mindMap.docId, { 
            branches, 
            currentBranch: branchName,
            branchData: mindMap.branchData,
        });
        
        try {
            const repoGitPath = await ensureMindMapGitRepo(domainId, mmid);
            
            // Ensure main branch exists first
            try {
                await exec(`git checkout main`, { cwd: repoGitPath });
            } catch {
                try {
                    await exec(`git checkout -b main`, { cwd: repoGitPath });
                } catch {
                    try {
                        const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoGitPath });
                        const baseBranch = currentBranch.trim() || 'main';
                        if (baseBranch !== 'main') {
                            await exec(`git checkout -b main`, { cwd: repoGitPath });
                        }
                    } catch {
                        // If all else fails, just try to create main branch
                        await exec(`git checkout -b main`, { cwd: repoGitPath });
                    }
                }
            }
            
            // Now create the new branch from main
            await exec(`git checkout main`, { cwd: repoGitPath });
            await exec(`git checkout -b ${branchName}`, { cwd: repoGitPath });
        } catch (err) {
            console.error('Failed to create git branch:', err);
            throw err;
        }
        
        // Redirect to branch detail page
        const redirectDocId = docId || mindMap.docId;
        this.response.redirect = this.url('mindmap_detail_branch', { 
            docId: redirectDocId.toString(), 
            branch: branchName 
        });
    }
    
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, mmid: number, branch?: string) {
        // Support GET request for URL-based branch creation
        return this.post(domainId, docId, mmid, branch);
    }
}

/**
 * MindMap Git Status Handler
 */
class MindMapGitStatusHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, mmid: number, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found');
        }
        
        const effectiveBranch = branch || (mindMap as any).currentBranch || 'main';
        const githubRepo = (mindMap.githubRepo || '') as string;
        
        let gitStatus: any = null;
        if (githubRepo) {
            try {
                const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
                const systemValue = system.get('ejunzrepo.github_token');
                const GH_TOKEN = settingValue || systemValue || '';
                
                let REPO_URL = githubRepo;
                if (githubRepo.startsWith('git@')) {
                    REPO_URL = githubRepo;
                } else {
                    if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                        if (githubRepo.includes('@github.com')) {
                            REPO_URL = githubRepo;
                        } else {
                            REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                                .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                        }
                    } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                        const repoPath = githubRepo.replace('.git', '');
                        REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
                    }
                }
                
                gitStatus = await getMindMapGitStatus(domainId, mmid, effectiveBranch, REPO_URL);
            } catch (err) {
                console.error('Failed to get git status:', err);
                gitStatus = await getMindMapGitStatus(domainId, mmid, effectiveBranch);
            }
        } else {
            gitStatus = await getMindMapGitStatus(domainId, mmid, effectiveBranch);
        }
        
        this.response.body = { gitStatus, branch: effectiveBranch };
    }
}

/**
 * MindMap Commit Handler
 */
class MindMapCommitHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('commitMessage', Types.String, true)
    @param('note', Types.String, true)
    async post(domainId: string, docId: ObjectId, mmid: number, commitMessage?: string, note?: string) {
        // Get commit message from request body if not provided as parameter
        const body = this.request.body || {};
        const customMessage = commitMessage || note || body.commitMessage || body.note || '';
        
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found');
        }
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        // Generate final commit message with prefix (same format as repo)
        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = customMessage && customMessage.trim() 
            ? `${defaultPrefix}: ${customMessage.trim()}`
            : defaultPrefix;
        
        try {
            await commitMindMapChanges(
                domainId,
                mindMap.mmid,
                mindMap,
                customMessage,
                this.user._id,
                this.user.uname || 'unknown'
            );

            // 记录commit历史（保存完整的commit消息，包括prefix）
            const historyEntry: MindMapHistoryEntry = {
                id: `hist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: 'commit',
                timestamp: new Date(),
                userId: this.user._id,
                username: this.user.uname || 'unknown',
                description: finalCommitMessage,
                snapshot: {
                    nodes: JSON.parse(JSON.stringify(mindMap.nodes || [])),
                    edges: JSON.parse(JSON.stringify(mindMap.edges || [])),
                    viewport: mindMap.viewport,
                },
            };

            // 更新历史记录（最多保留50条）
            const history = mindMap.history || [];
            history.unshift(historyEntry);
            if (history.length > 50) {
                history.splice(50);
            }

            await MindMapModel.updateFull(domainId, mindMap.docId, {
                history,
            });

            // 触发更新事件，通知所有连接的 WebSocket 客户端
            (this.ctx.emit as any)('mindmap/update', mindMap.docId, mindMap.mmid);
            (this.ctx.emit as any)('mindmap/git/status/update', mindMap.docId, mindMap.mmid);
            (this.ctx.emit as any)('mindmap/history/update', mindMap.docId, mindMap.mmid);

            this.response.body = { ok: true, message: 'Changes committed successfully' };
        } catch (err: any) {
            console.error('Commit failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, error: err?.message || String(err) };
        }
    }
}

/**
 * MindMap History Handler
 * 获取历史记录和恢复
 */
class MindMapHistoryHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, mmid: number, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found');
        }
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        }

        const history = mindMap.history || [];
        this.response.body = { history };
    }

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    @param('historyId', Types.String)
    async post(domainId: string, docId: ObjectId, mmid: number, branch: string, historyId: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found');
        }
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const currentBranch = branch || (mindMap as any).currentBranch || 'main';
        const history = mindMap.history || [];
        const historyEntry = history.find(h => h.id === historyId);
        if (!historyEntry) {
            throw new NotFoundError('History entry not found');
        }

        // 恢复快照数据到当前分支
        setBranchData(mindMap, currentBranch, 
            historyEntry.snapshot.nodes || [],
            historyEntry.snapshot.edges || []
        );

        await MindMapModel.updateFull(domainId, mindMap.docId, {
            branchData: mindMap.branchData,
            nodes: mindMap.nodes, // 向后兼容
            edges: mindMap.edges, // 向后兼容
            viewport: historyEntry.snapshot.viewport,
        });

        this.response.body = { success: true };
    }
}

/**
 * Import mindmap data from git file structure to database
 */
async function importMindMapFromFileStructure(
    domainId: string,
    mmid: number,
    localDir: string,
    branch: string
): Promise<{ nodes: MindMapNode[]; edges: MindMapEdge[] }> {
    const nodes: MindMapNode[] = [];
    const edges: MindMapEdge[] = [];
    const nodeIdMap = new Map<string, string>(); // dirPath -> nodeId
    
    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
    
    // Read README.md as mindmap content (but we don't update it here, just for reference)
    const readmePath = path.join(localDir, 'README.md');
    try {
        await fs.promises.readFile(readmePath, 'utf-8');
    } catch {}
    
    // Create root node (invisible, just for structure)
    const rootNodeId = `root_${mmid}`;
    nodes.push({
        id: rootNodeId,
        text: 'Root',
        x: 0,
        y: 0,
        data: {},
        style: { display: 'none' },
    });
    nodeIdMap.set(localDir, rootNodeId);
    
    let nodeCounter = 0;
    
    // Recursively import nodes from directory structure
    async function importNode(parentNodeId: string, dirPath: string, dirName: string, level: number = 0): Promise<void> {
        const nodeId = `node_${mmid}_${++nodeCounter}`;
        const nodeText = sanitize(dirName);
        
        // Create node
        const node: MindMapNode = {
            id: nodeId,
            text: nodeText,
            x: level * 200,
            y: 0,
            data: {},
        };
        nodes.push(node);
        nodeIdMap.set(dirPath, nodeId);
        
        // Create edge from parent to this node
        if (parentNodeId) {
            edges.push({
                id: `edge_${parentNodeId}_${nodeId}`,
                source: parentNodeId,
                target: nodeId,
                type: 'bezier',
            });
        }
        
        // Read cards (Markdown files) in this directory
        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            // 先取出该节点下现有的所有卡片，用于后续精确对齐（新增、更新、删除）
            const existingCards = await CardModel.getByNodeId(domainId, mmid, nodeId);
            const existingCardsByTitle = new Map<string, CardDoc>();
            const processedCardIds = new Set<string>();

            for (const card of existingCards) {
                // 以标题作为同一目录下卡片的唯一标识
                if (card.title) {
                    existingCardsByTitle.set(card.title, card);
                }
            }

            for (const entry of entries) {
                if (
                    entry.isFile() &&
                    entry.name.toLowerCase().endsWith('.md') &&
                    entry.name.toLowerCase() !== 'readme.md'
                ) {
                    const cardPath = path.join(dirPath, entry.name);
                    const cardContent = await fs.promises.readFile(cardPath, 'utf-8');
                    const cardTitle = sanitize(entry.name.replace(/\.md$/i, ''));

                    // 根据文件名（标题）精确匹配已有卡片，做到“只更新有改动的 / 新增的文件”
                    try {
                        const existingCard = existingCardsByTitle.get(cardTitle);

                        if (existingCard) {
                            // 更新已有卡片
                            await CardModel.update(domainId, existingCard.docId, {
                                content: cardContent,
                            });
                            processedCardIds.add(existingCard.docId.toString());
                        } else {
                            // 创建新卡片
                            const newCardId = await CardModel.create(
                                domainId,
                                mmid,
                                nodeId,
                                0, // owner (system)
                                cardTitle,
                                cardContent,
                                '127.0.0.1'
                            );
                            processedCardIds.add(newCardId.toString());
                        }
                    } catch (err) {
                        console.error(`Failed to create/update card ${cardTitle} for node ${nodeId}:`, err);
                    }
                }
            }

            // 删除目录下已经不存在对应 Markdown 文件的旧卡片（包括在 GitHub 上被删除或移动到其它目录的）
            for (const card of existingCards) {
                const idStr = card.docId.toString();
                if (!processedCardIds.has(idStr)) {
                    try {
                        await CardModel.delete(domainId, card.docId);
                    } catch (err) {
                        console.error(`Failed to delete stale card ${idStr} for node ${nodeId}:`, err);
                    }
                }
            }
            
            // Recursively import child directories
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name !== '.git') {
                    const childDirPath = path.join(dirPath, entry.name);
                    await importNode(nodeId, childDirPath, entry.name, level + 1);
                }
            }
        } catch (err) {
            console.error(`Failed to read directory ${dirPath}:`, err);
        }
    }
    
    // Import top-level directories (children of root)
    try {
        const topEntries = await fs.promises.readdir(localDir, { withFileTypes: true });
        for (const entry of topEntries) {
            if (entry.isDirectory() && entry.name !== '.git') {
                const childDirPath = path.join(localDir, entry.name);
                await importNode(rootNodeId, childDirPath, entry.name, 1);
            }
        }
    } catch (err) {
        console.error(`Failed to read top-level directories:`, err);
    }

    return { nodes, edges };
}

/**
 * Cleanup all cards of a mindmap before re-importing from Git.
 * 拉取前删除该思维导图下的所有卡片，后续完全按照仓库结构重建。
 */
async function cleanupMindMapCards(
    domainId: string,
    mmid: number,
    _nodes: MindMapNode[] // 兼容旧签名，暂不使用 nodes
): Promise<void> {
    try {
        // 直接删除该思维导图下所有旧卡片，完全按照本次拉取结果重建
        await document.deleteMulti(domainId, TYPE_CARD as any, { mmid } as any);
    } catch (err) {
        console.error(
            `cleanupMindMapCards failed for mmid=${mmid}:`,
            (err as any)?.message || err
        );
    }
}

/**
 * MindMap GitHub Pull Handler
 */
class MindMapGithubPullHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: ObjectId, mmid: number, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found');
        }
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const githubRepo = (mindMap.githubRepo || '') as string;
        if (!githubRepo) {
            throw new Error('GitHub repository not configured. Please configure it in mindmap settings.');
        }
        
        const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
        const systemValue = system.get('ejunzrepo.github_token');
        const GH_TOKEN = settingValue || systemValue || '';
        if (!GH_TOKEN) {
            throw new Error('GitHub token not configured. Please configure it in system settings.');
        }
        
        let REPO_URL = githubRepo;
        if (githubRepo.startsWith('git@')) {
            REPO_URL = githubRepo;
        } else {
            if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                if (githubRepo.includes('@github.com')) {
                    REPO_URL = githubRepo;
                } else {
                    REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                        .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || mindMap.branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        const repoGitPath = await ensureMindMapGitRepo(domainId, mindMap.mmid, REPO_URL);
        
        try {
            try {
                await exec(`git checkout ${effectiveBranch}`, { cwd: repoGitPath });
            } catch {
                await exec(`git checkout -b ${effectiveBranch}`, { cwd: repoGitPath });
            }
            
            try {
                await exec(`git remote set-url origin ${REPO_URL}`, { cwd: repoGitPath });
            } catch {
                try {
                    await exec(`git remote add origin ${REPO_URL}`, { cwd: repoGitPath });
                } catch {}
            }
            
            await exec('git fetch origin', { cwd: repoGitPath });
            await exec(`git reset --hard origin/${effectiveBranch}`, { cwd: repoGitPath });
            
            // 在从 Git 导入结构前，先清空旧卡片，确保后续严格以仓库为准重建
            await cleanupMindMapCards(domainId, mindMap.mmid, []);

            // Import mindmap structure from git file system（会根据目录和 .md 文件重新创建卡片）
            const { nodes, edges } = await importMindMapFromFileStructure(
                domainId,
                mindMap.mmid,
                repoGitPath,
                effectiveBranch
            );
            
            // Update branch data
            setBranchData(mindMap, effectiveBranch, nodes, edges);
            
            // Read README.md for content
            const readmePath = path.join(repoGitPath, 'README.md');
            let content = mindMap.content || '';
            try {
                content = await fs.promises.readFile(readmePath, 'utf-8');
            } catch {}
            
            await MindMapModel.updateFull(domainId, mindMap.docId, {
                branchData: mindMap.branchData,
                nodes: mindMap.nodes, // 向后兼容
                edges: mindMap.edges, // 向后兼容
                content,
            });
            
            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Pull failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        }
    }
}

/**
 * MindMap GitHub Config Handler
 */
class MindMapGithubConfigHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: ObjectId, mmid: number) {
        this.mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!this.mindMap) throw new NotFoundError('MindMap not found');
        
        if (!this.user.own(this.mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    @param('githubRepo', Types.String, true)
    async post(domainId: string, docId: ObjectId, mmid: number, githubRepo?: string) {
        if (githubRepo !== undefined) {
            await document.set(domainId, document.TYPE_MINDMAP, this.mindMap!.docId, {
                githubRepo: githubRepo || null,
            });
        }
        
        this.response.body = { success: true, githubRepo: githubRepo || null };
    }
}

/**
 * MindMap WebSocket Connection Handler
 * 用于实时推送 mindmap 的更新（git status, history 等）
 */
class MindMapConnectionHandler extends ConnectionHandler {
    private docId?: ObjectId;
    private mmid?: number;
    private subscriptions: Array<{ dispose: () => void }> = [];

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async prepare(domainId: string, docId?: ObjectId, mmid?: number) {
        if (!docId && !mmid) {
            this.close(1000, 'docId or mmid is required');
            return;
        }

        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid!);
        
        if (!mindMap) {
            this.close(1000, 'MindMap not found');
            return;
        }

        this.docId = mindMap.docId;
        this.mmid = mindMap.mmid;

        // 检查权限
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        }

        logger.info('MindMap WebSocket connected: docId=%s, mmid=%d', this.docId, this.mmid);

        // 发送初始数据
        await this.sendInitialData(domainId, mindMap);

        // 订阅 mindmap 更新事件
        const dispose1 = (this.ctx.on as any)('mindmap/update', async (...args: any[]) => {
            const [updateDocId, updateMmid] = args;
            if (updateDocId && updateDocId.toString() === this.docId!.toString() || updateMmid === this.mmid) {
                await this.sendUpdate(domainId);
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        // 订阅 git status 更新事件
        const dispose2 = (this.ctx.on as any)('mindmap/git/status/update', async (...args: any[]) => {
            const [updateDocId, updateMmid] = args;
            if (updateDocId && updateDocId.toString() === this.docId!.toString() || updateMmid === this.mmid) {
                await this.sendGitStatus(domainId);
            }
        });
        this.subscriptions.push({ dispose: dispose2 });

        // 订阅 history 更新事件
        const dispose3 = (this.ctx.on as any)('mindmap/history/update', async (...args: any[]) => {
            const [updateDocId, updateMmid] = args;
            if (updateDocId && updateDocId.toString() === this.docId!.toString() || updateMmid === this.mmid) {
                await this.sendHistory(domainId);
            }
        });
        this.subscriptions.push({ dispose: dispose3 });
    }

    async cleanup() {
        for (const sub of this.subscriptions) {
            try {
                sub.dispose();
            } catch (e) {
                // ignore
            }
        }
        this.subscriptions = [];
    }

    private async sendInitialData(domainId: string, mindMap: MindMapDoc) {
        try {
            const branch = (mindMap as any).currentBranch || 'main';
            const gitStatus = await getMindMapGitStatus(domainId, mindMap.mmid, branch).catch(() => null);
            const history = mindMap.history || [];

            this.send({
                type: 'init',
                gitStatus,
                history,
                branch,
            });
        } catch (err) {
            logger.error('Failed to send initial data:', err);
        }
    }

    private async sendUpdate(domainId: string) {
        try {
            const mindMap = await MindMapModel.get(domainId, this.docId!);
            if (!mindMap) return;

            const branch = (mindMap as any).currentBranch || 'main';
            const gitStatus = await getMindMapGitStatus(domainId, mindMap.mmid, branch).catch(() => null);
            const history = mindMap.history || [];

            this.send({
                type: 'update',
                gitStatus,
                history,
                branch,
            });
        } catch (err) {
            logger.error('Failed to send update:', err);
        }
    }

    private async sendGitStatus(domainId: string) {
        try {
            const mindMap = await MindMapModel.get(domainId, this.docId!);
            if (!mindMap) return;

            const branch = (mindMap as any).currentBranch || 'main';
            const gitStatus = await getMindMapGitStatus(domainId, mindMap.mmid, branch).catch(() => null);

            this.send({
                type: 'git_status',
                gitStatus,
                branch,
            });
        } catch (err) {
            logger.error('Failed to send git status:', err);
        }
    }

    private async sendHistory(domainId: string) {
        try {
            const mindMap = await MindMapModel.get(domainId, this.docId!);
            if (!mindMap) return;

            const history = mindMap.history || [];

            this.send({
                type: 'history',
                history,
            });
        } catch (err) {
            logger.error('Failed to send history:', err);
        }
    }
}

export async function apply(ctx: Context) {
    // 注册路由
    ctx.Route('mindmap_domain', '/mindmap', MindMapDomainHandler);
    ctx.Route('mindmap_list', '/mindmap/list', MindMapListHandler);
    ctx.Route('mindmap_create', '/mindmap/create', MindMapCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_detail', '/mindmap/:docId', MindMapDetailHandler);
    ctx.Route('mindmap_detail_mmid', '/mindmap/mmid/:mmid', MindMapDetailHandler);
    ctx.Route('mindmap_detail_branch', '/mindmap/:docId/branch/:branch', MindMapDetailHandler);
    ctx.Route('mindmap_detail_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch', MindMapDetailHandler);
    ctx.Route('mindmap_study', '/mindmap/:docId/study', MindMapStudyHandler);
    ctx.Route('mindmap_study_mmid', '/mindmap/mmid/:mmid/study', MindMapStudyHandler);
    ctx.Route('mindmap_study_branch', '/mindmap/:docId/branch/:branch/study', MindMapStudyHandler);
    ctx.Route('mindmap_study_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch/study', MindMapStudyHandler);
    ctx.Route('mindmap_data', '/mindmap/:docId/data', MindMapDataHandler);
    ctx.Route('mindmap_data_mmid', '/mindmap/mmid/:mmid/data', MindMapDataHandler);
    ctx.Route('mindmap_edit', '/mindmap/:docId/edit', MindMapEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_node', '/mindmap/:docId/node', MindMapNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_node_update', '/mindmap/:docId/node/:nodeId', MindMapNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_edge', '/mindmap/:docId/edge', MindMapEdgeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_save', '/mindmap/:docId/save', MindMapSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_branch_create', '/mindmap/:docId/branch', MindMapBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_branch_create_mmid', '/mindmap/mmid/:mmid/branch', MindMapBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_branch_create_with_param', '/mindmap/:docId/branch/:branch/create', MindMapBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_branch_create_with_param_mmid', '/mindmap/mmid/:mmid/branch/:branch/create', MindMapBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_git_status', '/mindmap/:docId/git/status', MindMapGitStatusHandler);
    ctx.Route('mindmap_git_status_mmid', '/mindmap/mmid/:mmid/git/status', MindMapGitStatusHandler);
    ctx.Route('mindmap_commit', '/mindmap/:docId/commit', MindMapCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_commit_mmid', '/mindmap/mmid/:mmid/commit', MindMapCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_commit_branch', '/mindmap/:docId/branch/:branch/commit', MindMapCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_commit_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch/commit', MindMapCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_push', '/mindmap/:docId/github/push', MindMapGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_push_mmid', '/mindmap/mmid/:mmid/github/push', MindMapGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_push_branch', '/mindmap/:docId/branch/:branch/github/push', MindMapGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_push_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch/github/push', MindMapGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_pull', '/mindmap/:docId/github/pull', MindMapGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_pull_mmid', '/mindmap/mmid/:mmid/github/pull', MindMapGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_pull_branch', '/mindmap/:docId/branch/:branch/github/pull', MindMapGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_pull_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch/github/pull', MindMapGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_history', '/mindmap/:docId/history', MindMapHistoryHandler);
    ctx.Route('mindmap_history_mmid', '/mindmap/mmid/:mmid/history', MindMapHistoryHandler);
    ctx.Route('mindmap_history_branch', '/mindmap/:docId/branch/:branch/history', MindMapHistoryHandler);
    ctx.Route('mindmap_history_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch/history', MindMapHistoryHandler);
    ctx.Route('mindmap_history_restore', '/mindmap/:docId/history/:historyId/restore', MindMapHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_history_restore_mmid', '/mindmap/mmid/:mmid/history/:historyId/restore', MindMapHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_history_restore_branch', '/mindmap/:docId/branch/:branch/history/:historyId/restore', MindMapHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_history_restore_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch/history/:historyId/restore', MindMapHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card', '/mindmap/:docId/card', MindMapCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_mmid', '/mindmap/mmid/:mmid/card', MindMapCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_update', '/mindmap/card/:cardId', MindMapCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_update_mmid', '/mindmap/mmid/:mmid/card/:cardId', MindMapCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_list', '/mindmap/:docId/node/:nodeId/cards', MindMapCardListHandler);
    ctx.Route('mindmap_card_list_mmid', '/mindmap/mmid/:mmid/node/:nodeId/cards', MindMapCardListHandler);
    ctx.Route('mindmap_card_list_branch', '/mindmap/:docId/branch/:branch/node/:nodeId/cards', MindMapCardListHandler);
    ctx.Route('mindmap_card_list_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch/node/:nodeId/cards', MindMapCardListHandler);
    ctx.Route('mindmap_card_edit', '/mindmap/:docId/node/:nodeId/card/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_edit_mmid', '/mindmap/mmid/:mmid/node/:nodeId/card/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_edit_with_card', '/mindmap/:docId/node/:nodeId/card/:cardId/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_edit_with_card_mmid', '/mindmap/mmid/:mmid/node/:nodeId/card/:cardId/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_edit_branch', '/mindmap/:docId/branch/:branch/node/:nodeId/card/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_edit_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch/node/:nodeId/card/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_edit_branch_with_card', '/mindmap/:docId/branch/:branch/node/:nodeId/card/:cardId/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_edit_branch_with_card_mmid', '/mindmap/mmid/:mmid/branch/:branch/node/:nodeId/card/:cardId/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_detail', '/mindmap/:docId/node/:nodeId/card/:cardId', MindMapCardDetailHandler);
    ctx.Route('mindmap_card_detail_mmid', '/mindmap/mmid/:mmid/node/:nodeId/card/:cardId', MindMapCardDetailHandler);
    ctx.Route('mindmap_card_detail_branch', '/mindmap/:docId/branch/:branch/node/:nodeId/card/:cardId', MindMapCardDetailHandler);
    ctx.Route('mindmap_card_detail_branch_mmid', '/mindmap/mmid/:mmid/branch/:branch/node/:nodeId/card/:cardId', MindMapCardDetailHandler);
    
    // WebSocket 连接路由
    ctx.Connection('mindmap_connection', '/mindmap/:docId/ws', MindMapConnectionHandler);
    ctx.Connection('mindmap_connection_mmid', '/mindmap/mmid/:mmid/ws', MindMapConnectionHandler);
}


import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import { Handler, param, Types } from '../service/server';
import { NotFoundError, ForbiddenError } from '../error';
import { PRIV, PERM } from '../model/builtin';
import { MindMapModel, CardModel } from '../model/mindmap';
import type { MindMapDoc, MindMapNode, MindMapEdge, CardDoc, MindMapHistoryEntry } from '../interface';
import * as document from '../model/document';
import { exec as execCb } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import system from '../model/system';
import https from 'https';

const exec = promisify(execCb);

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
        } else if (mmid) {
            this.mindMap = await MindMapModel.getByMmid(domainId, mmid);
        }
        if (!this.mindMap) throw new NotFoundError('MindMap not found');
        
        await MindMapModel.incrementViews(domainId, this.mindMap.docId);
    }

    @param('docId', Types.ObjectId, true)
    @param('mmid', Types.PositiveInt, true)
    async get(domainId: string, docId: ObjectId, mmid: number) {
        this.response.template = 'mindmap_detail.html';
        
        // Get git status
        let gitStatus: any = null;
        const currentBranch = (this.mindMap as any)?.currentBranch || 'main';
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
                
                gitStatus = await getMindMapGitStatus(domainId, this.mindMap!.mmid, currentBranch, REPO_URL);
            } catch (err) {
                console.error('Failed to get git status:', err);
                gitStatus = null;
            }
        } else {
            try {
                gitStatus = await getMindMapGitStatus(domainId, this.mindMap!.mmid, currentBranch);
            } catch (err) {
                console.error('Failed to get local git status:', err);
                gitStatus = null;
            }
        }
        
        this.response.body = {
            mindMap: this.mindMap,
            gitStatus,
            currentBranch,
        };
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
        
        const { docId, mmid } = await MindMapModel.create(
            domainId,
            this.user._id,
            title,
            content,
            rpid,
            branch,
            this.request.ip
        );

        // 自动创建 GitHub 仓库
        try {
            await ensureMindMapGitRepo(domainId, mmid);
            
            try {
                await createAndPushToGitHubOrgForMindMap(this, domainId, mmid, title, this.user);
            } catch (err) {
                console.error('Failed to create remote GitHub repo:', err);
            }
        } catch (err) {
            console.error('Failed to create git repo:', err);
        }

        this.response.body = { docId, mmid };
        this.response.redirect = this.url('mindmap_detail', { docId: docId.toString() });
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

        // 检测是否有非位置改变（用于commit检测）
        const hasNonPositionChanges = this.detectNonPositionChanges(mindMap, nodes, edges);

        // 记录操作历史
        const historyEntry: MindMapHistoryEntry = {
            id: `hist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: 'save',
            timestamp: new Date(),
            userId: this.user._id,
            username: this.user.uname || 'unknown',
            description: operationDescription || '自动保存',
            snapshot: {
                nodes: JSON.parse(JSON.stringify(nodes || mindMap.nodes)),
                edges: JSON.parse(JSON.stringify(edges || mindMap.edges)),
                viewport: viewport || mindMap.viewport,
            },
        };

        // 更新历史记录（最多保留50条）
        const history = mindMap.history || [];
        history.unshift(historyEntry);
        if (history.length > 50) {
            history.splice(50);
        }

        await MindMapModel.updateFull(domainId, docId, {
            nodes,
            edges,
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
    async get(domainId: string, page = 1, q = '') {
        let mindMaps = await MindMapModel.getAll(domainId);
        
        // 搜索过滤
        if (q && q.trim()) {
            const searchTerm = q.trim().toLowerCase();
            mindMaps = mindMaps.filter(mindMap => 
                mindMap.title.toLowerCase().includes(searchTerm) ||
                (mindMap.content && mindMap.content.toLowerCase().includes(searchTerm)) ||
                String(mindMap.mmid).includes(searchTerm)
            );
        }
        
        // 按 mmid 排序
        mindMaps.sort((a, b) => (a.mmid || 0) - (b.mmid || 0));
        
        // 计算统计信息
        const totalNodes = mindMaps.reduce((sum, mm) => sum + (mm.nodes?.length || 0), 0);
        const totalViews = mindMaps.reduce((sum, mm) => sum + (mm.views || 0), 0);
        
        this.response.template = 'mindmap_domain.html';
        this.response.body = { 
            mindMaps, 
            domainId,
            page,
            qs: q,
            totalNodes,
            totalViews,
        };
    }
}

class MindMapDataHandler extends Handler {
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
        this.response.body = this.mindMap;
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
async function exportMindMapToFile(mindMap: MindMapDoc, outputDir: string): Promise<void> {
    await fs.promises.mkdir(outputDir, { recursive: true });
    
    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
    
    // Create README.md for mindmap root (only contains the content, no metadata)
    const readmePath = path.join(outputDir, 'README.md');
    const contentText = mindMap.content || '';
    await fs.promises.writeFile(readmePath, contentText, 'utf-8');
    
    // Build node tree structure
    const nodeMap = new Map<string, MindMapNode>();
    
    for (const node of mindMap.nodes || []) {
        nodeMap.set(node.id, node);
    }
    
    // Find root node (node with no incoming edges)
    const rootNode = (mindMap.nodes || []).find(node => 
        !(mindMap.edges || []).some(edge => edge.target === node.id)
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
        const childEdges = (mindMap.edges || []).filter(edge => edge.source === node.id);
        for (const edge of childEdges) {
            const childNode = nodeMap.get(edge.target);
            if (childNode) {
                await exportNode(childNode, nodeDir);
            }
        }
    }
    
    // Export only root node's children (not the root node itself)
    if (rootNode) {
        const rootChildEdges = (mindMap.edges || []).filter(edge => edge.source === rootNode.id);
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

        const mindMap = await MindMapModel.getByMmid(domainId, mmid);
        if (mindMap) {
            await document.set(domainId, document.TYPE_MINDMAP, mindMap.docId, {
                githubRepo: REPO_URL,
            });
        }

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-mindmap-create-'));
        try {
            const mindMapForExport = await MindMapModel.getByMmid(domainId, mmid);
            if (mindMapForExport) {
                await exportMindMapToFile(mindMapForExport, tmpDir);
                const commitMessage = `${domainId}/${user._id}/${user.uname || 'unknown'}: Initial commit`;
                await gitInitAndPushMindMap(domainId, mmid, mindMapForExport, REPO_URL, 'main', commitMessage);
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
        
        // Export mindmap to files
        await exportMindMapToFile(mindMap, repoGitPath);
        
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
    @param('nodeId', Types.String)
    @param('title', Types.String)
    @param('content', Types.String, true)
    async post(
        domainId: string,
        docId: ObjectId,
        mmid: number,
        nodeId: string,
        title: string,
        content: string = ''
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
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
    
    @param('cardId', Types.ObjectId)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('operation', Types.String, true)
    async postUpdate(
        domainId: string,
        cardId: ObjectId,
        title?: string,
        content?: string,
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
        await exportMindMapToFile(mindMap, tmpDir);
        
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
    
    const branch = mindMap.branch || 'main';
    try {
        await exec(`git checkout ${branch}`, { cwd: repoGitPath });
    } catch {
        await exec(`git checkout -b ${branch}`, { cwd: repoGitPath });
    }
    
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-mindmap-commit-'));
    try {
        await exportMindMapToFile(mindMap, tmpDir);
        
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
    @param('branch', Types.String)
    async post(domainId: string, docId: ObjectId, mmid: number, branch: string) {
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
        const newBranch = (branch || '').trim() || 'main';
        if (!branches.includes(newBranch)) {
            branches.push(newBranch);
        }
        
        await document.set(domainId, document.TYPE_MINDMAP, mindMap.docId, { 
            branches, 
            currentBranch: newBranch 
        });
        
        try {
            const repoGitPath = await ensureMindMapGitRepo(domainId, mmid);
            await exec(`git checkout main`, { cwd: repoGitPath });
            await exec(`git checkout -b ${newBranch}`, { cwd: repoGitPath });
        } catch (err) {
            console.error('Failed to create git branch:', err);
        }
        
        this.response.body = { ok: true, branch: newBranch };
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
    async get(domainId: string, docId: ObjectId, mmid: number) {
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
    @param('historyId', Types.String)
    async postRestore(domainId: string, docId: ObjectId, mmid: number, historyId: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByMmid(domainId, mmid);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found');
        }
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const history = mindMap.history || [];
        const historyEntry = history.find(h => h.id === historyId);
        if (!historyEntry) {
            throw new NotFoundError('History entry not found');
        }

        // 恢复快照数据
        await MindMapModel.updateFull(domainId, mindMap.docId, {
            nodes: historyEntry.snapshot.nodes,
            edges: historyEntry.snapshot.edges,
            viewport: historyEntry.snapshot.viewport,
        });

        this.response.body = { success: true };
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
            await exec(`git pull origin ${effectiveBranch}`, { cwd: repoGitPath });
            
            // Read the JSON file and update mindmap
            const fileName = `mindmap-${mindMap.mmid}.json`;
            const filePath = path.join(repoGitPath, fileName);
            
            if (await fs.promises.access(filePath).then(() => true).catch(() => false)) {
                const fileContent = await fs.promises.readFile(filePath, 'utf-8');
                const importedData = JSON.parse(fileContent);
                
                await MindMapModel.updateFull(domainId, mindMap.docId, {
                    nodes: importedData.nodes,
                    edges: importedData.edges,
                    layout: importedData.layout,
                    viewport: importedData.viewport,
                    theme: importedData.theme,
                });
            }
            
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

export async function apply(ctx: Context) {
    // 注册路由
    ctx.Route('mindmap_domain', '/mindmap', MindMapDomainHandler);
    ctx.Route('mindmap_list', '/mindmap/list', MindMapListHandler);
    ctx.Route('mindmap_create', '/mindmap/create', MindMapCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_detail', '/mindmap/:docId', MindMapDetailHandler);
    ctx.Route('mindmap_detail_mmid', '/mindmap/mmid/:mmid', MindMapDetailHandler);
    ctx.Route('mindmap_study', '/mindmap/:docId/study', MindMapStudyHandler);
    ctx.Route('mindmap_study_mmid', '/mindmap/mmid/:mmid/study', MindMapStudyHandler);
    ctx.Route('mindmap_data', '/mindmap/:docId/data', MindMapDataHandler);
    ctx.Route('mindmap_data_mmid', '/mindmap/mmid/:mmid/data', MindMapDataHandler);
    ctx.Route('mindmap_edit', '/mindmap/:docId/edit', MindMapEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_node', '/mindmap/:docId/node', MindMapNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_node_update', '/mindmap/:docId/node/:nodeId', MindMapNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_edge', '/mindmap/:docId/edge', MindMapEdgeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_save', '/mindmap/:docId/save', MindMapSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_branch_create', '/mindmap/:docId/branch', MindMapBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_branch_create_mmid', '/mindmap/mmid/:mmid/branch', MindMapBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_git_status', '/mindmap/:docId/git/status', MindMapGitStatusHandler);
    ctx.Route('mindmap_git_status_mmid', '/mindmap/mmid/:mmid/git/status', MindMapGitStatusHandler);
    ctx.Route('mindmap_commit', '/mindmap/:docId/commit', MindMapCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_commit_mmid', '/mindmap/mmid/:mmid/commit', MindMapCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_push', '/mindmap/:docId/github/push', MindMapGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_push_mmid', '/mindmap/mmid/:mmid/github/push', MindMapGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_pull', '/mindmap/:docId/github/pull', MindMapGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_github_pull_mmid', '/mindmap/mmid/:mmid/github/pull', MindMapGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_history', '/mindmap/:docId/history', MindMapHistoryHandler);
    ctx.Route('mindmap_history_mmid', '/mindmap/mmid/:mmid/history', MindMapHistoryHandler);
    ctx.Route('mindmap_history_restore', '/mindmap/:docId/history/:historyId/restore', MindMapHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_history_restore_mmid', '/mindmap/mmid/:mmid/history/:historyId/restore', MindMapHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card', '/mindmap/:docId/card', MindMapCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_mmid', '/mindmap/mmid/:mmid/card', MindMapCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mindmap_card_update', '/mindmap/card/:cardId', MindMapCardHandler, PRIV.PRIV_USER_PROFILE);
}


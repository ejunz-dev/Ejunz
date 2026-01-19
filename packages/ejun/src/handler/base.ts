import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import { Handler, param, route, post, Types, ConnectionHandler } from '../service/server';
import { NotFoundError, ForbiddenError, BadRequestError, ValidationError, FileLimitExceededError, FileUploadError, FileExistsError } from '../error';
import { PRIV, PERM } from '../model/builtin';
import { MindMapModel, CardModel, TYPE_CARD, TYPE_MM } from '../model/base';
import type { MindMapDoc, MindMapNode, MindMapEdge, CardDoc } from '../interface';
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
import { pick, omit } from 'lodash';
import storage from '../model/storage';
import { sortFiles } from '@ejunz/utils/lib/common';

const exec = promisify(execCb);
const logger = new Logger('base');

/**
 * Base Detail Handler
 */
class MindMapDetailHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    async _prepare(domainId: string, docId: ObjectId) {
        const path = this.request.path || '';
        if (path.endsWith('.css.map') || path.endsWith('.js.map') || path.endsWith('.map')) {
            throw new NotFoundError('Static resource');
        }
        
        if (docId) {
            this.mindMap = await MindMapModel.get(domainId, docId);
        } else {
            // 如果没有 docId，通过 domainId 获取（一个 domain 一个 base）
            this.mindMap = await MindMapModel.getByDomain(domainId);
        }
        
        if (!this.mindMap) {
            throw new NotFoundError('Base not found');
        }
        
        await MindMapModel.incrementViews(domainId, this.mindMap.docId);
    }

    @param('docId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, branch?: string) {
        // If no branch parameter, redirect to branch URL
        if (!branch || !String(branch).trim()) {
            const target = this.url('base_detail_branch', { 
                domainId, 
                docId: docId || this.mindMap!.docId, 
                branch: 'main' 
            });
            this.response.redirect = target;
            return;
        }
        
        this.response.template = 'base_detail.html';
        
        // Handle branch parameter
        const requestedBranch = branch;
        const currentMindMapBranch = (this.mindMap as any)?.currentBranch || 'main';
        
        // Update currentBranch if different and checkout git branch
        if (requestedBranch !== currentMindMapBranch) {
            await document.set(domainId, document.TYPE_BASE, this.mindMap!.docId, { 
                currentBranch: requestedBranch 
            });
            (this.mindMap as any).currentBranch = requestedBranch;
            
            // Checkout to the requested branch in git
            try {
                const repoGitPath = getMindMapGitPath(domainId, this.mindMap!.docId);
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
                
                gitStatus = await getMindMapGitStatus(domainId, this.mindMap!.docId, requestedBranch, REPO_URL);
            } catch (err) {
                console.error('Failed to get git status:', err);
                gitStatus = null;
            }
        } else {
            try {
                gitStatus = await getMindMapGitStatus(domainId, this.mindMap!.docId, requestedBranch);
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
                    const cards = await CardModel.getByNodeId(domainId, this.mindMap!.docId, node.id);
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
            files: this.mindMap.files || [], // 添加文件列表
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
 * Base Study Handler
 */
class MindMapStudyHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: ObjectId, bid: number) {
        if (docId) {
            this.mindMap = await MindMapModel.get(domainId, docId);
        } else if (bid) {
            this.mindMap = await MindMapModel.getBybid(domainId, bid);
        }
        if (!this.mindMap) throw new NotFoundError('Base not found');
    }

    @param('docId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, branch?: string) {
        const currentBranch = branch || (this.mindMap as any)?.currentBranch || 'main';
        const branchData = getBranchData(this.mindMap!, currentBranch);
        
        // 找到根节点（没有父边的节点）
        const rootNodes = branchData.nodes.filter(node => 
            !branchData.edges.some(edge => edge.target === node.id)
        );

        const units: Array<{ 
            node: MindMapNode; 
            problemCount: number;
            problems: Array<{
                pid: string;
                type: 'single';
                stem: string;
                options: string[];
                answer: number;
                analysis?: string;
                cardId: string;
                cardTitle: string;
                cardUrl: string;
            }>;
        }> = [];

        // 辅助函数：收集节点的所有 problems
        const collectNodeProblems = async (node: MindMapNode): Promise<Array<{
            pid: string;
            type: 'single';
            stem: string;
            options: string[];
            answer: number;
            analysis?: string;
            cardId: string;
            cardTitle: string;
            cardUrl: string;
        }>> => {
            const allProblems: Array<{
                pid: string;
                type: 'single';
                stem: string;
                options: string[];
                answer: number;
                analysis?: string;
                cardId: string;
                cardTitle: string;
                cardUrl: string;
            }> = [];
            
            try {
                const cards = await CardModel.getByNodeId(domainId, this.mindMap!.docId, node.id);
                
                if (cards && cards.length > 0) {
                    const docId = this.mindMap!.docId;
                    
                    for (const card of cards) {
                        if (card.problems && card.problems.length > 0) {
                            // 构建卡片 URL
                            const cardUrl = `/d/${domainId}/base/${docId}/branch/${currentBranch}/node/${node.id}/cards?cardId=${card.docId}`;
                            
                            for (const problem of card.problems) {
                                allProblems.push({
                                    ...problem,
                                    cardId: card.docId.toString(),
                                    cardTitle: card.title,
                                    cardUrl,
                                });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error(`Failed to get cards for node ${node.id}:`, err);
            }
            
            return allProblems;
        };

        if (rootNodes.length > 0) {
            const rootNode = rootNodes[0];
            
            // 先处理根节点本身
            const rootProblems = await collectNodeProblems(rootNode);
            units.push({
                node: rootNode,
                problemCount: rootProblems.length,
                problems: rootProblems,
            });
            
            // 然后处理根节点的所有子节点
            const childEdges = branchData.edges.filter(e => e.source === rootNode.id);
            
            for (const edge of childEdges) {
                const childNode = branchData.nodes.find(n => n.id === edge.target);
                if (childNode) {
                    const childProblems = await collectNodeProblems(childNode);
                    units.push({
                        node: childNode,
                        problemCount: childProblems.length,
                        problems: childProblems,
                    });
                }
            }
        }

        this.response.template = 'base_study.html';
        this.response.body = {
            mindMap: {
                ...this.mindMap,
                nodes: branchData.nodes,
                edges: branchData.edges,
                currentBranch,
            },
            units,
        };
    }
}

/**
 * Base Outline Handler (文件模式)
 */
class MindMapOutlineHandler extends Handler {
    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        // If no branch parameter, redirect to branch URL
        if (!branch || !String(branch).trim()) {
            const target = this.url('base_outline_branch', { 
                domainId, 
                branch: 'main' 
            });
            this.response.redirect = target;
            return;
        }
        
        this.response.template = 'base_outline.html';
        
        const requestedBranch = branch || 'main';
        
        // 直接获取该域下的 base（如果存在），用于获取 nodes 和 edges
        let mindMap = await MindMapModel.getByDomain(domainId);
        
        // 如果没有 base，创建一个
        if (!mindMap) {
            const { docId } = await MindMapModel.create(
                domainId,
                this.user._id,
                '思维导图',
                '',
                undefined,
                requestedBranch,
                this.request.ip
            );
            mindMap = await MindMapModel.get(domainId, docId);
            if (!mindMap) {
                throw new Error('Failed to create base');
            }
        }
        
        // 获取 nodes 和 edges（从 base 或返回空数组）
        let nodes: MindMapNode[] = [];
        let edges: MindMapEdge[] = [];
        
        if (mindMap) {
            const branchData = getBranchData(mindMap, requestedBranch);
            nodes = branchData.nodes || [];
            edges = branchData.edges || [];
        }
        
        // 如果没有节点，自动创建一个根节点
        if (nodes.length === 0) {
            const rootNode: Omit<MindMapNode, 'id'> = {
                text: '根节点',
                level: 0,
            };
            const result = await MindMapModel.addNode(
                domainId,
                mindMap!.docId,
                rootNode,
                undefined, // 没有父节点
                requestedBranch
            );
            
            // 重新获取 base 以获取新创建的节点
            mindMap = await MindMapModel.get(domainId, mindMap!.docId);
            if (mindMap) {
                const branchData = getBranchData(mindMap, requestedBranch);
                nodes = branchData.nodes || [];
                edges = branchData.edges || [];
            }
        }
        
        // 获取该域下的所有 cards（不依赖 base 是否存在）
        // 先获取所有 cards，然后按 nodeId 分组
        const allCards = await document.getMulti(domainId, document.TYPE_CARD, {})
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        
        // 按节点ID分组 cards
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) {
                    nodeCardsMap[card.nodeId] = [];
                }
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        
        const cardId = this.request.query.cardId as string | undefined;
        if (cardId && nodes.length > 0 && edges.length > 0) {
            let targetNodeId: string | null = null;
            for (const [nodeId, cards] of Object.entries(nodeCardsMap)) {
                if (cards.some(card => String(card.docId) === String(cardId))) {
                    targetNodeId = nodeId;
                    break;
                }
            }
            
            if (targetNodeId) {
                const parentMap = new Map<string, string>();
                edges.forEach(edge => {
                    parentMap.set(edge.target, edge.source);
                });
                
                const nodesToExpand = new Set<string>();
                let currentNodeId: string | null = targetNodeId;
                while (currentNodeId) {
                    nodesToExpand.add(currentNodeId);
                    currentNodeId = parentMap.get(currentNodeId) || null;
                }
                
                nodes = nodes.map(node => {
                    if (nodesToExpand.has(node.id)) {
                        return {
                            ...node,
                            expandedOutline: true,
                        };
                    }
                    return node;
                });
            }
        }
        
        // 获取分支列表（如果 base 存在）
        const branches = mindMap && Array.isArray((mindMap as any)?.branches) 
            ? (mindMap as any).branches 
            : ['main'];
        if (!branches.includes('main')) {
            branches.unshift('main');
        }
        
        // Get git status（如果 base 存在）
        let gitStatus: any = null;
        if (mindMap) {
            const githubRepo = (mindMap.githubRepo || '') as string;
            
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
                    
                    gitStatus = await getMindMapGitStatus(domainId, mindMap.docId, requestedBranch, REPO_URL);
                } catch (err) {
                    console.error('Failed to get git status:', err);
                    gitStatus = null;
                }
            } else {
                try {
                    gitStatus = await getMindMapGitStatus(domainId, mindMap.docId, requestedBranch);
                } catch (err) {
                    console.error('Failed to get local git status:', err);
                    gitStatus = null;
                }
            }
        }
        
        // 即使 base 不存在，也返回一个基本结构，包含 nodes 和 edges
        this.response.body = {
            mindMap: mindMap ? {
                ...mindMap,
                nodes,
                edges,
            } : {
                domainId: domainId,
                nodes: [],
                edges: [],
                currentBranch: requestedBranch,
            },
            gitStatus,
            currentBranch: requestedBranch,
            branches,
            nodeCardsMap,
            files: mindMap?.files || [],
            domainId: domainId,
        };
    }
}

/**
 * Base Editor Handler (类似GitHub Web Editor)
 */
class MindMapEditorHandler extends Handler {
    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // If no branch parameter, redirect to branch URL
        if (!branch || !String(branch).trim()) {
            const target = this.url('base_editor_branch', { 
                domainId, 
                branch: 'main' 
            });
            this.response.redirect = target;
            return;
        }
        
        this.response.template = 'base_editor.html';
        
        const requestedBranch = branch || 'main';
        
        // 直接获取该域下的 base（如果存在），用于获取 nodes 和 edges
        let mindMap = await MindMapModel.getByDomain(domainId);
        
        // 如果没有 base，创建一个
        if (!mindMap) {
            const { docId } = await MindMapModel.create(
                domainId,
                this.user._id,
                '思维导图',
                '',
                undefined,
                requestedBranch,
                this.request.ip
            );
            mindMap = await MindMapModel.get(domainId, docId);
            if (!mindMap) {
                throw new Error('Failed to create base');
            }
        }
        
        // 获取 nodes 和 edges（从 base 或返回空数组）
        let nodes: MindMapNode[] = [];
        let edges: MindMapEdge[] = [];
        
        if (mindMap) {
            const branchData = getBranchData(mindMap, requestedBranch);
            nodes = branchData.nodes || [];
            edges = branchData.edges || [];
            
            // Update currentBranch if different
            const currentMindMapBranch = (mindMap as any)?.currentBranch || 'main';
            if (requestedBranch !== currentMindMapBranch) {
                await document.set(domainId, document.TYPE_BASE, mindMap.docId, { 
                    currentBranch: requestedBranch 
                });
            }
        }
        
        // 如果没有节点，自动创建一个根节点
        if (nodes.length === 0) {
            const rootNode: Omit<MindMapNode, 'id'> = {
                text: '根节点',
                level: 0,
            };
            const result = await MindMapModel.addNode(
                domainId,
                mindMap!.docId,
                rootNode,
                undefined, // 没有父节点
                requestedBranch
            );
            
            // 重新获取 base 以获取新创建的节点
            mindMap = await MindMapModel.get(domainId, mindMap!.docId);
            if (mindMap) {
                const branchData = getBranchData(mindMap, requestedBranch);
                nodes = branchData.nodes || [];
                edges = branchData.edges || [];
            }
        }
        
        // 获取该域下的所有 cards（不依赖 base 是否存在）
        // 先获取所有 cards，然后按 nodeId 分组
        const allCards = await document.getMulti(domainId, TYPE_CARD, {})
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        
        // 按节点ID分组 cards
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) {
                    nodeCardsMap[card.nodeId] = [];
                }
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        
        // 获取分支列表（如果 base 存在）
        const branches = mindMap && Array.isArray((mindMap as any)?.branches) 
            ? (mindMap as any).branches 
            : ['main'];
        if (!branches.includes('main')) {
            branches.unshift('main');
        }
        
        // 即使 base 不存在，也返回一个基本结构，包含 nodes 和 edges
        this.response.body = {
            mindMap: mindMap ? {
                ...mindMap,
                nodes,
                edges,
            } : {
                domainId: domainId,
                nodes: [],
                edges: [],
                currentBranch: requestedBranch,
            },
            currentBranch: requestedBranch,
            branches,
            nodeCardsMap,
            files: mindMap?.files || [],
            domainId: domainId,
        };
    }
}

/**
 * Base Create Handler
 */
class MindMapCreateHandler extends Handler {
    async get() {
        this.response.template = 'base_create.html';
        this.response.body = {};
    }

    @param('title', Types.String)
    @param('content', Types.String, true)
    @param('rpid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    @param('parentId', Types.ObjectId, true)
    async post(
        domainId: string,
        title: string,
        content: string = '',
        rpid?: number,
        branch?: string,
        parentId?: ObjectId
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 确保使用正确的 domainId（优先使用 this.args.domainId，因为它来自 ctx.domainId，是最准确的）
        const actualDomainId = this.args.domainId || domainId || 'system';
        console.log(`[Base Create] domainId param: ${domainId}, this.args.domainId: ${this.args.domainId}, actualDomainId: ${actualDomainId}`);
        
        const { docId } = await MindMapModel.create(
            actualDomainId,
            this.user._id,
            title,
            content,
            rpid,
            branch,
            this.request.ip,
            parentId
        );

        console.log(`[Base Create] Created/Updated base with docId: ${docId.toString()}, domainId: ${actualDomainId}`);

        // 验证 base 是否已成功创建
        let createdMindMap = await MindMapModel.get(actualDomainId, docId);
        if (!createdMindMap) {
            // 再等待一下，可能是数据库同步延迟
            await new Promise(resolve => setTimeout(resolve, 200));
            createdMindMap = await MindMapModel.get(actualDomainId, docId) || await MindMapModel.getByDomain(actualDomainId);
        }
        
        if (!createdMindMap) {
            console.error(`[Base Create] Failed to find base after creation: docId=${docId.toString()}, domainId=${actualDomainId}`);
            throw new Error(`Failed to create base: record not found after creation (docId: ${docId.toString()}, domainId: ${actualDomainId})`);
        }
        
        console.log(`[Base Create] Successfully verified base: docId=${createdMindMap.docId.toString()}`);

        // 自动创建 GitHub 仓库（异步处理，不阻塞重定向）
        try {
            await ensureMindMapGitRepo(actualDomainId, docId);
            
            try {
                await createAndPushToGitHubOrgForMindMap(this, actualDomainId, docId, title, this.user);
            } catch (err) {
                console.error('Failed to create remote GitHub repo:', err);
                // 即使 GitHub 仓库创建失败，也不影响 base 的使用
            }
        } catch (err) {
            console.error('Failed to create git repo:', err);
            // 即使 git repo 创建失败，也不影响 base 的使用
        }

        this.response.body = { docId };
        this.response.redirect = this.url('base_detail', { domainId: actualDomainId, docId: docId.toString() });
    }
}

// 请求去重缓存：用于防止重复创建节点
// key: `${domainId}:${docId}:${text}:${parentId}`, value: timestamp
const nodeCreationDedupCache = new Map<string, number>();
const DEDUP_WINDOW_MS = 2000; // 2秒内的相同请求视为重复

/**
 * Base Edit Handler
 */
class MindMapEditHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId)
    async _prepare(domainId: string, docId: ObjectId) {
        this.mindMap = await MindMapModel.get(domainId, docId);
        if (!this.mindMap) throw new NotFoundError('Base not found');
        
        if (!this.user.own(this.mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    async get() {
        this.response.template = 'base_edit.html';
        this.response.body = { mindMap: this.mindMap };
    }

    @param('docId', Types.ObjectId)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('parentId', Types.ObjectId, true)
    @post('domainPosition', Types.Any, true)
    async postUpdate(
        domainId: string,
        docId: ObjectId,
        title?: string,
        content?: string,
        parentId?: ObjectId,
        domainPosition?: { x: number; y: number }
    ) {
        const updates: any = {};
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;
        if (parentId !== undefined) updates.parentId = parentId;
        if (domainPosition !== undefined) updates.domainPosition = domainPosition;

        await MindMapModel.update(domainId, docId, updates);
        this.response.body = { docId };
        // 如果是通过 operation 参数调用的，不重定向
        const operation = this.request.body?.operation;
        if (operation !== 'update') {
            this.response.redirect = this.url('base_detail', { docId: docId.toString() });
        }
    }

    @param('docId', Types.ObjectId)
    async postDelete(domainId: string, docId: ObjectId) {
        // 检查权限
        if (!this.user.own(this.mindMap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }
        
        await MindMapModel.delete(domainId, docId);
        this.response.body = { success: true };
        this.response.redirect = this.url('base_list');
    }
}

/**
 * Base Node Handler
 * 节点操作API
 */
class MindMapNodeHandler extends Handler {
    @post('text', Types.String, true)
    @post('x', Types.Float, true)
    @post('y', Types.Float, true)
    @post('parentId', Types.String, true)
    @post('siblingId', Types.String, true)
    @post('operation', Types.String, true)
    @param('nodeId', Types.String, true)
    @post('branch', Types.String, true)
    // 通过 domainId 获取 base，不再需要 docId
    async post(
        domainId: string,
        text?: string,
        x?: number,
        y?: number,
        parentId?: string,
        siblingId?: string,
        operation?: string,
        nodeId?: string,
        branch?: string,
    ) {
        // 通过 domainId 获取 base
        const mindMap = await MindMapModel.getByDomain(domainId);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
        }
        
        if (operation === 'delete' && nodeId) {
            return this.postDelete(domainId, nodeId, branch);
        }
        
        const body: any = this.request?.body || {};
        const finalText = text !== undefined ? text : body.text;
        
        if (nodeId && operation === 'update') {
            return this.postUpdate(domainId, nodeId, finalText, undefined, undefined, undefined, x, y, undefined);
        }
        
        if (finalText !== undefined || operation === 'add') {
            const finalTextValue = finalText !== undefined ? finalText : '';
            return this.postAdd(domainId, finalTextValue, x, y, parentId, siblingId, branch);
        }
        
        throw new BadRequestError('Missing required parameters');
    }

    @post('text', Types.String)
    @post('x', Types.Float, true)
    @post('y', Types.Float, true)
    @post('parentId', Types.String, true)
    @post('siblingId', Types.String, true)
    @post('branch', Types.String, true)
    async postAdd(
        domainId: string,
        text: string,
        x?: number,
        y?: number,
        parentId?: string,
        siblingId?: string,
        branch?: string
    ) {
        const startTime = Date.now();
        
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 通过 domainId 获取 base
        const actualDomainId = this.args.domainId || domainId || 'system';
        const mindMap = await MindMapModel.getByDomain(actualDomainId);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
        }
        const docId = mindMap.docId;
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        let newNodeId: string | undefined;
        let edgeId: string | undefined;
        let edgeSourceId: string | undefined;
        let edgeTargetId: string | undefined;
        let dedupKey: string | undefined;
        
        try {
            const body: any = this.request?.body || {};
            const finalParentId = parentId !== undefined ? parentId : body.parentId;
            const finalSiblingId = siblingId !== undefined ? siblingId : body.siblingId;
            
            dedupKey = `${actualDomainId}:${docId.toString()}:${text}:${finalParentId || ''}`;
            const lastRequestTimeRaw = nodeCreationDedupCache.get(dedupKey);
            const lastRequestTime = lastRequestTimeRaw ? Math.abs(lastRequestTimeRaw) : undefined;
            const timeSinceLastRequest = lastRequestTime ? startTime - lastRequestTime : Infinity;
            
            if (lastRequestTime && timeSinceLastRequest < DEDUP_WINDOW_MS) {
                throw new BadRequestError('Duplicate request detected. Please wait a moment and try again.');
            }
            
            nodeCreationDedupCache.set(dedupKey, -startTime);
            
            for (const [key, timestamp] of nodeCreationDedupCache.entries()) {
                const absTimestamp = Math.abs(timestamp);
                if (startTime - absTimestamp > DEDUP_WINDOW_MS * 2) {
                    nodeCreationDedupCache.delete(key);
                }
            }

            // 从请求参数或 body 中获取分支（如果未提供）
            const effectiveBranch = branch || body.branch || (mindMap as any).currentBranch || (mindMap as any).branch || 'main';
            
            // 获取分支数据用于查找节点
            const branchData: {
                [branch: string]: { nodes: MindMapNode[]; edges: MindMapEdge[] };
            } = (mindMap as any).branchData || {};
            
            let nodes: MindMapNode[];
            if (branchData[effectiveBranch] && branchData[effectiveBranch].nodes) {
                nodes = branchData[effectiveBranch].nodes;
            } else if (effectiveBranch === 'main') {
                nodes = mindMap.nodes || [];
            } else {
                nodes = [];
            }
            
            // 数据库级别的去重检查：检查是否在去重窗口内已存在相同内容的节点
            // 这样可以防止多进程/集群模式下的重复创建
            if (finalParentId) {
                const recentDuplicateNode = nodes.find(n => 
                    n.text === text.trim() && 
                    n.parentId === finalParentId &&
                    n.id && 
                    n.id.startsWith('node_')
                );
                
                if (recentDuplicateNode) {
                    // 检查节点ID中的时间戳，判断是否在去重窗口内
                    const nodeIdMatch = recentDuplicateNode.id.match(/^node_(\d+)_/);
                    if (nodeIdMatch) {
                        const nodeCreatedTime = parseInt(nodeIdMatch[1], 10);
                        const timeSinceNodeCreation = startTime - nodeCreatedTime;
                        
                        if (timeSinceNodeCreation < DEDUP_WINDOW_MS && timeSinceNodeCreation >= 0) {
                            // 返回已存在的节点ID，而不是创建新节点
                            // 需要先获取 edges 用于查找对应的边
                            let edgesForDedup: MindMapEdge[];
                            if (branchData[effectiveBranch] && branchData[effectiveBranch].edges) {
                                edgesForDedup = branchData[effectiveBranch].edges;
                            } else if (effectiveBranch === 'main') {
                                edgesForDedup = mindMap.edges || [];
                            } else {
                                edgesForDedup = [];
                            }
                            
                            this.response.body = { 
                                nodeId: recentDuplicateNode.id,
                                edgeId: edgesForDedup.find(e => e.target === recentDuplicateNode.id && e.source === finalParentId)?.id,
                                edgeSource: finalParentId,
                                edgeTarget: recentDuplicateNode.id,
                            };
                            return;
                        }
                    }
                }
            }

            let effectiveParentId: string | undefined = finalParentId;

            if (finalSiblingId && !finalParentId) {
                const siblingNode = nodes.find(n => n.id === finalSiblingId);
                if (!siblingNode) {
                    throw new NotFoundError(`Sibling node not found: ${finalSiblingId}. Branch: ${effectiveBranch}`);
                }
                effectiveParentId = siblingNode.parentId;
            }

            const node: Omit<MindMapNode, 'id'> = {
                text,
                x,
                y,
                parentId: effectiveParentId,
            };

            // 确定边的源和目标
            if (finalSiblingId && !finalParentId) {
                if (!effectiveParentId) {
                    // 没有父节点，不需要创建边，只创建节点
                    const result = await MindMapModel.addNode(
                        actualDomainId,
                        docId,
                        node,
                        effectiveParentId,
                        effectiveBranch
                    );
                    this.response.body = { nodeId: result.nodeId };
                    return;
                }
                edgeSourceId = effectiveParentId;
            } else if (finalParentId) {
                edgeSourceId = finalParentId;
            } else {
                // 没有父节点，不需要创建边，只创建节点
                const result = await MindMapModel.addNode(
                    actualDomainId,
                    docId,
                    node,
                    effectiveParentId,
                    effectiveBranch
                );
                this.response.body = { nodeId: result.nodeId };
                return;
            }

            const result = await MindMapModel.addNode(
                actualDomainId,
                docId,
                node,
                effectiveParentId,
                effectiveBranch,
                edgeSourceId  // 传入 edgeSourceId，让 addNode 同时创建边
            );
            
            newNodeId = result.nodeId;
            edgeId = result.edgeId;
            edgeTargetId = newNodeId;

            nodeCreationDedupCache.delete(dedupKey);
            
            this.response.body = { 
                nodeId: newNodeId,
                edgeId: edgeId,
                edgeSource: edgeSourceId,
                edgeTarget: edgeTargetId,
            };
        } catch (error: any) {
            if (newNodeId) {
                this.response.body = { 
                    nodeId: newNodeId,
                    edgeId: edgeId,
                    edgeSource: edgeSourceId,
                    edgeTarget: edgeTargetId,
                };
                this.response.status = 200;
                return;
            } else {
                if (dedupKey) {
                    nodeCreationDedupCache.delete(dedupKey);
                }
                throw error;
            }
        }
    }

    @param('nodeId', Types.String)
    @post('text', Types.String, true)
    @post('color', Types.String, true)
    @post('backgroundColor', Types.String, true)
    @post('fontSize', Types.Int, true)
    @post('x', Types.Float, true)
    @post('y', Types.Float, true)
    @post('expanded', Types.Boolean, true)
    async postUpdate(
        domainId: string,
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
        
        // 通过 domainId 获取 base
        const mindMap = await MindMapModel.getByDomain(domainId);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
        }
        const docId = mindMap.docId;
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const updates: Partial<MindMapNode> = {};
        if (text !== undefined) {
            updates.text = text;
        }
        if (color !== undefined) updates.color = color;
        if (backgroundColor !== undefined) updates.backgroundColor = backgroundColor;
        if (fontSize !== undefined) updates.fontSize = fontSize;
        if (x !== undefined) updates.x = x;
        if (y !== undefined) updates.y = y;
        if (expanded !== undefined) updates.expanded = expanded;
        
        // 从请求体中读取 order（如果有）
        const body: any = this.request?.body || {};
        if (body.order !== undefined) {
            updates.order = body.order;
        }

        if (Object.keys(updates).length === 0) {
            this.response.body = { success: true };
            return;
        }

        await MindMapModel.updateNode(domainId, docId, nodeId, updates);
        this.response.body = { success: true };
    }

    @param('nodeId', Types.String)
    @post('branch', Types.String, true)
    async postDelete(domainId: string, nodeId: string, branch?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 通过 domainId 获取 base
        const mindMap = await MindMapModel.getByDomain(domainId);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
        }
        const docId = mindMap.docId;
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }

        // 从请求参数或 body 中获取分支（如果未提供）
        const effectiveBranch = branch || (this.request.body as any)?.branch || (mindMap as any).currentBranch || (mindMap as any).branch || 'main';
        
        await MindMapModel.deleteNode(domainId, docId, nodeId, effectiveBranch);
        this.response.body = { success: true };
    }
}

/**
 * Base Edge Handler
 */
class MindMapEdgeHandler extends Handler {
    @param('source', Types.String)
    @param('target', Types.String)
    @param('label', Types.String, true)
    async postAdd(
        domainId: string,
        source: string,
        target: string,
        label?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 通过 domainId 获取 base
        const mindMap = await MindMapModel.getByDomain(domainId);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
        }
        const docId = mindMap.docId;
        
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

    @param('edgeId', Types.String)
    async postDelete(domainId: string, edgeId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 通过 domainId 获取 base
        const mindMap = await MindMapModel.getByDomain(domainId);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
        }
        const docId = mindMap.docId;
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }

        await MindMapModel.deleteEdge(domainId, docId, edgeId);
        this.response.body = { success: true };
    }
}

/**
 * Base Save Handler
 */
class MindMapSaveHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 直接获取或创建包含 nodes 和 edges 的文档（不依赖 base 实体）
        let mindMap = await MindMapModel.getByDomain(domainId);
        let docId: ObjectId;
        
        if (!mindMap) {
            // 如果不存在，直接创建一个包含 nodes 和 edges 的文档
            const data = this.request.body || {};
            const { nodes = [], edges = [] } = data;
            
            // 如果没有节点，创建一个默认根节点
            const finalNodes = nodes.length > 0 ? nodes : [{
                id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                text: '根节点',
                level: 0,
            }];
            
            const payload: Partial<MindMapDoc> = {
                docType: TYPE_MM,
                domainId,
                title: '思维导图',
                content: '',
                owner: this.user._id,
                nodes: finalNodes,
                edges: edges || [],
                layout: {
                    type: 'hierarchical',
                    direction: 'LR',
                    spacing: { x: 200, y: 100 },
                },
                viewport: {
                    x: 0,
                    y: 0,
                    zoom: 1,
                },
                createdAt: new Date(),
                updateAt: new Date(),
                views: 0,
                ip: this.request.ip,
                branch: 'main',
            };
            
            // 使用解构来排除不需要的字段，替代 omit
            const { domainId: _, content: __, owner: ___, ...restPayload } = payload;
            
            docId = await document.add(
                domainId,
                payload.content!,
                payload.owner!,
                TYPE_MM,
                null,
                null,
                null,
                restPayload
            );
            
            mindMap = await MindMapModel.get(domainId, docId);
            if (!mindMap) {
                throw new NotFoundError('Failed to create document');
            }
        } else {
            docId = mindMap.docId;
            if (!this.user.own(mindMap)) {
                this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
            }
        }

        const data = this.request.body || {};
        let { nodes, edges, layout, viewport, theme, operationDescription } = data;
        
        const isExpandOnlySave = operationDescription === '自动保存展开状态' || operationDescription === '自动保存 outline 展开状态';
        
        if (isExpandOnlySave && nodes && Array.isArray(nodes)) {
            const currentBranch = (mindMap as any).currentBranch || 'main';
            const currentBranchData = getBranchData(mindMap, currentBranch);
            
            const updatedNodes = currentBranchData.nodes.map((existingNode: MindMapNode) => {
                const updatedNode = nodes.find((n: MindMapNode) => n.id === existingNode.id);
                if (updatedNode) {
                    const result: MindMapNode = { ...existingNode };
                    if (updatedNode.expanded !== undefined) {
                        result.expanded = updatedNode.expanded;
                    }
                    if ((updatedNode as any).expandedOutline !== undefined) {
                        (result as any).expandedOutline = (updatedNode as any).expandedOutline;
                    }
                    return result;
                }
                return existingNode;
            });
            
            setBranchData(mindMap, currentBranch, updatedNodes, currentBranchData.edges);
            
            await MindMapModel.updateFull(domainId, docId, {
                branchData: mindMap.branchData,
                nodes: mindMap.nodes, // 向后兼容
                edges: mindMap.edges, // 向后兼容
            });
            
            (this.ctx.emit as any)('base/update', docId);
            
            this.response.body = { success: true, hasNonPositionChanges: false };
            return;
        }
        
        // 过滤掉临时节点和边，确保不会保存临时数据
        // 临时节点ID格式：temp-node-xxx，临时边ID格式：temp-edge-xxx
        if (nodes && Array.isArray(nodes)) {
            nodes = nodes.filter((node: MindMapNode) => {
                if (!node.id) return false;
                // 拒绝保存临时节点
                if (node.id.startsWith('temp-node-')) {
                    console.warn(`Rejected temporary node from save: ${node.id}`);
                    return false;
                }
                return true;
            });
        }
        
        if (edges && Array.isArray(edges)) {
            edges = edges.filter((edge: MindMapEdge) => {
                if (!edge.id && !edge.source && !edge.target) return false;
                // 拒绝保存临时边或包含临时节点的边
                if (edge.id && edge.id.startsWith('temp-edge-')) {
                    console.warn(`Rejected temporary edge from save: ${edge.id}`);
                    return false;
                }
                if (edge.source && edge.source.startsWith('temp-node-')) {
                    console.warn(`Rejected edge with temporary source node: ${edge.source}`);
                    return false;
                }
                if (edge.target && edge.target.startsWith('temp-node-')) {
                    console.warn(`Rejected edge with temporary target node: ${edge.target}`);
                    return false;
                }
                return true;
            });
        }
        
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


        // 更新当前分支的数据（使用过滤后的nodes和edges）
        setBranchData(mindMap, currentBranch, nodes || [], edges || []);

        await MindMapModel.updateFull(domainId, docId, {
            branchData: mindMap.branchData,
            nodes: mindMap.nodes, // 向后兼容
            edges: mindMap.edges, // 向后兼容
            layout,
            viewport,
            theme,
        });
        
        // 如果有非位置改变，立即同步到git（这样git status可以立即检测到）
        if (hasNonPositionChanges) {
            try {
                const updatedMindMap = await MindMapModel.get(domainId, docId);
                if (updatedMindMap) {
                    const branch = updatedMindMap.currentBranch || 'main';
                    await syncMindMapToGit(domainId, updatedMindMap.docId, branch);
                }
            } catch (err) {
                console.error('Failed to sync to git after save:', err);
                // 不抛出错误，保存仍然成功
            }
        }
        
        // 触发更新事件，通知所有连接的 WebSocket 客户端
        (this.ctx.emit as any)('base/update', docId);
        (this.ctx.emit as any)('base/git/status/update', docId);
        
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

                // 比较非位置属性（包括 order）
                if (
                    oldNode.text !== newNode.text ||
                    oldNode.color !== newNode.color ||
                    oldNode.backgroundColor !== newNode.backgroundColor ||
                    oldNode.fontSize !== newNode.fontSize ||
                    oldNode.expanded !== newNode.expanded ||
                    oldNode.shape !== newNode.shape ||
                    oldNode.order !== newNode.order
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
 * Base List Handler
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

        this.response.template = 'base_list.html';
        this.response.body = { mindMaps, rpid, branch };
    }
}

/**
 * Base Domain Handler
 * 显示当前 base 的第一层节点
 */
class MindMapDomainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('pjax', Types.Boolean)
    @param('all', Types.Boolean, true)
    async get(domainId: string, page = 1, q = '', pjax = false, all = false) {
        // 获取当前 domain 的 base（一个 domain 一个 base）
        const mindMap = await MindMapModel.getByDomain(domainId);
        
        if (!mindMap) {
            throw new NotFoundError('Base not found for this domain');
        }
        
        const branch = (mindMap as any)?.currentBranch || 'main';
        const branchData = getBranchData(mindMap, branch);
        
        // 找到根节点（没有父边的节点，或者 level=0 的节点）
        const rootNodes = branchData.nodes.filter(node => 
            node.level === 0 || !branchData.edges.some(edge => edge.target === node.id)
        );
        const rootNode = rootNodes[0] || branchData.nodes[0];
        
        if (!rootNode) {
            // 如果没有节点，返回空数据
            this.response.template = 'base_domain.html';
            this.response.body = {
                mindMap: {
                    ...mindMap,
                    docId: mindMap.docId.toString(),
                },
                nodes: [],
                edges: [],
                domainId,
                page: 1,
                totalPages: 1,
                total: 0,
                qs: q ? q.trim() : '',
                totalNodes: 0,
                totalViews: mindMap.views || 0,
            };
            return;
        }
        
        // 找到第一层节点（根节点的直接子节点）
        const firstLevelNodeIds = new Set(
            branchData.edges
                .filter(edge => edge.source === rootNode.id)
                .map(edge => edge.target)
        );
        
        const firstLevelNodes = branchData.nodes.filter(node => firstLevelNodeIds.has(node.id));
        
        // 找到第一层节点之间的边
        const firstLevelEdges = branchData.edges.filter(edge => 
            firstLevelNodeIds.has(edge.source) && firstLevelNodeIds.has(edge.target)
        );
        
        // 搜索过滤
        let filteredNodes = firstLevelNodes;
        if (q && q.trim()) {
            const searchTerm = q.toLowerCase().trim();
            filteredNodes = firstLevelNodes.filter(node => 
                node.text.toLowerCase().includes(searchTerm) ||
                node.id.toLowerCase().includes(searchTerm)
            );
        }
        
        // 分页
        const limit = 20;
        const skip = (page - 1) * limit;
        const total = filteredNodes.length;
        const totalPages = Math.ceil(total / limit);
        const nodesRaw = all ? filteredNodes : filteredNodes.slice(skip, skip + limit);
        
        // 清理数据，转换为前端需要的格式
        const nodes = nodesRaw.map((node: any) => ({
            ...node,
            nodeId: node.id,
            title: node.text,
            domainPosition: node.position || { x: 0, y: 0 },
        }));
        
        const totalViews = mindMap.views || 0;
        
        if (pjax) {
            const html = await this.renderHTML('partials/base_list.html', {
                page, totalPages, total, nodes, qs: q ? q.trim() : '', domainId,
            });
            this.response.body = {
                title: this.renderTitle(this.translate('Base Domain')),
                fragments: [{ html: html || '' }],
            };
        } else {
            this.response.template = 'base_domain.html';
            this.response.body = { 
                mindMap: {
                    ...mindMap,
                    docId: mindMap.docId.toString(),
                },
                nodes,
                edges: firstLevelEdges,
                domainId,
                page,
                totalPages,
                total,
                qs: q ? q.trim() : '',
                totalNodes: firstLevelNodes.length,
                totalViews,
            };
        }
    }
}

class MindMapDataHandler extends Handler {
    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        // 直接获取该域下的 base（如果存在）
        let mindMap = await MindMapModel.getByDomain(domainId);
        
        // 如果没有 base，创建一个
        if (!mindMap) {
            const { docId } = await MindMapModel.create(
                domainId,
                this.user._id,
                '思维导图',
                '',
                undefined,
                branch || 'main',
                this.request.ip
            );
            mindMap = await MindMapModel.get(domainId, docId);
            if (!mindMap) {
                throw new Error('Failed to create base');
            }
        }
        
        const currentBranch = branch || (mindMap as any)?.currentBranch || 'main';
        
        // 获取 nodes 和 edges（从 base 或返回空数组）
        let nodes: MindMapNode[] = [];
        let edges: MindMapEdge[] = [];
        
        if (mindMap) {
            const branchData = getBranchData(mindMap, currentBranch);
            nodes = branchData.nodes || [];
            edges = branchData.edges || [];
        }
        
        // 如果没有节点，自动创建一个根节点
        if (nodes.length === 0) {
            const rootNode: Omit<MindMapNode, 'id'> = {
                text: '根节点',
                level: 0,
            };
            const result = await MindMapModel.addNode(
                domainId,
                mindMap!.docId,
                rootNode,
                undefined, // 没有父节点
                currentBranch
            );
            
            // 重新获取 base 以获取新创建的节点
            mindMap = await MindMapModel.get(domainId, mindMap!.docId);
            if (mindMap) {
                const branchData = getBranchData(mindMap, currentBranch);
                nodes = branchData.nodes || [];
                edges = branchData.edges || [];
            }
        }
        
        // 获取该域下的所有 cards（不依赖 base 是否存在）
        const allCards = await document.getMulti(domainId, TYPE_CARD, {})
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        
        // 按节点ID分组 cards
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) {
                    nodeCardsMap[card.nodeId] = [];
                }
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        
        // 返回当前分支的数据（即使 base 不存在也返回基本结构）
        this.response.body = mindMap ? {
            ...mindMap,
            nodes,
            edges,
            currentBranch,
            nodeCardsMap,
        } : {
            domainId: domainId,
            nodes: [],
            edges: [],
            currentBranch,
            nodeCardsMap: {},
        };
    }
}

/**
 * Get git repository path for base
 */
function getMindMapGitPath(domainId: string, docId: ObjectId): string {
    return path.join('/data/git/ejunz', domainId, 'base', String(docId));
}

/**
 * Initialize or get git repository for base
 */
async function ensureMindMapGitRepo(domainId: string, docId: ObjectId, remoteUrl?: string): Promise<string> {
    const repoPath = getMindMapGitPath(domainId, docId);
    
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
 * Export base to file structure (node as folder, card as md file)
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
    
    // Create README.md for base root (only contains the content, no metadata)
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
        const cards = await CardModel.getByNodeId(mindMap.domainId, mindMap.docId, node.id);
        
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
    docId: ObjectId,
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
        .replace(/^-|-$/g, '') || `base-${bid}`;

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

        let repoUrlForStorage = remoteUrl;
        if (remoteUrl.startsWith('https://') && remoteUrl.includes('@github.com')) {
            repoUrlForStorage = remoteUrl.replace(/^https:\/\/[^@]+@github\.com\//, 'https://github.com/');
        }

        let mindMap = await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) {
            await new Promise(resolve => setTimeout(resolve, 100));
            mindMap = await MindMapModel.getBybid(domainId, bid);
        }
        
        if (mindMap) {
            await document.set(domainId, document.TYPE_BASE, mindMap.docId, {
                githubRepo: repoUrlForStorage,
            });
        } else {
            console.warn(`Base with bid ${bid} not found, skipping GitHub repo setup`);
            return;
        }

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-base-create-'));
        try {
            const mindMapForExport = await MindMapModel.getBybid(domainId, bid);
            if (mindMapForExport) {
                await exportMindMapToFile(mindMapForExport, tmpDir, 'main');
                const commitMessage = `${domainId}/${user._id}/${user.uname || 'unknown'}: Initial commit`;
                await gitInitAndPushMindMap(domainId, bid, mindMapForExport, REPO_URL, 'main', commitMessage);
            } else {
                console.warn(`Base with bid ${bid} not found for export, skipping`);
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
 * Git init and push for base
 */
async function gitInitAndPushMindMap(
    domainId: string,
    docId: ObjectId,
    mindMap: MindMapDoc,
    remoteUrlWithAuth: string, 
    branch: string = 'main', 
    commitMessage: string = 'chore: sync base from ejunz'
) {
    const repoGitPath = await ensureMindMapGitRepo(domainId, docId, remoteUrlWithAuth);
    
    // 设置环境变量禁用终端提示，避免非交互式环境下的密码输入问题
    const gitEnv: Record<string, string> = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
    };
    
    const execOptions: any = { cwd: repoGitPath, env: gitEnv };
    
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await exec(`git config user.name "${botName}"`, execOptions);
    await exec(`git config user.email "${botEmail}"`, execOptions);
    
    await exec(`git config credential.helper store`, execOptions);
    await exec(`git config credential.https://github.com.helper store`, execOptions);
    
    try {
        const { stdout: currentRemote } = await exec('git remote get-url origin', execOptions);
        const currentUrl = (typeof currentRemote === 'string' ? currentRemote : currentRemote.toString()).trim();
        
        const currentTokenMatch = currentUrl.match(/^https?:\/\/([^@]+)@github\.com\//);
        const targetTokenMatch = remoteUrlWithAuth.match(/^https?:\/\/([^@]+)@github\.com\//);
        const currentToken = currentTokenMatch ? currentTokenMatch[1] : '';
        const targetToken = targetTokenMatch ? targetTokenMatch[1] : '';
        
        if (currentToken !== targetToken || currentUrl !== remoteUrlWithAuth) {
            await exec(`git remote set-url origin "${remoteUrlWithAuth}"`, execOptions);
            try {
                await exec(`echo -e "protocol=https\\nhost=github.com\\n" | git credential reject`, execOptions);
            } catch {
            }
        } else {
            await exec(`git remote set-url origin "${remoteUrlWithAuth}"`, execOptions);
        }
    } catch {
        await exec(`git remote add origin "${remoteUrlWithAuth}"`, execOptions);
    }
    
    let isNewRepo = false;
    
    try {
        try {
            await exec('git rev-parse HEAD', execOptions);
            isNewRepo = false;
        } catch {
            isNewRepo = true;
        }
        
        if (isNewRepo) {
            try {
                const tmpCloneDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-base-clone-'));
                try {
                    await exec(`git clone ${remoteUrlWithAuth} .`, { cwd: tmpCloneDir, env: gitEnv } as any);
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
                await exec('git fetch origin', execOptions);
            } catch {}
        }
        
        try {
            await exec(`git checkout ${branch}`, execOptions);
        } catch {
            try {
                await exec(`git checkout -b ${branch} origin/${branch}`, execOptions);
            } catch {
                try {
                    const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', execOptions);
                    const baseBranch = String(currentBranch).trim() || 'main';
                    await exec(`git checkout -b ${branch} ${baseBranch}`, execOptions);
                } catch {
                    await exec(`git checkout -b ${branch}`, execOptions);
                }
            }
        }
        
        if (!isNewRepo) {
            try {
                await exec(`git pull origin ${branch}`, execOptions);
            } catch {
            }
        }
        
        // Export base to files (use the branch parameter from function signature)
        await exportMindMapToFile(mindMap, repoGitPath, branch);
        
        await exec('git add -A', execOptions);
        
        try {
            const { stdout } = await exec('git status --porcelain', execOptions);
            const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString();
            if (stdoutStr.trim()) {
                const escapedMessage = commitMessage.replace(/'/g, "'\\''");
                await exec(`git commit -m '${escapedMessage}'`, execOptions);
            }
        } catch (err) {
            const escapedMessage = commitMessage.replace(/'/g, "'\\''");
            try {
                await exec(`git commit -m '${escapedMessage}'`, execOptions);
            } catch {
            }
        }
        
        if (isNewRepo) {
            await exec(`git push -u origin ${branch}`, execOptions);
        } else {
            try {
                await exec(`git push origin ${branch}`, execOptions);
            } catch {
                await exec(`git push -u origin ${branch}`, execOptions);
            }
        }
    } catch (err) {
        throw err;
    }
}

/**
 * Base GitHub Push Handler
 */
class MindMapGithubPushHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: ObjectId, bid: number, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
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
            throw new Error('GitHub repository not configured. Please configure it in base settings.');
        }
        
        let REPO_URL = githubRepo;
        if (githubRepo.startsWith('git@')) {
            REPO_URL = githubRepo;
        } else {
            const isGitHubHttps = /^https?:\/\/.*github\.com\//.test(githubRepo);
            
            if (isGitHubHttps) {
                let repoPathMatch = githubRepo.match(/^https?:\/\/[^@]+@github\.com\/(.+)$/);
                if (!repoPathMatch) {
                    repoPathMatch = githubRepo.match(/^https?:\/\/github\.com\/(.+)$/);
                }
                
                if (repoPathMatch && repoPathMatch[1]) {
                    REPO_URL = `https://${GH_TOKEN}@github.com/${repoPathMatch[1]}`;
                } else {
                    // 如果匹配失败，使用简单的替换方式
                    // 先去掉可能的旧 token，然后添加新 token
                    const urlWithoutToken = githubRepo.replace(/^https?:\/\/[^@]+@github\.com\//, 'https://github.com/');
                    REPO_URL = urlWithoutToken.replace(/^https:\/\/github\.com\//, `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || mindMap.branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        // 先 commit 本地更改
        try {
            const commitMessage = this.request.body?.commitMessage || `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}: Update base`;
            await commitMindMapChanges(domainId, mindMap.docId, mindMap, commitMessage, this.user._id, this.user.uname || 'unknown');
        } catch (err: any) {
            console.warn('Commit before push failed (may be no changes):', err?.message || err);
        }
        
        // 然后 push
        const commitMessage = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}: Update base`;
        
        try {
            await gitInitAndPushMindMap(domainId, mindMap.docId, mindMap, REPO_URL, effectiveBranch, commitMessage);
            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Push failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        }
    }

    @param('docId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, branch?: string) {
        return this.post(domainId, docId, bid, branch);
    }
}

/**
 * Base Card Handler
 */
class MindMapCardHandler extends Handler {
    @param('nodeId', Types.String, true)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('operation', Types.String, true)
    async post(
        domainId: string,
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
        
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 优先从 body 中读取字段，兼容 JSON 提交
        const body: any = this.request?.body || {};
        const finalNodeId: string | undefined = body.nodeId || nodeId;
        const finalTitle: string | undefined = body.title || title;
        const finalContent: string = body.content !== undefined ? body.content : content || '';

        // 创建新卡片需要 nodeId 和 title
        if (!finalNodeId || !finalTitle) {
            throw new ValidationError('nodeId and title are required for creating a card');
        }
        
        // 通过 domainId 获取 base
        const mindMap = await MindMapModel.getByDomain(domainId);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
        }
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const cardDocId = await CardModel.create(
            domainId,
            mindMap.docId,
            finalNodeId,
            this.user._id,
            finalTitle,
            finalContent,
            this.request.ip,
            body?.problems,
        );
        
        this.response.body = { cardId: cardDocId.toString() };
    }
    
    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    async get(domainId: string, docId: ObjectId, bid: number, nodeId: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) throw new NotFoundError('Base not found');
        
        const cards = await CardModel.getByNodeId(domainId, mindMap.docId, nodeId);
        this.response.body = { cards };
    }
    
    @route('cardId', Types.String)
    @param('nodeId', Types.String, true)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('order', Types.PositiveInt, true)
    @param('operation', Types.String, true)
    @param('cid', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
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
        bidParam?: number,
        docIdParam?: ObjectId,
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        await this.handleCardMutation('update', domainId, {
            cardIdParam,
            nodeId,
            title,
            content,
            order,
            cidParam,
            bidParam,
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
    @param('bid', Types.PositiveInt, true)
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
        bidParam?: number,
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
            bidParam,
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
            bidParam?: number;
            docIdParam?: ObjectId;
        },
    ) {
        const { cardIdParam, nodeId, title, content, order, cidParam, bidParam, docIdParam } = params;

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

        // 通过 domainId 获取 base
        const getMindMapByArgs = async (): Promise<MindMapDoc | null> => {
            if (docIdParam) {
                return await MindMapModel.get(domainId, docIdParam);
            }
            // 不再使用 bid，直接通过 domainId 获取
            return await MindMapModel.getByDomain(domainId);
        };

        let targetCard: CardDoc | null = null;
        if (resolvedDocId) {
            targetCard = await CardModel.get(domainId, resolvedDocId);
        }

        if (!targetCard && resolvedCid !== undefined) {
            if (!nodeId) {
                throw new ValidationError('nodeId is required when using cid to locate a card');
            }
            // 通过 domainId 获取 base，然后使用其 docId 查找卡片
            const mindMap = await getMindMapByArgs();
            if (mindMap) {
                targetCard = await CardModel.getByCid(domainId, nodeId, resolvedCid, mindMap.docId);
            }
        }

        if (!targetCard) throw new NotFoundError('Card not found');

        // 通过 domainId 获取 base，不再使用 bid
        const mindMap = await MindMapModel.getByDomain(domainId);
        if (!mindMap) throw new NotFoundError('Base not found');
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
        if (nodeId !== undefined) updates.nodeId = nodeId; // 支持更新 nodeId
        // 从请求体中读取 problems（如果有），用于更新卡片练习题
        const body: any = (this as any).request?.body || {};
        if (body && body.problems !== undefined) {
            updates.problems = body.problems;
        }

        await CardModel.update(domainId, targetCard.docId, updates);
        this.response.body = { success: true };
    }
}

/**
 * Base Card List Handler
 * 卡片列表页面
 */
class MindMapCardListHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('branch', Types.String, true)
    @param('cardId', Types.ObjectId, true)
    async get(domainId: string, docId: ObjectId, bid: number, nodeId: string, branch?: string, cardId?: ObjectId) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) throw new NotFoundError('Base not found');
        
        const effectiveBranch = branch || 'main';
        const branchData = getBranchData(mindMap, effectiveBranch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        // 检查节点是否存在于当前分支中
        const node = nodes.find(n => n.id === nodeId);
        if (!node) {
            throw new NotFoundError('Node not found in this branch');
        }
        
        // 获取节点的所有卡片
        const cards = await CardModel.getByNodeId(domainId, mindMap.docId, nodeId);
        
        // 构建从根节点到当前节点的完整路径
        const nodePath: Array<{ id: string; text: string }> = [];
        
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
        
        this.response.template = 'base_card_list.html';
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
 * Base Files Handler
 * 思维导图文件管理
 */
class MindMapFilesHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async _prepare(domainId: string, docId: ObjectId, bid: number, branch?: string) {
        if (docId) {
            this.mindMap = await MindMapModel.get(domainId, docId);
        } else if (bid) {
            this.mindMap = await MindMapModel.getBybid(domainId, bid);
        }
        if (!this.mindMap) throw new NotFoundError('Base not found');
        if (!this.user.own(this.mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    @param('docId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, branch?: string) {
        const files = sortFiles(this.mindMap!.files || []).map((file) => {
            let lastModified: Date | null = null;
            if (file.lastModified) {
                lastModified = file.lastModified instanceof Date ? file.lastModified : new Date(file.lastModified);
            }
            return {
                ...file,
                lastModified,
            };
        });
        this.response.body = {
            mindMap: this.mindMap,
            files,
            urlForFile: (filename: string) => {
                if (docId) {
                    return this.url('base_file_download', { docId, filename });
                } else {
                    return this.url('base_file_download_bid', { bid, filename });
                }
            },
            urlForFilePreview: (filename: string) => {
                if (docId) {
                    return this.url('base_file_download', { docId, filename, noDisposition: 1 });
                } else {
                    return this.url('base_file_download_bid', { bid, filename, noDisposition: 1 });
                }
            },
            branch: branch || 'main',
        };
        this.response.pjax = 'partials/files.html';
        this.response.template = 'base_files.html';
    }

    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, docId: ObjectId, bid: number, branch?: string, filename?: string) {
        if ((this.mindMap!.files?.length || 0) >= system.get('limit.user_files')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const size = Math.sum((this.mindMap!.files || []).map((i) => i.size)) + file.size;
        if (size >= system.get('limit.user_files_size')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('size');
        }
        const finalFilename = filename || file.originalFilename || 'untitled';
        if (this.mindMap!.files?.find((i) => i.name === finalFilename)) throw new FileExistsError(finalFilename);
        const storagePath = `base/${domainId}/${this.mindMap!.docId.toString()}/${finalFilename}`;
        await storage.put(storagePath, file.filepath, this.user._id);
        const meta = await storage.getMeta(storagePath);
        const payload = { _id: finalFilename, name: finalFilename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        const updatedFiles = [...(this.mindMap!.files || []), payload];
        await MindMapModel.update(domainId, this.mindMap!.docId, { files: updatedFiles });
        this.back();
    }

    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, docId: ObjectId, bid: number, branch: string, files: string[]) {
        const storagePaths = files.map((t) => `base/${domainId}/${this.mindMap!.bid}/${t}`);
        await Promise.all([
            storage.del(storagePaths, this.user._id),
            MindMapModel.update(domainId, this.mindMap!.docId, { 
                files: (this.mindMap!.files || []).filter((i) => !files.includes(i.name)) 
            }),
        ]);
        this.back();
    }
}

/**
 * Base File Download Handler
 * 思维导图文件下载
 */
class MindMapFileDownloadHandler extends Handler {
    noCheckPermView = true;

    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    async get(domainId: string, docId: ObjectId, bid: number, filename: string, noDisposition = false) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) throw new NotFoundError('Base not found');
        
        const target = `base/${domainId}/${mindMap.bid}/${filename}`;
        const file = await storage.getMeta(target);
        if (!file) throw new NotFoundError(filename);
        
        try {
            this.response.redirect = await storage.signDownloadLink(
                target, noDisposition ? undefined : filename, false, 'user',
            );
            this.response.addHeader('Cache-Control', 'public');
        } catch (e) {
            if (e.message.includes('Invalid path')) throw new NotFoundError(filename);
            throw e;
        }
    }
}

/**
 * Base Card Edit Handler
 * 卡片编辑页面
 */
class MindMapCardEditHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('cardId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, bid: number, nodeId: string, cardId?: ObjectId, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) throw new NotFoundError('Base not found');
        
        let card = null;
        if (cardId) {
            card = await CardModel.get(domainId, cardId);
            if (!card) throw new NotFoundError('Card not found');
            if (card.nodeId !== nodeId) throw new NotFoundError('Card does not belong to this node');
        }
        
        this.response.template = 'base_card_edit.html';
        const returnUrl = this.request.query.returnUrl;
        this.response.body = {
            mindMap,
            card,
            nodeId,
            branch: branch || 'main',
            returnUrl: returnUrl || '',
        };
        this.UiContext.extraTitleContent = `${card?.title || '卡片'} - ${mindMap.title}`;
    }
    
    // 处理创建新卡片（没有 cardId 的路由）
    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('branch', Types.String, true)
    // 创建/更新时仅要求 title 存在，其它字段从表单 body 中按需读取
    @post('title', Types.String)
    @post('content', Types.String, true)
    @post('operation', Types.String, true)
    @post('cardId', Types.ObjectId, true)
    async post(
        domainId: string,
        docId: ObjectId,
        bid: number,
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
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) throw new NotFoundError('Base not found');
        
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
            this.response.redirect = this.url('base_card_list_branch', { 
                docId: docId.toString(), 
                branch: effectiveBranch, 
                nodeId 
                }) + `?cardId=${cardId.toString()}`;
        } else {
                this.response.redirect = this.url('base_card_list_branch_bid', { 
                    bid: bid.toString(), 
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
                mindMap.docId,
                nodeId,
                this.user._id,
                title,
                content || '',
                this.request.ip
            );
        // 重定向到新创建的卡片URL
        if (docId) {
            this.response.redirect = this.url('base_card_list_branch', { 
                docId: docId.toString(), 
                branch: effectiveBranch, 
                nodeId 
            }) + `?cardId=${newCardId.toString()}`;
        } else {
            this.response.redirect = this.url('base_card_list_branch_bid', { 
                bid: bid.toString(), 
                branch: effectiveBranch, 
                nodeId 
            }) + `?cardId=${newCardId.toString()}`;
        }
    }
    
    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @route('cardId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    // 更新时 title / content / operation 都是从表单 body 中按需读取，允许为空
    @post('title', Types.String, true)
    @post('content', Types.String, true)
    @post('operation', Types.String, true)
    async postUpdate(
        domainId: string,
        docId: ObjectId,
        bid: number,
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
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) throw new NotFoundError('Base not found');
        
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
            this.response.redirect = this.url('base_card_list_branch', { 
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
            
            // 检查是否有 returnUrl 参数
            const returnUrl = this.request.body.returnUrl || this.request.query.returnUrl;
            if (returnUrl) {
                // 如果有 returnUrl，重定向到该 URL，并添加 fromEdit=true 和 cardId 参数
                const returnUrlObj = new URL(returnUrl, `http://${this.request.headers.host || 'localhost'}`);
                returnUrlObj.searchParams.set('fromEdit', 'true');
                returnUrlObj.searchParams.set('cardId', cardId.toString());
                this.response.redirect = returnUrlObj.pathname + returnUrlObj.search;
            } else {
            if (docId) {
                this.response.redirect = this.url('base_card_list_branch', { 
                    docId: docId.toString(), 
                    branch: effectiveBranch, 
                    nodeId 
                }) + `?cardId=${cardId.toString()}`;
            } else {
                this.response.redirect = this.url('base_card_list_branch_bid', { 
                    bid: bid.toString(), 
                    branch: effectiveBranch, 
                    nodeId 
                }) + `?cardId=${cardId.toString()}`;
                }
            }
        } else {
            throw new BadRequestError('cardId is required for update operation');
        }
    }
}

/**
 * Base Card Detail Handler
 * 卡片详情页面
 */
class MindMapCardDetailHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('cardId', Types.ObjectId)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, bid: number, nodeId: string, cardId: ObjectId, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) throw new NotFoundError('Base not found');
        
        const effectiveBranch = branch || 'main';
        const branchData = getBranchData(mindMap, effectiveBranch);
        const nodes = branchData.nodes || [];
        
        // 检查节点是否存在于当前分支中
        const node = nodes.find(n => n.id === nodeId);
        if (!node) {
            throw new NotFoundError('Node not found in this branch');
        }
        
        const card = await CardModel.get(domainId, cardId);
        if (!card) throw new NotFoundError('Card not found');
        if (card.nodeId !== nodeId) throw new NotFoundError('Card does not belong to this node');
        
        // 获取同一节点的所有卡片
        const cards = await CardModel.getByNodeId(domainId, mindMap.docId, nodeId);
        const currentIndex = cards.findIndex(c => c.docId.toString() === cardId.toString());
        
        this.response.template = 'base_card_detail.html';
        this.response.body = {
            mindMap,
            card,
            cards,
            currentIndex: currentIndex >= 0 ? currentIndex : 0,
            nodeId,
            branch: effectiveBranch,
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
            
            const mindMap = await MindMapModel.getBybid(domainId, card.bid);
            if (!mindMap) throw new NotFoundError('Base not found');
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
        
        const mindMap = await MindMapModel.getBybid(domainId, card.bid);
        if (!mindMap) throw new NotFoundError('Base not found');
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const updates: any = {};
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;
        if (order !== undefined) updates.order = order;
        if (nodeId !== undefined) updates.nodeId = nodeId; // 支持更新 nodeId
        
        await CardModel.update(domainId, cardId, updates);
        this.response.body = { success: true };
    }
}

/**
 * Sync base data to git repository (without committing)
 */
async function syncMindMapToGit(domainId: string, bid: number, branch: string): Promise<void> {
    const mindMap = await MindMapModel.getBybid(domainId, bid);
    if (!mindMap) {
        return;
    }
    
    const repoGitPath = getMindMapGitPath(domainId, bid);
    
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
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-base-sync-'));
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
 * Get git status for base
 */
async function getMindMapGitStatus(
    domainId: string,
    docId: ObjectId,
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
    const repoGitPath = getMindMapGitPath(domainId, docId);
    
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
        
        // Sync latest base data to git repository before checking status
        // First checkout to the correct branch
        try {
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
            await syncMindMapToGit(domainId, docId, branch);
        } catch (err) {
            console.error('Failed to sync base to git:', err);
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
 * Commit base changes to git
 */
async function commitMindMapChanges(
    domainId: string,
    docId: ObjectId,
    mindMap: MindMapDoc,
    commitMessage: string,
    userId: number,
    userName: string
): Promise<void> {
    const repoGitPath = getMindMapGitPath(domainId, docId);
    
    try {
        await exec('git rev-parse --git-dir', { cwd: repoGitPath });
    } catch {
        await ensureMindMapGitRepo(domainId, docId);
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
    
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-base-commit-'));
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
        
        // 只添加真正有内容变化的文件
        // 先检查哪些文件有变化
        try {
            const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
            if (statusOutput.trim()) {
                const lines = statusOutput.trim().split('\n');
                const changedFiles: string[] = [];
                
                for (const line of lines) {
                    const status = line.substring(0, 2).trim();
                    const filePath = line.substring(3).trim();
                    
                    // 对于修改的文件，检查内容是否真的不同
                    if (status === 'M' || status.startsWith('M')) {
                        try {
                            // git diff --quiet 如果文件内容相同返回0，不同返回非0
                            await exec(`git diff --quiet "${filePath}"`, { cwd: repoGitPath });
                            // 如果执行成功（返回0），说明内容相同，跳过
                            continue;
                        } catch {
                            // diff --quiet 返回非零表示有变化，添加到列表
                            changedFiles.push(filePath);
                        }
                    } else if (status === '??' || status.startsWith('A') || status.startsWith('D')) {
                        // 新增或删除的文件直接添加
                        changedFiles.push(filePath);
                    }
                }
                
                // 只添加有变化的文件
                if (changedFiles.length > 0) {
                    for (const file of changedFiles) {
                        try {
                            await exec(`git add "${file}"`, { cwd: repoGitPath });
                        } catch (err: any) {
                            console.warn(`[commitMindMapChanges] Failed to add ${file}:`, err.message);
                        }
                    }
                }
            }
        } catch (err: any) {
            // 如果检查失败，回退到添加所有文件
            console.warn(`[commitMindMapChanges] Failed to check file changes, using git add -A:`, err.message);
        await exec('git add -A', { cwd: repoGitPath });
        }
        
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
 * Base Branch Create Handler
 */
class MindMapBranchCreateHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: ObjectId, bid: number, branch?: string) {
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
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
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
        
        await document.set(domainId, document.TYPE_BASE, mindMap.docId, { 
            branches, 
            currentBranch: branchName,
            branchData: mindMap.branchData,
        });
        
        try {
            const repoGitPath = await ensureMindMapGitRepo(domainId, bid);
            
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
        this.response.redirect = this.url('base_detail_branch', { 
            docId: redirectDocId.toString(), 
            branch: branchName 
        });
    }
    
    @param('docId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, branch?: string) {
        // Support GET request for URL-based branch creation
        return this.post(domainId, docId, bid, branch);
    }
}

/**
 * Base Git Status Handler
 */
class MindMapGitStatusHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: ObjectId, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByDomain(domainId);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
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
                
                gitStatus = await getMindMapGitStatus(domainId, mindMap.docId, effectiveBranch, REPO_URL);
            } catch (err) {
                console.error('Failed to get git status:', err);
                gitStatus = await getMindMapGitStatus(domainId, mindMap.docId, effectiveBranch);
            }
        } else {
            gitStatus = await getMindMapGitStatus(domainId, mindMap.docId, effectiveBranch);
        }
        
        this.response.body = { gitStatus, branch: effectiveBranch };
    }
}

/**
 * Base Commit Handler
 */
class MindMapCommitHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('commitMessage', Types.String, true)
    @param('note', Types.String, true)
    async post(domainId: string, docId: ObjectId, commitMessage?: string, note?: string) {
        // Get commit message from request body if not provided as parameter
        const body = this.request.body || {};
        const customMessage = commitMessage || note || body.commitMessage || body.note || '';
        
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getByDomain(domainId);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
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
                mindMap.docId,
                mindMap,
                customMessage,
                this.user._id,
                this.user.uname || 'unknown'
            );

            // 触发更新事件，通知所有连接的 WebSocket 客户端
            (this.ctx.emit as any)('base/update', mindMap.docId, mindMap.bid);
            (this.ctx.emit as any)('base/git/status/update', mindMap.docId, mindMap.bid);

            this.response.body = { ok: true, message: 'Changes committed successfully' };
        } catch (err: any) {
            console.error('Commit failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, error: err?.message || String(err) };
        }
    }
}


/**
 * Import base data from git file structure to database
 */
async function importMindMapFromFileStructure(
    domainId: string,
    mindMapDocId: ObjectId,
    localDir: string,
    branch: string
): Promise<{ nodes: MindMapNode[]; edges: MindMapEdge[] }> {
    const nodes: MindMapNode[] = [];
    const edges: MindMapEdge[] = [];
    const nodeIdMap = new Map<string, string>(); // dirPath -> nodeId
    
    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
    
    // Read README.md as base content (but we don't update it here, just for reference)
    const readmePath = path.join(localDir, 'README.md');
    try {
        await fs.promises.readFile(readmePath, 'utf-8');
    } catch {}
    
    // Create root node (invisible, just for structure)
    const rootNodeId = `root_${mindMapDocId.toString().substring(0, 8)}`;
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
        const nodeId = `node_${bid}_${++nodeCounter}`;
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
            const existingCards = await CardModel.getByNodeId(domainId, bid, nodeId);
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
                                mindMapDocId,
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
 * Cleanup all cards of a base before re-importing from Git.
 * 拉取前删除该思维导图下的所有卡片，后续完全按照仓库结构重建。
 */
async function cleanupMindMapCards(
    domainId: string,
    bid: number,
    _nodes: MindMapNode[] // 兼容旧签名，暂不使用 nodes
): Promise<void> {
    try {
        // 直接删除该思维导图下所有旧卡片，完全按照本次拉取结果重建
        await document.deleteMulti(domainId, TYPE_CARD as any, { bid } as any);
    } catch (err) {
        console.error(
            `cleanupMindMapCards failed for bid=${bid}:`,
            (err as any)?.message || err
        );
    }
}

/**
 * Base GitHub Pull Handler
 */
class MindMapGithubPullHandler extends Handler {
    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: ObjectId, bid: number, branch?: string) {
        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getBybid(domainId, bid);
        if (!mindMap) {
            throw new NotFoundError('Base not found');
        }
        
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const githubRepo = (mindMap.githubRepo || '') as string;
        if (!githubRepo) {
            throw new Error('GitHub repository not configured. Please configure it in base settings.');
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
                // 无论 URL 是否已包含 token，都强制使用最新的 token 重新构建 URL
                // 这样可以确保使用最新的、有效的 token，避免使用已过期或无效的旧 token
                // 提取仓库路径（去掉协议、域名和可能的旧 token）
                const repoPathMatch = githubRepo.match(/^https?:\/\/[^@]*@?github\.com\/(.+)$/);
                if (repoPathMatch && repoPathMatch[1]) {
                    REPO_URL = `https://${GH_TOKEN}@github.com/${repoPathMatch[1]}`;
                } else {
                    // 如果匹配失败，使用简单的替换方式
                    REPO_URL = githubRepo.replace(/^https?:\/\/[^@]*@?github\.com\//, `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || mindMap.branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        const repoGitPath = await ensureMindMapGitRepo(domainId, mindMap.docId, REPO_URL);
        
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
            await cleanupMindMapCards(domainId, mindMap.docId, []);

            // Import base structure from git file system（会根据目录和 .md 文件重新创建卡片）
            const { nodes, edges } = await importMindMapFromFileStructure(
                domainId,
                mindMap.docId,
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
 * Base GitHub Config Handler
 */
class MindMapGithubConfigHandler extends Handler {
    mindMap?: MindMapDoc;

    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: ObjectId, bid: number) {
        this.mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getBybid(domainId, bid);
        if (!this.mindMap) throw new NotFoundError('Base not found');
        
        if (!this.user.own(this.mindMap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    @param('githubRepo', Types.String, true)
    async post(domainId: string, docId: ObjectId, bid: number, githubRepo?: string) {
        if (githubRepo !== undefined) {
            let repoUrlForStorage = githubRepo;
            if (repoUrlForStorage && repoUrlForStorage.startsWith('https://') && repoUrlForStorage.includes('@github.com')) {
                repoUrlForStorage = repoUrlForStorage.replace(/^https:\/\/[^@]+@github\.com\//, 'https://github.com/');
            }
            
            await document.set(domainId, document.TYPE_BASE, this.mindMap!.docId, {
                githubRepo: repoUrlForStorage || null,
            });
        }
        
        this.response.body = { success: true, githubRepo: githubRepo || null };
    }
}

/**
 * Base WebSocket Connection Handler
 * 用于实时推送 base 的更新（git status 等）
 */
class MindMapConnectionHandler extends ConnectionHandler {
    private docId?: ObjectId;
    private bid?: number;
    private subscriptions: Array<{ dispose: () => void }> = [];

    @param('docId', Types.ObjectId, true)
    @param('bid', Types.PositiveInt, true)
    async prepare(domainId: string, docId?: ObjectId, bid?: number) {
        if (!docId && !bid) {
            this.close(1000, 'docId or bid is required');
            return;
        }

        const mindMap = docId 
            ? await MindMapModel.get(domainId, docId)
            : await MindMapModel.getBybid(domainId, bid!);
        
        if (!mindMap) {
            this.close(1000, 'Base not found');
            return;
        }

        this.docId = mindMap.docId;

        // 检查权限
        if (!this.user.own(mindMap)) {
            this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        }

        logger.info('Base WebSocket connected: docId=%s', this.docId);

        // 发送初始数据
        await this.sendInitialData(domainId, mindMap);

        // 订阅 base 更新事件
        const dispose1 = (this.ctx.on as any)('base/update', async (...args: any[]) => {
            const [updateDocId, updatebid] = args;
            if (updateDocId && updateDocId.toString() === this.docId!.toString()) {
                await this.sendUpdate(domainId);
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        // 订阅 git status 更新事件
        const dispose2 = (this.ctx.on as any)('base/git/status/update', async (...args: any[]) => {
            const [updateDocId, updatebid] = args;
            if (updateDocId && updateDocId.toString() === this.docId!.toString()) {
                await this.sendGitStatus(domainId);
            }
        });
        this.subscriptions.push({ dispose: dispose2 });

    }

    async message(msg: any) {
        try {
            if (!msg || typeof msg !== 'object') {
                return;
            }

            if (msg.type === 'request_markdown') {
                await this.handleMarkdownRequest(msg);
            } else if (msg.type === 'request_image') {
                await this.handleImageRequest(msg);
            }
        } catch (err) {
            logger.error('Failed to handle WebSocket message:', err);
        }
    }

    private async handleMarkdownRequest(msg: any) {
        try {
            const { requestId, text, inline = false } = msg;
            if (!requestId || !text) {
                this.send({ type: 'markdown_response', requestId, error: 'Missing requestId or text' });
                return;
            }

            const markdownModule = require('@ejunz/ui-default/backendlib/markdown');
            const html = inline 
                ? markdownModule.renderInline(text)
                : markdownModule.render(text);
            
            this.send({
                type: 'markdown_response',
                requestId,
                html,
            });
        } catch (err) {
            logger.error('Failed to handle markdown request:', err);
            this.send({
                type: 'markdown_response',
                requestId: msg.requestId,
                error: err instanceof Error ? err.message : 'Unknown error',
            });
        }
    }

    private async handleImageRequest(msg: any) {
        try {
            const { requestId, url } = msg;
            if (!requestId || !url) {
                this.send({ type: 'image_response', requestId, error: 'Missing requestId or url' });
                return;
            }

            let fullUrl = url;
            if (url.startsWith('/')) {
                const protocol = (this.request.headers['x-forwarded-proto'] as string) || 
                                 ((this.request.headers['x-forwarded-ssl'] === 'on') ? 'https' : 'http');
                const host = this.request.host || this.request.headers.host || 'localhost';
                fullUrl = `${protocol}://${host}${url}`;
            }

            const https = require('https');
            const http = require('http');
            const urlModule = require('url');
            const parsedUrl = urlModule.parse(fullUrl);
            const client = parsedUrl.protocol === 'https:' ? https : http;
            
            const imageData = await new Promise<Buffer>((resolve, reject) => {
                client.get(fullUrl, (res: any) => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Failed to fetch image: ${res.statusCode}`));
                        return;
                    }
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                    res.on('error', reject);
                }).on('error', reject);
            });
            
            const base64 = imageData.toString('base64');
            const contentType = imageData.length > 0 && imageData[0] === 0x89 && imageData[1] === 0x50 
                ? 'image/png' 
                : (imageData.length > 0 && imageData[0] === 0xFF && imageData[1] === 0xD8 
                    ? 'image/jpeg' 
                    : 'image/png');
            
            this.send({
                type: 'image_response',
                requestId,
                data: `data:${contentType};base64,${base64}`,
            });
        } catch (err) {
            logger.error('Failed to handle image request:', err);
            this.send({
                type: 'image_response',
                requestId: msg.requestId,
                error: err instanceof Error ? err.message : 'Unknown error',
            });
        }
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
            const gitStatus = await getMindMapGitStatus(domainId, mindMap.docId, branch).catch(() => null);

            this.send({
                type: 'init',
                gitStatus,
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
            const gitStatus = await getMindMapGitStatus(domainId, mindMap.docId, branch).catch(() => null);

            this.send({
                type: 'update',
                gitStatus,
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
            const gitStatus = await getMindMapGitStatus(domainId, mindMap.docId, branch).catch(() => null);

            this.send({
                type: 'git_status',
                gitStatus,
                branch,
            });
        } catch (err) {
            logger.error('Failed to send git status:', err);
        }
    }

}

/**
 * Base Domain Edit Handler
 * 用于编辑导图结构（新建、删除、编辑节点，连线等）
 */
class MindMapDomainEditHandler extends Handler {
    @param('q', Types.Content, true)
    async get(domainId: string, q = '') {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // 获取当前 domain 的 base（一个 domain 一个 base）
        const mindMap = await MindMapModel.getByDomain(domainId);
        
        if (!mindMap) {
            throw new NotFoundError('Base not found for this domain');
        }
        
        const branch = (mindMap as any)?.currentBranch || 'main';
        const branchData = getBranchData(mindMap, branch);
        
        // 找到根节点
        const rootNodes = branchData.nodes.filter(node => 
            node.level === 0 || !branchData.edges.some(edge => edge.target === node.id)
        );
        const rootNode = rootNodes[0] || branchData.nodes[0];
        
        if (!rootNode) {
            // 如果没有节点，返回空数据
            this.response.template = 'base_domain_edit.html';
            this.response.body = { 
                mindMap: {
                    ...mindMap,
                    docId: mindMap.docId.toString(),
                },
                nodes: [],
                edges: [],
                domainId,
                qs: q ? q.trim() : '',
            };
            return;
        }
        
        // 找到第一层节点（根节点的直接子节点）
        const firstLevelNodeIds = new Set(
            branchData.edges
                .filter(edge => edge.source === rootNode.id)
                .map(edge => edge.target)
        );
        
        let firstLevelNodes = branchData.nodes.filter(node => firstLevelNodeIds.has(node.id));
        
        // 搜索过滤
        if (q && q.trim()) {
            const searchTerm = q.toLowerCase().trim();
            firstLevelNodes = firstLevelNodes.filter(node => 
                node.text.toLowerCase().includes(searchTerm) ||
                node.id.toLowerCase().includes(searchTerm)
            );
        }
        
        // 找到第一层节点之间的边
        const firstLevelEdges = branchData.edges.filter(edge => 
            firstLevelNodeIds.has(edge.source) && firstLevelNodeIds.has(edge.target)
        );
        
        // 清理数据，转换为前端需要的格式
        const nodes = firstLevelNodes.map((node: any) => ({
            ...node,
            nodeId: node.id,
            title: node.text,
            domainPosition: node.position || { x: 0, y: 0 },
        }));
        
        this.response.template = 'base_domain_edit.html';
        this.response.body = { 
            mindMap: {
                ...mindMap,
                docId: mindMap.docId.toString(),
            },
            nodes,
            edges: firstLevelEdges,
            domainId,
            qs: q ? q.trim() : '',
        };
    }
}

export async function apply(ctx: Context) {
    // 注册路由
    // /base 路由现在指向 outline 页面（一个域一个 base，不需要 docId）
    // 注意：更具体的路由（如 /base/data）必须在参数路由（如 /base/:docId）之前注册
    ctx.Route('base_outline', '/base', MindMapOutlineHandler);
    ctx.Route('base_outline_branch', '/base/branch/:branch', MindMapOutlineHandler);
    ctx.Route('base_list', '/base/list', MindMapListHandler);
    ctx.Route('base_data', '/base/data', MindMapDataHandler); // 必须在 /base/:docId 之前
    // 更具体的路由先注册，确保这些路由在 /base/:docId 之前匹配
    ctx.Route('base_node_update', '/base/node/:nodeId', MindMapNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_node', '/base/node', MindMapNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_edge', '/base/edge', MindMapEdgeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_save', '/base/save', MindMapSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card', '/base/card', MindMapCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_update', '/base/card/:cardId', MindMapCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_branch_create', '/base/branch', MindMapBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_branch_create_with_param', '/base/branch/:branch/create', MindMapBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_git_status', '/base/git/status', MindMapGitStatusHandler);
    ctx.Route('base_commit', '/base/commit', MindMapCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_commit_branch', '/base/branch/:branch/commit', MindMapCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_github_push', '/base/github/push', MindMapGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_github_push_branch', '/base/branch/:branch/github/push', MindMapGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_github_pull', '/base/github/pull', MindMapGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_github_pull_branch', '/base/branch/:branch/github/pull', MindMapGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    // 参数路由放在最后
    ctx.Route('base_detail', '/base/:docId', MindMapDetailHandler);
    ctx.Route('base_detail_branch', '/base/:docId/branch/:branch', MindMapDetailHandler);
    ctx.Route('base_study', '/base/:docId/study', MindMapStudyHandler);
    ctx.Route('base_study_branch', '/base/:docId/branch/:branch/study', MindMapStudyHandler);
    ctx.Route('base_edit', '/base/:docId/edit', MindMapEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_list', '/base/node/:nodeId/cards', MindMapCardListHandler);
    ctx.Route('base_card_list_branch', '/base/branch/:branch/node/:nodeId/cards', MindMapCardListHandler);
    ctx.Route('base_card_edit', '/base/node/:nodeId/card/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_edit_with_card', '/base/node/:nodeId/card/:cardId/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_edit_branch', '/base/branch/:branch/node/:nodeId/card/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_edit_branch_with_card', '/base/branch/:branch/node/:nodeId/card/:cardId/edit', MindMapCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_detail', '/base/node/:nodeId/card/:cardId', MindMapCardDetailHandler);
    ctx.Route('base_card_detail_branch', '/base/branch/:branch/node/:nodeId/card/:cardId', MindMapCardDetailHandler);
    ctx.Route('base_files', '/base/files', MindMapFilesHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_files_branch', '/base/branch/:branch/files', MindMapFilesHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_file_download', '/base/file/:filename', MindMapFileDownloadHandler);
    ctx.Route('base_editor', '/base/editor', MindMapEditorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_editor_branch', '/base/branch/:branch/editor', MindMapEditorHandler, PRIV.PRIV_USER_PROFILE);
    
    // WebSocket 连接路由
    ctx.Connection('base_connection', '/base/ws', MindMapConnectionHandler);
}


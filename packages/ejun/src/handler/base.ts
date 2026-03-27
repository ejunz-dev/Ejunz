import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import { Handler, param, route, post, Types, ConnectionHandler } from '../service/server';
import { NotFoundError, ForbiddenError, BadRequestError, ValidationError, FileLimitExceededError, FileUploadError, FileExistsError } from '../error';
import { PRIV, PERM } from '../model/builtin';
import { BaseModel, CardModel, TYPE_CARD, TYPE_MM } from '../model/base';
import type { BaseDoc, BaseNode, BaseEdge, CardDoc, FileInfo } from '../interface';
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
import moment from 'moment-timezone';

const exec = promisify(execCb);
const logger = new Logger('base');

/* Comment translated to English. */
export function readOptionalRequestBaseDocId(req: { body?: any; query?: any } | undefined): number | undefined {
    if (!req) return undefined;
    const body = req.body || {};
    const q = req.query || {};
    const raw = body.docId ?? body.baseDocId ?? q.docId;
    if (raw === undefined || raw === null || raw === '') return undefined;
    try {
        const n = Number(raw);
        if (!Number.isSafeInteger(n) || n <= 0) return undefined;
        return n;
    } catch {
        return undefined;
    }
}

/* Comment translated to English. */
async function resolveBaseByDocIdOrBid(domainId: string, docIdOrBid: string): Promise<BaseDoc | null> {
    const key = String(docIdOrBid || '').trim();
    if (!key) return null;
    if (/^\d+$/.test(key)) {
        const byDocId = await BaseModel.get(domainId, Number(key));
        if (byDocId) return byDocId;
    }
    return BaseModel.getBybid(domainId, key);
}

/* Comment translated to English. */
async function buildContributionDataForDomain(
    domainId: string,
    uid: number,
    domainName: string,
    base?: BaseDoc & { nodes?: BaseNode[] },
): Promise<{
    todayContribution: { nodes: number; cards: number; problems: number; nodeChars: number; cardChars: number; problemChars: number };
    contributions: Array<{ date: string; type: 'node' | 'card' | 'problem'; count: number }>;
    contributionDetails: Record<string, Array<{
        domainId: string; domainName: string; nodes: number; cards: number; problems: number;
        nodeStats: { created: number; modified: number; deleted: number };
        cardStats: { created: number; modified: number; deleted: number };
        problemStats: { created: number; modified: number; deleted: number };
    }>>;
}> {
    const todayStart = moment.utc().startOf('day').toDate();
    const todayEnd = moment.utc().endOf('day').toDate();
    let todayNodes = 0;
    let todayCards = 0;
    let todayProblems = 0;
    let todayNodeChars = 0;
    let todayCardChars = 0;
    let todayProblemChars = 0;
    if (base?.updateAt && base.updateAt >= todayStart && base.updateAt <= todayEnd && base.nodes) {
        todayNodes = base.nodes.length;
        for (const n of base.nodes) {
            todayNodeChars += typeof (n as any).text === 'string' ? (n as any).text.length : 0;
        }
    }
    if (base?.docId) {
        const cardsUpdatedToday = await document.getMulti(domainId, TYPE_CARD, {
            baseDocId: base.docId,
            owner: uid,
            $or: [
                { createdAt: { $gte: todayStart, $lte: todayEnd } },
                { updateAt: { $gte: todayStart, $lte: todayEnd } },
            ],
        })
            .project({ docId: 1, title: 1, content: 1, problems: 1 })
            .toArray();
        todayCards = cardsUpdatedToday.length;
        for (const c of cardsUpdatedToday) {
            todayCardChars += (typeof (c as any).title === 'string' ? (c as any).title.length : 0)
                + (typeof (c as any).content === 'string' ? (c as any).content.length : 0);
            if (Array.isArray((c as any).problems)) {
                for (const p of (c as any).problems) {
                    todayProblems += 1;
                    todayProblemChars += typeof p.stem === 'string' ? p.stem.length : 0;
                    if (Array.isArray(p.options)) todayProblemChars += p.options.join('').length;
                    if (typeof p.analysis === 'string') todayProblemChars += p.analysis.length;
                }
            }
        }
    }
    const todayContribution = {
        nodes: todayNodes,
        cards: todayCards,
        problems: todayProblems,
        nodeChars: todayNodeChars,
        cardChars: todayCardChars,
        problemChars: todayProblemChars,
    };

    const contributions: Array<{ date: string; type: 'node' | 'card' | 'problem'; count: number }> = [];
    const nodeCounts: Record<string, number> = {};
    const cardCounts: Record<string, number> = {};
    const problemCounts: Record<string, number> = {};
    const contributionDetails: Record<string, Array<{
        domainId: string; domainName: string; nodes: number; cards: number; problems: number;
        nodeStats: { created: number; modified: number; deleted: number };
        cardStats: { created: number; modified: number; deleted: number };
        problemStats: { created: number; modified: number; deleted: number };
    }>> = {};

    const independentNodes = await document.getMulti(domainId, document.TYPE_NODE, { owner: uid })
        .project({ createdAt: 1, updateAt: 1 })
        .toArray();
    for (const nodeDoc of independentNodes) {
        if ((nodeDoc as any).createdAt) {
            const createDate = moment.utc((nodeDoc as any).createdAt).format('YYYY-MM-DD');
            const updateDate = (nodeDoc as any).updateAt ? moment.utc((nodeDoc as any).updateAt).format('YYYY-MM-DD') : createDate;
            const date = createDate === updateDate && (nodeDoc as any).updateAt
                && Math.abs(moment.utc((nodeDoc as any).updateAt).diff(moment.utc((nodeDoc as any).createdAt), 'minutes')) < 5
                ? createDate : updateDate;
            nodeCounts[date] = (nodeCounts[date] || 0) + 1;
            if (!contributionDetails[date]) contributionDetails[date] = [];
            let detail = contributionDetails[date].find(d => d.domainId === domainId);
            if (!detail) {
                detail = { domainId, domainName, nodes: 0, cards: 0, problems: 0, nodeStats: { created: 0, modified: 0, deleted: 0 }, cardStats: { created: 0, modified: 0, deleted: 0 }, problemStats: { created: 0, modified: 0, deleted: 0 } };
                contributionDetails[date].push(detail);
            }
            detail.nodes += 1;
            if (date === createDate) detail.nodeStats.created += 1;
            else if (updateDate !== createDate) detail.nodeStats.modified += 1;
        }
    }

    const basesForWall = await document.getMulti(domainId, document.TYPE_BASE, { owner: uid })
        .project({ nodes: 1, branchData: 1, updateAt: 1, createdAt: 1 })
        .toArray();
    for (const baseDoc of basesForWall) {
        const nodeIds = new Set<string>();
        if (baseDoc.nodes && Array.isArray(baseDoc.nodes)) {
            for (const node of baseDoc.nodes) {
                if (node && (node as any).id) nodeIds.add((node as any).id);
            }
        }
        if ((baseDoc as any).branchData && typeof (baseDoc as any).branchData === 'object') {
            for (const branch in (baseDoc as any).branchData) {
                const branchNodes = (baseDoc as any).branchData[branch]?.nodes;
                if (branchNodes && Array.isArray(branchNodes)) {
                    for (const node of branchNodes) {
                        if (node && (node as any).id) nodeIds.add((node as any).id);
                    }
                }
            }
        }
        const totalNodesInBase = nodeIds.size;
        if (totalNodesInBase > 0) {
            const date = (baseDoc as any).updateAt ? moment.utc((baseDoc as any).updateAt).format('YYYY-MM-DD') : ((baseDoc as any).createdAt ? moment.utc((baseDoc as any).createdAt).format('YYYY-MM-DD') : null);
            if (date) {
                nodeCounts[date] = (nodeCounts[date] || 0) + totalNodesInBase;
                if (!contributionDetails[date]) contributionDetails[date] = [];
                let detail = contributionDetails[date].find(d => d.domainId === domainId);
                if (!detail) {
                    detail = { domainId, domainName, nodes: 0, cards: 0, problems: 0, nodeStats: { created: 0, modified: 0, deleted: 0 }, cardStats: { created: 0, modified: 0, deleted: 0 }, problemStats: { created: 0, modified: 0, deleted: 0 } };
                    contributionDetails[date].push(detail);
                }
                detail.nodes += totalNodesInBase;
                const createDate = (baseDoc as any).createdAt ? moment.utc((baseDoc as any).createdAt).format('YYYY-MM-DD') : null;
                const isCreated = createDate === date && (baseDoc as any).updateAt && Math.abs(moment.utc((baseDoc as any).updateAt).diff(moment.utc((baseDoc as any).createdAt), 'minutes')) < 5;
                if (isCreated) detail.nodeStats.created += totalNodesInBase;
                else if (createDate && createDate !== date) detail.nodeStats.modified += totalNodesInBase;
            }
        }
    }

    const allCardsForWall = await document.getMulti(domainId, TYPE_CARD, { owner: uid })
        .project({ createdAt: 1, updateAt: 1, problems: 1 })
        .toArray();
    for (const cardDoc of allCardsForWall) {
        if ((cardDoc as any).createdAt) {
            const createDate = moment.utc((cardDoc as any).createdAt).format('YYYY-MM-DD');
            const updateDate = (cardDoc as any).updateAt ? moment.utc((cardDoc as any).updateAt).format('YYYY-MM-DD') : createDate;
            const date = createDate === updateDate && (cardDoc as any).updateAt && Math.abs(moment.utc((cardDoc as any).updateAt).diff(moment.utc((cardDoc as any).createdAt), 'minutes')) < 5 ? createDate : updateDate;
            cardCounts[date] = (cardCounts[date] || 0) + 1;
            if (!contributionDetails[date]) contributionDetails[date] = [];
            let detail = contributionDetails[date].find(d => d.domainId === domainId);
            if (!detail) {
                detail = { domainId, domainName, nodes: 0, cards: 0, problems: 0, nodeStats: { created: 0, modified: 0, deleted: 0 }, cardStats: { created: 0, modified: 0, deleted: 0 }, problemStats: { created: 0, modified: 0, deleted: 0 } };
                contributionDetails[date].push(detail);
            }
            detail.cards += 1;
            if (date === createDate) detail.cardStats.created += 1;
            else if (updateDate !== createDate) detail.cardStats.modified += 1;
            if ((cardDoc as any).problems && Array.isArray((cardDoc as any).problems)) {
                const problemCount = (cardDoc as any).problems.length;
                problemCounts[date] = (problemCounts[date] || 0) + problemCount;
                detail.problems += problemCount;
                detail.problemStats.created += problemCount;
            }
        }
    }

    const allDates = new Set([...Object.keys(nodeCounts), ...Object.keys(cardCounts), ...Object.keys(problemCounts), ...Object.keys(contributionDetails)]);
    for (const date of allDates) {
        const nodeCount = nodeCounts[date] || 0;
        const cardCount = cardCounts[date] || 0;
        const problemCount = problemCounts[date] || 0;
        let finalNode = nodeCount;
        let finalCard = cardCount;
        let finalProblem = problemCount;
        if (contributionDetails[date] && nodeCount === 0 && cardCount === 0 && problemCount === 0) {
            for (const d of contributionDetails[date]) {
                finalNode += d.nodes; finalCard += d.cards; finalProblem += d.problems;
            }
        }
        if (finalNode > 0) contributions.push({ date, type: 'node', count: finalNode });
        if (finalCard > 0) contributions.push({ date, type: 'card', count: finalCard });
        if (finalProblem > 0) contributions.push({ date, type: 'problem', count: finalProblem });
    }
    return { todayContribution, contributions, contributionDetails };
}

/* Comment translated to English. */
async function buildTodayContributionAllDomains(uid: number): Promise<{
    nodes: number;
    cards: number;
    problems: number;
    nodeChars: number;
    cardChars: number;
    problemChars: number;
}> {
    const todayStart = moment.utc().startOf('day').toDate();
    const todayEnd = moment.utc().endOf('day').toDate();
    let nodes = 0;
    let cards = 0;
    let problems = 0;
    let nodeChars = 0;
    let cardChars = 0;
    let problemChars = 0;

    const basesToday = await document.coll.find({
        docType: TYPE_MM,
        owner: uid,
        updateAt: { $gte: todayStart, $lte: todayEnd },
    }).project({ nodes: 1, edges: 1 }).toArray();
    for (const b of basesToday) {
        const arr = (b as any).nodes;
        const edges = (b as any).edges || [];
        if (Array.isArray(arr)) {
            const targetIds = new Set(edges.map((e: { target: string }) => e.target));
            const rootCount = arr.filter((n: { id: string }) => !targetIds.has(n.id)).length;
            nodes += rootCount;
            for (const n of arr) {
                nodeChars += typeof (n as any).text === 'string' ? (n as any).text.length : 0;
            }
        }
    }

    const cardsToday = await document.coll.find({
        docType: TYPE_CARD,
        owner: uid,
        $or: [
            { createdAt: { $gte: todayStart, $lte: todayEnd } },
            { updateAt: { $gte: todayStart, $lte: todayEnd } },
        ],
    }).project({ title: 1, content: 1, problems: 1 }).toArray();
    for (const c of cardsToday) {
        cards += 1;
        cardChars += (typeof (c as any).title === 'string' ? (c as any).title.length : 0)
            + (typeof (c as any).content === 'string' ? (c as any).content.length : 0);
        const probs = (c as any).problems;
        if (Array.isArray(probs)) {
            for (const p of probs) {
                problems += 1;
                problemChars += typeof p.stem === 'string' ? p.stem.length : 0;
                if (Array.isArray(p.options)) problemChars += p.options.join('').length;
                if (typeof p.analysis === 'string') problemChars += p.analysis.length;
            }
        }
    }

    return { nodes, cards, problems, nodeChars, cardChars, problemChars };
}

/**
 * Base Detail Handler
 */
class BaseDetailHandler extends Handler {
    base?: BaseDoc;

    @param('docId', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: number) {
        const path = this.request.path || '';
        if (path.endsWith('.css.map') || path.endsWith('.js.map') || path.endsWith('.map')) {
            throw new NotFoundError('Static resource');
        }
        
        if (docId) {
            this.base = await BaseModel.get(domainId, docId);
        } else {
            // Comment translated to English.
            this.base = await BaseModel.getByDomain(domainId);
        }
        
        if (!this.base) {
            throw new NotFoundError('Base not found');
        }
        
        await BaseModel.incrementViews(domainId, this.base.docId);
    }

    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, branch?: string) {
        // If no branch parameter, redirect to branch URL
        if (!branch || !String(branch).trim()) {
            const target = this.url('base_detail_branch', { 
                domainId, 
                docId: docId || this.base!.docId, 
                branch: 'main' 
            });
            this.response.redirect = target;
            return;
        }
        
        this.response.template = 'base_detail.html';
        
        // Handle branch parameter
        const requestedBranch = branch;
        const currentBaseBranch = (this.base as any)?.currentBranch || 'main';
        
        // Update currentBranch if different and checkout git branch
        if (requestedBranch !== currentBaseBranch) {
            await document.set(domainId, document.TYPE_BASE, this.base!.docId, { 
                currentBranch: requestedBranch 
            });
            (this.base as any).currentBranch = requestedBranch;
            
            // Checkout to the requested branch in git
            try {
                const repoGitPath = getBaseGitPath(domainId, this.base!.docId);
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
        const branches = Array.isArray((this.base as any)?.branches) 
            ? (this.base as any).branches 
            : ['main'];
        if (!branches.includes('main')) {
            branches.unshift('main');
        }
        
        // Get git status
        let gitStatus: any = null;
        const githubRepo = (this.base?.githubRepo || '') as string;
        
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
                
                gitStatus = await getBaseGitStatus(domainId, this.base!.docId, requestedBranch, REPO_URL);
            } catch (err) {
                console.error('Failed to get git status:', err);
                gitStatus = null;
            }
        } else {
            try {
                gitStatus = await getBaseGitStatus(domainId, this.base!.docId, requestedBranch);
            } catch (err) {
                console.error('Failed to get local git status:', err);
                gitStatus = null;
            }
        }
        
        // Comment translated to English.
        const branchData = getBranchData(this.base!, requestedBranch);
        
        // Comment translated to English.
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        if (branchData.nodes && branchData.nodes.length > 0) {
            for (const node of branchData.nodes) {
                try {
                    const cards = await CardModel.getByNodeId(domainId, this.base!.docId, node.id);
                    if (cards && cards.length > 0) {
                        nodeCardsMap[node.id] = cards.sort((a, b) =>
                            (a.order ?? 999999) - (b.order ?? 999999) || (a.cid - b.cid));
                    }
                } catch (err) {
                    console.error(`Failed to get cards for node ${node.id}:`, err);
                }
            }
        }

        this.response.body = {
            base: {
                ...this.base,
                nodes: branchData.nodes,
                edges: branchData.edges,
            },
            gitStatus,
            currentBranch: requestedBranch,
            branches,
            nodeCardsMap, // Comment translated to English.
            files: this.base.files || [], // Comment translated to English.
        };
    }

}

/**
 * Helper functions for branch data management
 */
export function getBranchData(base: BaseDoc, branch: string): { nodes: BaseNode[]; edges: BaseEdge[] } {
    const branchName = branch || 'main';
    
    // Comment translated to English.
    if (base.branchData && base.branchData[branchName]) {
        return {
            nodes: base.branchData[branchName].nodes || [],
            edges: base.branchData[branchName].edges || [],
        };
    }
    
    // Comment translated to English.
    if (branchName === 'main') {
        return {
            nodes: base.nodes || [],
            edges: base.edges || [],
        };
    }
    
    // Comment translated to English.
    return { nodes: [], edges: [] };
}

export function setBranchData(base: BaseDoc, branch: string, nodes: BaseNode[], edges: BaseEdge[]): void {
    const branchName = branch || 'main';
    
    if (!base.branchData) {
        base.branchData = {};
    }
    
    base.branchData[branchName] = { nodes, edges };
    
    // Comment translated to English.
    if (branchName === 'main') {
        base.nodes = nodes;
        base.edges = edges;
    }
}

/**
 * Base Study Handler
 */
class BaseStudyHandler extends Handler {
    base?: BaseDoc;

    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: number, bid: number) {
        if (docId) {
            this.base = await BaseModel.get(domainId, docId);
        } else if (bid) {
            this.base = await BaseModel.getBybid(domainId, bid);
        }
        if (!this.base) throw new NotFoundError('Base not found');
    }

    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, branch?: string) {
        const currentBranch = branch || (this.base as any)?.currentBranch || 'main';
        const branchData = getBranchData(this.base!, currentBranch);
        
        // Comment translated to English.
        const rootNodes = branchData.nodes.filter(node => 
            !branchData.edges.some(edge => edge.target === node.id)
        );

        const units: Array<{ 
            node: BaseNode; 
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

        // Comment translated to English.
        const collectNodeProblems = async (node: BaseNode): Promise<Array<{
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
                const cards = await CardModel.getByNodeId(domainId, this.base!.docId, node.id);
                
                if (cards && cards.length > 0) {
                    const docId = this.base!.docId;
                    
                    for (const card of cards) {
                        if (card.problems && card.problems.length > 0) {
                            // Comment translated to English.
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
            
            // Comment translated to English.
            const rootProblems = await collectNodeProblems(rootNode);
            units.push({
                node: rootNode,
                problemCount: rootProblems.length,
                problems: rootProblems,
            });
            
            // Comment translated to English.
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
            base: {
                ...this.base,
                nodes: branchData.nodes,
                edges: branchData.edges,
                currentBranch,
            },
            units,
        };
    }
}

/* Comment translated to English. */
export interface BaseOutlineOptions {
    template: string;
    editorMode: 'base' | 'skill';
    redirectRouteName: string;
    getRequestedBranch: (branch?: string) => string;
    getBase: (domainId: string, requestedBranch: string) => Promise<BaseDoc | null>;
    createBase: (domainId: string, requestedBranch: string) => Promise<BaseDoc>;
    defaultRootText: string;
    cleanupBranchData?: (
        domainId: string,
        base: BaseDoc,
        requestedBranch: string,
        nodes: BaseNode[],
        edges: BaseEdge[]
    ) => Promise<{ nodes: BaseNode[]; edges: BaseEdge[] }>;
}

/**
 * Comment translated to English.
 */
export class BaseOutlineHandler extends Handler {
    protected getOutlineOptions(domainId: string, branch?: string): BaseOutlineOptions {
        return {
            template: 'base_outline.html',
            editorMode: 'base',
            redirectRouteName: 'base_outline_branch',
            getRequestedBranch: (b) => (b && String(b).trim() ? b : 'main'),
            getBase: async (d) => BaseModel.getByDomain(d),
            createBase: async (d, requestedBranch) => {
                const { docId } = await BaseModel.create(
                    d,
                    this.user._id,
                    this.domain.name || '知识库',
                    '',
                    undefined,
                    requestedBranch,
                    this.request.ip,
                    undefined,
                    this.domain.name
                );
                const base = await BaseModel.get(d, docId);
                if (!base) throw new Error('Failed to create base');
                return base;
            },
            defaultRootText: this.domain.name || '根节点',
        };
    }

    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        const opts = this.getOutlineOptions(domainId, branch);
        const requestedBranch = opts.getRequestedBranch(branch);

        if (!branch || !String(branch).trim()) {
            const target = this.url(opts.redirectRouteName as any, { domainId, branch: 'main' });
            this.response.redirect = target;
            return;
        }

        this.response.template = opts.template;

        let base = await opts.getBase(domainId, requestedBranch);
        if (!base) base = await opts.createBase(domainId, requestedBranch);

        let nodes: BaseNode[] = [];
        let edges: BaseEdge[] = [];
        const branchData = getBranchData(base, requestedBranch);
        nodes = branchData.nodes || [];
        edges = branchData.edges || [];

        if (opts.cleanupBranchData) {
            const cleaned = await opts.cleanupBranchData(domainId, base, requestedBranch, nodes, edges);
            nodes = cleaned.nodes;
            edges = cleaned.edges;
        }

        if (nodes.length === 0) {
            const rootNode: Omit<BaseNode, 'id'> = { text: opts.defaultRootText, level: 0 };
            await BaseModel.addNode(domainId, base.docId, rootNode, undefined, requestedBranch);
            const updated = await BaseModel.get(domainId, base.docId);
            if (updated) {
                const updatedBranchData = getBranchData(updated, requestedBranch);
                nodes = updatedBranchData.nodes || [];
                edges = updatedBranchData.edges || [];
            }
        }

        const cardFilter: any = { baseDocId: base.docId };
        if (requestedBranch === 'main') {
            cardFilter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
        } else {
            cardFilter.branch = requestedBranch;
        }
        const allCards = await document.getMulti(domainId, document.TYPE_CARD, cardFilter)
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) {
                    nodeCardsMap[card.nodeId] = [];
                }
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        for (const nodeId of Object.keys(nodeCardsMap)) {
            nodeCardsMap[nodeId].sort((a, b) =>
                (a.order ?? 999999) - (b.order ?? 999999) || (a.cid - b.cid));
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
        
        // Comment translated to English.
        const branches = base && Array.isArray((base as any)?.branches) 
            ? (base as any).branches 
            : ['main'];
        if (!branches.includes('main')) {
            branches.unshift('main');
        }
        
        // Comment translated to English.
        let gitStatus: any = null;
        if (base) {
            const githubRepo = (base.githubRepo || '') as string;
            
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
                    
                    gitStatus = await getBaseGitStatus(domainId, base.docId, requestedBranch, REPO_URL);
                } catch (err) {
                    console.error('Failed to get git status:', err);
                    gitStatus = null;
                }
            } else {
                try {
                    gitStatus = await getBaseGitStatus(domainId, base.docId, requestedBranch);
                } catch (err) {
                    console.error('Failed to get local git status:', err);
                    gitStatus = null;
                }
            }
        }
        
        this.response.body = {
            base: base ? { ...base, nodes, edges } : {
                domainId,
                nodes: [],
                edges: [],
                currentBranch: requestedBranch,
            },
            gitStatus,
            currentBranch: requestedBranch,
            branches,
            nodeCardsMap,
            files: base?.files || [],
            domainId,
            editorMode: opts.editorMode,
        };
    }
}

/* Comment translated to English. */
export interface BaseEditorOptions {
    template: string;
    editorMode: 'base' | 'skill';
    redirectRouteName: string;
    getRequestedBranch: (branch?: string) => string;
    getBase: (domainId: string, requestedBranch: string) => Promise<BaseDoc | null>;
    createBase: (domainId: string, requestedBranch: string) => Promise<BaseDoc>;
    defaultRootText: string;
    cleanupBranchData?: (
        domainId: string,
        base: BaseDoc,
        requestedBranch: string,
        nodes: BaseNode[],
        edges: BaseEdge[]
    ) => Promise<{ nodes: BaseNode[]; edges: BaseEdge[] }>;
}

/**
 * Comment translated to English.
 */
export class BaseEditorHandler extends Handler {
    protected getEditorOptions(domainId: string, branch?: string): BaseEditorOptions {
        return {
            template: 'base_editor.html',
            editorMode: 'base',
            redirectRouteName: 'base_editor_branch',
            getRequestedBranch: (b) => (b && String(b).trim() ? b : 'main'),
            getBase: async (d) => BaseModel.getByDomain(d),
            createBase: async (d, requestedBranch) => {
                const { docId } = await BaseModel.create(
                    d,
                    this.user._id,
                    this.domain.name || '知识库',
                    '',
                    undefined,
                    requestedBranch,
                    this.request.ip,
                    undefined,
                    this.domain.name
                );
                const base = await BaseModel.get(d, docId);
                if (!base) throw new Error('Failed to create base');
                return base;
            },
            defaultRootText: this.domain.name || '知识库',
        };
    }

    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);

        const opts = this.getEditorOptions(domainId, branch);
        const requestedBranch = opts.getRequestedBranch(branch);

        if (!branch || !String(branch).trim()) {
            const target = this.url(opts.redirectRouteName as any, { domainId, branch: 'main' });
            this.response.redirect = target;
            return;
        }

        this.response.template = opts.template;

        let base = await opts.getBase(domainId, requestedBranch);
        if (!base) base = await opts.createBase(domainId, requestedBranch);

        let nodes: BaseNode[] = [];
        let edges: BaseEdge[] = [];
        const branchData = getBranchData(base, requestedBranch);
        nodes = branchData.nodes || [];
        edges = branchData.edges || [];

        if (opts.cleanupBranchData) {
            const cleaned = await opts.cleanupBranchData(domainId, base, requestedBranch, nodes, edges);
            nodes = cleaned.nodes;
            edges = cleaned.edges;
        }

        const currentBaseBranch = (base as any)?.currentBranch || 'main';
        if (requestedBranch !== currentBaseBranch) {
            await document.set(domainId, document.TYPE_BASE, base.docId, { currentBranch: requestedBranch });
        }

        if (nodes.length === 0) {
            const rootNode: Omit<BaseNode, 'id'> = { text: opts.defaultRootText, level: 0 };
            await BaseModel.addNode(domainId, base.docId, rootNode, undefined, requestedBranch);
            const updated = await BaseModel.get(domainId, base.docId);
            if (updated) {
                const updatedBranchData = getBranchData(updated, requestedBranch);
                nodes = updatedBranchData.nodes || [];
                edges = updatedBranchData.edges || [];
            }
        }

        const editorCardFilter: any = { baseDocId: base.docId };
        if (requestedBranch === 'main') {
            editorCardFilter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
        } else {
            editorCardFilter.branch = requestedBranch;
        }
        const allCards = await document.getMulti(domainId, TYPE_CARD, editorCardFilter)
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) nodeCardsMap[card.nodeId] = [];
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        for (const nodeId of Object.keys(nodeCardsMap)) {
            nodeCardsMap[nodeId].sort((a, b) =>
                (a.order ?? 999999) - (b.order ?? 999999) || (a.cid - b.cid));
        }

        const branches = Array.isArray((base as any)?.branches) ? (base as any).branches : ['main'];
        if (!branches.includes('main')) branches.unshift('main');

        const uid = this.user._id;
        const domainName = (this as any).domain?.name || domainId;
        const baseForContrib = { ...base, nodes };
        const [contrib, todayAllDomains] = await Promise.all([
            buildContributionDataForDomain(domainId, uid, domainName, baseForContrib),
            buildTodayContributionAllDomains(uid),
        ]);
        const { todayContribution, contributions, contributionDetails } = contrib;

        let baseExpandState: string[] = [];
        try {
            const coll = this.ctx.db.db.collection('base.userExpand');
            const doc = await coll.findOne({ domainId, baseDocId: base.docId, uid });
            baseExpandState = Array.isArray(doc?.expandedNodeIds) ? doc.expandedNodeIds : [];
        } catch {
            // ignore
        }

        const workspaceFromQuery = (this.request.query?.workspace as string) || '';
        const nodeIds = new Set(nodes.map((n: BaseNode) => n.id));
        const workspaceNodeId = workspaceFromQuery && nodeIds.has(workspaceFromQuery) ? workspaceFromQuery : '';

        this.response.body = {
            base: { ...base, nodes, edges },
            currentBranch: requestedBranch,
            branches,
            nodeCardsMap,
            files: base.files || [],
            domainId,
            editorMode: opts.editorMode,
            todayContribution,
            todayContributionAllDomains: todayAllDomains,
            contributions,
            contributionDetails,
            baseExpandState,
            workspaceNodeId,
            // Comment translated to English.
            ...(opts.editorMode === 'skill' ? { page_name: 'base_skill_editor_branch' } : {}),
        };
    }
}

/**
 * Comment translated to English.
 *
 * Comment translated to English.
 *   /d/:domainId/base/:docId/branch/:branch/editor
 */
export class BaseEditorDocHandler extends Handler {
    base?: BaseDoc;

    @param('docId', Types.String)
    async _prepare(domainId: string, docId: string) {
        this.base = await resolveBaseByDocIdOrBid(domainId, docId);
        if (!this.base) throw new NotFoundError('Base not found');
    }

    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);

        const base = this.base!;
        const requestedBranch = branch && String(branch).trim() ? branch : 'main';

        this.response.template = 'base_editor.html';

        let nodes: BaseNode[] = [];
        let edges: BaseEdge[] = [];

        const branchData = getBranchData(base, requestedBranch);
        nodes = branchData.nodes || [];
        edges = branchData.edges || [];

        const currentBaseBranch = (base as any)?.currentBranch || 'main';
        if (requestedBranch !== currentBaseBranch) {
            await document.set(domainId, document.TYPE_BASE, base.docId, { currentBranch: requestedBranch });
        }

        if (nodes.length === 0) {
            const rootNode: Omit<BaseNode, 'id'> = { text: (this as any).domain?.name || '知识库', level: 0 };
            await BaseModel.addNode(domainId, base.docId, rootNode, undefined, requestedBranch);
            const updated = await BaseModel.get(domainId, base.docId);
            if (updated) {
                const updatedBranchData = getBranchData(updated, requestedBranch);
                nodes = updatedBranchData.nodes || [];
                edges = updatedBranchData.edges || [];
            }
        }

        const docCardFilter: any = { baseDocId: base.docId };
        if (requestedBranch === 'main') {
            docCardFilter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
        } else {
            docCardFilter.branch = requestedBranch;
        }
        const allCards = await document.getMulti(domainId, TYPE_CARD, docCardFilter)
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) nodeCardsMap[card.nodeId] = [];
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        for (const nodeId of Object.keys(nodeCardsMap)) {
            nodeCardsMap[nodeId].sort((a, b) =>
                (a.order ?? 999999) - (b.order ?? 999999) || (a.cid - b.cid));
        }

        const branches = Array.isArray((base as any)?.branches) ? (base as any).branches : ['main'];
        if (!branches.includes('main')) branches.unshift('main');

        const uid = this.user._id;
        const domainName = (this as any).domain?.name || domainId;
        const baseForContrib = { ...base, nodes };
        const [contrib, todayAllDomains] = await Promise.all([
            buildContributionDataForDomain(domainId, uid, domainName, baseForContrib),
            buildTodayContributionAllDomains(uid),
        ]);
        const { todayContribution, contributions, contributionDetails } = contrib;

        let baseExpandState: string[] = [];
        try {
            const coll = this.ctx.db.db.collection('base.userExpand');
            const doc = await coll.findOne({ domainId, baseDocId: base.docId, uid });
            baseExpandState = Array.isArray(doc?.expandedNodeIds) ? doc.expandedNodeIds : [];
        } catch {
            // ignore
        }

        const workspaceFromQuery = (this.request.query?.workspace as string) || '';
        const nodeIds = new Set(nodes.map((n: BaseNode) => n.id));
        const workspaceNodeId = workspaceFromQuery && nodeIds.has(workspaceFromQuery) ? workspaceFromQuery : '';

        this.response.body = {
            base: { ...base, nodes, edges },
            currentBranch: requestedBranch,
            branches,
            nodeCardsMap,
            files: base.files || [],
            domainId,
            editorMode: 'base',
            todayContribution,
            todayContributionAllDomains: todayAllDomains,
            contributions,
            contributionDetails,
            baseExpandState,
            workspaceNodeId,
        };
    }
}

/**
 * Base Create Handler
 */
class BaseCreateHandler extends Handler {
    async get() {
        this.response.template = 'base_create.html';
        this.response.body = {};
    }

    @param('title', Types.String)
    @param('bid', Types.String, true)
    async post(
        domainId: string,
        title: string,
        bid?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const actualDomainId = this.args.domainId || domainId || 'system';
        const finalBid = (bid || '').trim();
        if (finalBid) {
            const existed = await BaseModel.getBybid(actualDomainId, finalBid);
            if (existed) {
                throw new ValidationError(`Base bid already exists: ${finalBid}`);
            }
        }
        
        const { docId } = await BaseModel.create(
            actualDomainId,
            this.user._id,
            title,
            '',
            undefined,
            'main',
            this.request.ip,
            undefined,
            this.domain.name,
            'base',
            true,
            finalBid || undefined
        );

        let createdBase = await BaseModel.get(actualDomainId, docId);
        if (!createdBase) {
            await new Promise(resolve => setTimeout(resolve, 200));
            createdBase = await BaseModel.get(actualDomainId, docId) || await BaseModel.getByDomain(actualDomainId);
        }
        
        if (!createdBase) {
            throw new Error(`Failed to create base: record not found after creation (docId: ${docId.toString()}, domainId: ${actualDomainId})`);
        }

        // Comment translated to English.
        try {
            await ensureBaseGitRepo(actualDomainId, docId);
            
            try {
                await createAndPushToGitHubOrgForBase(this, actualDomainId, docId, title, this.user);
            } catch (err) {
                console.error('Failed to create remote GitHub repo:', err);
                // Comment translated to English.
            }
        } catch (err) {
            console.error('Failed to create git repo:', err);
            // Comment translated to English.
        }

        this.response.body = { docId, bid: finalBid || undefined };
        this.response.redirect = this.url('base_outline_doc_branch', { domainId: actualDomainId, docId: finalBid || docId.toString(), branch: 'main' });
    }
}

// Comment translated to English.
// key: `${domainId}:${docId}:${text}:${parentId}`, value: timestamp
const nodeCreationDedupCache = new Map<string, number>();
const DEDUP_WINDOW_MS = 2000; // Comment translated to English.

/**
 * Base Edit Handler
 */
class BaseEditHandler extends Handler {
    base?: BaseDoc;

    @param('docId', Types.PositiveInt)
    async _prepare(domainId: string, docId: number) {
        this.base = await BaseModel.get(domainId, docId);
        if (!this.base) throw new NotFoundError('Base not found');
        
        if (!this.user.own(this.base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    async get() {
        this.response.template = 'base_edit.html';
        this.response.body = { base: this.base };
    }

    @param('docId', Types.PositiveInt)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('parentId', Types.ObjectId, true)
    @post('domainPosition', Types.Any, true)
    async postUpdate(
        domainId: string,
        docId: number,
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

        await BaseModel.update(domainId, docId, updates);
        this.response.body = { docId };
        // Comment translated to English.
        const operation = this.request.body?.operation;
        if (operation !== 'update') {
            this.response.redirect = this.url('base_detail', { docId: docId.toString() });
        }
    }

    @param('docId', Types.PositiveInt)
    async postDelete(domainId: string, docId: number) {
        // Comment translated to English.
        if (!this.user.own(this.base)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }
        
        await BaseModel.delete(domainId, docId);
        this.response.body = { success: true };
        this.response.redirect = this.url('base_list');
    }
}

/**
 * Base Node Handler
 * Comment translated to English.
 */
export class BaseNodeHandler extends Handler {
    /* Comment translated to English. */
    protected async getBase(domainId: string): Promise<BaseDoc> {
        const base = await BaseModel.getByDomain(domainId);
        if (!base) throw new NotFoundError('Base not found');
        return base;
    }

    /* Comment translated to English. */
    protected async resolveBase(domainId: string): Promise<BaseDoc> {
        const specified = readOptionalRequestBaseDocId(this.request);
        if (specified) {
            const base = await BaseModel.get(domainId, specified);
            if (!base) throw new NotFoundError('Base not found');
            return base;
        }
        return this.getBase(domainId);
    }

    @post('text', Types.String, true)
    @post('x', Types.Float, true)
    @post('y', Types.Float, true)
    @post('parentId', Types.String, true)
    @post('siblingId', Types.String, true)
    @post('operation', Types.String, true)
    @param('nodeId', Types.String, true)
    @post('branch', Types.String, true)
    // Comment translated to English.
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
        const base = await this.resolveBase(domainId);
        
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
        
        // Comment translated to English.
        const actualDomainId = this.args.domainId || domainId || 'system';
        const base = await this.resolveBase(actualDomainId);
        const docId = base.docId;
        
        if (!this.user.own(base)) {
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

            // Comment translated to English.
            const effectiveBranch = branch || body.branch || (base as any).currentBranch || (base as any).branch || 'main';
            
            // Comment translated to English.
            const branchData: {
                [branch: string]: { nodes: BaseNode[]; edges: BaseEdge[] };
            } = (base as any).branchData || {};
            
            let nodes: BaseNode[];
            if (branchData[effectiveBranch] && branchData[effectiveBranch].nodes) {
                nodes = branchData[effectiveBranch].nodes;
            } else if (effectiveBranch === 'main') {
                nodes = base.nodes || [];
            } else {
                nodes = [];
            }
            
            // Comment translated to English.
            // Comment translated to English.
            if (finalParentId) {
                const recentDuplicateNode = nodes.find(n => 
                    n.text === text.trim() && 
                    n.parentId === finalParentId &&
                    n.id && 
                    n.id.startsWith('node_')
                );
                
                if (recentDuplicateNode) {
                    // Comment translated to English.
                    const nodeIdMatch = recentDuplicateNode.id.match(/^node_(\d+)_/);
                    if (nodeIdMatch) {
                        const nodeCreatedTime = parseInt(nodeIdMatch[1], 10);
                        const timeSinceNodeCreation = startTime - nodeCreatedTime;
                        
                        if (timeSinceNodeCreation < DEDUP_WINDOW_MS && timeSinceNodeCreation >= 0) {
                            // Comment translated to English.
                            // Comment translated to English.
                            let edgesForDedup: BaseEdge[];
                            if (branchData[effectiveBranch] && branchData[effectiveBranch].edges) {
                                edgesForDedup = branchData[effectiveBranch].edges;
                            } else if (effectiveBranch === 'main') {
                                edgesForDedup = base.edges || [];
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

            const node: Omit<BaseNode, 'id'> = {
                text,
                x,
                y,
                parentId: effectiveParentId,
            };

            // Comment translated to English.
            if (finalSiblingId && !finalParentId) {
                if (!effectiveParentId) {
                    // Comment translated to English.
                    const result = await BaseModel.addNode(
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
                // Comment translated to English.
                const result = await BaseModel.addNode(
                    actualDomainId,
                    docId,
                    node,
                    effectiveParentId,
                    effectiveBranch
                );
                this.response.body = { nodeId: result.nodeId };
                return;
            }

            const result = await BaseModel.addNode(
                actualDomainId,
                docId,
                node,
                effectiveParentId,
                effectiveBranch,
                edgeSourceId  // Comment translated to English.
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
        
        const base = await this.resolveBase(domainId);
        const docId = base.docId;
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const updates: Partial<BaseNode> = {};
        if (text !== undefined) {
            updates.text = text;
        }
        if (color !== undefined) updates.color = color;
        if (backgroundColor !== undefined) updates.backgroundColor = backgroundColor;
        if (fontSize !== undefined) updates.fontSize = fontSize;
        if (x !== undefined) updates.x = x;
        if (y !== undefined) updates.y = y;
        if (expanded !== undefined) updates.expanded = expanded;
        
        const body: any = this.request?.body || {};
        if (body.order !== undefined) {
            updates.order = body.order;
        }
        if (body.intent !== undefined) {
            updates.intent = body.intent;
        }

        if (Object.keys(updates).length === 0) {
            this.response.body = { success: true };
            return;
        }

        const effectiveBranch = body.branch?.trim() || (base as any).currentBranch || 'main';
        await BaseModel.updateNode(domainId, docId, nodeId, updates, effectiveBranch);
        this.response.body = { success: true };
    }

    @param('nodeId', Types.String)
    @post('branch', Types.String, true)
    async postDelete(domainId: string, nodeId: string, branch?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const base = await this.resolveBase(domainId);
        const docId = base.docId;
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }

        // Comment translated to English.
        const effectiveBranch = branch || (this.request.body as any)?.branch || (base as any).currentBranch || (base as any).branch || 'main';
        
        await BaseModel.deleteNode(domainId, docId, nodeId, effectiveBranch);
        this.response.body = { success: true };
    }
}

/**
 * Base Edge Handler
 */
export class BaseEdgeHandler extends Handler {
    /* Comment translated to English. */
    protected async getBase(domainId: string): Promise<BaseDoc> {
        const base = await BaseModel.getByDomain(domainId);
        if (!base) throw new NotFoundError('Base not found');
        return base;
    }

    protected async resolveBase(domainId: string): Promise<BaseDoc> {
        const specified = readOptionalRequestBaseDocId(this.request);
        if (specified) {
            const base = await BaseModel.get(domainId, specified);
            if (!base) throw new NotFoundError('Base not found');
            return base;
        }
        return this.getBase(domainId);
    }

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
        
        const base = await this.resolveBase(domainId);
        const docId = base.docId;
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const edge: Omit<BaseEdge, 'id'> = {
            source,
            target,
            label,
        };

        const body: any = this.request?.body || {};
        const effectiveBranch = body.branch?.trim() || (base as any).currentBranch || 'main';
        const newEdgeId = await BaseModel.addEdge(
            domainId,
            docId,
            edge,
            effectiveBranch
        );

        this.response.body = { edgeId: newEdgeId };
    }

    @param('edgeId', Types.String)
    async postDelete(domainId: string, edgeId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const base = await this.resolveBase(domainId);
        const docId = base.docId;
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }

        const body: any = this.request?.body || {};
        const effectiveBranch = body.branch?.trim() || (base as any).currentBranch || 'main';
        await BaseModel.deleteEdge(domainId, docId, edgeId, effectiveBranch);
        this.response.body = { success: true };
    }
}

/**
 * Base Save Handler
 */
export class BaseSaveHandler extends Handler {
    /* Comment translated to English. */
    protected async getBase(domainId: string): Promise<BaseDoc | null> {
        return BaseModel.getByDomain(domainId);
    }
    /* Comment translated to English. */
    protected getDefaultTitle(): string {
        return this.domain.name || '知识库';
    }
    /* Comment translated to English. */
    protected getDefaultRootText(): string {
        return this.domain.name;
    }
    /* Comment translated to English. */
    protected async createBase(domainId: string): Promise<BaseDoc> {
        const data = this.request.body || {};
        const { nodes = [], edges = [] } = data;
        const rootNodeText = this.getDefaultRootText();
        const finalNodes = nodes.length > 0 ? nodes : [{
            id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            text: rootNodeText,
            level: 0,
        }];
        const payload: Partial<BaseDoc> = {
            docType: TYPE_MM,
            domainId,
            title: this.getDefaultTitle(),
            content: '',
            owner: this.user._id,
            nodes: finalNodes,
            edges: edges || [],
            layout: {
                type: 'hierarchical',
                direction: 'LR',
                spacing: { x: 200, y: 100 },
            },
            viewport: { x: 0, y: 0, zoom: 1 },
            createdAt: new Date(),
            updateAt: new Date(),
            views: 0,
            ip: this.request.ip,
            branch: 'main',
        };
        const { domainId: _, content: __, owner: ___, ...restPayload } = payload;
        const docId = await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            TYPE_MM,
            null,
            null,
            null,
            restPayload
        );
        const base = await BaseModel.get(domainId, docId);
        if (!base) throw new NotFoundError('Failed to create document');
        return base;
    }
    /* Comment translated to English. */
    protected shouldSyncToGit(): boolean {
        return true;
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const specifiedDocId = readOptionalRequestBaseDocId(this.request);
        let base: BaseDoc | null = null;
        let docId: number;

        if (specifiedDocId) {
            base = await BaseModel.get(domainId, specifiedDocId);
            if (!base) throw new NotFoundError('Base not found');
            docId = base.docId;
            if (!this.user.own(base)) {
                this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
            }
        } else {
            base = await this.getBase(domainId);
            if (!base) {
                base = await this.createBase(domainId);
                docId = base.docId;
            } else {
                docId = base.docId;
                if (!this.user.own(base)) {
                    this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
                }
            }
        }

        const data = this.request.body || {};
        let { nodes, edges, layout, viewport, theme, operationDescription } = data;
        
        const isExpandOnlySave = operationDescription === '自动保存展开状态' || operationDescription === '自动保存 outline 展开状态';
        const requestBranch = data.branch?.trim();
        
        if (isExpandOnlySave && nodes && Array.isArray(nodes)) {
            const currentBranch = requestBranch || (base as any).currentBranch || 'main';
            const currentBranchData = getBranchData(base, currentBranch);
            
            const updatedNodes = currentBranchData.nodes.map((existingNode: BaseNode) => {
                const updatedNode = nodes.find((n: BaseNode) => n.id === existingNode.id);
                if (updatedNode) {
                    const result: BaseNode = { ...existingNode };
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
            
            setBranchData(base, currentBranch, updatedNodes, currentBranchData.edges);
            
            await BaseModel.updateFull(domainId, docId, {
                branchData: base.branchData,
                nodes: base.nodes, // Comment translated to English.
                edges: base.edges, // Comment translated to English.
            });
            
            (this.ctx.emit as any)('base/update', docId, null, currentBranch);
            
            this.response.body = { success: true, hasNonPositionChanges: false };
            return;
        }
        
        // Comment translated to English.
        // Comment translated to English.
        if (nodes && Array.isArray(nodes)) {
            nodes = nodes.filter((node: BaseNode) => {
                if (!node.id) return false;
                // Comment translated to English.
                if (node.id.startsWith('temp-node-')) {
                    console.warn(`Rejected temporary node from save: ${node.id}`);
                    return false;
                }
                return true;
            });
        }
        
        if (edges && Array.isArray(edges)) {
            edges = edges.filter((edge: BaseEdge) => {
                if (!edge.id && !edge.source && !edge.target) return false;
                // Comment translated to English.
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
        
        const currentBranch = requestBranch || (base as any).currentBranch || 'main';
        
        const currentBranchData = getBranchData(base, currentBranch);

        const hasNonPositionChanges = this.detectNonPositionChanges(
            { ...base, nodes: currentBranchData.nodes, edges: currentBranchData.edges },
            nodes,
            edges
        );


        // Comment translated to English.
        setBranchData(base, currentBranch, nodes || [], edges || []);

        await BaseModel.updateFull(domainId, docId, {
            branchData: base.branchData,
            nodes: base.nodes, // Comment translated to English.
            edges: base.edges, // Comment translated to English.
            layout,
            viewport,
            theme,
        });
        
        // Comment translated to English.
        if (hasNonPositionChanges && this.shouldSyncToGit()) {
            try {
                const updatedBase = await BaseModel.get(domainId, docId);
                if (updatedBase) {
                    const branch = updatedBase.currentBranch || 'main';
                    await syncBaseToGit(domainId, updatedBase.docId, branch);
                }
            } catch (err) {
                console.error('Failed to sync to git after save:', err);
                // Comment translated to English.
            }
        }
        
        (this.ctx.emit as any)('base/update', docId, null, currentBranch);
        (this.ctx.emit as any)('base/git/status/update', docId);
        
        this.response.body = { success: true, hasNonPositionChanges };
    }

    /**
     * Comment translated to English.
     */
    private detectNonPositionChanges(
        oldBase: BaseDoc,
        newNodes?: BaseNode[],
        newEdges?: BaseEdge[]
    ): boolean {
        if (!newNodes && !newEdges) return false;

        // Comment translated to English.
        if (newNodes && newNodes.length !== oldBase.nodes.length) {
            return true;
        }

        // Comment translated to English.
        if (newEdges && newEdges.length !== oldBase.edges.length) {
            return true;
        }

        // Comment translated to English.
        if (newNodes) {
            for (const newNode of newNodes) {
                const oldNode = oldBase.nodes.find(n => n.id === newNode.id);
                if (!oldNode) return true; // Comment translated to English.

                // Comment translated to English.
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

        // Comment translated to English.
        if (newEdges) {
            const oldEdgeSet = new Set(oldBase.edges.map(e => `${e.source}-${e.target}`));
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
class BaseListHandler extends Handler {
    @param('rpid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    @param('format', Types.String, true)
    async get(domainId: string, rpid?: number, branch?: string, format?: string) {
        let bases: BaseDoc[];

        if (rpid) {
            bases = await BaseModel.getByRepo(domainId, rpid, branch);
        } else {
            bases = await BaseModel.getAll(domainId);
        }

        const basesPayload = bases.map((b) => ({ ...b, docId: b.docId.toString() }));
        if (format === 'json') {
            this.response.body = { bases: basesPayload, rpid, branch };
            return;
        }
        this.response.template = 'base_list.html';
        this.response.body = { bases: basesPayload, rpid, branch };
    }
}

/**
 * Comment translated to English.
 */
class BaseDomainListHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('pjax', Types.Boolean)
    async get(domainId: string, page = 1, q = '', pjax = false) {
        const did = typeof domainId === 'string' ? domainId : (this.args?.domainId ?? (domainId as any)?._id ?? 'system');
        const limit = this.ctx.setting.get('pagination.problem') || 20;
        let bases = await BaseModel.getAll(did);
        const qs = (q || '').trim();
        if (qs) {
            const lower = qs.toLowerCase();
            bases = bases.filter((b) => (b.title || '').toLowerCase().includes(lower) || (b.content || '').toLowerCase().includes(lower));
        }
        const total = bases.length;
        const ppcount = Math.max(1, Math.ceil(total / limit));
        const page1 = Math.max(1, Math.min(page, ppcount));
        const basesPage = bases.slice((page1 - 1) * limit, page1 * limit).map((b) => ({
            ...b,
            docId: b.docId.toString(),
            nodes: (b as any).nodes || [],
        }));
        this.response.template = 'base_domain.html';
        if (pjax) {
            const html = await this.renderHTML('partials/base_list.html', {
                bases: basesPage,
                domainId: String(did),
                page: page1,
                ppcount,
                totalPages: ppcount,
                qs,
            });
            this.response.body = {
                title: this.renderTitle(this.translate('base_domain')),
                fragments: [{ html: html || '' }],
            };
        } else {
            this.response.body = {
                bases: basesPage,
                domainId: String(did),
                page: page1,
                ppcount,
                totalPages: ppcount,
                qs,
            };
        }
    }

    async postDeleteSelected(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { docIds } = this.request.body;
        const did = typeof domainId === 'string' ? domainId : (this.args?.domainId ?? 'system');
        const ids: string[] = Array.isArray(docIds) ? docIds : [];
        for (const raw of ids) {
            const id = Number(raw);
            if (!Number.isFinite(id)) continue;
            const base = await BaseModel.get(did, id);
            if (!base) continue;
            if (!this.user.own(base)) {
                this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
            }
            await BaseModel.delete(did, id);
        }
        this.response.body = { success: true };
    }
}

/**
 * Comment translated to English.
 */
class BaseCreateNewHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const did = typeof domainId === 'string' ? domainId : (this.args?.domainId ?? (domainId as any)?._id ?? 'system');
        const { docId } = await BaseModel.create(
            did,
            this.user._id,
            this.domain.name || '知识库',
            '',
            undefined,
            'main',
            this.request.ip,
            undefined,
            this.domain.name,
            'base',
            true
        );
        const target = this.url('base_outline_doc_branch', { domainId: did, docId, branch: 'main' });
        this.response.redirect = target;
    }
}

/**
 * Comment translated to English.
 */
class BaseOutlineDocHandler extends Handler {
    @param('docId', Types.String)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: string, branch?: string) {
        const requestedBranch = branch && String(branch).trim() ? branch : 'main';
        if (!branch || !String(branch).trim()) {
            const target = this.url('base_outline_doc_branch', { domainId, docId, branch: 'main' });
            this.response.redirect = target;
            return;
        }

        const base = await resolveBaseByDocIdOrBid(domainId, docId);
        if (!base) throw new NotFoundError('Base not found');

        this.response.template = 'base_outline.html';

        let nodes: BaseNode[] = [];
        let edges: BaseEdge[] = [];
        const branchData = getBranchData(base, requestedBranch);
        nodes = branchData.nodes || [];
        edges = branchData.edges || [];

        if (nodes.length === 0) {
            const rootNode: Omit<BaseNode, 'id'> = { text: this.domain.name || '根节点', level: 0 };
            await BaseModel.addNode(domainId, base.docId, rootNode, undefined, requestedBranch);
            const updated = await BaseModel.get(domainId, base.docId);
            if (updated) {
                const updatedBranchData = getBranchData(updated, requestedBranch);
                nodes = updatedBranchData.nodes || [];
                edges = updatedBranchData.edges || [];
            }
        }

        const outlineDocCardFilter: any = { baseDocId: base.docId };
        if (requestedBranch === 'main') {
            outlineDocCardFilter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
        } else {
            outlineDocCardFilter.branch = requestedBranch;
        }
        const allCards = await document.getMulti(domainId, document.TYPE_CARD, outlineDocCardFilter)
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) nodeCardsMap[card.nodeId] = [];
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        for (const nodeId of Object.keys(nodeCardsMap)) {
            nodeCardsMap[nodeId].sort((a, b) =>
                (a.order ?? 999999) - (b.order ?? 999999) || (a.cid - b.cid));
        }

        const cardId = this.request.query.cardId as string | undefined;
        if (cardId && nodes.length > 0 && edges.length > 0) {
            let targetNodeId: string | null = null;
            for (const [nodeId, cards] of Object.entries(nodeCardsMap)) {
                if (cards.some(c => String(c.docId) === String(cardId))) {
                    targetNodeId = nodeId;
                    break;
                }
            }
            if (targetNodeId) {
                const parentMap = new Map<string, string>();
                edges.forEach(edge => parentMap.set(edge.target, edge.source));
                const nodesToExpand = new Set<string>();
                let current: string | null = targetNodeId;
                while (current) {
                    nodesToExpand.add(current);
                    current = parentMap.get(current) || null;
                }
                nodes = nodes.map(node => ({
                    ...node,
                    expandedOutline: nodesToExpand.has(node.id),
                }));
            }
        }

        const branches = base && Array.isArray((base as any)?.branches) ? (base as any).branches : ['main'];
        if (!branches.includes('main')) branches.unshift('main');

        let gitStatus: any = null;
        if (base) {
            const githubRepo = (base.githubRepo || '') as string;
            try {
                if (githubRepo && githubRepo.trim()) {
                    const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
                    const systemValue = system.get('ejunzrepo.github_token');
                    const GH_TOKEN = settingValue || systemValue || '';
                    let REPO_URL = githubRepo;
                    if (githubRepo.startsWith('https://github.com/') || githubRepo.startsWith('http://github.com/')) {
                        if (!githubRepo.includes('@github.com')) {
                            REPO_URL = githubRepo.replace('https://github.com/', `https://${GH_TOKEN}@github.com/`)
                                .replace('http://github.com/', `https://${GH_TOKEN}@github.com/`);
                        }
                    } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                        REPO_URL = `https://${GH_TOKEN}@github.com/${githubRepo.replace('.git', '')}.git`;
                    }
                    gitStatus = await getBaseGitStatus(domainId, base.docId, requestedBranch, REPO_URL);
                } else {
                    gitStatus = await getBaseGitStatus(domainId, base.docId, requestedBranch);
                }
            } catch (err) {
                logger.error('Failed to get git status:', err);
            }
        }

        this.response.body = {
            base: { ...base, nodes, edges },
            gitStatus,
            currentBranch: requestedBranch,
            branches,
            nodeCardsMap,
            files: base?.files || [],
            domainId,
            editorMode: 'base',
        };
    }
}

/**
 * Comment translated to English.
 */
class BaseOutlineRedirectHandler extends Handler {
    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        const base = await BaseModel.getByDomain(domainId);
        const b = branch && String(branch).trim() ? branch : 'main';
        if (base) {
            const target = this.url('base_outline_doc_branch', { domainId, docId: base.docId, branch: b });
            this.response.redirect = target;
        } else {
            const target = this.url('base_domain', { domainId });
            this.response.redirect = target;
        }
    }
}

/**
 * Base Domain Handler
 * Comment translated to English.
 */
class BaseDomainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('pjax', Types.Boolean)
    @param('all', Types.Boolean, true)
    async get(domainId: string, page = 1, q = '', pjax = false, all = false) {
        // Comment translated to English.
        const base = await BaseModel.getByDomain(domainId);
        
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }
        
        const branch = (base as any)?.currentBranch || 'main';
        const branchData = getBranchData(base, branch);
        
        // Comment translated to English.
        const rootNodes = branchData.nodes.filter(node => 
            node.level === 0 || !branchData.edges.some(edge => edge.target === node.id)
        );
        const rootNode = rootNodes[0] || branchData.nodes[0];
        
        if (!rootNode) {
            // Comment translated to English.
            this.response.template = 'base_domain.html';
            this.response.body = {
                base: {
                    ...base,
                    docId: base.docId.toString(),
                },
                nodes: [],
                edges: [],
                domainId,
                page: 1,
                totalPages: 1,
                total: 0,
                qs: q ? q.trim() : '',
                totalNodes: 0,
                totalViews: base.views || 0,
            };
            return;
        }
        
        // Comment translated to English.
        const firstLevelNodeIds = new Set(
            branchData.edges
                .filter(edge => edge.source === rootNode.id)
                .map(edge => edge.target)
        );
        
        const firstLevelNodes = branchData.nodes.filter(node => firstLevelNodeIds.has(node.id));
        
        // Comment translated to English.
        const firstLevelEdges = branchData.edges.filter(edge => 
            firstLevelNodeIds.has(edge.source) && firstLevelNodeIds.has(edge.target)
        );
        
        // Comment translated to English.
        let filteredNodes = firstLevelNodes;
        if (q && q.trim()) {
            const searchTerm = q.toLowerCase().trim();
            filteredNodes = firstLevelNodes.filter(node => 
                node.text.toLowerCase().includes(searchTerm) ||
                node.id.toLowerCase().includes(searchTerm)
            );
        }
        
        // Comment translated to English.
        const limit = 20;
        const skip = (page - 1) * limit;
        const total = filteredNodes.length;
        const totalPages = Math.ceil(total / limit);
        const nodesRaw = all ? filteredNodes : filteredNodes.slice(skip, skip + limit);
        
        // Comment translated to English.
        const nodes = nodesRaw.map((node: any) => ({
            ...node,
            nodeId: node.id,
            title: node.text,
            domainPosition: node.position || { x: 0, y: 0 },
        }));
        
        const totalViews = base.views || 0;
        
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
                base: {
                    ...base,
                    docId: base.docId.toString(),
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

export class BaseDataHandler extends Handler {
    /* Comment translated to English. */
    protected async getBase(domainId: string): Promise<BaseDoc | null> {
        return BaseModel.getByDomain(domainId);
    }
    /* Comment translated to English. */
    protected async createBase(domainId: string, branch: string): Promise<BaseDoc> {
        const { docId } = await BaseModel.create(
            domainId,
            this.user._id,
            '思维导图',
            '',
            undefined,
            branch,
            this.request.ip
        );
        const base = await BaseModel.get(domainId, docId);
        if (!base) throw new Error('Failed to create base');
        return base;
    }
    /* Comment translated to English. */
    protected getDefaultRootText(): string {
        return this.domain.name;
    }
    /* Comment translated to English. */
    protected getCardFilter(_base: BaseDoc): Record<string, unknown> {
        return {};
    }

    @param('branch', Types.String, true)
    @param('docId', Types.String, true)
    async get(domainId: string, branch?: string, docId?: string) {
        let base: BaseDoc | null = null;
        if (docId) {
            base = await resolveBaseByDocIdOrBid(domainId, docId);
            if (!base) throw new NotFoundError('Base not found');
        } else {
            base = await this.getBase(domainId);
            if (!base) base = await this.createBase(domainId, branch || 'main');
        }
        
        const currentBranch = branch || (base as any)?.currentBranch || 'main';
        
        let nodes: BaseNode[] = [];
        let edges: BaseEdge[] = [];
        
        if (base) {
            const branchData = getBranchData(base, currentBranch);
            nodes = branchData.nodes || [];
            edges = branchData.edges || [];
        }
        
        if (nodes.length === 0) {
            const rootNode: Omit<BaseNode, 'id'> = {
                text: this.getDefaultRootText(),
                level: 0,
            };
            const result = await BaseModel.addNode(
                domainId,
                base!.docId,
                rootNode,
                undefined,
                currentBranch
            );
            
            base = await BaseModel.get(domainId, base!.docId);
            if (base) {
                const branchData = getBranchData(base, currentBranch);
                nodes = branchData.nodes || [];
                edges = branchData.edges || [];
            }
        }
        
        const dataCardFilter: any = { ...this.getCardFilter(base) };
        if (currentBranch === 'main') {
            dataCardFilter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
        } else {
            dataCardFilter.branch = currentBranch;
        }
        const allCards = await document.getMulti(domainId, TYPE_CARD, dataCardFilter)
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) {
                    nodeCardsMap[card.nodeId] = [];
                }
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        for (const nodeId of Object.keys(nodeCardsMap)) {
            nodeCardsMap[nodeId].sort((a, b) =>
                (a.order ?? 999999) - (b.order ?? 999999) || (a.cid - b.cid));
        }

        this.response.body = base ? {
            ...base,
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
function getBaseGitPath(domainId: string, docId: number): string {
    return path.join('/data/git/ejunz', domainId, 'base', String(docId));
}

/**
 * Initialize or get git repository for base
 */
async function ensureBaseGitRepo(domainId: string, docId: number, remoteUrl?: string): Promise<string> {
    const repoPath = getBaseGitPath(domainId, docId);
    
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
async function exportBaseToFile(base: BaseDoc, outputDir: string, branch?: string): Promise<void> {
    await fs.promises.mkdir(outputDir, { recursive: true });
    
    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
    
    // Get branch-specific data
    const currentBranch = branch || (base as any).currentBranch || 'main';
    const branchData = getBranchData(base, currentBranch);
    const nodes = branchData.nodes;
    const edges = branchData.edges;
    
    // Create README.md for base root (only contains the content, no metadata)
    const readmePath = path.join(outputDir, 'README.md');
    const contentText = base.content || '';
    await fs.promises.writeFile(readmePath, contentText, 'utf-8');
    
    // Build node tree structure
    const nodeMap = new Map<string, BaseNode>();
    
    for (const node of nodes || []) {
        nodeMap.set(node.id, node);
    }
    
    // Find root node (node with no incoming edges)
    const rootNode = (nodes || []).find(node => 
        !(edges || []).some(edge => edge.target === node.id)
    );
    
    // Recursively export nodes as folders
    async function exportNode(node: BaseNode, parentPath: string): Promise<void> {
        const dirName = sanitize(node.text);
        const nodeDir = path.join(parentPath, dirName);
        await fs.promises.mkdir(nodeDir, { recursive: true });
        
        // Get all cards for this node
        const cards = await CardModel.getByNodeId(base.domainId, base.docId, node.id);
        
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
async function createGitHubRepoForBase(
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
async function createAndPushToGitHubOrgForBase(
    handler: any,
    domainId: string,
    docId: number,
    baseTitle: string,
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

    const repoName = baseTitle
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || `base-${bid}`;

    try {
        const remoteUrl = await createGitHubRepoForBase(orgName, repoName, baseTitle, GH_TOKEN, false);
        
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

        let base = await BaseModel.getBybid(domainId, bid);
        if (!base) {
            await new Promise(resolve => setTimeout(resolve, 100));
            base = await BaseModel.getBybid(domainId, bid);
        }
        
        if (base) {
            await document.set(domainId, document.TYPE_BASE, base.docId, {
                githubRepo: repoUrlForStorage,
            });
        } else {
            console.warn(`Base with bid ${bid} not found, skipping GitHub repo setup`);
            return;
        }

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ejunz-base-create-'));
        try {
            const baseForExport = await BaseModel.getBybid(domainId, bid);
            if (baseForExport) {
                await exportBaseToFile(baseForExport, tmpDir, 'main');
                const commitMessage = `${domainId}/${user._id}/${user.uname || 'unknown'}: Initial commit`;
                await gitInitAndPushBase(domainId, bid, baseForExport, REPO_URL, 'main', commitMessage);
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
async function gitInitAndPushBase(
    domainId: string,
    docId: number,
    base: BaseDoc,
    remoteUrlWithAuth: string, 
    branch: string = 'main', 
    commitMessage: string = 'chore: sync base from ejunz'
) {
    const repoGitPath = await ensureBaseGitRepo(domainId, docId, remoteUrlWithAuth);
    
    // Comment translated to English.
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
        await exportBaseToFile(base, repoGitPath, branch);
        
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
class BaseGithubPushHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: number, bid: number, branch?: string) {
        const base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getBybid(domainId, bid);
        if (!base) {
            throw new NotFoundError('Base not found');
        }
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const settingValue = this.ctx.setting.get('ejunzrepo.github_token');
        const systemValue = system.get('ejunzrepo.github_token');
        const GH_TOKEN = settingValue || systemValue || '';
        if (!GH_TOKEN) {
            throw new Error('GitHub token not configured. Please configure it in system settings.');
        }
        
        const githubRepo = (base.githubRepo || '') as string;
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
                    // Comment translated to English.
                    // Comment translated to English.
                    const urlWithoutToken = githubRepo.replace(/^https?:\/\/[^@]+@github\.com\//, 'https://github.com/');
                    REPO_URL = urlWithoutToken.replace(/^https:\/\/github\.com\//, `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || base.branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        // Comment translated to English.
        try {
            const commitMessage = this.request.body?.commitMessage || `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}: Update base`;
            await commitBaseChanges(domainId, base.docId, base, commitMessage, this.user._id, this.user.uname || 'unknown');
        } catch (err: any) {
            console.warn('Commit before push failed (may be no changes):', err?.message || err);
        }
        
        // Comment translated to English.
        const commitMessage = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}: Update base`;
        
        try {
            await gitInitAndPushBase(domainId, base.docId, base, REPO_URL, effectiveBranch, commitMessage);
            this.response.body = { ok: true, branch: effectiveBranch };
        } catch (err: any) {
            console.error('Push failed:', err?.message || err);
            this.response.status = 500;
            this.response.body = { ok: false, branch: effectiveBranch, error: err?.message || String(err) };
        }
    }

    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, branch?: string) {
        return this.post(domainId, docId, bid, branch);
    }
}

/**
 * Base Card Handler
 */
export class BaseCardHandler extends Handler {
    /* Comment translated to English. */
    protected async getBase(domainId: string): Promise<BaseDoc> {
        const specified = readOptionalRequestBaseDocId(this.request);
        if (specified) {
            const base = await BaseModel.get(domainId, specified);
            if (!base) throw new NotFoundError('Base not found');
            return base;
        }
        const base = await BaseModel.getByDomain(domainId);
        if (!base) throw new NotFoundError('Base not found');
        return base;
    }

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
        // Comment translated to English.
        // Comment translated to English.
        if (operation) {
            return;
        }
        
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // Comment translated to English.
        const body: any = this.request?.body || {};
        const finalNodeId: string | undefined = body.nodeId || nodeId;
        const finalTitle: string | undefined = body.title || title;
        const finalContent: string = body.content !== undefined ? body.content : content || '';

        // Comment translated to English.
        if (!finalNodeId || !finalTitle) {
            throw new ValidationError('nodeId and title are required for creating a card');
        }
        
        const base = await this.getBase(domainId);
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const cardBranch = body.branch?.trim() || (base as any).currentBranch || 'main';
        const cardDocId = await CardModel.create(
            domainId,
            base.docId,
            finalNodeId,
            this.user._id,
            finalTitle,
            finalContent,
            this.request.ip,
            body?.problems,
            undefined,
            cardBranch,
        );
        
        this.response.body = { cardId: cardDocId.toString() };
    }
    
    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    async get(domainId: string, docId: number, bid: number, nodeId: string) {
        const base = (docId ? await BaseModel.get(domainId, docId) : null)
            ?? (bid ? await BaseModel.getBybid(domainId, bid) : null)
            ?? await this.getBase(domainId);
        if (!base) throw new NotFoundError('Base not found');
        
        const cards = await CardModel.getByNodeId(domainId, base.docId, nodeId);
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
    @param('docId', Types.PositiveInt, true)
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
    @param('docId', Types.PositiveInt, true)
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

        let targetCard: CardDoc | null = null;
        if (resolvedDocId) {
            targetCard = await CardModel.get(domainId, resolvedDocId);
        }

        if (!targetCard && resolvedCid !== undefined) {
            if (!nodeId) throw new ValidationError('nodeId is required when using cid to locate a card');
            const specified = readOptionalRequestBaseDocId((this as any).request);
            const baseForCid = specified
                ? await BaseModel.get(domainId, specified)
                : await this.getBase(domainId);
            if (!baseForCid) throw new NotFoundError('Base not found');
            targetCard = await CardModel.getByCid(domainId, nodeId, resolvedCid, baseForCid.docId);
        }

        if (!targetCard) throw new NotFoundError('Card not found');
        const base = await BaseModel.get(domainId, targetCard.baseDocId);
        if (!base) throw new NotFoundError('Base not found');
        if (!this.user.own(base)) {
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
        if (nodeId !== undefined) updates.nodeId = nodeId; // Comment translated to English.
        // Comment translated to English.
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
 * Comment translated to English.
 */
class BaseCardListHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('branch', Types.String, true)
    @param('cardId', Types.ObjectId, true)
    async get(domainId: string, docId: number, bid: number, nodeId: string, branch?: string, cardId?: ObjectId) {
        const base = docId
            ? await BaseModel.get(domainId, docId)
            : bid
                ? await BaseModel.getBybid(domainId, bid)
                : await BaseModel.getByDomain(domainId);
        if (!base) throw new NotFoundError('Base not found');
        
        const effectiveBranch = branch || 'main';
        const branchData = getBranchData(base, effectiveBranch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        // Comment translated to English.
        const node = nodes.find(n => n.id === nodeId);
        if (!node) {
            throw new NotFoundError('Node not found in this branch');
        }
        
        // Comment translated to English.
        const cards = await CardModel.getByNodeId(domainId, base.docId, nodeId);
        
        // Comment translated to English.
        const nodePath: Array<{ id: string; text: string }> = [];
        
        // Comment translated to English.
        const nodeMap = new Map<string, BaseNode>();
        nodes.forEach(n => nodeMap.set(n.id, n));
        
        // Comment translated to English.
        const parentMap = new Map<string, string>();
        edges.forEach(edge => {
            parentMap.set(edge.target, edge.source);
        });
        
        // Comment translated to English.
        let currentNodeId: string | undefined = nodeId;
        const pathNodes: Array<{ id: string; text: string }> = [];
        while (currentNodeId) {
            const currentNode = nodeMap.get(currentNodeId);
            if (currentNode) {
                pathNodes.unshift({ id: currentNodeId, text: currentNode.text || '未命名节点' });
            }
            currentNodeId = parentMap.get(currentNodeId);
        }
        
        // Comment translated to English.
        const reversedPathNodes = pathNodes.slice().reverse();
        
        // Comment translated to English.
        let selectedCard = null;
        if (cardId) {
            selectedCard = cards.find(c => c.docId.toString() === cardId.toString());
        }
        if (!selectedCard && cards.length > 0) {
            selectedCard = cards[0];
        }
        
        const extraTitleContent = `${reversedPathNodes.map(p => p.text).join(' / ')} - ${base.title}`;
        
        this.response.template = 'base_card_list.html';
        this.response.body = {
            base,
            cards,
            nodeId,
            nodeText: node?.text || '节点',
            nodePath: reversedPathNodes, // Comment translated to English.
            branch: branch || 'main',
            selectedCard,
        };
        this.UiContext.extraTitleContent = extraTitleContent;
    }
}

/**
 * Card-mounted files: list, upload, delete
 */
class BaseCardFilesHandler extends Handler {
    base?: BaseDoc;
    card?: CardDoc | null;

    @param('docId', Types.PositiveInt, true)
    @param('cardId', Types.ObjectId, true)
    async _prepare(domainId: string, docId: number, cardId: ObjectId) {
        this.base = await BaseModel.get(domainId, docId);
        if (!this.base) throw new NotFoundError('Base not found');
        if (!this.user.own(this.base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        this.card = await CardModel.get(domainId, cardId);
        if (!this.card || this.card.baseDocId.toString() !== docId.toString()) {
            throw new NotFoundError('Card not found');
        }
    }

    @param('docId', Types.PositiveInt, true)
    @param('cardId', Types.ObjectId, true)
    async get(domainId: string, docId: number, cardId: ObjectId) {
        const files = sortFiles(this.card!.files || []).map((file) => {
            let lastModified: Date | null = null;
            if (file.lastModified) {
                lastModified = file.lastModified instanceof Date ? file.lastModified : new Date(file.lastModified);
            }
            return { ...file, lastModified };
        });
        this.response.body = { files };
    }

    @param('docId', Types.PositiveInt, true)
    @param('cardId', Types.ObjectId, true)
    async post(domainId: string, docId: number, cardId: ObjectId) {
        const body = (this.request.body as any) || {};
        if (this.request.files?.file) {
            const filename = body.filename || this.request.files.file.originalFilename || 'untitled';
            return this.postUploadFile(domainId, docId, cardId, filename);
        }
        if (body.fileAction === 'rename' && typeof body.oldName === 'string' && typeof body.newName === 'string') {
            return this.postRenameFile(domainId, docId, cardId, 'rename', body.oldName, body.newName);
        }
        if (Array.isArray(body.files) && body.files.length > 0) {
            return this.postDeleteFiles(domainId, docId, cardId, body.files);
        }
        throw new ValidationError('file or files');
    }

    @param('docId', Types.PositiveInt, true)
    @param('cardId', Types.ObjectId, true)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, docId: number, cardId: ObjectId, filename?: string) {
        if ((this.card!.files?.length || 0) >= system.get('limit.user_files')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const size = Math.sum((this.card!.files || []).map((i) => i.size)) + file.size;
        if (size >= system.get('limit.user_files_size')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('size');
        }
        const finalFilename = filename || file.originalFilename || 'untitled';
        if ((this.card!.files || []).find((i) => i.name === finalFilename)) throw new FileExistsError(finalFilename);
        const storagePath = `base/${domainId}/${docId.toString()}/card/${cardId.toString()}/${finalFilename}`;
        await storage.put(storagePath, file.filepath, this.user._id);
        const meta = await storage.getMeta(storagePath);
        const payload = { _id: finalFilename, name: finalFilename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        const updatedFiles = [...(this.card!.files || []), payload];
        await CardModel.update(domainId, cardId, { files: updatedFiles });
        this.response.body = { ok: true, files: updatedFiles };
    }

    @param('docId', Types.PositiveInt, true)
    @param('cardId', Types.ObjectId, true)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, docId: number, cardId: ObjectId, files: string[]) {
        const storagePaths = files.map((name) => `base/${domainId}/${docId.toString()}/card/${cardId.toString()}/${name}`);
        await Promise.all([
            storage.del(storagePaths, this.user._id),
            CardModel.update(domainId, cardId, {
                files: (this.card!.files || []).filter((i) => !files.includes(i.name)),
            }),
        ]);
        this.response.body = { ok: true };
    }

    @param('docId', Types.PositiveInt, true)
    @param('cardId', Types.ObjectId, true)
    @post('operation', Types.String, true)
    @post('oldName', Types.Filename, true)
    @post('newName', Types.Filename, true)
    async postRenameFile(domainId: string, docId: number, cardId: ObjectId, operation?: string, oldName?: string, newName?: string) {
        if (operation !== 'rename' || !oldName || !newName) throw new ValidationError('operation, oldName, newName');
        const prefix = `base/${domainId}/${docId.toString()}/card/${cardId.toString()}`;
        const oldPath = `${prefix}/${oldName}`;
        const newPath = `${prefix}/${newName}`;
        if (!(this.card!.files || []).find((i) => i.name === oldName)) throw new NotFoundError(oldName);
        if ((this.card!.files || []).find((i) => i.name === newName)) throw new FileExistsError(newName);
        await storage.rename(oldPath, newPath, this.user._id);
        const meta = await storage.getMeta(newPath);
        const updatedFiles = (this.card!.files || []).map((i) =>
            i.name === oldName ? { _id: newName, name: newName, ...pick(meta || i, ['size', 'lastModified', 'etag']) } : i,
        );
        await CardModel.update(domainId, cardId, { files: updatedFiles });
        this.response.body = { ok: true, files: updatedFiles };
    }
}

/**
 * Card file download
 */
class BaseCardFileDownloadHandler extends Handler {
    noCheckPermView = true;

    @param('docId', Types.PositiveInt, true)
    @param('cardId', Types.ObjectId, true)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    async get(domainId: string, docId: number, cardId: ObjectId, filename: string, noDisposition = false) {
        const base = await BaseModel.get(domainId, docId);
        if (!base) throw new NotFoundError('Base not found');
        const card = await CardModel.get(domainId, cardId);
        if (!card || card.baseDocId.toString() !== docId.toString()) throw new NotFoundError('Card not found');
        const target = `base/${domainId}/${docId.toString()}/card/${cardId.toString()}/${filename}`;
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
 * Node-mounted files: list, upload, delete (branch-aware)
 */
class BaseNodeFilesHandler extends Handler {
    base?: BaseDoc;
    node?: BaseNode;
    branch?: string;

    @param('docId', Types.PositiveInt, true)
    @param('nodeId', Types.String, true)
    @param('branch', Types.String, true)
    async _prepare(domainId: string, docId: number, nodeId: string, branch?: string) {
        this.base = await BaseModel.get(domainId, docId);
        if (!this.base) throw new NotFoundError('Base not found');
        if (!this.user.own(this.base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        this.branch = branch || (this.base as any).currentBranch || 'main';
        const { nodes } = getBranchData(this.base, this.branch);
        this.node = nodes.find((n) => n.id === nodeId) || null;
        if (!this.node) throw new NotFoundError('Node not found');
    }

    @param('docId', Types.PositiveInt, true)
    @param('nodeId', Types.String, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, nodeId: string, branch?: string) {
        const files = sortFiles(this.node!.files || []).map((file) => {
            let lastModified: Date | null = null;
            if (file.lastModified) {
                lastModified = file.lastModified instanceof Date ? file.lastModified : new Date(file.lastModified);
            }
            return { ...file, lastModified };
        });
        this.response.body = { files };
    }

    @param('docId', Types.PositiveInt, true)
    @param('nodeId', Types.String, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: number, nodeId: string, branch?: string) {
        const body = (this.request.body as any) || {};
        if (this.request.files?.file) {
            const filename = body.filename || this.request.files.file.originalFilename || 'untitled';
            return this.postUploadFile(domainId, docId, nodeId, branch, filename);
        }
        if (body.fileAction === 'rename' && typeof body.oldName === 'string' && typeof body.newName === 'string') {
            return this.postRenameFile(domainId, docId, nodeId, branch, 'rename', body.oldName, body.newName);
        }
        if (Array.isArray(body.files) && body.files.length > 0) {
            return this.postDeleteFiles(domainId, docId, nodeId, branch, body.files);
        }
        throw new ValidationError('file or files');
    }

    @param('docId', Types.PositiveInt, true)
    @param('nodeId', Types.String, true)
    @param('branch', Types.String, true)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, docId: number, nodeId: string, branch?: string, filename?: string) {
        if ((this.node!.files?.length || 0) >= system.get('limit.user_files')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const size = Math.sum((this.node!.files || []).map((i) => i.size)) + file.size;
        if (size >= system.get('limit.user_files_size')) {
            if (!this.user.hasPriv(PRIV.PRIV_UNLIMITED_QUOTA)) throw new FileLimitExceededError('size');
        }
        const finalFilename = filename || file.originalFilename || 'untitled';
        if ((this.node!.files || []).find((i) => i.name === finalFilename)) throw new FileExistsError(finalFilename);
        const storagePath = `base/${domainId}/${docId.toString()}/node/${nodeId}/${finalFilename}`;
        await storage.put(storagePath, file.filepath, this.user._id);
        const meta = await storage.getMeta(storagePath);
        const payload = { _id: finalFilename, name: finalFilename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        const updatedFiles = [...(this.node!.files || []), payload];
        await this.updateNodeFiles(domainId, docId, updatedFiles);
        this.response.body = { ok: true, files: updatedFiles };
    }

    @param('docId', Types.PositiveInt, true)
    @param('nodeId', Types.String, true)
    @param('branch', Types.String, true)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, docId: number, nodeId: string, branch?: string, files: string[] = []) {
        const storagePaths = files.map((name) => `base/${domainId}/${docId.toString()}/node/${nodeId}/${name}`);
        await Promise.all([
            storage.del(storagePaths, this.user._id),
            this.updateNodeFiles(domainId, docId, (this.node!.files || []).filter((i) => !files.includes(i.name))),
        ]);
        this.response.body = { ok: true };
    }

    @param('docId', Types.PositiveInt, true)
    @param('nodeId', Types.String, true)
    @param('branch', Types.String, true)
    @post('operation', Types.String, true)
    @post('oldName', Types.Filename, true)
    @post('newName', Types.Filename, true)
    async postRenameFile(domainId: string, docId: number, nodeId: string, branch?: string, operation?: string, oldName?: string, newName?: string) {
        if (operation !== 'rename' || !oldName || !newName) throw new ValidationError('operation, oldName, newName');
        const prefix = `base/${domainId}/${docId.toString()}/node/${nodeId}`;
        const oldPath = `${prefix}/${oldName}`;
        const newPath = `${prefix}/${newName}`;
        if (!(this.node!.files || []).find((i) => i.name === oldName)) throw new NotFoundError(oldName);
        if ((this.node!.files || []).find((i) => i.name === newName)) throw new FileExistsError(newName);
        await storage.rename(oldPath, newPath, this.user._id);
        const meta = await storage.getMeta(newPath);
        const updatedFiles = (this.node!.files || []).map((i) =>
            i.name === oldName ? { _id: newName, name: newName, ...pick(meta || i, ['size', 'lastModified', 'etag']) } : i,
        );
        await this.updateNodeFiles(domainId, docId, updatedFiles);
        this.response.body = { ok: true, files: updatedFiles };
    }

    private async updateNodeFiles(domainId: string, docId: number, files: FileInfo[]) {
        const base = await BaseModel.get(domainId, docId);
        if (!base) throw new NotFoundError('Base not found');
        const branchName = this.branch!;
        const branchData = { ...(base.branchData || {}) };
        if (!branchData[branchName]) {
            branchData[branchName] = { nodes: base.nodes || [], edges: base.edges || [] };
        }
        const nodes = [...branchData[branchName].nodes];
        const idx = nodes.findIndex((n) => n.id === this.node!.id);
        if (idx < 0) throw new NotFoundError('Node not found');
        nodes[idx] = { ...nodes[idx], files };
        branchData[branchName] = { ...branchData[branchName], nodes };
        const updates: any = { branchData };
        if (branchName === 'main') {
            updates.nodes = nodes;
            updates.edges = branchData[branchName].edges;
        }
        await BaseModel.updateFull(domainId, docId, updates);
    }
}

/**
 * Node file download
 */
class BaseNodeFileDownloadHandler extends Handler {
    noCheckPermView = true;

    @param('docId', Types.PositiveInt, true)
    @param('nodeId', Types.String, true)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, nodeId: string, filename: string, noDisposition = false, branch?: string) {
        const base = await BaseModel.get(domainId, docId);
        if (!base) throw new NotFoundError('Base not found');
        const branchName = branch || (base as any).currentBranch || 'main';
        const { nodes } = getBranchData(base, branchName);
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) throw new NotFoundError('Node not found');
        const target = `base/${domainId}/${docId.toString()}/node/${nodeId}/${filename}`;
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
 * Comment translated to English.
 */
class BaseCardEditHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('cardId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, bid: number, nodeId: string, cardId?: ObjectId, branch?: string) {
        const base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getBybid(domainId, bid);
        if (!base) throw new NotFoundError('Base not found');
        
        let card = null;
        if (cardId) {
            card = await CardModel.get(domainId, cardId);
            if (!card) throw new NotFoundError('Card not found');
            if (card.nodeId !== nodeId) throw new NotFoundError('Card does not belong to this node');
        }
        
        this.response.template = 'base_card_edit.html';
        const returnUrl = this.request.query.returnUrl;
        this.response.body = {
            base,
            card,
            nodeId,
            branch: branch || 'main',
            returnUrl: returnUrl || '',
        };
        this.UiContext.extraTitleContent = `${card?.title || '卡片'} - ${base.title}`;
    }
    
    // Comment translated to English.
    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('branch', Types.String, true)
    // Comment translated to English.
    @post('title', Types.String)
    @post('content', Types.String, true)
    @post('operation', Types.String, true)
    @post('cardId', Types.ObjectId, true)
    async post(
        domainId: string,
        docId: number,
        bid: number,
        nodeId: string,
        branch?: string,
        title?: string,
        content?: string,
        operation?: string,
        cardId?: ObjectId
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getBybid(domainId, bid);
        if (!base) throw new NotFoundError('Base not found');
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const effectiveBranch = branch || 'main';
        
        // Comment translated to English.
        if (operation === 'update' && cardId) {
            const updates: any = {};
            if (title !== undefined) updates.title = title;
            if (content !== undefined) updates.content = content;
            await CardModel.update(domainId, cardId, updates);
            // Comment translated to English.
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
        
            // Comment translated to English.
            if (!title) {
                throw new ValidationError('title is required');
            }
        const newCardId = await CardModel.create(
                domainId,
                base.docId,
                nodeId,
                this.user._id,
                title,
                content || '',
                this.request.ip,
                undefined,
                undefined,
                effectiveBranch,
            );
        // Comment translated to English.
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
    
    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @route('cardId', Types.ObjectId, true)
    @param('branch', Types.String, true)
    // Comment translated to English.
    @post('title', Types.String, true)
    @post('content', Types.String, true)
    @post('operation', Types.String, true)
    async postUpdate(
        domainId: string,
        docId: number,
        bid: number,
        nodeId: string,
        cardId?: ObjectId,
        branch?: string,
        title?: string,
        content?: string,
        operation?: string
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        const base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getBybid(domainId, bid);
        if (!base) throw new NotFoundError('Base not found');
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const effectiveBranch = branch || 'main';
        
        if (cardId) {
            // Comment translated to English.
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
            
            // Comment translated to English.
            const returnUrl = this.request.body.returnUrl || this.request.query.returnUrl;
            if (returnUrl) {
                // Comment translated to English.
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
 * Comment translated to English.
 */
class BaseCardDetailHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('nodeId', Types.String)
    @param('cardId', Types.ObjectId)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, bid: number, nodeId: string, cardId: ObjectId, branch?: string) {
        const base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getBybid(domainId, bid);
        if (!base) throw new NotFoundError('Base not found');
        
        const effectiveBranch = branch || 'main';
        const branchData = getBranchData(base, effectiveBranch);
        const nodes = branchData.nodes || [];
        
        // Comment translated to English.
        const node = nodes.find(n => n.id === nodeId);
        if (!node) {
            throw new NotFoundError('Node not found in this branch');
        }
        
        const card = await CardModel.get(domainId, cardId);
        if (!card) throw new NotFoundError('Card not found');
        if (card.nodeId !== nodeId) throw new NotFoundError('Card does not belong to this node');
        
        // Comment translated to English.
        const cards = await CardModel.getByNodeId(domainId, base.docId, nodeId);
        const currentIndex = cards.findIndex(c => c.docId.toString() === cardId.toString());
        
        this.response.template = 'base_card_detail.html';
        this.response.body = {
            base,
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
        
        // Comment translated to English.
        if (operation === 'delete') {
            const card = await CardModel.get(domainId, cardId);
            if (!card) throw new NotFoundError('Card not found');
            
            const base = await BaseModel.getBybid(domainId, card.bid);
            if (!base) throw new NotFoundError('Base not found');
            if (!this.user.own(base)) {
                this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
            }
            
            await CardModel.delete(domainId, cardId);
            this.response.body = { success: true };
            return;
        }
        
        // Comment translated to English.
        const card = await CardModel.get(domainId, cardId);
        if (!card) throw new NotFoundError('Card not found');
        
        const base = await BaseModel.getBybid(domainId, card.bid);
        if (!base) throw new NotFoundError('Base not found');
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const updates: any = {};
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;
        if (order !== undefined) updates.order = order;
        if (nodeId !== undefined) updates.nodeId = nodeId; // Comment translated to English.
        
        await CardModel.update(domainId, cardId, updates);
        this.response.body = { success: true };
    }
}

/* Comment translated to English. */
export interface BatchSaveOptions {
    type: 'base' | 'skill';
    getBase: (actualDomainId: string) => Promise<BaseDoc | null>;
    createBase: (actualDomainId: string) => Promise<BaseDoc>;
    getBranch: (base: BaseDoc) => string;
}

/**
 * Base Batch Save Handler
 * Comment translated to English.
 */
export class BaseBatchSaveHandler extends Handler {
    protected getBatchSaveOptions(): BatchSaveOptions {
        return {
            type: 'base',
            getBase: (d) => BaseModel.getByDomain(d),
            createBase: async (d) => {
                const { docId } = await BaseModel.create(
                    d,
                    this.user._id,
                    this.domain.name || '知识库',
                    '',
                    undefined,
                    'main',
                    this.request.ip,
                    undefined,
                    this.domain.name
                );
                const base = await BaseModel.get(d, docId);
                if (!base) throw new Error('Failed to create base');
                return base;
            },
            getBranch: (base) => (base as any).currentBranch || 'main',
        };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);

        const actualDomainId = this.args.domainId || domainId || 'system';
        const opts = this.getBatchSaveOptions();
        const data = this.request.body || {};
        const specifiedDocId = readOptionalRequestBaseDocId(this.request);
        let base: BaseDoc | null = null;
        if (specifiedDocId) {
            base = await BaseModel.get(actualDomainId, specifiedDocId);
            if (!base) throw new NotFoundError('Base not found');
        } else {
            base = await opts.getBase(actualDomainId);
            if (!base) base = await opts.createBase(actualDomainId);
        }
        if (!this.user.own(base)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        const docId = base.docId;
        const branch = data.branch?.trim() || opts.getBranch(base);

        const {
            nodeCreates = [],
            nodeUpdates = [],
            nodeDeletes = [],
            cardCreates = [],
            cardUpdates = [],
            cardDeletes = [],
            edgeCreates = [],
            edgeDeletes = [],
        } = data;

        const errors: string[] = [];
        const nodeIdMap = new Map<string, string>();
        const cardIdMap = new Map<string, string>();
        
        const remainingNodeCreates = [...nodeCreates];
        const processedNodeCreates = new Set<string>();
        
        while (remainingNodeCreates.length > 0) {
            const beforeCount = remainingNodeCreates.length;
            const currentRound: typeof nodeCreates = [];
            
            for (const nodeCreate of remainingNodeCreates) {
                if (processedNodeCreates.has(nodeCreate.tempId)) {
                    continue;
                }
                
                let realParentId = nodeCreate.parentId;
                if (nodeCreate.parentId && nodeCreate.parentId.startsWith('temp-node-')) {
                    realParentId = nodeIdMap.get(nodeCreate.parentId);
                    if (!realParentId) {
                        continue;
                    }
                }
                
                currentRound.push(nodeCreate);
                processedNodeCreates.add(nodeCreate.tempId);
            }
            
            if (currentRound.length === 0) {
                // Comment translated to English.
                break;
            }
            
            // Comment translated to English.
            for (const nodeCreate of currentRound) {
                try {
                    let realParentId = nodeCreate.parentId;
                    if (nodeCreate.parentId && nodeCreate.parentId.startsWith('temp-node-')) {
                        realParentId = nodeIdMap.get(nodeCreate.parentId);
                    }
                    
                    if (realParentId && !realParentId.startsWith('temp-node-')) {
                        const currentBase = await BaseModel.get(actualDomainId, docId);
                        if (currentBase) {
                            const branchData = getBranchData(currentBase, branch);
                            const parentExists = branchData.nodes.some((n: BaseNode) => n.id === realParentId);
                            if (!parentExists) {
                                realParentId = undefined;
                            }
                        } else {
                            realParentId = undefined;
                        }
                    }
                    
                    const nodePayload: Partial<BaseNode> = {
                        text: nodeCreate.text,
                        x: nodeCreate.x,
                        y: nodeCreate.y,
                        parentId: realParentId,
                    };
                    if (nodeCreate.order != null) nodePayload.order = nodeCreate.order;
                    if (nodeCreate.intent !== undefined) nodePayload.intent = nodeCreate.intent;
                    const result = await BaseModel.addNode(
                        actualDomainId,
                        docId,
                        nodePayload as Omit<BaseNode, 'id'>,
                        realParentId,
                        branch,
                        realParentId // edgeSourceId
                    );
                    if (nodeCreate.tempId) {
                        nodeIdMap.set(nodeCreate.tempId, result.nodeId);
                    }
                } catch (error: any) {
                    errors.push(`创建节点失败: ${error.message || '未知错误'}`);
                }
            }
            
            remainingNodeCreates.splice(0, remainingNodeCreates.length, 
                ...remainingNodeCreates.filter(nc => !processedNodeCreates.has(nc.tempId))
            );
            
            if (remainingNodeCreates.length === beforeCount) {
                break;
            }
        }
        
        for (const nodeUpdate of nodeUpdates) {
            try {
                const updates: Partial<BaseNode> = {};
                if (nodeUpdate.text != null) updates.text = nodeUpdate.text;
                if (nodeUpdate.order != null) updates.order = nodeUpdate.order;
                if (nodeUpdate.intent !== undefined) updates.intent = nodeUpdate.intent;
                if (Object.keys(updates).length === 0) continue;
                await BaseModel.updateNode(actualDomainId, docId, nodeUpdate.nodeId, updates, branch);
            } catch (error: any) {
                errors.push(`更新节点失败: ${error.message || '未知错误'}`);
            }
        }
        
        // Comment translated to English.
        for (const edgeId of edgeDeletes) {
            try {
                await BaseModel.deleteEdge(actualDomainId, docId, edgeId, branch);
            } catch (error: any) {
                // Comment translated to English.
            }
        }
        
        // Comment translated to English.
        for (const nodeId of nodeDeletes) {
            try {
                await BaseModel.deleteNode(actualDomainId, docId, nodeId, branch);
            } catch (error: any) {
                errors.push(`删除节点失败: ${error.message || '未知错误'}`);
            }
        }
        
        for (const edgeCreate of edgeCreates) {
            try {
                const sourceId = edgeCreate.source.startsWith('temp-node-') 
                    ? nodeIdMap.get(edgeCreate.source) || edgeCreate.source
                    : edgeCreate.source;
                const targetId = edgeCreate.target.startsWith('temp-node-')
                    ? nodeIdMap.get(edgeCreate.target) || edgeCreate.target
                    : edgeCreate.target;
                
                if (sourceId && targetId && !sourceId.startsWith('temp-node-') && !targetId.startsWith('temp-node-')) {
                    await BaseModel.addEdge(actualDomainId, docId, {
                        source: sourceId,
                        target: targetId,
                        label: edgeCreate.label,
                    }, branch);
                }
            } catch (error: any) {
                errors.push(`创建边失败: ${error.message || '未知错误'}`);
            }
        }
        
        // Comment translated to English.
        for (const cardCreate of cardCreates) {
            try {
                // Comment translated to English.
                const realNodeId = cardCreate.nodeId.startsWith('temp-node-')
                    ? nodeIdMap.get(cardCreate.nodeId) || cardCreate.nodeId
                    : cardCreate.nodeId;
                
                if (realNodeId && !realNodeId.startsWith('temp-node-')) {
                    const response = await CardModel.create(
                        actualDomainId,
                        docId,
                        realNodeId,
                        this.user._id,
                        cardCreate.title || '新卡片',
                        cardCreate.content || '',
                        this.request.ip,
                        cardCreate.problems,
                        cardCreate.order,
                        branch,
                    );
                    
                    if (cardCreate.tempId) {
                        cardIdMap.set(cardCreate.tempId, response.toString());
                    }
                }
            } catch (error: any) {
                errors.push(`创建卡片失败: ${error.message || '未知错误'}`);
            }
        }
        
        // Comment translated to English.
        for (const cardUpdate of cardUpdates) {
            try {
                const updates: Partial<Pick<CardDoc, 'title' | 'content' | 'cardFace' | 'order' | 'nodeId' | 'problems'>> = {};
                if (cardUpdate.title !== undefined) updates.title = cardUpdate.title;
                if (cardUpdate.content !== undefined) updates.content = cardUpdate.content;
                if (cardUpdate.cardFace !== undefined) updates.cardFace = cardUpdate.cardFace;
                if (cardUpdate.nodeId !== undefined) updates.nodeId = cardUpdate.nodeId;
                if (cardUpdate.order !== undefined) updates.order = cardUpdate.order;
                if (cardUpdate.problems !== undefined) updates.problems = cardUpdate.problems;
                if (Object.keys(updates).length === 0) continue;
                await CardModel.update(actualDomainId, new ObjectId(cardUpdate.cardId), updates);
            } catch (error: any) {
                errors.push(`更新卡片失败: ${error.message || '未知错误'}`);
            }
        }
        
        for (const cardId of cardDeletes) {
            try {
                await CardModel.delete(actualDomainId, new ObjectId(cardId));
            } catch (error: any) {
                errors.push(`删除卡片失败: ${error.message || '未知错误'}`);
            }
        }
        
        (this.ctx.emit as any)('base/update', docId, null, branch);
        
        this.response.body = {
            success: errors.length === 0,
            errors,
            nodeIdMap: Object.fromEntries(nodeIdMap),
            cardIdMap: Object.fromEntries(cardIdMap),
        };
    }
}

/**
 * Sync base data to git repository (without committing)
 */
async function syncBaseToGit(domainId: string, docId: number, branch: string): Promise<void> {
    const base = await BaseModel.get(domainId, docId);
    if (!base) {
        return;
    }
    
    const repoGitPath = getBaseGitPath(domainId, docId);
    
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
        const branch = (base as any).currentBranch || 'main';
        await exportBaseToFile(base, tmpDir, branch);
        
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
                            console.log(`[syncBaseToGit] Removed directory: ${destPath}`);
                        } else {
                            await fs.promises.unlink(destPath);
                            console.log(`[syncBaseToGit] Removed file: ${destPath}`);
                        }
                    } catch (err: any) {
                        console.warn(`[syncBaseToGit] Failed to remove ${destPath}:`, err.message);
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
async function getBaseGitStatus(
    domainId: string,
    docId: number,
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
    const repoGitPath = getBaseGitPath(domainId, docId);
    
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
            await syncBaseToGit(domainId, docId, branch);
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
        
        // Comment translated to English.
        try {
            const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
            const changes = statusOutput.trim();
            status.uncommittedChanges = changes.length > 0;
            
            // Comment translated to English.
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
        
        // Comment translated to English.
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
        
        // Comment translated to English.
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
        console.error('getBaseGitStatus error:', err);
        return defaultStatus;
    }
}

/**
 * Commit base changes to git
 */
async function commitBaseChanges(
    domainId: string,
    docId: number,
    base: BaseDoc,
    commitMessage: string,
    userId: number,
    userName: string
): Promise<void> {
    const repoGitPath = getBaseGitPath(domainId, docId);
    
    try {
        await exec('git rev-parse --git-dir', { cwd: repoGitPath });
    } catch {
        await ensureBaseGitRepo(domainId, docId);
    }
    
    const botName = system.get('ejunzrepo.github_bot_name') || 'ejunz-bot';
    const botEmail = system.get('ejunzrepo.github_bot_email') || 'bot@ejunz.local';
    await exec(`git config user.name "${botName}"`, { cwd: repoGitPath });
    await exec(`git config user.email "${botEmail}"`, { cwd: repoGitPath });
    
    const branch = (base as any).currentBranch || base.branch || 'main';
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
        const branch = (base as any).currentBranch || 'main';
        await exportBaseToFile(base, tmpDir, branch);
        
        // Comment translated to English.
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
        
        // Comment translated to English.
        // Comment translated to English.
        try {
            const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: repoGitPath });
            if (statusOutput.trim()) {
                const lines = statusOutput.trim().split('\n');
                const changedFiles: string[] = [];
                
                for (const line of lines) {
                    const status = line.substring(0, 2).trim();
                    const filePath = line.substring(3).trim();
                    
                    // Comment translated to English.
                    if (status === 'M' || status.startsWith('M')) {
                        try {
                            // Comment translated to English.
                            await exec(`git diff --quiet "${filePath}"`, { cwd: repoGitPath });
                            // Comment translated to English.
                            continue;
                        } catch {
                            // Comment translated to English.
                            changedFiles.push(filePath);
                        }
                    } else if (status === '??' || status.startsWith('A') || status.startsWith('D')) {
                        // Comment translated to English.
                        changedFiles.push(filePath);
                    }
                }
                
                // Comment translated to English.
                if (changedFiles.length > 0) {
                    for (const file of changedFiles) {
                        try {
                            await exec(`git add "${file}"`, { cwd: repoGitPath });
                        } catch (err: any) {
                            console.warn(`[commitBaseChanges] Failed to add ${file}:`, err.message);
                        }
                    }
                }
            }
        } catch (err: any) {
            // Comment translated to English.
            console.warn(`[commitBaseChanges] Failed to check file changes, using git add -A:`, err.message);
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
            console.error(`[commitBaseChanges] Error during commit:`, err);
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
class BaseBranchCreateHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: number, bid: number, branch?: string) {
        // Support both POST body and URL parameter
        const newBranch = branch || this.request.body?.branch || '';
        if (!newBranch || !newBranch.trim()) {
            throw new Error('Branch name is required');
        }
        
        const branchName = newBranch.trim();
        if (branchName === 'main') {
            throw new ForbiddenError('Cannot create branch named main');
        }
        
        const base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getBybid(domainId, bid);
        if (!base) {
            throw new NotFoundError('Base not found');
        }
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const currentBranch = (base as any).currentBranch || 'main';
        if (currentBranch !== 'main') {
            throw new ForbiddenError('Branches can only be created from the main branch.');
        }
        
        const branches = Array.isArray((base as any).branches) ? [...(base as any).branches] : ['main'];
        if (!branches.includes(branchName)) {
            branches.push(branchName);
        }
        
        // Comment translated to English.
        const mainBranchData = getBranchData(base, 'main');
        setBranchData(base, branchName, 
            JSON.parse(JSON.stringify(mainBranchData.nodes)), 
            JSON.parse(JSON.stringify(mainBranchData.edges))
        );
        
        await document.set(domainId, document.TYPE_BASE, base.docId, { 
            branches, 
            currentBranch: branchName,
            branchData: base.branchData,
        });
        
        try {
            const repoGitPath = await ensureBaseGitRepo(domainId, bid);
            
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
        const redirectDocId = docId || base.docId;
        this.response.redirect = this.url('base_detail_branch', { 
            docId: redirectDocId.toString(), 
            branch: branchName 
        });
    }
    
    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, branch?: string) {
        // Support GET request for URL-based branch creation
        return this.post(domainId, docId, bid, branch);
    }
}

class BaseBranchesHandler extends Handler {
    @param('docId', Types.PositiveInt)
    async get(domainId: string, docId: number) {
        const base = await resolveBaseByDocIdOrBid(domainId, String(docId));
        if (!base) throw new NotFoundError('Base not found');
        const branches: string[] = Array.isArray((base as any).branches) ? (base as any).branches : ['main'];
        if (!branches.includes('main')) branches.unshift('main');
        const currentBranch = (base as any).currentBranch || 'main';
        this.response.template = 'base_branches.html';
        this.response.body = {
            base: { ...base, docId: base.docId.toString() },
            branches,
            currentBranch,
            domainId,
        };
    }

    @param('docId', Types.PositiveInt)
    async postCreateBranch(domainId: string, docId: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { branch: newBranch, sourceBranch } = this.request.body;
        if (!newBranch || !newBranch.trim()) {
            throw new BadRequestError('Branch name is required');
        }
        const branchName = newBranch.trim();
        if (branchName === 'main') {
            throw new ForbiddenError('Cannot create branch named main');
        }

        const base = await BaseModel.get(domainId, docId);
        if (!base) throw new NotFoundError('Base not found');
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }

        const source = sourceBranch?.trim() || 'main';
        const branches: string[] = Array.isArray((base as any).branches) ? [...(base as any).branches] : ['main'];
        if (branches.includes(branchName)) {
            throw new BadRequestError('Branch already exists');
        }
        branches.push(branchName);

        const srcData = getBranchData(base, source);
        setBranchData(base, branchName,
            JSON.parse(JSON.stringify(srcData.nodes)),
            JSON.parse(JSON.stringify(srcData.edges)),
        );

        await document.set(domainId, document.TYPE_BASE, base.docId, {
            branches,
            branchData: base.branchData,
        });

        this.response.body = { success: true };
        this.response.redirect = this.url('base_branches', { docId: docId.toString() });
    }
}

/**
 * Base Git Status Handler
 */
class BaseGitStatusHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, branch?: string) {
        const base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getByDomain(domainId);
        if (!base) {
            throw new NotFoundError('Base not found');
        }
        
        const effectiveBranch = branch || (base as any).currentBranch || 'main';
        const githubRepo = (base.githubRepo || '') as string;
        
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
                
                gitStatus = await getBaseGitStatus(domainId, base.docId, effectiveBranch, REPO_URL);
            } catch (err) {
                console.error('Failed to get git status:', err);
                gitStatus = await getBaseGitStatus(domainId, base.docId, effectiveBranch);
            }
        } else {
            gitStatus = await getBaseGitStatus(domainId, base.docId, effectiveBranch);
        }
        
        this.response.body = { gitStatus, branch: effectiveBranch };
    }
}

/**
 * Base Commit Handler
 */
class BaseCommitHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('commitMessage', Types.String, true)
    @param('note', Types.String, true)
    async post(domainId: string, docId: number, commitMessage?: string, note?: string) {
        // Get commit message from request body if not provided as parameter
        const body = this.request.body || {};
        const customMessage = commitMessage || note || body.commitMessage || body.note || '';
        
        const base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getByDomain(domainId);
        if (!base) {
            throw new NotFoundError('Base not found');
        }
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        // Generate final commit message with prefix (same format as repo)
        const defaultPrefix = `${domainId}/${this.user._id}/${this.user.uname || 'unknown'}`;
        const finalCommitMessage = customMessage && customMessage.trim() 
            ? `${defaultPrefix}: ${customMessage.trim()}`
            : defaultPrefix;
        
        try {
            await commitBaseChanges(
                domainId,
                base.docId,
                base,
                customMessage,
                this.user._id,
                this.user.uname || 'unknown'
            );

            // Comment translated to English.
            (this.ctx.emit as any)('base/update', base.docId, base.bid);
            (this.ctx.emit as any)('base/git/status/update', base.docId, base.bid);

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
async function importBaseFromFileStructure(
    domainId: string,
    baseDocId: number,
    localDir: string,
    branch: string
): Promise<{ nodes: BaseNode[]; edges: BaseEdge[] }> {
    const nodes: BaseNode[] = [];
    const edges: BaseEdge[] = [];
    const nodeIdMap = new Map<string, string>(); // dirPath -> nodeId
    
    const sanitize = (name: string) => (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
    
    // Read README.md as base content (but we don't update it here, just for reference)
    const readmePath = path.join(localDir, 'README.md');
    try {
        await fs.promises.readFile(readmePath, 'utf-8');
    } catch {}
    
    // Create root node (invisible, just for structure)
    const rootNodeId = `root_${baseDocId.toString().substring(0, 8)}`;
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
        const node: BaseNode = {
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
            // Comment translated to English.
            const existingCards = await CardModel.getByNodeId(domainId, bid, nodeId);
            const existingCardsByTitle = new Map<string, CardDoc>();
            const processedCardIds = new Set<string>();

            for (const card of existingCards) {
                // Comment translated to English.
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

                    // Comment translated to English.
                    try {
                        const existingCard = existingCardsByTitle.get(cardTitle);

                        if (existingCard) {
                            // Comment translated to English.
                            await CardModel.update(domainId, existingCard.docId, {
                                content: cardContent,
                            });
                            processedCardIds.add(existingCard.docId.toString());
                        } else {
                            // Comment translated to English.
                            const newCardId = await CardModel.create(
                                domainId,
                                baseDocId,
                                nodeId,
                                0, // owner (system)
                                cardTitle,
                                cardContent,
                                '127.0.0.1',
                                undefined,
                                undefined,
                                branch,
                            );
                            processedCardIds.add(newCardId.toString());
                        }
                    } catch (err) {
                        console.error(`Failed to create/update card ${cardTitle} for node ${nodeId}:`, err);
                    }
                }
            }

            // Comment translated to English.
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
 * Comment translated to English.
 */
async function cleanupBaseCards(
    domainId: string,
    bid: number,
    _nodes: BaseNode[] // Comment translated to English.
): Promise<void> {
    try {
        // Comment translated to English.
        await document.deleteMulti(domainId, TYPE_CARD as any, { bid } as any);
    } catch (err) {
        console.error(
            `cleanupBaseCards failed for bid=${bid}:`,
            (err as any)?.message || err
        );
    }
}

/**
 * Base GitHub Pull Handler
 */
class BaseGithubPullHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async post(domainId: string, docId: number, bid: number, branch?: string) {
        const base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getBybid(domainId, bid);
        if (!base) {
            throw new NotFoundError('Base not found');
        }
        
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
        
        const githubRepo = (base.githubRepo || '') as string;
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
                // Comment translated to English.
                // Comment translated to English.
                // Comment translated to English.
                const repoPathMatch = githubRepo.match(/^https?:\/\/[^@]*@?github\.com\/(.+)$/);
                if (repoPathMatch && repoPathMatch[1]) {
                    REPO_URL = `https://${GH_TOKEN}@github.com/${repoPathMatch[1]}`;
                } else {
                    // Comment translated to English.
                    REPO_URL = githubRepo.replace(/^https?:\/\/[^@]*@?github\.com\//, `https://${GH_TOKEN}@github.com/`);
                }
            } else if (!githubRepo.includes('://') && !githubRepo.includes('@')) {
                const repoPath = githubRepo.replace('.git', '');
                REPO_URL = `https://${GH_TOKEN}@github.com/${repoPath}.git`;
            }
        }
        
        const effectiveBranch = (branch || base.branch || this.args?.branch || this.request.body?.branch || 'main').toString();
        
        const repoGitPath = await ensureBaseGitRepo(domainId, base.docId, REPO_URL);
        
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
            
            // Comment translated to English.
            await cleanupBaseCards(domainId, base.docId, []);

            // Comment translated to English.
            const { nodes, edges } = await importBaseFromFileStructure(
                domainId,
                base.docId,
                repoGitPath,
                effectiveBranch
            );
            
            // Update branch data
            setBranchData(base, effectiveBranch, nodes, edges);
            
            // Read README.md for content
            const readmePath = path.join(repoGitPath, 'README.md');
            let content = base.content || '';
            try {
                content = await fs.promises.readFile(readmePath, 'utf-8');
            } catch {}
            
            await BaseModel.updateFull(domainId, base.docId, {
                branchData: base.branchData,
                nodes: base.nodes, // Comment translated to English.
                edges: base.edges, // Comment translated to English.
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
class BaseGithubConfigHandler extends Handler {
    base?: BaseDoc;

    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    async _prepare(domainId: string, docId: number, bid: number) {
        this.base = docId 
            ? await BaseModel.get(domainId, docId)
            : await BaseModel.getBybid(domainId, bid);
        if (!this.base) throw new NotFoundError('Base not found');
        
        if (!this.user.own(this.base)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    @param('docId', Types.PositiveInt, true)
    @param('bid', Types.PositiveInt, true)
    @param('githubRepo', Types.String, true)
    async post(domainId: string, docId: number, bid: number, githubRepo?: string) {
        if (githubRepo !== undefined) {
            let repoUrlForStorage = githubRepo;
            if (repoUrlForStorage && repoUrlForStorage.startsWith('https://') && repoUrlForStorage.includes('@github.com')) {
                repoUrlForStorage = repoUrlForStorage.replace(/^https:\/\/[^@]+@github\.com\//, 'https://github.com/');
            }
            
            await document.set(domainId, document.TYPE_BASE, this.base!.docId, {
                githubRepo: repoUrlForStorage || null,
            });
        }
        
        this.response.body = { success: true, githubRepo: githubRepo || null };
    }
}

/**
 * Base WebSocket Connection Handler
 * Comment translated to English.
 */
class BaseConnectionHandler extends ConnectionHandler {
    private docId?: number;
    private bid?: string;
    private subscriptions: Array<{ dispose: () => void }> = [];

    @param('docId', Types.String, true)
    @param('bid', Types.String, true)
    async prepare(domainId: string, docId?: string, bid?: string) {
        // Comment translated to English.
        const finalDomainId = domainId || (this.request.query?.domainId as string) || (this.args as any).domainId;
        const qDocId = this.request.query?.docId as string;
        const qBid = this.request.query?.bid as string;
        const finalDocToken = (docId && String(docId).trim())
            || (qDocId && String(qDocId).trim())
            || (bid && String(bid).trim())
            || (qBid && String(qBid).trim())
            || '';

        if (!finalDocToken) {
            this.close(1000, 'docId or bid is required');
            return;
        }
        if (!finalDomainId) {
            this.close(1000, 'domainId is required');
            return;
        }

        const base = await resolveBaseByDocIdOrBid(finalDomainId, finalDocToken);

        if (!base) {
            this.close(1000, 'Base not found');
            return;
        }

        this.docId = base.docId;

        // Comment translated to English.
        if (!this.user.own(base)) {
            this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        }

        logger.info('Base WebSocket connected: docId=%s', this.docId);

        // Comment translated to English.
        await this.sendInitialData(finalDomainId, base);

        // Comment translated to English.
        const dispose1 = (this.ctx.on as any)('base/update', async (...args: any[]) => {
            const [updateDocId, updatebid, updateBranch] = args;
            if (updateDocId && updateDocId.toString() === this.docId!.toString()) {
                await this.sendUpdate(finalDomainId, updateBranch);
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        // Comment translated to English.
        const dispose2 = (this.ctx.on as any)('base/git/status/update', async (...args: any[]) => {
            const [updateDocId, updatebid] = args;
            if (updateDocId && updateDocId.toString() === this.docId!.toString()) {
                await this.sendGitStatus(finalDomainId);
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

    private async sendInitialData(domainId: string, base: BaseDoc) {
        try {
            const branch = (base as any).currentBranch || 'main';
            const gitStatus = await getBaseGitStatus(domainId, base.docId, branch).catch(() => null);
            const branchData = getBranchData(base, branch);
            const baseWithNodes = { ...base, nodes: branchData.nodes };
            const domainName = (this as any).domain?.name || domainId;
            const contrib = await buildContributionDataForDomain(domainId, this.user._id, domainName, baseWithNodes);
            const todayAllDomains = await buildTodayContributionAllDomains(this.user._id);

            this.send({
                type: 'init',
                gitStatus,
                branch,
                todayContribution: contrib.todayContribution,
                todayContributionAllDomains: todayAllDomains,
                contributions: contrib.contributions,
                contributionDetails: contrib.contributionDetails,
            });
        } catch (err) {
            logger.error('Failed to send initial data:', err);
        }
    }

    private async sendUpdate(domainId: string, sourceBranch?: string) {
        try {
            const base = await BaseModel.get(domainId, this.docId!);
            if (!base) return;

            const branch = (base as any).currentBranch || 'main';
            const gitStatus = await getBaseGitStatus(domainId, base.docId, branch).catch(() => null);
            const branchData = getBranchData(base, branch);
            const baseWithNodes = { ...base, nodes: branchData.nodes };
            const domainName = (this as any).domain?.name || domainId;
            const contrib = await buildContributionDataForDomain(domainId, this.user._id, domainName, baseWithNodes);
            const todayAllDomains = await buildTodayContributionAllDomains(this.user._id);

            this.send({
                type: 'update',
                gitStatus,
                branch,
                sourceBranch: sourceBranch || branch,
                todayContribution: contrib.todayContribution,
                todayContributionAllDomains: todayAllDomains,
                contributions: contrib.contributions,
                contributionDetails: contrib.contributionDetails,
            });
        } catch (err) {
            logger.error('Failed to send update:', err);
        }
    }

    private async sendGitStatus(domainId: string) {
        try {
            const base = await BaseModel.get(domainId, this.docId!);
            if (!base) return;

            const branch = (base as any).currentBranch || 'main';
            const gitStatus = await getBaseGitStatus(domainId, base.docId, branch).catch(() => null);

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
 * Comment translated to English.
 */
class BaseDomainEditHandler extends Handler {
    @param('q', Types.Content, true)
    async get(domainId: string, q = '') {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        // Comment translated to English.
        const base = await BaseModel.getByDomain(domainId);
        
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }
        
        const branch = (base as any)?.currentBranch || 'main';
        const branchData = getBranchData(base, branch);
        
        // Comment translated to English.
        const rootNodes = branchData.nodes.filter(node => 
            node.level === 0 || !branchData.edges.some(edge => edge.target === node.id)
        );
        const rootNode = rootNodes[0] || branchData.nodes[0];
        
        if (!rootNode) {
            // Comment translated to English.
            this.response.template = 'base_domain_edit.html';
            this.response.body = { 
                base: {
                    ...base,
                    docId: base.docId.toString(),
                },
                nodes: [],
                edges: [],
                domainId,
                qs: q ? q.trim() : '',
            };
            return;
        }
        
        // Comment translated to English.
        const firstLevelNodeIds = new Set(
            branchData.edges
                .filter(edge => edge.source === rootNode.id)
                .map(edge => edge.target)
        );
        
        let firstLevelNodes = branchData.nodes.filter(node => firstLevelNodeIds.has(node.id));
        
        // Comment translated to English.
        if (q && q.trim()) {
            const searchTerm = q.toLowerCase().trim();
            firstLevelNodes = firstLevelNodes.filter(node => 
                node.text.toLowerCase().includes(searchTerm) ||
                node.id.toLowerCase().includes(searchTerm)
            );
        }
        
        // Comment translated to English.
        const firstLevelEdges = branchData.edges.filter(edge => 
            firstLevelNodeIds.has(edge.source) && firstLevelNodeIds.has(edge.target)
        );
        
        // Comment translated to English.
        const nodes = firstLevelNodes.map((node: any) => ({
            ...node,
            nodeId: node.id,
            title: node.text,
            domainPosition: node.position || { x: 0, y: 0 },
        }));
        
        this.response.template = 'base_domain_edit.html';
        this.response.body = { 
            base: {
                ...base,
                docId: base.docId.toString(),
            },
            nodes,
            edges: firstLevelEdges,
            domainId,
            qs: q ? q.trim() : '',
        };
    }
}

function collectSubtreeNodeIds(nodes: BaseNode[], edges: BaseEdge[], rootId: string): Set<string> {
    const ids = new Set<string>();
    const walk = (id: string) => {
        if (ids.has(id)) return;
        ids.add(id);
        const n = nodes.find((x) => x.id === id);
        if (n?.children?.length) {
            for (const c of n.children) walk(c);
        }
        for (const e of edges) {
            if (e.source === id) walk(e.target);
        }
    };
    walk(rootId);
    return ids;
}

/**
 * Cut a node subtree into a newly created base (editor migrate action).
 */
class BaseMigrateNodeToNewHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const actualDomainId = this.args.domainId || domainId || 'system';
        const body = (this.request.body || {}) as Record<string, unknown>;
        const sourceDocId = readOptionalRequestBaseDocId(this.request);
        const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : 'main';
        const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const bidRaw = typeof body.bid === 'string' ? body.bid.trim() : '';

        if (!sourceDocId || !nodeId) {
            throw new ValidationError('docId and nodeId are required');
        }
        if (!title) {
            throw new ValidationError('title is required');
        }

        const sourceBase = await BaseModel.get(actualDomainId, sourceDocId);
        if (!sourceBase) throw new NotFoundError('Base not found');
        if ((sourceBase as any).type === 'skill') {
            throw new ValidationError('Cannot migrate from skill base');
        }
        if (!this.user.own(sourceBase)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const finalBid = bidRaw;
        if (finalBid) {
            const existed = await BaseModel.getBybid(actualDomainId, finalBid);
            if (existed) {
                throw new ValidationError(`Base bid already exists: ${finalBid}`);
            }
        }

        const { nodes, edges } = getBranchData(sourceBase, branch);
        const getRoot = (ns: BaseNode[], es: BaseEdge[]) => {
            const incoming = new Set(es.map((e) => e.target));
            const noIncoming = ns.find((n) => !incoming.has(n.id));
            return noIncoming?.id || ns[0]?.id || null;
        };
        const graphRootId = getRoot(nodes, edges);

        if (!nodes.some((n) => n.id === nodeId)) {
            throw new NotFoundError('Node not found in this branch');
        }

        const subtreeIds = collectSubtreeNodeIds(nodes, edges, nodeId);
        if (subtreeIds.size === 0) {
            throw new ValidationError('Empty subtree');
        }

        const { docId: newDocIdNum } = await BaseModel.create(
            actualDomainId,
            this.user._id,
            title,
            '',
            undefined,
            'main',
            this.request.ip,
            undefined,
            this.domain.name,
            'base',
            true,
            finalBid || undefined,
        );
        const newDocId = Number(newDocIdNum);

        const oldDocIdStr = String(sourceDocId);

        const migratedNodes: BaseNode[] = nodes
            .filter((n) => subtreeIds.has(n.id))
            .map((n) => ({ ...n }));
        const migratedEdges: BaseEdge[] = edges.filter(
            (e) => subtreeIds.has(e.source) && subtreeIds.has(e.target),
        );

        const isFullMigration = graphRootId && nodeId === graphRootId;

        const rootInNew = migratedNodes.find((n) => n.id === nodeId);
        if (rootInNew) {
            const { parentId: _p, ...rest } = rootInNew as any;
            const updatedRoot: BaseNode = {
                ...rest,
                level: 0,
            };
            delete (updatedRoot as any).parentId;
            const idx = migratedNodes.findIndex((n) => n.id === nodeId);
            migratedNodes[idx] = updatedRoot;
        }

        const remainingNodes = nodes.filter((n) => !subtreeIds.has(n.id));
        const remainingEdges = edges.filter((e) => !subtreeIds.has(e.source) && !subtreeIds.has(e.target));

        let finalSourceNodes = remainingNodes;
        let finalSourceEdges = remainingEdges;

        if (isFullMigration) {
            const freshRoot: BaseNode = {
                id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                text: sourceBase.title || '根节点',
                x: 0,
                y: 0,
                level: 0,
                expanded: true,
            };
            finalSourceNodes = [freshRoot];
            finalSourceEdges = [];
        }

        const sourceBranchData = { ...(sourceBase.branchData || {}) };
        sourceBranchData[branch] = { nodes: finalSourceNodes, edges: finalSourceEdges };
        const sourceUpdate: any = {
            branchData: sourceBranchData,
            updateAt: new Date(),
        };
        if (branch === 'main') {
            sourceUpdate.nodes = finalSourceNodes;
            sourceUpdate.edges = finalSourceEdges;
        }
        await BaseModel.updateFull(actualDomainId, sourceDocId, sourceUpdate);

        const createdNew = await BaseModel.get(actualDomainId, newDocId);
        if (!createdNew) throw new Error('Failed to load new base after create');
        const newBranchData: any = { ...(createdNew.branchData || {}) };
        newBranchData.main = { nodes: migratedNodes, edges: migratedEdges };
        await BaseModel.updateFull(actualDomainId, newDocId, {
            branchData: newBranchData,
            nodes: migratedNodes,
            edges: migratedEdges,
            title,
            updateAt: new Date(),
        });

        const allCards: CardDoc[] = [];
        for (const nid of subtreeIds) {
            const cs = await CardModel.getByNodeId(actualDomainId, sourceDocId, nid);
            allCards.push(...cs);
        }

        const newDocIdStr = String(newDocId);
        for (const nid of subtreeIds) {
            const node = nodes.find((n) => n.id === nid);
            const files = node?.files || [];
            for (const f of files) {
                const name = f.name || (f as any)._id;
                if (!name) continue;
                const oldPath = `base/${actualDomainId}/${oldDocIdStr}/node/${nid}/${name}`;
                const newPath = `base/${actualDomainId}/${newDocIdStr}/node/${nid}/${name}`;
                try {
                    await storage.rename(oldPath, newPath, this.user._id);
                } catch {
                    // missing file row is ok
                }
            }
        }
        for (const card of allCards) {
            const cid = card.docId.toString();
            const files = card.files || [];
            for (const f of files) {
                const name = f.name || (f as any)._id;
                if (!name) continue;
                const oldPath = `base/${actualDomainId}/${oldDocIdStr}/card/${cid}/${name}`;
                const newPath = `base/${actualDomainId}/${newDocIdStr}/card/${cid}/${name}`;
                try {
                    await storage.rename(oldPath, newPath, this.user._id);
                } catch {
                }
            }
        }

        for (const card of allCards) {
            await CardModel.update(actualDomainId, card.docId, { baseDocId: newDocId });
        }

        try {
            await ensureBaseGitRepo(actualDomainId, newDocId);
        } catch (err) {
            logger.error('migrate-node: ensureBaseGitRepo failed', err);
        }

        (this.ctx.emit as any)('base/update', sourceDocId);
        (this.ctx.emit as any)('base/update', newDocId);

        this.response.body = {
            success: true,
            newDocId,
            bid: finalBid || undefined,
        };
    }
}

/**
 * Base Expand State Handler — per-user node expand/collapse state for base editor (POST only, load via UiContext)
 */
export class BaseExpandStateHandler extends Handler {
    protected async getBase(domainId: string, docId: number): Promise<BaseDoc | null> {
        return BaseModel.get(domainId, docId);
    }

    @post('docId', Types.PositiveInt)
    @post('expandedNodeIds', Types.ArrayOf(Types.String), true)
    async post(domainId: string, docId: number, expandedNodeIds?: string[]) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const baseDocId = Number(docId);
        const base = await this.getBase(domainId, baseDocId);
        if (!base) throw new NotFoundError('Base not found');
        if (!this.user.own(base)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const coll = this.ctx.db.db.collection('base.userExpand');
        const list = Array.isArray(expandedNodeIds) ? expandedNodeIds : [];
        await coll.updateOne(
            { domainId, baseDocId, uid: this.user._id },
            { $set: { domainId, baseDocId, uid: this.user._id, expandedNodeIds: list, updateAt: new Date() } },
            { upsert: true }
        );

        (this.ctx.emit as any)('base/update', baseDocId);

        this.response.body = { success: true };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('base_domain', '/base', BaseDomainListHandler);
    ctx.Route('base_outline_branch', '/base/branch/:branch', BaseOutlineRedirectHandler);
    ctx.Route('base_create', '/base/create', BaseCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_outline_doc', '/base/:docId/outline', BaseOutlineDocHandler);
    ctx.Route('base_outline_doc_branch', '/base/:docId/outline/branch/:branch', BaseOutlineDocHandler);
    ctx.Route('base_list', '/base/list', BaseListHandler);
    ctx.Route('base_data', '/base/data', BaseDataHandler);
    ctx.Route('base_node_update', '/base/node/:nodeId', BaseNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_node', '/base/node', BaseNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_edge', '/base/edge', BaseEdgeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_save', '/base/save', BaseSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_batch_save', '/base/batch-save', BaseBatchSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_migrate_node_to_new', '/base/migrate-node-to-new', BaseMigrateNodeToNewHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_expand_state', '/base/expand-state', BaseExpandStateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card', '/base/card', BaseCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_update', '/base/card/:cardId', BaseCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_branch_create', '/base/branch', BaseBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_branch_create_with_param', '/base/branch/:branch/create', BaseBranchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_git_status', '/base/git/status', BaseGitStatusHandler);
    ctx.Route('base_commit', '/base/commit', BaseCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_commit_branch', '/base/branch/:branch/commit', BaseCommitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_github_push', '/base/github/push', BaseGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_github_push_branch', '/base/branch/:branch/github/push', BaseGithubPushHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_github_pull', '/base/github/pull', BaseGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_github_pull_branch', '/base/branch/:branch/github/pull', BaseGithubPullHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_branches', '/base/:docId/branches', BaseBranchesHandler);
    ctx.Route('base_detail', '/base/:docId', BaseDetailHandler);
    ctx.Route('base_detail_branch', '/base/:docId/branch/:branch', BaseDetailHandler);
    ctx.Route('base_study', '/base/:docId/study', BaseStudyHandler);
    ctx.Route('base_study_branch', '/base/:docId/branch/:branch/study', BaseStudyHandler);
    ctx.Route('base_edit', '/base/:docId/edit', BaseEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_list', '/base/node/:nodeId/cards', BaseCardListHandler);
    ctx.Route('base_card_list_branch', '/base/branch/:branch/node/:nodeId/cards', BaseCardListHandler);
    ctx.Route('base_card_edit', '/base/node/:nodeId/card/edit', BaseCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_edit_with_card', '/base/node/:nodeId/card/:cardId/edit', BaseCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_edit_branch', '/base/branch/:branch/node/:nodeId/card/edit', BaseCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_edit_branch_with_card', '/base/branch/:branch/node/:nodeId/card/:cardId/edit', BaseCardEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_detail', '/base/node/:nodeId/card/:cardId', BaseCardDetailHandler);
    ctx.Route('base_card_detail_branch', '/base/branch/:branch/node/:nodeId/card/:cardId', BaseCardDetailHandler);
    ctx.Route('base_card_files', '/base/:docId/card/:cardId/files', BaseCardFilesHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_card_file_download', '/base/:docId/card/:cardId/file/:filename', BaseCardFileDownloadHandler);
    ctx.Route('base_node_files', '/base/:docId/node/:nodeId/files', BaseNodeFilesHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_node_file_download', '/base/:docId/node/:nodeId/file/:filename', BaseNodeFileDownloadHandler);
    // Comment translated to English.
    ctx.Route('base_editor', '/base/:docId/editor', BaseEditorDocHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('base_editor_branch', '/base/:docId/branch/:branch/editor', BaseEditorDocHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('base_connection', '/base/ws', BaseConnectionHandler);
}

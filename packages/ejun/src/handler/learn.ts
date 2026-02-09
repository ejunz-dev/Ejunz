import type { Context } from '../context';
import { Handler, param, post, Types } from '../service/server';
import { BaseModel, CardModel } from '../model/base';
import type { BaseDoc, BaseNode, BaseEdge } from '../interface';
import domain from '../model/domain';
import learn, { type LearnDAGNode } from '../model/learn';
import user from '../model/user';
import { PERM, PRIV } from '../model/builtin';
import { BadRequestError, NotFoundError, ValidationError } from '../error';
import { MethodNotAllowedError } from '@ejunz/framework';
import { ObjectId } from 'mongodb';
import db from '../service/db';
import moment from 'moment-timezone';
import bus from '../service/bus';
import { updateDomainRanking } from './domain';

function getBranchData(base: BaseDoc, branch: string): { nodes: BaseNode[]; edges: BaseEdge[] } {
    const branchName = branch || 'main';
    
    if (base.branchData && base.branchData[branchName]) {
        return {
            nodes: base.branchData[branchName].nodes || [],
            edges: base.branchData[branchName].edges || [],
        };
    }
    
    if (branchName === 'main') {
        return {
            nodes: base.nodes || [],
            edges: base.edges || [],
        };
    }
    
    return { nodes: [], edges: [] };
}

function applyUserSectionOrder(sections: LearnDAGNode[], learnSectionOrder: string[] | undefined): LearnDAGNode[] {
    if (!learnSectionOrder || learnSectionOrder.length === 0) {
        return [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    const sectionMap = new Map<string, LearnDAGNode>();
    sections.forEach(s => sectionMap.set(String(s._id), s));
    const result: LearnDAGNode[] = [];
    for (const id of learnSectionOrder) {
        const s = sectionMap.get(String(id));
        if (s) result.push({ ...s, order: result.length });
    }
    return result;
}

function getSectionProgress(
    sections: LearnDAGNode[],
    allDagNodes: LearnDAGNode[],
    passedCardIds: Set<string>
): { pending: Array<{ _id: string; title: string; passed: number; total: number }>; completed: Array<{ _id: string; title: string; passed: number; total: number }> } {
    const nodeMap = new Map<string, LearnDAGNode>();
    sections.forEach(s => nodeMap.set(String(s._id), s));
    allDagNodes.forEach(n => nodeMap.set(String(n._id), n));

    const collectCards = (nodeId: string, collected: Set<string>): Array<{ cardId: string }> => {
        if (collected.has(nodeId)) return [];
        collected.add(nodeId);
        const node = nodeMap.get(nodeId);
        if (!node) return [];
        const cards = (node.cards || []).map((c: any) => ({ cardId: c.cardId }));
        const children = allDagNodes.filter((n: any) => n.requireNids?.length > 0 && n.requireNids[n.requireNids.length - 1] === nodeId);
        for (const child of children) {
            cards.push(...collectCards(child._id, collected));
        }
        return cards;
    };

    const pending: Array<{ _id: string; title: string; passed: number; total: number }> = [];
    const completed: Array<{ _id: string; title: string; passed: number; total: number }> = [];

    for (const section of sections) {
        const cards = collectCards(section._id, new Set());
        const total = cards.length;
        const passed = cards.filter((c: any) => passedCardIds.has(String(c.cardId))).length;
        const item = { _id: section._id, title: section.title || 'Unnamed', passed, total };
        if (total > 0 && passed >= total) {
            completed.push(item);
        } else {
            pending.push(item);
        }
    }

    return { pending, completed };
}

async function generateDAG(
    domainId: string,
    baseDocId: ObjectId,
    nodes: BaseNode[],
    edges: BaseEdge[],
    translate: (key: string) => string
): Promise<{ sections: LearnDAGNode[]; dag: LearnDAGNode[] }> {
    
    const nodeMap = new Map<string, BaseNode>();
    nodes.forEach(node => nodeMap.set(node.id, node));

    const parentMap = new Map<string, string>();
    const childrenMap = new Map<string, string[]>();
    edges.forEach(edge => {
        parentMap.set(edge.target, edge.source);
        if (!childrenMap.has(edge.source)) {
            childrenMap.set(edge.source, []);
        }
        if (!childrenMap.get(edge.source)!.includes(edge.target)) {
            childrenMap.get(edge.source)!.push(edge.target);
        }
    });
    // 补充 parentId：base 可能用 parentId 而非 edges 表示父子关系
    nodes.forEach(node => {
        const parentId = (node as any).parentId;
        if (parentId && nodeMap.has(parentId)) {
            if (!parentMap.has(node.id)) parentMap.set(node.id, parentId);
            if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
            if (!childrenMap.get(parentId)!.includes(node.id)) {
                childrenMap.get(parentId)!.push(node.id);
            }
        }
    });

    const rootNodes = nodes.filter(node => 
        node.level === 0 || !parentMap.has(node.id)
    );
    if (rootNodes.length === 0 && nodes.length > 0) {
        rootNodes.push(nodes[0]);
    }

    const sections: LearnDAGNode[] = [];
    const dagNodes: LearnDAGNode[] = [];
    let nodeIndex = 1;

    const toCardItem = (card: any) => {
        const problems = (card as any).problems || [];
        return {
            cardId: card.docId.toString(),
            title: card.title || translate('Unnamed Card'),
            order: (card as any).order || 0,
            problemCount: problems.length,
            problems: problems.map((p: any) => ({ pid: p.pid, stem: p.stem, options: p.options, answer: p.answer })),
        };
    };

    const processNode = async (nodeId: string, parentIds: string[], isFirstLevel: boolean = false) => {
        const node = nodeMap.get(nodeId);
        if (!node) {
            return;
        }

        // 每个节点只存储该节点自身的卡片，不包含子节点的卡片（避免树形渲染时重复）
        const cards = await CardModel.getByNodeId(domainId, baseDocId, nodeId);
        const cardList = cards.map(card => toCardItem(card)).sort((a, b) => (a.order || 0) - (b.order || 0));

        const dagNode: LearnDAGNode = {
            _id: nodeId,
            title: node.text || translate('Unnamed Node'),
            requireNids: parentIds,
            cards: cardList,
            order: node.order || nodeIndex++,
        };

        if (isFirstLevel) {
            sections.push(dagNode);
        } else {
            dagNodes.push(dagNode);
        }

        const childIds = childrenMap.get(nodeId) || [];
        for (const childId of childIds) {
            await processNode(childId, [...parentIds, nodeId], false);
        }
    };

    for (const rootNode of rootNodes) {
        const firstLevelChildIds = childrenMap.get(rootNode.id) || [];
        
        if (firstLevelChildIds.length > 0) {
            for (const childId of firstLevelChildIds) {
                await processNode(childId, [rootNode.id], true);
            }
        } else {
            const allOtherNodes = nodes.filter(n => n.id !== rootNode.id);
            
            if (allOtherNodes.length > 0) {
                for (const otherNode of allOtherNodes) {
                    const cards = await CardModel.getByNodeId(domainId, baseDocId, otherNode.id);
                    const cardList = cards.map(card => toCardItem(card)).sort((a, b) => (a.order || 0) - (b.order || 0));
                    
                    sections.push({
                        _id: otherNode.id,
                        title: otherNode.text || translate('Unnamed Node'),
                        requireNids: [],
                        cards: cardList,
                        order: otherNode.order || nodeIndex++,
                    });
                }
            } else {
                
                const rootCards = await CardModel.getByNodeId(domainId, baseDocId, rootNode.id);
                if (rootCards.length > 0) {
                    const rootCardList = rootCards.map(card => toCardItem(card)).sort((a, b) => (a.order || 0) - (b.order || 0));
                    
                    sections.push({
                        _id: rootNode.id,
                        title: rootNode.text || translate('Unnamed Node'),
                        requireNids: [],
                        cards: rootCardList,
                        order: rootNode.order || nodeIndex++,
                    });
                }
            }
        }
    }

    sections.sort((a, b) => (a.order || 0) - (b.order || 0));
    dagNodes.sort((a, b) => (a.order || 0) - (b.order || 0));

    return { sections, dag: dagNodes };
}

interface BaseNodeWithCards {
    id: string;
    text: string;
    level?: number;
    order?: number;
    cards: Array<{
        id: string;
        title: string;
        cardId: string;
        cardDocId: string;
        order?: number;
    }>;
    children?: BaseNodeWithCards[];
}

class LearnHandler extends Handler {
    async after(domainId: string) {
        if (this.request.json || !this.response.template) return;
        
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: this.translate('Home'),
                checker: () => true,
            },
            {
                name: 'user_task',
                args: { uid: this.user._id },
                displayName: this.translate('My Task'),
                checker: () => true,
            },
            {
                name: 'learn_sections',
                args: {},
                displayName: this.translate('Sections'),
                checker: () => true,
            },
        ];
    }

    async post(domainId: string) {
        if (this.request.path.includes('/daily-goal')) {
            return this.postSetDailyGoal(domainId);
        }
    }

    async postSetDailyGoal(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body: any = this.request?.body || {};
        const dailyGoal = parseInt(body.dailyGoal || '0', 10);
        
        if (isNaN(dailyGoal) || dailyGoal < 0) {
            throw new ValidationError('Invalid daily goal');
        }
        
        await learn.setUserLearnState(finalDomainId, this.user._id, { dailyGoal });
        
        this.response.body = { success: true, dailyGoal };
    }

    @param('sectionId', Types.String, true)
    async get(domainId: string, sectionId?: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        let base = await BaseModel.getByDomain(finalDomainId);
        
        if (!base) {
            this.response.template = 'learn.html';
            this.response.body = {
                dag: [],
                domainId: finalDomainId,
                baseDocId: null,
            };
            return;
        }

        
        const initialNodes = base.nodes?.length || 0;
        const initialEdges = base.edges?.length || 0;
        const branchDataNodes = base.branchData?.['main']?.nodes?.length || 0;
        const branchDataEdges = base.branchData?.['main']?.edges?.length || 0;
        
        if ((initialNodes <= 1 && initialEdges === 0 && branchDataNodes <= 1 && branchDataEdges === 0)) {
            const reloadedBase = await BaseModel.get(finalDomainId, base.docId);
            if (reloadedBase) {
                base = reloadedBase;
            }
        }

        const dbBase = await this.ctx.db.db.collection('document').findOne({
            domainId: finalDomainId,
            docType: 70,
            docId: base.docId,
        });
        if (dbBase) {
            const dbNodes = dbBase.branchData?.['main']?.nodes || dbBase.nodes || [];
            const dbEdges = dbBase.branchData?.['main']?.edges || dbBase.edges || [];
            if (dbNodes.length > (base.nodes?.length || 0) || dbEdges.length > (base.edges?.length || 0)) {
                base.nodes = dbNodes;
                base.edges = dbEdges;
                if (dbBase.branchData) {
                    base.branchData = dbBase.branchData;
                }
            }
        }
        
        const branch = 'main';
        const branchData = getBranchData(base, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        if (nodes.length === 0) {
            this.response.template = 'learn.html';
            this.response.body = {
                dag: [],
                sections: [],
                domainId: finalDomainId,
                baseDocId: base.docId.toString() || null,
                pendingSections: [],
                completedSections: [],
            };
            return;
        }

        
        const existingDAG = await learn.getDAG(finalDomainId, base.docId, branch);

        const baseVersion = base.updateAt ? base.updateAt.getTime() : 0;
        const needsUpdate = !existingDAG || (existingDAG.version || 0) < baseVersion;
        
        const hasEmptySections = existingDAG && (!existingDAG.sections || existingDAG.sections.length === 0);
        const cachedNodesCount = existingDAG ? ((existingDAG.dag?.length || 0) + (existingDAG.sections?.length || 0)) : 0;
        const shouldRegenerate = needsUpdate || !existingDAG || hasEmptySections || (nodes.length > 0 && cachedNodesCount === 0);

        let sections: LearnDAGNode[] = [];
        let allDagNodes: LearnDAGNode[] = [];

        if (shouldRegenerate) {
            const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (key: string) => this.translate(key));
            sections = result.sections;
            allDagNodes = result.dag;
            
            await learn.setDAG(finalDomainId, base.docId, branch, {
                sections,
                dag: allDagNodes,
                version: baseVersion,
                updateAt: new Date(),
            });
        } else {
            sections = existingDAG.sections || [];
            allDagNodes = existingDAG.dag || [];
        }

        const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const savedSectionIndex = (dudoc as any)?.currentLearnSectionIndex;
        const savedSectionId = (dudoc as any)?.currentLearnSectionId;
        const dailyGoal = (dudoc as any)?.dailyGoal || 0;
        const learnSectionOrder = (dudoc as any)?.learnSectionOrder;
        const savedLearnProgressPosition = (dudoc as any)?.learnProgressPosition;
        const savedLearnProgressTotal = (dudoc as any)?.learnProgressTotal;
        sections = applyUserSectionOrder(sections, learnSectionOrder);
        
        let finalSectionId: string | null = null;
        let currentSectionIndex: number = 0;
        const totalSectionsForProgress = sections.length;
        if (sectionId) {
            const idx = sections.findIndex(s => s._id === sectionId);
            finalSectionId = sectionId;
            currentSectionIndex = idx >= 0 ? idx : 0;
            // 第一个=0/4，最后一个=3/4：已完成数 = currentSectionIndex
            await learn.setUserLearnState(finalDomainId, this.user._id, {
                currentLearnSectionId: sectionId,
                currentLearnSectionIndex: currentSectionIndex,
                learnProgressPosition: Math.max(0, currentSectionIndex),
                learnProgressTotal: totalSectionsForProgress,
            });
        } else if (typeof savedSectionIndex === 'number' && savedSectionIndex >= 0 && savedSectionIndex < sections.length) {
            finalSectionId = sections[savedSectionIndex]._id;
            currentSectionIndex = savedSectionIndex;
        } else if (savedSectionId && sections.find(s => s._id === savedSectionId)) {
            const idx = sections.findIndex(s => s._id === savedSectionId);
            finalSectionId = savedSectionId;
            currentSectionIndex = idx >= 0 ? idx : 0;
            await learn.setUserLearnState(finalDomainId, this.user._id, {
                currentLearnSectionIndex: currentSectionIndex,
                learnProgressPosition: Math.max(0, currentSectionIndex),
                learnProgressTotal: totalSectionsForProgress,
            });
        } else if (sections.length > 0) {
            finalSectionId = sections[0]._id;
            currentSectionIndex = 0;
            await learn.setUserLearnState(finalDomainId, this.user._id, {
                currentLearnSectionId: finalSectionId,
                currentLearnSectionIndex: 0,
                learnProgressPosition: 0,
                learnProgressTotal: totalSectionsForProgress,
            });
        }

        let dag: LearnDAGNode[] = [];
        if (finalSectionId) {
            const collectChildren = (parentId: string, collected: Set<string>) => {
                if (collected.has(parentId)) return;
                collected.add(parentId);
                
                const children = allDagNodes.filter(node => {
                    if (collected.has(node._id)) return false;
                    
                    const isDirectChild = node.requireNids.length > 0 && 
                                        node.requireNids[node.requireNids.length - 1] === parentId;
                    return isDirectChild;
                });
                
                
                for (const child of children) {
                    if (!collected.has(child._id)) {
                        dag.push(child);
                        collectChildren(child._id, collected);
                    }
                }
            };
            
            const collected = new Set<string>();
            collectChildren(finalSectionId, collected);
        } else if (sections.length > 0) {
            const firstSection = sections[0];
            
            const collectChildren = (parentId: string, collected: Set<string>) => {
                if (collected.has(parentId)) return;
                collected.add(parentId);
                
                const children = allDagNodes.filter(node => {
                    if (collected.has(node._id)) return false;
                    return node.requireNids.length > 0 && 
                           node.requireNids[node.requireNids.length - 1] === parentId;
                });
                
                for (const child of children) {
                    if (!collected.has(child._id)) {
                        dag.push(child);
                        collectChildren(child._id, collected);
                    }
                }
            };
            
            const collected = new Set<string>();
            collectChildren(firstSection._id, collected);
        }

        const passedCardIds = await learn.getPassedCardIds(finalDomainId, this.user._id);

        const flatCards: Array<{ nodeId: string; cardId: string; order: number; nodeIndex: number; cardIndex: number }> = [];
        dag.forEach((node, nodeIndex) => {
            (node.cards || []).forEach((card, cardIndex) => {
                flatCards.push({
                    nodeId: node._id,
                    cardId: card.cardId,
                    order: card.order || 0,
                    nodeIndex: nodeIndex,
                    cardIndex: cardIndex,
                });
            });
        });

        const totalCards = flatCards.length;

        // 总进度 = 已完成节数/总节数，仅用数据库 learnProgressPosition / learnProgressTotal
        const totalSections = sections.length;
        const currentProgress = typeof savedLearnProgressPosition === 'number' && typeof savedLearnProgressTotal === 'number' && savedLearnProgressTotal > 0
            ? Math.max(0, Math.min(savedLearnProgressPosition, savedLearnProgressTotal))
            : 0;
        const totalProgress = typeof savedLearnProgressTotal === 'number' && savedLearnProgressTotal > 0 ? savedLearnProgressTotal : 0;

        const { pending: pendingSections, completed: completedSections } = getSectionProgress(sections, allDagNodes, passedCardIds);

        const allResults = await learn.getResults(finalDomainId, this.user._id);

        const practiceDates = new Set<string>();
        const todayStart = moment.utc().startOf('day').toDate();
        const todayEnd = moment.utc().add(1, 'day').startOf('day').toDate();
        let todayCompletedCount = 0;
        for (const result of allResults) {
            if (result.createdAt) {
                const date = moment.utc(result.createdAt).format('YYYY-MM-DD');
                practiceDates.add(date);
                if (result.createdAt >= todayStart && result.createdAt < todayEnd) {
                    todayCompletedCount++;
                }
            }
        }

        const totalCheckinDays = practiceDates.size;

        let consecutiveDays = 0;
        const today = moment.utc();
        let checkDate = moment.utc(today);
        
        while (true) {
            const dateStr = checkDate.format('YYYY-MM-DD');
            if (practiceDates.has(dateStr)) {
                consecutiveDays++;
                checkDate = checkDate.subtract(1, 'day');
            } else {
                break;
            }
        }

        const dagWithProgress = dag.map((node, nodeIndex) => ({
            ...node,
            cards: (node.cards || []).map((card, cardIndex) => {
                const cardPassed = passedCardIds.has(card.cardId);
                const currentCardGlobalIndex = flatCards.findIndex(c => 
                    c.nodeIndex === nodeIndex && c.cardIndex === cardIndex
                );
                
                let isUnlocked = false;
                if (currentCardGlobalIndex === 0) {
                    isUnlocked = true;
                } else if (currentCardGlobalIndex > 0) {
                    const prevCard = flatCards[currentCardGlobalIndex - 1];
                    isUnlocked = passedCardIds.has(prevCard.cardId);
                }
                
                return {
                    ...card,
                    passed: cardPassed,
                    unlocked: isUnlocked,
                };
            }),
        }));

        let nextCard: { nodeId: string; cardId: string } | null = null;
        for (let i = 0; i < flatCards.length; i++) {
            if (!passedCardIds.has(flatCards[i].cardId)) {
                nextCard = { nodeId: flatCards[i].nodeId, cardId: flatCards[i].cardId };
                break;
            }
        }

        // 仅在非第一节时自动进入下一节，否则第一节无卡片时会从 0/4 被写成 1/4
        if (!nextCard && sections.length > 0 && currentSectionIndex > 0 && currentSectionIndex + 1 < sections.length) {
            const nextIndex = currentSectionIndex + 1;
            const nextSectionId = sections[nextIndex]._id;
            await learn.setUserLearnState(finalDomainId, this.user._id, {
                currentLearnSectionIndex: nextIndex,
                currentLearnSectionId: nextSectionId,
                learnProgressPosition: Math.max(0, nextIndex),
                learnProgressTotal: totalSections,
            });
            this.response.redirect = this.url('learn', { domainId: finalDomainId });
            return;
        }

        this.response.template = 'learn.html';
        this.response.body = {
            dag: dagWithProgress,
            sections: sections,
            currentSectionId: finalSectionId,
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
            currentProgress,
            totalProgress,
            totalCards,
            totalCheckinDays,
            consecutiveDays,
            dailyGoal,
            todayCompletedCount,
            pendingSections,
            completedSections,
            nextCard,
        };
    }

}

class LearnEditHandler extends Handler {
    async after(domainId: string) {
        if (this.request.json || !this.response.template) return;
        
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: this.translate('Home'),
                checker: () => true,
            },
            {
                name: 'learn',
                args: {},
                displayName: this.translate('Learn'),
                checker: () => true,
            },
            {
                name: 'learn_sections',
                args: {},
                displayName: this.translate('Sections'),
                checker: () => true,
            },
        ];
    }

    async get(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const base = await BaseModel.getByDomain(finalDomainId);
        
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }

        const branches = Array.isArray((base as any)?.branches) 
            ? (base as any).branches 
            : ['main'];
        if (!branches.includes('main')) {
            branches.unshift('main');
        }

        const dudoc = await domain.getDomainUser(domainId, { _id: this.user._id, priv: this.user.priv });
        const currentBranch = (dudoc as any)?.learnBranch || (base as any)?.currentBranch || 'main';

        this.response.template = 'learn_edit.html';
        this.response.body = {
            domainId,
            branches,
            currentBranch,
            baseTitle: base.title,
        };
    }

    @post('branch', Types.String)
    async postSetBranch(domainId: string, branch: string) {
        const base = await BaseModel.getByDomain(domainId);
        
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }

        const branches = Array.isArray((base as any)?.branches) 
            ? (base as any).branches 
            : ['main'];
        if (!branches.includes('main')) {
            branches.unshift('main');
        }

        if (!branches.includes(branch)) {
            throw new ValidationError('Invalid branch');
        }

        await learn.setUserLearnState(domainId, this.user._id, { learnBranch: branch });
        this.back();
    }
}

class LessonHandler extends Handler {
    async after(domainId: string) {
        if (this.request.json || !this.response.template) return;
        
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: this.translate('Home'),
                checker: () => true,
            },
            {
                name: 'learn',
                args: {},
                displayName: this.translate('Learn'),
                checker: () => true,
            },
        ];
    }

    async post(domainId: string) {
        if (this.request.path.endsWith('/pass')) {
            return this.postPass(domainId);
        }
        throw new MethodNotAllowedError('POST');
    }

    @param('resultId', Types.ObjectId, true)
    async get(domainId: string, resultId?: ObjectId) {
        if (resultId) {
            return this.getResult(domainId, resultId);
        }
        
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const base = await BaseModel.getByDomain(finalDomainId);
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }

        const queryCardId = this.request.query?.cardId;
        if (queryCardId) {
            let cardId: ObjectId;
            try {
                cardId = new ObjectId(queryCardId as string);
            } catch {
                throw new ValidationError('Invalid cardId');
            }

            const card = await CardModel.get(finalDomainId, cardId);
            if (!card) {
                throw new NotFoundError('Card not found');
            }

            if (!card.problems || card.problems.length === 0) {
                throw new NotFoundError('Card has no practice questions');
            }

            const node = (getBranchData(base, 'main').nodes || []).find(n => n.id === card.nodeId);
            if (!node) {
                throw new NotFoundError('Node not found');
            }

            const cards = await CardModel.getByNodeId(finalDomainId, base.docId, card.nodeId);
            const currentIndex = cards.findIndex(c => c.docId.toString() === cardId.toString());

            this.response.template = 'lesson.html';
            this.response.body = {
                card,
                node,
                cards,
                currentIndex: currentIndex >= 0 ? currentIndex : 0,
                domainId: finalDomainId,
                baseDocId: base.docId.toString(),
                isAlonePractice: true,
            };
            return;
        }

        const branch = 'main';
        const branchData = getBranchData(base, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        if (nodes.length === 0) {
            throw new NotFoundError('No nodes available');
        }

        const existingDAG = await learn.getDAG(finalDomainId, base.docId, branch);

        const baseVersion = base.updateAt ? base.updateAt.getTime() : 0;
        const needsUpdate = !existingDAG || (existingDAG.version || 0) < baseVersion;
        const hasEmptySections = existingDAG && (!existingDAG.sections || existingDAG.sections.length === 0);
        const cachedNodesCount = existingDAG ? ((existingDAG.dag?.length || 0) + (existingDAG.sections?.length || 0)) : 0;
        const shouldRegenerate = needsUpdate || !existingDAG || hasEmptySections || (nodes.length > 0 && cachedNodesCount === 0);

        let sections: LearnDAGNode[] = [];
        let allDagNodes: LearnDAGNode[] = [];

        if (shouldRegenerate) {
            const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (key: string) => this.translate(key));
            sections = result.sections;
            allDagNodes = result.dag;
            
            await learn.setDAG(finalDomainId, base.docId, branch, {
                sections,
                dag: allDagNodes,
                version: baseVersion,
                updateAt: new Date(),
            });
        } else {
            sections = existingDAG.sections || [];
            allDagNodes = existingDAG.dag || [];
        }

        const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const savedSectionIndex = (dudoc as any)?.currentLearnSectionIndex;
        const savedSectionId = (dudoc as any)?.currentLearnSectionId;
        const learnSectionOrder = (dudoc as any)?.learnSectionOrder;
        sections = applyUserSectionOrder(sections, learnSectionOrder);
        
        let finalSectionId: string | null = null;
        let currentSectionIndex = 0;
        if (typeof savedSectionIndex === 'number' && savedSectionIndex >= 0 && savedSectionIndex < sections.length) {
            finalSectionId = sections[savedSectionIndex]._id;
            currentSectionIndex = savedSectionIndex;
        } else if (savedSectionId && sections.find(s => s._id === savedSectionId)) {
            const idx = sections.findIndex(s => s._id === savedSectionId);
            finalSectionId = savedSectionId;
            currentSectionIndex = idx >= 0 ? idx : 0;
            await learn.setUserLearnState(finalDomainId, this.user._id, { currentLearnSectionIndex: currentSectionIndex });
        } else if (sections.length > 0) {
            finalSectionId = sections[0]._id;
            currentSectionIndex = 0;
            await learn.setUserLearnState(finalDomainId, this.user._id, { currentLearnSectionId: finalSectionId, currentLearnSectionIndex: 0 });
        }

        let dag: LearnDAGNode[] = [];
        if (finalSectionId) {
            const collectChildren = (parentId: string, collected: Set<string>) => {
                if (collected.has(parentId)) return;
                collected.add(parentId);
                
                const children = allDagNodes.filter(node => {
                    if (collected.has(node._id)) return false;
                    const isDirectChild = node.requireNids.length > 0 && 
                                        node.requireNids[node.requireNids.length - 1] === parentId;
                    return isDirectChild;
                });
                
                for (const child of children) {
                    if (!collected.has(child._id)) {
                        dag.push(child);
                        collectChildren(child._id, collected);
                    }
                }
            };
            
            const collected = new Set<string>();
            collectChildren(finalSectionId, collected);
        }

        const passedCardIds = await learn.getPassedCardIds(finalDomainId, this.user._id);

        const flatCards: Array<{ nodeId: string; cardId: string; order: number; nodeIndex: number; cardIndex: number }> = [];
        dag.forEach((node, nodeIndex) => {
            (node.cards || []).forEach((card, cardIndex) => {
                flatCards.push({
                    nodeId: node._id,
                    cardId: card.cardId,
                    order: card.order || 0,
                    nodeIndex: nodeIndex,
                    cardIndex: cardIndex,
                });
            });
        });

        let nextCard: { nodeId: string; cardId: string } | null = null;
        for (let i = 0; i < flatCards.length; i++) {
            if (!passedCardIds.has(flatCards[i].cardId)) {
                const candidateCard = await CardModel.get(finalDomainId, new ObjectId(flatCards[i].cardId));
                if (candidateCard && candidateCard.problems && candidateCard.problems.length > 0) {
                    nextCard = flatCards[i];
                    break;
                }
            }
        }

        if (!nextCard) {
            if (sections.length > 0 && currentSectionIndex > 0 && currentSectionIndex + 1 < sections.length) {
                const nextIndex = currentSectionIndex + 1;
                const nextSectionId = sections[nextIndex]._id;
                await learn.setUserLearnState(finalDomainId, this.user._id, { currentLearnSectionIndex: nextIndex, currentLearnSectionId: nextSectionId });
                this.response.redirect = this.url('learn', { domainId: finalDomainId });
                return;
            }
            this.response.redirect = this.url('learn', { domainId: finalDomainId });
            return;
        }

        const card = await CardModel.get(finalDomainId, new ObjectId(nextCard.cardId));
        if (!card) {
            throw new NotFoundError('Card not found');
        }

        const node = (getBranchData(base, 'main').nodes || []).find(n => n.id === nextCard!.nodeId);
        if (!node) {
            throw new NotFoundError('Node not found');
        }

        const cards = await CardModel.getByNodeId(finalDomainId, base.docId, nextCard.nodeId);
        const currentIndex = cards.findIndex(c => c.docId.toString() === nextCard!.cardId);

        this.response.template = 'lesson.html';
        this.response.body = {
            card,
            node,
            cards,
            currentIndex: currentIndex >= 0 ? currentIndex : 0,
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
        };
    }

    async postPass(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body: any = this.request?.body || {};
        const answerHistory = body.answerHistory || [];
        const totalTime = body.totalTime || 0;
        const isAlonePractice = body.isAlonePractice || false;
        const cardIdFromBody = body.cardId;
        
        const base = await BaseModel.getByDomain(finalDomainId);
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }

        const branch = 'main';
        const branchData = getBranchData(base, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        if (nodes.length === 0) {
            throw new NotFoundError('No nodes available');
        }

        const existingDAG = await learn.getDAG(finalDomainId, base.docId, branch);

        const baseVersion = base.updateAt ? base.updateAt.getTime() : 0;
        const needsUpdate = !existingDAG || (existingDAG.version || 0) < baseVersion;
        const hasEmptySections = existingDAG && (!existingDAG.sections || existingDAG.sections.length === 0);
        const cachedNodesCount = existingDAG ? ((existingDAG.dag?.length || 0) + (existingDAG.sections?.length || 0)) : 0;
        const shouldRegenerate = needsUpdate || !existingDAG || hasEmptySections || (nodes.length > 0 && cachedNodesCount === 0);

        let sections: LearnDAGNode[] = [];
        let allDagNodes: LearnDAGNode[] = [];

        if (shouldRegenerate) {
            const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (key: string) => this.translate(key));
            sections = result.sections;
            allDagNodes = result.dag;
            
            await learn.setDAG(finalDomainId, base.docId, branch, {
                sections,
                dag: allDagNodes,
                version: baseVersion,
                updateAt: new Date(),
            });
        } else {
            sections = existingDAG.sections || [];
            allDagNodes = existingDAG.dag || [];
        }

        const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const savedSectionId = (dudoc as any)?.currentLearnSectionId;
        
        let finalSectionId: string | null = null;
        if (savedSectionId && sections.find(s => s._id === savedSectionId)) {
            finalSectionId = savedSectionId;
        } else if (sections.length > 0) {
            finalSectionId = sections[0]._id;
        }

        let dag: LearnDAGNode[] = [];
        if (finalSectionId) {
            const collectChildren = (parentId: string, collected: Set<string>) => {
                if (collected.has(parentId)) return;
                collected.add(parentId);
                
                const children = allDagNodes.filter(node => {
                    if (collected.has(node._id)) return false;
                    const isDirectChild = node.requireNids.length > 0 && 
                                        node.requireNids[node.requireNids.length - 1] === parentId;
                    return isDirectChild;
                });
                
                for (const child of children) {
                    if (!collected.has(child._id)) {
                        dag.push(child);
                        collectChildren(child._id, collected);
                    }
                }
            };
            
            const collected = new Set<string>();
            collectChildren(finalSectionId, collected);
        }

        const passedCardIds = await learn.getPassedCardIds(finalDomainId, this.user._id);

        const flatCards: Array<{ nodeId: string; cardId: string; order: number }> = [];
        for (const node of dag) {
            for (const card of node.cards || []) {
                flatCards.push({
                    nodeId: node._id,
                    cardId: card.cardId,
                    order: card.order || 0,
                });
            }
        }
        flatCards.sort((a, b) => a.order - b.order);

        let currentCard: { nodeId: string; cardId: string } | null = null;
        let currentCardId: ObjectId | null = null;
        let currentCardNodeId: string | null = null;

        if (isAlonePractice) {
            const cardIdStr = cardIdFromBody || this.request.query?.cardId;
            if (cardIdStr) {
                try {
                    currentCardId = new ObjectId(cardIdStr as string);
                    const card = await CardModel.get(finalDomainId, currentCardId);
                    if (!card) {
                        throw new NotFoundError('Card not found');
                    }
                    currentCardNodeId = card.nodeId;
                } catch {
                    throw new ValidationError('Invalid cardId');
                }
            } else {
                throw new ValidationError('cardId is required for alone practice');
            }
        } else {
            for (let i = 0; i < flatCards.length; i++) {
                if (!passedCardIds.has(flatCards[i].cardId)) {
                    currentCard = flatCards[i];
                    break;
                }
            }

            if (!currentCard) {
                throw new NotFoundError('No available card to practice');
            }

            currentCardId = new ObjectId(currentCard.cardId);
            currentCardNodeId = currentCard.nodeId;
        }

        const card = await CardModel.get(finalDomainId, currentCardId);
        if (!card) {
            throw new NotFoundError('Card not found');
        }

        if (!isAlonePractice && currentCardNodeId) {
            await learn.setCardPassed(finalDomainId, this.user._id, currentCardId, currentCardNodeId);
        }

        const node = (getBranchData(base, 'main').nodes || []).find(n => n.id === currentCardNodeId);
        const cards = await CardModel.getByNodeId(finalDomainId, base.docId, currentCardNodeId);
        const cardIndex = cards.findIndex(c => c.docId.toString() === currentCardId.toString());
        const currentCardDoc = cards[cardIndex];

        const resultData = {
            card: currentCardDoc,
            node: node,
            answerHistory: answerHistory,
            totalTime: totalTime,
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
        };

        const score = answerHistory.length * 5;
        const resultId = await learn.addResult(finalDomainId, this.user._id, {
            cardId: currentCardId,
            nodeId: currentCardNodeId,
            answerHistory,
            totalTime,
            score,
            createdAt: new Date(),
        });

        await bus.parallel('learn_result/add', finalDomainId);

        const today = moment.utc().format('YYYY-MM-DD');
        let problemCount = 0;
        for (const history of answerHistory) {
            if (history.problemId) problemCount++;
        }
        const timeToAdd = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
        await learn.incConsumptionStats(finalDomainId, this.user._id, today, {
            nodes: currentCardNodeId ? 1 : 0,
            cards: 1,
            problems: problemCount,
            practices: 1,
            ...(timeToAdd > 0 ? { totalTime: timeToAdd } : {}),
        });

        this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson/result/${resultId}` };
    }

    async getResult(domainId: string, resultId: ObjectId) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const result = await learn.getResultById(finalDomainId, this.user._id, resultId);

        if (!result) {
            throw new NotFoundError('Result not found');
        }

        const base = await BaseModel.getByDomain(finalDomainId);
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }

        const node = (getBranchData(base, 'main').nodes || []).find(n => n.id === result.nodeId);
        if (!node) {
            throw new NotFoundError('Node not found');
        }

        const card = await CardModel.get(finalDomainId, result.cardId);
        if (!card) {
            throw new NotFoundError('Card not found');
        }

        const allProblems = (card.problems || []).map((p, idx) => ({
            ...p,
            index: idx,
        }));

        const problemStats = allProblems.map(problem => {
            const history = result.answerHistory.filter((h: any) => h.problemId === problem.pid);
            const correctHistory = history.filter((h: any) => h.correct);
            const totalTime = history.reduce((sum: number, h: any) => sum + (h.timeSpent || 0), 0);
            const attempts = history.length > 0 ? Math.max(...history.map((h: any) => h.attempts || 1)) : 0;
            
            return {
                problem,
                totalTime,
                attempts,
                correct: correctHistory.length > 0,
            };
        });

        this.response.template = 'lesson_result.html';
        this.response.body = {
            card,
            node,
            problemStats,
            totalTime: result.totalTime,
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
        };
    }
}

class LearnSectionEditHandler extends Handler {
    async after(domainId: string) {
        if (this.request.json || !this.response.template) return;
        
        const uidParam = this.request.query?.uid;
        const uid = uidParam ? parseInt(String(uidParam), 10) : this.user._id;
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: this.translate('Home'),
                checker: () => true,
            },
            {
                name: 'learn',
                args: {},
                displayName: this.translate('Learn'),
                checker: () => true,
            },
            {
                name: 'learn_sections',
                args: {},
                displayName: this.translate('Sections'),
                checker: () => true,
            },
            {
                name: 'learn_section_edit',
                args: { query: { uid: String(uid) } },
                displayName: this.translate('Section Order'),
                checker: () => true,
            },
        ];
    }

    async post(domainId: string) {
        return this.postSaveOrder(domainId);
    }

    async resolveTargetUid(domainId: string): Promise<number> {
        const uidParam = this.request.query?.uid || this.request.body?.uid;
        let targetUid = uidParam ? parseInt(String(uidParam), 10) : this.user._id;
        if (Number.isNaN(targetUid)) targetUid = this.user._id;
        if (targetUid !== this.user._id) {
            this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        }
        const udoc = await user.getById(domainId, targetUid);
        if (!udoc) throw new NotFoundError('User not found');
        return targetUid;
    }

    async postSaveOrder(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const targetUid = await this.resolveTargetUid(finalDomainId);
        const body: any = this.request?.body || {};
        const sectionOrder: string[] = Array.isArray(body.sectionOrder) ? body.sectionOrder : [];
        const rawIndex = body.currentLearnSectionIndex;
        const currentLearnSectionIndex = typeof rawIndex === 'number' ? rawIndex : parseInt(String(rawIndex), 10);

        const base = await BaseModel.getByDomain(finalDomainId);
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }

        const existingDAG = await learn.getDAG(finalDomainId, base.docId, 'main');

        if (!existingDAG || !existingDAG.sections || existingDAG.sections.length === 0) {
            throw new NotFoundError('No sections to reorder');
        }

        const totalSections = sectionOrder.length;
        let indexToUse = Number.isNaN(currentLearnSectionIndex) || currentLearnSectionIndex < 0 || currentLearnSectionIndex >= totalSections
            ? null
            : currentLearnSectionIndex;
        if (indexToUse === null) {
            const dudoc = await domain.getDomainUser(finalDomainId, { _id: targetUid, priv: this.user.priv });
            const saved = (dudoc as any)?.currentLearnSectionIndex;
            if (typeof saved === 'number' && saved >= 0 && saved < totalSections) indexToUse = saved;
            else indexToUse = 0;
        }
        const currentLearnSectionIndexFinal = indexToUse;

        // 前端 sectionOrder：[0]=先学，[i]=第 i+1 个，故已完成数 = currentLearnSectionIndex
        const learnProgressPosition = Math.max(0, Math.min(currentLearnSectionIndexFinal, totalSections));
        const learnProgressTotal = totalSections;

        const update = {
            learnSectionOrder: sectionOrder,
            currentLearnSectionIndex: currentLearnSectionIndexFinal,
            currentLearnSectionId: sectionOrder[currentLearnSectionIndexFinal],
            learnProgressPosition,
            learnProgressTotal,
        };
        await learn.setUserLearnState(finalDomainId, targetUid, update);

        this.response.body = { success: true, sectionOrder, currentLearnSectionIndex: currentLearnSectionIndexFinal };
    }

    async get(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const targetUid = await this.resolveTargetUid(finalDomainId);
        const base = await BaseModel.getByDomain(finalDomainId);
        
        if (!base) {
            this.response.template = 'learn_section_edit.html';
            this.response.body = {
                sections: [],
                allSections: [],
                dag: [],
                domainId: finalDomainId,
                baseDocId: null,
                targetUid,
                targetUser: null,
            };
            return;
        }

        const branch = 'main';
        const existingDAG = await learn.getDAG(finalDomainId, base.docId, branch);

        const allSections: LearnDAGNode[] = [];
        const dag: LearnDAGNode[] = [];
        if (existingDAG) {
            if (existingDAG.sections && existingDAG.sections.length > 0) {
                allSections.push(...[...existingDAG.sections].sort((a, b) => (a.order || 0) - (b.order || 0)));
            }
            if (existingDAG.dag && existingDAG.dag.length > 0) {
                dag.push(...[...existingDAG.dag].sort((a, b) => (a.order || 0) - (b.order || 0)));
            }
        }

        const dudoc = await domain.getDomainUser(finalDomainId, { _id: targetUid, priv: this.user.priv });
        const learnSectionOrder = (dudoc as any)?.learnSectionOrder;
        const sections = applyUserSectionOrder(allSections.length ? [...allSections] : [], learnSectionOrder);
        const currentLearnSectionIndex = (dudoc as any)?.currentLearnSectionIndex;
        const currentLearnSectionId = (dudoc as any)?.currentLearnSectionId;

        const udoc = await user.getById(finalDomainId, targetUid);

        this.response.template = 'learn_section_edit.html';
        this.response.body = {
            sections,
            allSections,
            dag,
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
            targetUid,
            targetUser: udoc ? { uname: udoc.uname, _id: udoc._id } : null,
            currentLearnSectionIndex: typeof currentLearnSectionIndex === 'number' ? currentLearnSectionIndex : null,
            currentLearnSectionId: currentLearnSectionId || null,
        };
    }
}

class LearnSectionsHandler extends Handler {
    async after(domainId: string) {
        if (this.request.json || !this.response.template) return;
        
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: this.translate('Home'),
                checker: () => true,
            },
            {
                name: 'learn',
                args: {},
                displayName: this.translate('Learn'),
                checker: () => true,
            },
            {
                name: 'learn_sections',
                args: {},
                displayName: this.translate('Sections'),
                checker: () => true,
            },
            {
                name: 'learn_section_edit',
                args: {},
                displayName: this.translate('Section Order'),
                checker: () => true,
            },
        ];
    }

    async get(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const base = await BaseModel.getByDomain(finalDomainId);
        
        if (!base) {
            this.response.template = 'learn_sections.html';
            this.response.body = {
                sections: [],
                domainId: finalDomainId,
                baseDocId: null,
            };
            return;
        }

        const branch = 'main';
        const branchData = getBranchData(base, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        if (nodes.length === 0) {
            this.response.template = 'learn_sections.html';
            this.response.body = {
                sections: [],
                dag: [],
                domainId: finalDomainId,
                baseDocId: base.docId.toString() || null,
                currentSectionId: null,
                currentLearnSectionIndex: null,
            };
            return;
        }

        
        const existingDAG = await learn.getDAG(finalDomainId, base.docId, branch);

        const baseVersion = base.updateAt ? base.updateAt.getTime() : 0;
        const DAG_SCHEMA_VERSION = 2; // 增量：每个节点只存自身卡片，不聚合子节点
        const needsUpdate = !existingDAG || (existingDAG.version || 0) < baseVersion;
        const needsSchemaUpdate = existingDAG && ((existingDAG as any).dagSchemaVersion || 0) < DAG_SCHEMA_VERSION;
        
        const hasSectionsWithoutCards = existingDAG && existingDAG.sections && 
            existingDAG.sections.some((s: any) => !s.cards || s.cards.length === 0);

        // 检查缓存中的卡片是否缺少 problemCount（旧格式），需要重新生成以包含题目数据
        const hasCardsWithoutProblemCount = existingDAG && (
            (existingDAG.sections || []).some((s: any) =>
                (s.cards || []).some((c: any) => c.problemCount === undefined && c.problems === undefined)
            ) ||
            (existingDAG.dag || []).some((n: any) =>
                (n.cards || []).some((c: any) => c.problemCount === undefined && c.problems === undefined)
            )
        );

        let sections: LearnDAGNode[] = [];
        let dag: LearnDAGNode[] = [];

        if (needsUpdate || !existingDAG || hasSectionsWithoutCards || hasCardsWithoutProblemCount || needsSchemaUpdate) {
            const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (key: string) => this.translate(key));
            sections = result.sections;
            dag = result.dag;

            await learn.setDAG(finalDomainId, base.docId, branch, {
                sections,
                dag: result.dag,
                version: baseVersion,
                updateAt: new Date(),
            }, { dagSchemaVersion: DAG_SCHEMA_VERSION });
        } else {
            sections = existingDAG.sections || [];
            dag = existingDAG.dag || [];
        }

        const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const currentLearnSectionIndex = (dudoc as any)?.currentLearnSectionIndex;
        const currentSectionId = (dudoc as any)?.currentLearnSectionId || null;
        const learnSectionOrder = (dudoc as any)?.learnSectionOrder;
        sections = applyUserSectionOrder(sections, learnSectionOrder);

        sections = sections.map(section => ({
            ...section,
            cards: section.cards || [],
        }));

        this.response.template = 'learn_sections.html';
        this.response.body = {
            sections: sections,
            dag: dag,
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
            currentSectionId: currentSectionId,
            currentLearnSectionIndex: typeof currentLearnSectionIndex === 'number' && currentLearnSectionIndex >= 0 && currentLearnSectionIndex < sections.length ? currentLearnSectionIndex : null,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('learn', '/learn', LearnHandler);
    ctx.Route('learn_set_daily_goal', '/learn/daily-goal', LearnHandler);
    ctx.Route('learn_sections', '/learn/sections', LearnSectionsHandler);
    ctx.Route('learn_section_edit', '/learn/section/edit', LearnSectionEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_edit', '/learn/edit', LearnEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_lesson', '/learn/lesson', LessonHandler);
    ctx.Route('learn_lesson_pass', '/learn/lesson/pass', LessonHandler);
}

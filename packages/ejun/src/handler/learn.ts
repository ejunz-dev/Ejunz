import type { Context } from '../context';
import { Handler, param, post, Types } from '../service/server';
import { BaseModel, CardModel } from '../model/base';
import type { BaseDoc, BaseNode, BaseEdge } from '../interface';
import domain from '../model/domain';
import { PRIV } from '../model/builtin';
import { NotFoundError, ValidationError } from '../error';
import { MethodNotAllowedError } from '@ejunz/framework';
import { ObjectId } from 'mongodb';
import db from '../service/db';
import moment from 'moment-timezone';
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
        childrenMap.get(edge.source)!.push(edge.target);
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

    const collectAllCards = async (nodeId: string, collectedCards: Array<{ cardId: string; title: string; order: number }>): Promise<void> => {
        const node = nodeMap.get(nodeId);
        if (!node) return;

        const cards = await CardModel.getByNodeId(domainId, baseDocId, nodeId);
        for (const card of cards) {
            collectedCards.push({
                cardId: card.docId.toString(),
                title: card.title || translate('Unnamed Card'),
                order: (card as any).order || 0,
            });
        }

        const childIds = childrenMap.get(nodeId) || [];
        for (const childId of childIds) {
            await collectAllCards(childId, collectedCards);
        }
    };

    const processNode = async (nodeId: string, parentIds: string[], isFirstLevel: boolean = false) => {
        const node = nodeMap.get(nodeId);
        if (!node) {
            return;
        }

        let cardList: Array<{ cardId: string; title: string; order: number }> = [];
        
        if (isFirstLevel) {
            const allCards: Array<{ cardId: string; title: string; order: number }> = [];
            await collectAllCards(nodeId, allCards);
            cardList = allCards.sort((a, b) => (a.order || 0) - (b.order || 0));
        } else {
            const cards = await CardModel.getByNodeId(domainId, baseDocId, nodeId);
            cardList = cards.map(card => ({
                cardId: card.docId.toString(),
                title: card.title || translate('Unnamed Card'),
                order: (card as any).order || 0,
            })).sort((a, b) => (a.order || 0) - (b.order || 0));
        }

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
                    const cardList = cards.map(card => ({
                        cardId: card.docId.toString(),
                        title: card.title || translate('Unnamed Card'),
                        order: (card as any).order || 0,
                    })).sort((a, b) => (a.order || 0) - (b.order || 0));
                    
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
                    const rootCardList = rootCards.map(card => ({
                        cardId: card.docId.toString(),
                        title: card.title || translate('Unnamed Card'),
                        order: (card as any).order || 0,
                    })).sort((a, b) => (a.order || 0) - (b.order || 0));
                    
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

interface LearnDAGNode {
    _id: string;
    title: string;
    requireNids: string[];
    cards: Array<{
        cardId: string;
        title: string;
        order?: number;
    }>;
    content?: string;
    order?: number;
}

interface LearnDAGDoc {
    domainId: string;
    baseDocId: ObjectId;
    branch: string;
    sections: LearnDAGNode[];
    dag: LearnDAGNode[];
    version: number;
    updateAt: Date;
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
        
        await domain.setUserInDomain(finalDomainId, this.user._id, { dailyGoal });
        
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
            };
            return;
        }

        
        const learnDAGColl = this.ctx.db.db.collection('learn_dag');
        const existingDAG = await learnDAGColl.findOne({
            domainId: finalDomainId,
            baseDocId: base.docId,
            branch: branch,
        });

        
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
            
            await learnDAGColl.updateOne(
                {
                    domainId: finalDomainId,
                    baseDocId: base.docId,
                    branch: branch,
                },
                {
                    $set: {
                        domainId: finalDomainId,
                        baseDocId: base.docId,
                        branch: branch,
                        sections: sections,
                        dag: allDagNodes,
                        version: baseVersion,
                        updateAt: new Date(),
                    },
                },
                { upsert: true }
            );
        } else {
            sections = existingDAG.sections || [];
            allDagNodes = existingDAG.dag || [];
        }

        const dudoc = await domain.getDomainUser(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const savedSectionId = (dudoc as any)?.currentLearnSectionId;
        const dailyGoal = (dudoc as any)?.dailyGoal || 0;
        
        let finalSectionId: string | null = null;
        if (sectionId) {
            finalSectionId = sectionId;
            await domain.setUserInDomain(finalDomainId, this.user._id, { currentLearnSectionId: sectionId });
        } else if (savedSectionId && sections.find(s => s._id === savedSectionId)) {
            finalSectionId = savedSectionId;
        } else if (sections.length > 0) {
            finalSectionId = sections[0]._id;
            await domain.setUserInDomain(finalDomainId, this.user._id, { currentLearnSectionId: finalSectionId });
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

        const learnProgressColl = this.ctx.db.db.collection('learn_progress');
        const passedCards = await learnProgressColl.find({
            domainId: finalDomainId,
            userId: this.user._id,
            passed: true,
        }).toArray();
        const passedCardIds = new Set(passedCards.map(p => p.cardId.toString()));

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
        const passedCardsCount = passedCardIds.size;
        const currentProgress = totalCards > 0 ? passedCardsCount : 0;

        const learnResultColl = this.ctx.db.db.collection('learn_result');
        const allResults = await learnResultColl.find({
            domainId: finalDomainId,
            userId: this.user._id,
        }).toArray();

        const practiceDates = new Set<string>();
        for (const result of allResults) {
            if (result.createdAt) {
                const date = moment.utc(result.createdAt).format('YYYY-MM-DD');
                practiceDates.add(date);
            }
        }

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

        this.response.template = 'learn.html';
        this.response.body = {
            dag: dagWithProgress,
            sections: sections,
            currentSectionId: finalSectionId,
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
            currentProgress,
            totalCards,
            consecutiveDays,
            dailyGoal,
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

        await domain.setUserInDomain(domainId, this.user._id, { learnBranch: branch });
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

        const learnDAGColl = this.ctx.db.db.collection('learn_dag');
        const existingDAG = await learnDAGColl.findOne({
            domainId: finalDomainId,
            baseDocId: base.docId,
            branch: branch,
        });

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
            
            await learnDAGColl.updateOne(
                {
                    domainId: finalDomainId,
                    baseDocId: base.docId,
                    branch: branch,
                },
                {
                    $set: {
                        domainId: finalDomainId,
                        baseDocId: base.docId,
                        branch: branch,
                        sections: sections,
                        dag: allDagNodes,
                        version: baseVersion,
                        updateAt: new Date(),
                    },
                },
                { upsert: true }
            );
        } else {
            sections = existingDAG.sections || [];
            allDagNodes = existingDAG.dag || [];
        }

        const dudoc = await domain.getDomainUser(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const savedSectionId = (dudoc as any)?.currentLearnSectionId;
        
        let finalSectionId: string | null = null;
        if (savedSectionId && sections.find(s => s._id === savedSectionId)) {
            finalSectionId = savedSectionId;
        } else if (sections.length > 0) {
            finalSectionId = sections[0]._id;
            await domain.setUserInDomain(finalDomainId, this.user._id, { currentLearnSectionId: finalSectionId });
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

        const learnProgressColl = this.ctx.db.db.collection('learn_progress');
        const passedCards = await learnProgressColl.find({
            domainId: finalDomainId,
            userId: this.user._id,
            passed: true,
        }).toArray();
        const passedCardIds = new Set(passedCards.map(p => p.cardId.toString()));

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
            throw new NotFoundError('No available card to practice');
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

        const learnDAGColl = this.ctx.db.db.collection('learn_dag');
        const existingDAG = await learnDAGColl.findOne({
            domainId: finalDomainId,
            baseDocId: base.docId,
            branch: branch,
        });

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
            
            await learnDAGColl.updateOne(
                {
                    domainId: finalDomainId,
                    baseDocId: base.docId,
                    branch: branch,
                },
                {
                    $set: {
                        domainId: finalDomainId,
                        baseDocId: base.docId,
                        branch: branch,
                        sections: sections,
                        dag: allDagNodes,
                        version: baseVersion,
                        updateAt: new Date(),
                    },
                },
                { upsert: true }
            );
        } else {
            sections = existingDAG.sections || [];
            allDagNodes = existingDAG.dag || [];
        }

        const dudoc = await domain.getDomainUser(finalDomainId, { _id: this.user._id, priv: this.user.priv });
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

        const learnProgressColl = this.ctx.db.db.collection('learn_progress');
        const passedCards = await learnProgressColl.find({
            domainId: finalDomainId,
            userId: this.user._id,
            passed: true,
        }).toArray();
        const passedCardIds = new Set(passedCards.map(p => p.cardId.toString()));

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

        if (!isAlonePractice) {
            await learnProgressColl.updateOne(
                {
                    domainId: finalDomainId,
                    userId: this.user._id,
                    cardId: currentCardId,
                },
                {
                    $set: {
                        domainId: finalDomainId,
                        userId: this.user._id,
                        cardId: currentCardId,
                        nodeId: currentCardNodeId,
                        passed: true,
                        passedAt: new Date(),
                    },
                },
                { upsert: true }
            );
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
        
        const resultId = new ObjectId();
        const resultColl = this.ctx.db.db.collection('learn_result');
        await resultColl.insertOne({
            _id: resultId,
            domainId: finalDomainId,
            userId: this.user._id,
            cardId: currentCardId,
            nodeId: currentCardNodeId,
            answerHistory: answerHistory,
            totalTime: totalTime,
            score: score,
            createdAt: new Date(),
        });

        // 触发事件通知更新排名
        await bus.parallel('learn_result/add', finalDomainId);

        const today = moment.utc().format('YYYY-MM-DD');
        const uniqueProblemIds = new Set<string>();
        for (const history of answerHistory) {
            if (history.problemId) {
                uniqueProblemIds.add(history.problemId);
            }
        }
        const problemCount = uniqueProblemIds.size;

        const consumptionStatsColl = this.ctx.db.db.collection('learn_consumption_stats');
        const timeToAdd = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
        const updateData: any = {
            $inc: {
                nodes: currentCardNodeId ? 1 : 0,
                cards: 1,
                problems: problemCount,
                practices: 1,
            },
            $set: {
                updateAt: new Date(),
            },
        };
        if (timeToAdd > 0) {
            updateData.$inc.totalTime = timeToAdd;
        }
        await consumptionStatsColl.updateOne(
            {
                userId: this.user._id,
                domainId: finalDomainId,
                date: today,
            },
            updateData,
            { upsert: true }
        );

        this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson/result/${resultId}` };
    }

    async getResult(domainId: string, resultId: ObjectId) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const resultColl = this.ctx.db.db.collection('learn_result');
        const result = await resultColl.findOne({
            _id: resultId,
            domainId: finalDomainId,
            userId: this.user._id,
        });

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
                domainId: finalDomainId,
                baseDocId: base.docId.toString() || null,
            };
            return;
        }

        
        const learnDAGColl = this.ctx.db.db.collection('learn_dag');
        const existingDAG = await learnDAGColl.findOne({
            domainId: finalDomainId,
            baseDocId: base.docId,
            branch: branch,
        });

        const baseVersion = base.updateAt ? base.updateAt.getTime() : 0;
        const needsUpdate = !existingDAG || (existingDAG.version || 0) < baseVersion;
        
        const hasSectionsWithoutCards = existingDAG && existingDAG.sections && 
            existingDAG.sections.some((s: any) => !s.cards || s.cards.length === 0);

        let sections: LearnDAGNode[] = [];

        if (needsUpdate || !existingDAG || hasSectionsWithoutCards) {
            const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (key: string) => this.translate(key));
            sections = result.sections;
            
            await learnDAGColl.updateOne(
                {
                    domainId: finalDomainId,
                    baseDocId: base.docId,
                    branch: branch,
                },
                {
                    $set: {
                        domainId: finalDomainId,
                        baseDocId: base.docId,
                        branch: branch,
                        sections: sections,
                        dag: result.dag,
                        version: baseVersion,
                        updateAt: new Date(),
                    },
                },
                { upsert: true }
            );
        } else {
            sections = existingDAG.sections || [];
        }

        const dudoc = await domain.getDomainUser(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const currentSectionId = (dudoc as any)?.currentLearnSectionId || null;

        sections = sections.map(section => ({
            ...section,
            cards: section.cards || [],
        }));

        this.response.template = 'learn_sections.html';
        this.response.body = {
            sections: sections,
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
            currentSectionId: currentSectionId,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('learn', '/learn', LearnHandler);
    ctx.Route('learn_set_daily_goal', '/learn/daily-goal', LearnHandler);
    ctx.Route('learn_sections', '/learn/sections', LearnSectionsHandler);
    ctx.Route('learn_edit', '/learn/edit', LearnEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_lesson', '/learn/lesson', LessonHandler);
    ctx.Route('learn_lesson_pass', '/learn/lesson/pass', LessonHandler);
}

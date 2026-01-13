import type { Context } from '../context';
import { Handler, param, post, Types } from '../service/server';
import { MindMapModel, CardModel } from '../model/mindmap';
import type { MindMapDoc, MindMapNode, MindMapEdge } from '../interface';
import domain from '../model/domain';
import { PRIV } from '../model/builtin';
import { NotFoundError, ValidationError } from '../error';
import { MethodNotAllowedError } from '@ejunz/framework';
import { ObjectId } from 'mongodb';
import db from '../service/db';

function getBranchData(mindMap: MindMapDoc, branch: string): { nodes: MindMapNode[]; edges: MindMapEdge[] } {
    const branchName = branch || 'main';
    
    if (mindMap.branchData && mindMap.branchData[branchName]) {
        return {
            nodes: mindMap.branchData[branchName].nodes || [],
            edges: mindMap.branchData[branchName].edges || [],
        };
    }
    
    if (branchName === 'main') {
        return {
            nodes: mindMap.nodes || [],
            edges: mindMap.edges || [],
        };
    }
    
    return { nodes: [], edges: [] };
}

async function generateDAG(
    domainId: string,
    mindMapDocId: ObjectId,
    nodes: MindMapNode[],
    edges: MindMapEdge[],
    translate: (key: string) => string
): Promise<{ sections: LearnDAGNode[]; dag: LearnDAGNode[] }> {
    
    const nodeMap = new Map<string, MindMapNode>();
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

        const cards = await CardModel.getByNodeId(domainId, mindMapDocId, nodeId);
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
            const cards = await CardModel.getByNodeId(domainId, mindMapDocId, nodeId);
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
                    const cards = await CardModel.getByNodeId(domainId, mindMapDocId, otherNode.id);
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
                
                const rootCards = await CardModel.getByNodeId(domainId, mindMapDocId, rootNode.id);
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

interface MindMapNodeWithCards {
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
    children?: MindMapNodeWithCards[];
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
    mindMapDocId: ObjectId;
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
                name: 'learn_sections',
                args: {},
                displayName: this.translate('Sections'),
                checker: () => true,
            },
        ];
    }

    @param('sectionId', Types.String, true)
    async get(domainId: string, sectionId?: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        let mindMap = await MindMapModel.getByDomain(finalDomainId);
        
        if (!mindMap) {
            this.response.template = 'learn.html';
            this.response.body = {
                dag: [],
                domainId: finalDomainId,
                mindMapDocId: null,
            };
            return;
        }

        
        const initialNodes = mindMap.nodes?.length || 0;
        const initialEdges = mindMap.edges?.length || 0;
        const branchDataNodes = mindMap.branchData?.['main']?.nodes?.length || 0;
        const branchDataEdges = mindMap.branchData?.['main']?.edges?.length || 0;
        
        if ((initialNodes <= 1 && initialEdges === 0 && branchDataNodes <= 1 && branchDataEdges === 0)) {
            const reloadedMindMap = await MindMapModel.get(finalDomainId, mindMap.docId);
            if (reloadedMindMap) {
                mindMap = reloadedMindMap;
            }
        }

        const dbMindMap = await this.ctx.db.db.collection('document').findOne({
            domainId: finalDomainId,
            docType: 70,
            docId: mindMap.docId,
        });
        if (dbMindMap) {
            const dbNodes = dbMindMap.branchData?.['main']?.nodes || dbMindMap.nodes || [];
            const dbEdges = dbMindMap.branchData?.['main']?.edges || dbMindMap.edges || [];
            if (dbNodes.length > (mindMap.nodes?.length || 0) || dbEdges.length > (mindMap.edges?.length || 0)) {
                mindMap.nodes = dbNodes;
                mindMap.edges = dbEdges;
                if (dbMindMap.branchData) {
                    mindMap.branchData = dbMindMap.branchData;
                }
            }
        }
        
        const branch = 'main';
        const branchData = getBranchData(mindMap, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        if (nodes.length === 0) {
            this.response.template = 'learn.html';
            this.response.body = {
                dag: [],
                sections: [],
                domainId: finalDomainId,
                mindMapDocId: mindMap.docId.toString() || null,
            };
            return;
        }

        
        const learnDAGColl = this.ctx.db.db.collection('learn_dag');
        const existingDAG = await learnDAGColl.findOne({
            domainId: finalDomainId,
            mindMapDocId: mindMap.docId,
            branch: branch,
        });

        
        const mindMapVersion = mindMap.updateAt ? mindMap.updateAt.getTime() : 0;
        const needsUpdate = !existingDAG || (existingDAG.version || 0) < mindMapVersion;
        
        const hasEmptySections = existingDAG && (!existingDAG.sections || existingDAG.sections.length === 0);
        const cachedNodesCount = existingDAG ? ((existingDAG.dag?.length || 0) + (existingDAG.sections?.length || 0)) : 0;
        const shouldRegenerate = needsUpdate || !existingDAG || hasEmptySections || (nodes.length > 0 && cachedNodesCount === 0);

        let sections: LearnDAGNode[] = [];
        let allDagNodes: LearnDAGNode[] = [];

        if (shouldRegenerate) {
            const result = await generateDAG(finalDomainId, mindMap.docId, nodes, edges, (key: string) => this.translate(key));
            sections = result.sections;
            allDagNodes = result.dag;
            
            await learnDAGColl.updateOne(
                {
                    domainId: finalDomainId,
                    mindMapDocId: mindMap.docId,
                    branch: branch,
                },
                {
                    $set: {
                        domainId: finalDomainId,
                        mindMapDocId: mindMap.docId,
                        branch: branch,
                        sections: sections,
                        dag: allDagNodes,
                        version: mindMapVersion,
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

        this.response.template = 'learn.html';
        this.response.body = {
            dag: dagWithProgress,
            sections: sections,
            currentSectionId: finalSectionId,
            domainId: finalDomainId,
            mindMapDocId: mindMap.docId.toString(),
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
        const mindMap = await MindMapModel.getByDomain(finalDomainId);
        
        if (!mindMap) {
            throw new NotFoundError('MindMap not found for this domain');
        }

        const branches = Array.isArray((mindMap as any)?.branches) 
            ? (mindMap as any).branches 
            : ['main'];
        if (!branches.includes('main')) {
            branches.unshift('main');
        }

        const dudoc = await domain.getDomainUser(domainId, { _id: this.user._id, priv: this.user.priv });
        const currentBranch = (dudoc as any)?.learnBranch || (mindMap as any)?.currentBranch || 'main';

        this.response.template = 'learn_edit.html';
        this.response.body = {
            domainId,
            branches,
            currentBranch,
            mindMapTitle: mindMap.title,
        };
    }

    @post('branch', Types.String)
    async postSetBranch(domainId: string, branch: string) {
        const mindMap = await MindMapModel.getByDomain(domainId);
        
        if (!mindMap) {
            throw new NotFoundError('MindMap not found for this domain');
        }

        const branches = Array.isArray((mindMap as any)?.branches) 
            ? (mindMap as any).branches 
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
        const mindMap = await MindMapModel.getByDomain(finalDomainId);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found for this domain');
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

            const node = (getBranchData(mindMap, 'main').nodes || []).find(n => n.id === card.nodeId);
            if (!node) {
                throw new NotFoundError('Node not found');
            }

            const cards = await CardModel.getByNodeId(finalDomainId, mindMap.docId, card.nodeId);
            const currentIndex = cards.findIndex(c => c.docId.toString() === cardId.toString());

            this.response.template = 'lesson.html';
            this.response.body = {
                card,
                node,
                cards,
                currentIndex: currentIndex >= 0 ? currentIndex : 0,
                domainId: finalDomainId,
                mindMapDocId: mindMap.docId.toString(),
                isAlonePractice: true,
            };
            return;
        }

        const branch = 'main';
        const branchData = getBranchData(mindMap, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        if (nodes.length === 0) {
            throw new NotFoundError('No nodes available');
        }

        const learnDAGColl = this.ctx.db.db.collection('learn_dag');
        const existingDAG = await learnDAGColl.findOne({
            domainId: finalDomainId,
            mindMapDocId: mindMap.docId,
            branch: branch,
        });

        const mindMapVersion = mindMap.updateAt ? mindMap.updateAt.getTime() : 0;
        const needsUpdate = !existingDAG || (existingDAG.version || 0) < mindMapVersion;
        const hasEmptySections = existingDAG && (!existingDAG.sections || existingDAG.sections.length === 0);
        const cachedNodesCount = existingDAG ? ((existingDAG.dag?.length || 0) + (existingDAG.sections?.length || 0)) : 0;
        const shouldRegenerate = needsUpdate || !existingDAG || hasEmptySections || (nodes.length > 0 && cachedNodesCount === 0);

        let sections: LearnDAGNode[] = [];
        let allDagNodes: LearnDAGNode[] = [];

        if (shouldRegenerate) {
            const result = await generateDAG(finalDomainId, mindMap.docId, nodes, edges, (key: string) => this.translate(key));
            sections = result.sections;
            allDagNodes = result.dag;
            
            await learnDAGColl.updateOne(
                {
                    domainId: finalDomainId,
                    mindMapDocId: mindMap.docId,
                    branch: branch,
                },
                {
                    $set: {
                        domainId: finalDomainId,
                        mindMapDocId: mindMap.docId,
                        branch: branch,
                        sections: sections,
                        dag: allDagNodes,
                        version: mindMapVersion,
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

        const node = (getBranchData(mindMap, 'main').nodes || []).find(n => n.id === nextCard!.nodeId);
        if (!node) {
            throw new NotFoundError('Node not found');
        }

        const cards = await CardModel.getByNodeId(finalDomainId, mindMap.docId, nextCard.nodeId);
        const currentIndex = cards.findIndex(c => c.docId.toString() === nextCard!.cardId);

        this.response.template = 'lesson.html';
        this.response.body = {
            card,
            node,
            cards,
            currentIndex: currentIndex >= 0 ? currentIndex : 0,
            domainId: finalDomainId,
            mindMapDocId: mindMap.docId.toString(),
        };
    }

    async postPass(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body: any = this.request?.body || {};
        const answerHistory = body.answerHistory || [];
        const totalTime = body.totalTime || 0;
        
        const mindMap = await MindMapModel.getByDomain(finalDomainId);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found for this domain');
        }

        const branch = 'main';
        const branchData = getBranchData(mindMap, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        if (nodes.length === 0) {
            throw new NotFoundError('No nodes available');
        }

        const learnDAGColl = this.ctx.db.db.collection('learn_dag');
        const existingDAG = await learnDAGColl.findOne({
            domainId: finalDomainId,
            mindMapDocId: mindMap.docId,
            branch: branch,
        });

        const mindMapVersion = mindMap.updateAt ? mindMap.updateAt.getTime() : 0;
        const needsUpdate = !existingDAG || (existingDAG.version || 0) < mindMapVersion;
        const hasEmptySections = existingDAG && (!existingDAG.sections || existingDAG.sections.length === 0);
        const cachedNodesCount = existingDAG ? ((existingDAG.dag?.length || 0) + (existingDAG.sections?.length || 0)) : 0;
        const shouldRegenerate = needsUpdate || !existingDAG || hasEmptySections || (nodes.length > 0 && cachedNodesCount === 0);

        let sections: LearnDAGNode[] = [];
        let allDagNodes: LearnDAGNode[] = [];

        if (shouldRegenerate) {
            const result = await generateDAG(finalDomainId, mindMap.docId, nodes, edges, (key: string) => this.translate(key));
            sections = result.sections;
            allDagNodes = result.dag;
            
            await learnDAGColl.updateOne(
                {
                    domainId: finalDomainId,
                    mindMapDocId: mindMap.docId,
                    branch: branch,
                },
                {
                    $set: {
                        domainId: finalDomainId,
                        mindMapDocId: mindMap.docId,
                        branch: branch,
                        sections: sections,
                        dag: allDagNodes,
                        version: mindMapVersion,
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
        for (let i = 0; i < flatCards.length; i++) {
            if (!passedCardIds.has(flatCards[i].cardId)) {
                currentCard = flatCards[i];
                break;
            }
        }

        if (!currentCard) {
            throw new NotFoundError('No available card to practice');
        }

        const card = await CardModel.get(finalDomainId, new ObjectId(currentCard.cardId));
        if (!card) {
            throw new NotFoundError('Card not found');
        }

        await learnProgressColl.updateOne(
            {
                domainId: finalDomainId,
                userId: this.user._id,
                cardId: new ObjectId(currentCard.cardId),
            },
            {
                $set: {
                    domainId: finalDomainId,
                    userId: this.user._id,
                    cardId: new ObjectId(currentCard.cardId),
                    nodeId: currentCard.nodeId,
                    passed: true,
                    passedAt: new Date(),
                },
            },
            { upsert: true }
        );

        const node = (getBranchData(mindMap, 'main').nodes || []).find(n => n.id === currentCard.nodeId);
        const cards = await CardModel.getByNodeId(finalDomainId, mindMap.docId, currentCard.nodeId);
        const cardIndex = cards.findIndex(c => c.docId.toString() === currentCard.cardId);
        const currentCardDoc = cards[cardIndex];

        const resultData = {
            card: currentCardDoc,
            node: node,
            answerHistory: answerHistory,
            totalTime: totalTime,
            domainId: finalDomainId,
            mindMapDocId: mindMap.docId.toString(),
        };

        const resultId = new ObjectId();
        const resultColl = this.ctx.db.db.collection('learn_result');
        await resultColl.insertOne({
            _id: resultId,
            domainId: finalDomainId,
            userId: this.user._id,
            cardId: new ObjectId(currentCard.cardId),
            nodeId: currentCard.nodeId,
            answerHistory: answerHistory,
            totalTime: totalTime,
            createdAt: new Date(),
        });

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

        const mindMap = await MindMapModel.getByDomain(finalDomainId);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found for this domain');
        }

        const node = (getBranchData(mindMap, 'main').nodes || []).find(n => n.id === result.nodeId);
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
            mindMapDocId: mindMap.docId.toString(),
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
        const mindMap = await MindMapModel.getByDomain(finalDomainId);
        
        if (!mindMap) {
            this.response.template = 'learn_sections.html';
            this.response.body = {
                sections: [],
                domainId: finalDomainId,
                mindMapDocId: null,
            };
            return;
        }

        const branch = 'main';
        const branchData = getBranchData(mindMap, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        
        if (nodes.length === 0) {
            this.response.template = 'learn_sections.html';
            this.response.body = {
                sections: [],
                domainId: finalDomainId,
                mindMapDocId: mindMap.docId.toString() || null,
            };
            return;
        }

        
        const learnDAGColl = this.ctx.db.db.collection('learn_dag');
        const existingDAG = await learnDAGColl.findOne({
            domainId: finalDomainId,
            mindMapDocId: mindMap.docId,
            branch: branch,
        });

        const mindMapVersion = mindMap.updateAt ? mindMap.updateAt.getTime() : 0;
        const needsUpdate = !existingDAG || (existingDAG.version || 0) < mindMapVersion;
        
        const hasSectionsWithoutCards = existingDAG && existingDAG.sections && 
            existingDAG.sections.some((s: any) => !s.cards || s.cards.length === 0);

        let sections: LearnDAGNode[] = [];

        if (needsUpdate || !existingDAG || hasSectionsWithoutCards) {
            const result = await generateDAG(finalDomainId, mindMap.docId, nodes, edges, (key: string) => this.translate(key));
            sections = result.sections;
            
            await learnDAGColl.updateOne(
                {
                    domainId: finalDomainId,
                    mindMapDocId: mindMap.docId,
                    branch: branch,
                },
                {
                    $set: {
                        domainId: finalDomainId,
                        mindMapDocId: mindMap.docId,
                        branch: branch,
                        sections: sections,
                        dag: result.dag,
                        version: mindMapVersion,
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
            mindMapDocId: mindMap.docId.toString(),
            currentSectionId: currentSectionId,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('learn', '/learn', LearnHandler);
    ctx.Route('learn_sections', '/learn/sections', LearnSectionsHandler);
    ctx.Route('learn_edit', '/learn/edit', LearnEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_lesson', '/learn/lesson', LessonHandler);
    ctx.Route('learn_lesson_pass', '/learn/lesson/pass', LessonHandler);
}

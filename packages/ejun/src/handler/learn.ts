import type { Context } from '../context';
import { Handler, param, post, Types } from '../service/server';
import { MindMapModel, CardModel } from '../model/mindmap';
import type { MindMapDoc, MindMapNode, MindMapEdge } from '../interface';
import domain from '../model/domain';
import { PRIV } from '../model/builtin';
import { NotFoundError, ValidationError } from '../error';
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
        this.response.template = 'learn.html';
        this.response.body = {
            dag: dag,
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

    @param('nodeId', Types.String)
    @param('cardId', Types.ObjectId)
    async get(domainId: string, nodeId: string, cardId: ObjectId) {
        const mindMap = await MindMapModel.getByDomain(domainId);
        if (!mindMap) {
            throw new NotFoundError('MindMap not found for this domain');
        }

        const card = await CardModel.get(domainId, cardId);
        if (!card) {
            throw new NotFoundError('Card not found');
        }
        if (card.nodeId !== nodeId) {
            throw new NotFoundError('Card does not belong to this node');
        }

        const node = (getBranchData(mindMap, 'main').nodes || []).find(n => n.id === nodeId);
        if (!node) {
            throw new NotFoundError('Node not found');
        }

        const cards = await CardModel.getByNodeId(domainId, mindMap.docId, nodeId);
        const currentIndex = cards.findIndex(c => c.docId.toString() === cardId.toString());

        this.response.template = 'lesson.html';
        this.response.body = {
            card,
            node,
            cards,
            currentIndex: currentIndex >= 0 ? currentIndex : 0,
            domainId,
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
    ctx.Route('learn_lesson', '/learn/lesson/:domainId/:nodeId/:cardId', LessonHandler);
}

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

/**
 * 按用户的学习顺序组装 section 列表。learnSectionOrder 为每人独立、可含重复 id（同一节出现多次）。
 * 不做去重，严格按 learnSectionOrder 顺序；无 order 时回退为 DAG 默认排序。
 */
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

interface SectionProgressItem {
    _id: string;
    title: string;
    passed: number;
    total: number;
    slotIndex: number;  // 顺序中的位置，用于列表 key 和 sectionId 跳转时区分同 id 的 slot
}

function getSectionProgress(
    sections: LearnDAGNode[],
    allDagNodes: LearnDAGNode[],
    passedCardIds: Set<string>
): { pending: SectionProgressItem[]; completed: SectionProgressItem[] } {
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

    const pending: SectionProgressItem[] = [];
    const completed: SectionProgressItem[] = [];

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const cards = collectCards(section._id, new Set());
        const total = cards.length;
        const passed = cards.filter((c: any) => passedCardIds.has(String(c.cardId))).length;
        const item: SectionProgressItem = {
            _id: section._id,
            title: section.title || 'Unnamed',
            passed,
            total,
            slotIndex: i,
        };
        if (total > 0 && passed >= total) {
            completed.push(item);
        } else {
            pending.push(item);
        }
    }

    return { pending, completed };
}

/** 今日已完成的节：根据今日 learn_result 统计（含单卡片刷题、node 模式刷题），与学习点无关 */
function getCompletedSectionsToday(
    sections: LearnDAGNode[],
    allDagNodes: LearnDAGNode[],
    todayResultCardIds: Set<string>
): Array<{ _id: string; title: string; passed: number; total: number }> {
    const nodeMap = new Map<string, LearnDAGNode>();
    sections.forEach(s => nodeMap.set(String(s._id), s));
    allDagNodes.forEach(n => nodeMap.set(String(n._id), n));

    const collectCards = (nodeId: string, collected: Set<string>): Array<{ cardId: string }> => {
        if (collected.has(nodeId)) return [];
        collected.add(nodeId);
        const node = nodeMap.get(nodeId);
        if (!node) return [];
        const cards = (node.cards || []).map((c: any) => ({ cardId: String(c.cardId) }));
        const children = allDagNodes.filter((n: any) => n.requireNids?.length > 0 && n.requireNids[n.requireNids.length - 1] === nodeId);
        for (const child of children) {
            cards.push(...collectCards(child._id, collected));
        }
        return cards;
    };

    const result: Array<{ _id: string; title: string; passed: number; total: number }> = [];
    for (const section of sections) {
        const cards = collectCards(section._id, new Set());
        const total = cards.length;
        const passed = cards.filter((c) => todayResultCardIds.has(c.cardId)).length;
        if (total > 0 && passed > 0) {
            result.push({ _id: section._id, title: section.title || 'Unnamed', passed, total });
        }
    }
    return result;
}

/** 从当前学习点起的节点列表：每个节点一条，带顺序号，及该节点（含子节点）下的卡片与题目题干 */
function getPendingNodeList(
    sections: LearnDAGNode[],
    allDagNodes: LearnDAGNode[]
): Array<{ orderIndex: number; _id: string; title: string; cards: Array<{ cardId: string; title: string; problems?: Array<{ stem?: string }> }> }> {
    const fromLearningPoint = sections;
    if (fromLearningPoint.length === 0) return [];
    const nodeMap = new Map<string, LearnDAGNode>();
    fromLearningPoint.forEach(s => nodeMap.set(String(s._id), s));
    allDagNodes.forEach(n => nodeMap.set(String(n._id), n));

    const collectCardsUnder = (nodeId: string, collected: Set<string>): Array<{ cardId: string; title: string; problems?: Array<{ stem?: string }> }> => {
        if (collected.has(nodeId)) return [];
        collected.add(nodeId);
        const node = nodeMap.get(nodeId);
        if (!node) return [];
        const cardList: Array<{ cardId: string; title: string; problems?: Array<{ stem?: string }> }> = (node.cards || []).map((c: any) => ({
            cardId: String(c.cardId),
            title: c.title || 'Unnamed',
            problems: (c.problems || []).map((p: any) => ({ stem: p.stem })),
        }));
        const children = allDagNodes.filter((n: any) => n.requireNids?.length > 0 && n.requireNids[n.requireNids.length - 1] === nodeId);
        for (const child of children) {
            cardList.push(...collectCardsUnder(child._id, collected));
        }
        return cardList;
    };

    return fromLearningPoint.map((section, i) => ({
        orderIndex: i + 1,
        _id: section._id,
        title: section.title || 'Unnamed',
        cards: collectCardsUnder(section._id, new Set()),
    }));
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
                fullDag: [],
                sections: [],
                currentSectionId: null,
                currentSectionIndex: 0,
                domainId: finalDomainId,
                baseDocId: base.docId.toString() || null,
                pendingNodeList: [],
                completedSections: [],
                completedCardsToday: [],
                passedCardIds: [],
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
        const sectionIndexParam = this.request.query?.sectionIndex;
        const sectionIndexFromQuery = typeof sectionIndexParam === 'string' ? parseInt(sectionIndexParam, 10) : typeof sectionIndexParam === 'number' ? sectionIndexParam : NaN;
        if (!Number.isNaN(sectionIndexFromQuery) && sectionIndexFromQuery >= 0 && sectionIndexFromQuery < sections.length) {
            currentSectionIndex = sectionIndexFromQuery;
            finalSectionId = sections[sectionIndexFromQuery]._id;
            await learn.setUserLearnState(finalDomainId, this.user._id, {
                currentLearnSectionId: finalSectionId,
                currentLearnSectionIndex: currentSectionIndex,
                learnProgressPosition: Math.max(0, currentSectionIndex),
                learnProgressTotal: totalSectionsForProgress,
            });
        } else if (sectionId) {
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

        const allResults = await learn.getResults(finalDomainId, this.user._id);

        const practiceDates = new Set<string>();
        const todayStart = moment.utc().startOf('day').toDate();
        const todayEnd = moment.utc().add(1, 'day').startOf('day').toDate();
        let todayCompletedCount = 0;
        const todayResultCardIds = new Set<string>();
        for (const result of allResults) {
            if (result.createdAt) {
                const date = moment.utc(result.createdAt).format('YYYY-MM-DD');
                practiceDates.add(date);
                if (result.createdAt >= todayStart && result.createdAt < todayEnd) {
                    todayCompletedCount++;
                    if (result.cardId) todayResultCardIds.add(String(result.cardId));
                }
            }
        }

        const pendingNodeList = getPendingNodeList(sections.slice(currentSectionIndex), allDagNodes);
        const completedSections = getCompletedSectionsToday(sections, allDagNodes, todayResultCardIds);

        const todayResults = allResults.filter(
            (r: any) => r.createdAt && r.createdAt >= todayStart && r.createdAt < todayEnd && r.cardId
        );
        const latestByCardId = new Map<string, { createdAt: Date; resultId: string }>();
        for (const r of todayResults) {
            const cid = String(r.cardId);
            const rid = r._id ? String(r._id) : '';
            const existing = latestByCardId.get(cid);
            if (!existing || (r.createdAt && r.createdAt > existing.createdAt)) {
                latestByCardId.set(cid, { createdAt: r.createdAt, resultId: rid });
            }
        }
        const completedCardsToday: Array<{ cardId: string; resultId: string; cardTitle: string; nodeTitle: string; completedAt: Date }> = [];
        const baseNodes = getBranchData(base, 'main').nodes || [];
        for (const [cardIdStr, { createdAt, resultId }] of latestByCardId) {
            if (!resultId) continue;
            const cardDoc = await CardModel.get(finalDomainId, new ObjectId(cardIdStr));
            if (!cardDoc) continue;
            const nodeDoc = baseNodes.find((n: BaseNode) => n.id === cardDoc.nodeId);
            completedCardsToday.push({
                cardId: cardIdStr,
                resultId,
                cardTitle: cardDoc.title || '',
                nodeTitle: nodeDoc?.text || '',
                completedAt: createdAt,
            });
        }
        completedCardsToday.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());

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
            fullDag: allDagNodes,
            sections: sections,
            currentSectionId: finalSectionId,
            currentSectionIndex,
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
            currentProgress,
            totalProgress,
            totalCards,
            totalCheckinDays,
            consecutiveDays,
            dailyGoal,
            todayCompletedCount,
            pendingNodeList,
            completedSections,
            completedCardsToday,
            nextCard,
            passedCardIds: Array.from(passedCardIds),
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
        const queryNodeId = this.request.query?.nodeId as string | undefined;
        const queryToday = this.request.query?.today === '1' || this.request.query?.today === 'true';

        if (!queryCardId && !queryNodeId && !queryToday) {
            const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const lessonMode = dudoc?.lessonMode;
            const lessonCardIndex = typeof dudoc?.lessonCardIndex === 'number' ? dudoc.lessonCardIndex : 0;
            const lessonNodeId = dudoc?.lessonNodeId as string | undefined;
            if (lessonMode === 'today') {
                this.response.redirect = `/d/${finalDomainId}/learn/lesson?today=1&cardIndex=${Math.max(0, lessonCardIndex)}`;
                return;
            }
            if (lessonMode === 'node' && lessonNodeId) {
                this.response.redirect = `/d/${finalDomainId}/learn/lesson?nodeId=${encodeURIComponent(lessonNodeId)}&cardIndex=${Math.max(0, lessonCardIndex)}`;
                return;
            }
            this.response.redirect = `/d/${finalDomainId}/learn/lesson?today=1`;
            return;
        }

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

            await learn.setUserLearnState(finalDomainId, this.user._id, {
                lessonMode: null,
                lessonNodeId: null,
                lessonCardIndex: 0,
                lessonUpdatedAt: new Date(),
            });

            this.response.template = 'lesson.html';
            this.response.body = {
                card,
                node,
                cards,
                currentIndex: currentIndex >= 0 ? currentIndex : 0,
                domainId: finalDomainId,
                baseDocId: base.docId.toString(),
                isAlonePractice: true,
                hasProblems: true,
            };
            return;
        }

        if (queryNodeId) {
            const branch = 'main';
            const branchData = getBranchData(base, branch);
            const nodes = branchData.nodes || [];
            const edges = branchData.edges || [];
            if (nodes.length === 0) throw new NotFoundError('No nodes available');
            const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (k: string) => this.translate(k));
            const sections = result.sections;
            const allDagNodes = result.dag;
            const nodeMap = new Map<string, LearnDAGNode>();
            sections.forEach(n => nodeMap.set(n._id, n));
            allDagNodes.forEach(n => nodeMap.set(n._id, n));
            const rootNode = nodeMap.get(queryNodeId);
            if (!rootNode) throw new NotFoundError('Node not found');

            const getChildNodes = (parentId: string): LearnDAGNode[] => {
                return allDagNodes
                    .filter(n => n.requireNids && n.requireNids[n.requireNids.length - 1] === parentId)
                    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            };

            const flatCards: Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string }> = [];
            const nodeTree: Array<{ type: 'node'; id: string; title: string; children: Array<{ type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }> }> = [];

            const collectUnder = (nodeId: string): Array<{ type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }> => {
                const node = nodeMap.get(nodeId);
                if (!node) return [];
                const children: Array<{ type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }> = [];
                const cardList = (node.cards || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                for (const c of cardList) {
                    flatCards.push({
                        nodeId: node._id,
                        cardId: c.cardId,
                        nodeTitle: node.title || '',
                        cardTitle: c.title || '',
                    });
                    children.push({ type: 'card', id: c.cardId, title: c.title || '' });
                }
                const childNodes = getChildNodes(nodeId);
                for (const ch of childNodes) {
                    const sub = collectUnder(ch._id);
                    children.push({ type: 'node', id: ch._id, title: ch.title || '', children: sub });
                }
                return children;
            };

            nodeTree.push({
                type: 'node',
                id: rootNode._id,
                title: rootNode.title || '',
                children: collectUnder(queryNodeId),
            });

            const cardIndexParam = this.request.query?.cardIndex;
            let currentCardIndex = typeof cardIndexParam === 'string' ? parseInt(cardIndexParam, 10) : NaN;
            if (Number.isNaN(currentCardIndex) || currentCardIndex < 0) {
                const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
                if (dudoc?.lessonMode === 'node' && dudoc?.lessonNodeId === queryNodeId && typeof dudoc?.lessonCardIndex === 'number') {
                    currentCardIndex = Math.max(0, dudoc.lessonCardIndex);
                } else {
                    currentCardIndex = 0;
                }
            }

            if (flatCards.length === 0) {
                throw new NotFoundError('No cards under this node');
            }
            if (currentCardIndex >= flatCards.length) currentCardIndex = 0;

            const reviewCardId = this.request.query?.reviewCardId as string | undefined;
            let currentItem: { nodeId: string; cardId: string; nodeTitle: string; cardTitle: string };
            let lessonReviewCardIds: string[] = [];
            let lessonCardTimesMs: number[] = [];
            if (reviewCardId) {
                const fromReview = flatCards.find(c => c.cardId === reviewCardId);
                if (fromReview) {
                    currentItem = fromReview;
                    currentCardIndex = flatCards.findIndex(c => c.cardId === reviewCardId);
                    const dudocReview = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
                    const reviewIds: string[] = Array.isArray(dudocReview?.lessonReviewCardIds) ? dudocReview.lessonReviewCardIds : [];
                    lessonReviewCardIds = reviewIds.filter(id => id !== reviewCardId);
                    lessonCardTimesMs = Array.isArray(dudocReview?.lessonCardTimesMs) ? dudocReview.lessonCardTimesMs : [];
                    await learn.setUserLearnState(finalDomainId, this.user._id, { lessonReviewCardIds, lessonUpdatedAt: new Date() });
                } else {
                    currentItem = flatCards[currentCardIndex];
                    const dudocReview = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
                    lessonReviewCardIds = Array.isArray(dudocReview?.lessonReviewCardIds) ? dudocReview.lessonReviewCardIds : [];
                    lessonCardTimesMs = Array.isArray(dudocReview?.lessonCardTimesMs) ? dudocReview.lessonCardTimesMs : [];
                }
            } else {
                currentItem = flatCards[currentCardIndex];
                const dudocReview = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
                lessonReviewCardIds = Array.isArray(dudocReview?.lessonReviewCardIds) ? dudocReview.lessonReviewCardIds : [];
                lessonCardTimesMs = Array.isArray(dudocReview?.lessonCardTimesMs) ? dudocReview.lessonCardTimesMs : [];
            }

            const currentCard = await CardModel.get(finalDomainId, new ObjectId(currentItem.cardId));
            if (!currentCard) throw new NotFoundError('Card not found');
            const currentNode = (getBranchData(base, 'main').nodes || []).find(n => n.id === currentItem.nodeId);
            if (!currentNode) throw new NotFoundError('Node not found');
            const currentCardList = await CardModel.getByNodeId(finalDomainId, base.docId, currentItem.nodeId);
            const currentIndexInNode = currentCardList.findIndex(c => c.docId.toString() === currentItem.cardId);

            await learn.setUserLearnState(finalDomainId, this.user._id, {
                lessonMode: 'node',
                lessonNodeId: queryNodeId,
                lessonCardIndex: currentCardIndex,
                lessonUpdatedAt: new Date(),
            });

            this.response.template = 'lesson.html';
            this.response.body = {
                card: currentCard,
                node: currentNode,
                cards: currentCardList,
                currentIndex: currentIndexInNode >= 0 ? currentIndexInNode : 0,
                domainId: finalDomainId,
                baseDocId: base.docId.toString(),
                isAlonePractice: false,
                isSingleNodeMode: true,
                rootNodeId: queryNodeId,
                rootNodeTitle: rootNode.title || '',
                flatCards: flatCards,
                nodeTree,
                currentCardIndex,
                hasProblems: !!(currentCard?.problems?.length),
                lessonReviewCardIds,
                lessonCardTimesMs,
            };
            return;
        }

        if (queryToday) {
            const branch = 'main';
            const branchData = getBranchData(base, branch);
            const nodes = branchData.nodes || [];
            const edges = branchData.edges || [];
            if (nodes.length === 0) throw new NotFoundError('No nodes available');
            const existingDAG = await learn.getDAG(finalDomainId, base.docId, branch);
            const baseVersion = base.updateAt ? base.updateAt.getTime() : 0;
            const needsUpdate = !existingDAG || (existingDAG.version || 0) < baseVersion;
            const hasEmptySections = existingDAG && (!existingDAG.sections || existingDAG.sections.length === 0);
            const cachedNodesCount = existingDAG ? ((existingDAG.dag?.length || 0) + (existingDAG.sections?.length || 0)) : 0;
            const shouldRegenerate = needsUpdate || !existingDAG || hasEmptySections || (nodes.length > 0 && cachedNodesCount === 0);

            let sections: LearnDAGNode[] = [];
            let allDagNodes: LearnDAGNode[] = [];
            if (shouldRegenerate) {
                const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (k: string) => this.translate(k));
                sections = result.sections;
                allDagNodes = result.dag;
                await learn.setDAG(finalDomainId, base.docId, branch, {
                    sections, dag: allDagNodes, version: baseVersion, updateAt: new Date(),
                });
            } else {
                sections = existingDAG!.sections || [];
                allDagNodes = existingDAG!.dag || [];
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
            } else if (sections.length > 0) {
                finalSectionId = sections[0]._id;
                currentSectionIndex = 0;
            }

            let dag: LearnDAGNode[] = [];
            if (finalSectionId) {
                const collectChildren = (parentId: string, collected: Set<string>) => {
                    if (collected.has(parentId)) return;
                    collected.add(parentId);
                    const children = allDagNodes.filter(n =>
                        n.requireNids && n.requireNids[n.requireNids.length - 1] === parentId && !collected.has(n._id)
                    );
                    for (const ch of children) {
                        dag.push(ch);
                        collectChildren(ch._id, collected);
                    }
                };
                collectChildren(finalSectionId, new Set());
            }

            const todayFlatCards: Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string }> = [];
            const nodeMap = new Map(allDagNodes.map(n => [n._id, n]));
            sections.forEach(s => nodeMap.set(s._id, s));
            for (const node of dag) {
                const n = nodeMap.get(node._id);
                if (!n) continue;
                const cardList = (n.cards || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                for (const c of cardList) {
                    todayFlatCards.push({
                        nodeId: n._id,
                        cardId: c.cardId,
                        nodeTitle: n.title || '',
                        cardTitle: c.title || '',
                    });
                }
            }

            const cardsWithProblems: Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string }> = [];
            for (const item of todayFlatCards) {
                const cardDoc = await CardModel.get(finalDomainId, new ObjectId(item.cardId));
                if (cardDoc && cardDoc.problems && cardDoc.problems.length > 0) {
                    cardsWithProblems.push(item);
                }
            }

            if (cardsWithProblems.length === 0) {
                if (sections.length > 0 && currentSectionIndex + 1 < sections.length) {
                    await learn.setUserLearnState(finalDomainId, this.user._id, {
                        currentLearnSectionIndex: currentSectionIndex + 1,
                        currentLearnSectionId: sections[currentSectionIndex + 1]._id,
                        lessonMode: 'today',
                        lessonNodeId: null,
                        lessonCardIndex: 0,
                        lessonUpdatedAt: new Date(),
                    });
                    this.response.redirect = `/d/${finalDomainId}/learn/lesson?today=1`;
                    return;
                }
                await learn.setUserLearnState(finalDomainId, this.user._id, {
                    lessonMode: null,
                    lessonNodeId: null,
                    lessonCardIndex: 0,
                    lessonUpdatedAt: new Date(),
                });
                this.response.redirect = this.url('learn', { domainId: finalDomainId });
                return;
            }

            const cardIndexParam = this.request.query?.cardIndex;
            let currentCardIndex = typeof cardIndexParam === 'string' ? parseInt(cardIndexParam, 10) : NaN;
            if (Number.isNaN(currentCardIndex) || currentCardIndex < 0) {
                if ((dudoc as any)?.lessonMode === 'today' && typeof (dudoc as any)?.lessonCardIndex === 'number') {
                    currentCardIndex = Math.max(0, (dudoc as any).lessonCardIndex);
                } else {
                    currentCardIndex = 0;
                }
            }
            if (currentCardIndex >= cardsWithProblems.length) currentCardIndex = 0;

            const currentItem = cardsWithProblems[currentCardIndex];
            const currentCard = await CardModel.get(finalDomainId, new ObjectId(currentItem.cardId));
            if (!currentCard || !currentCard.problems || currentCard.problems.length === 0) {
                throw new NotFoundError('Card not found');
            }
            const currentNode = (getBranchData(base, 'main').nodes || []).find((n: any) => n.id === currentItem.nodeId);
            if (!currentNode) throw new NotFoundError('Node not found');
            const currentCardList = await CardModel.getByNodeId(finalDomainId, base.docId, currentItem.nodeId);
            const currentIndexInNode = currentCardList.findIndex(c => c.docId.toString() === currentItem.cardId);

            await learn.setUserLearnState(finalDomainId, this.user._id, {
                lessonMode: 'today',
                lessonNodeId: null,
                lessonCardIndex: currentCardIndex,
                lessonUpdatedAt: new Date(),
            });

            const todayNodeTree = [{
                type: 'node' as const,
                id: 'today',
                title: this.translate('Today task') || '今日任务',
                children: cardsWithProblems.map(c => ({ type: 'card' as const, id: c.cardId, title: c.cardTitle })),
            }];

            this.response.template = 'lesson.html';
            this.response.body = {
                card: currentCard,
                node: currentNode,
                cards: currentCardList,
                currentIndex: currentIndexInNode >= 0 ? currentIndexInNode : 0,
                domainId: finalDomainId,
                baseDocId: base.docId.toString(),
                isAlonePractice: false,
                isTodayMode: true,
                rootNodeTitle: this.translate('Today task') || '今日任务',
                flatCards: cardsWithProblems,
                nodeTree: todayNodeTree,
                currentCardIndex,
                hasProblems: !!(currentCard?.problems?.length),
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
            hasProblems: !!(card?.problems?.length),
        };
    }

    async postPass(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body: any = this.request?.body || {};
        const answerHistory = body.answerHistory || [];
        const totalTime = body.totalTime || 0;
        const isAlonePractice = body.isAlonePractice || false;
        const isSingleNodeMode = body.singleNodeMode === true;
        const nodeIdFromBody = body.nodeId as string | undefined;
        const cardIndexFromBody = typeof body.cardIndex === 'number' ? body.cardIndex : parseInt(body.cardIndex, 10);
        const cardIdFromBody = body.cardId;

        const base = await BaseModel.getByDomain(finalDomainId);
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }

        const isTodayMode = body.todayMode === true;

        if (isTodayMode) {
            const branch = 'main';
            const branchData = getBranchData(base, branch);
            const nodes = branchData.nodes || [];
            const edges = branchData.edges || [];
            if (nodes.length === 0) throw new NotFoundError('No nodes available');
            const existingDAG = await learn.getDAG(finalDomainId, base.docId, branch);
            let sections: LearnDAGNode[] = existingDAG?.sections || [];
            let allDagNodes: LearnDAGNode[] = existingDAG?.dag || [];
            if (sections.length === 0 || allDagNodes.length === 0) {
                const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (k: string) => this.translate(k));
                sections = result.sections;
                allDagNodes = result.dag;
            }
            const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv });
            const savedSectionIndex = (dudoc as any)?.currentLearnSectionIndex ?? 0;
            const currentSectionIndex = Math.min(savedSectionIndex, sections.length - 1);
            const finalSectionId = sections[currentSectionIndex]?._id || null;

            let dag: LearnDAGNode[] = [];
            if (finalSectionId) {
                const collectChildren = (parentId: string, collected: Set<string>) => {
                    if (collected.has(parentId)) return;
                    collected.add(parentId);
                    const children = allDagNodes.filter(n =>
                        n.requireNids && n.requireNids[n.requireNids.length - 1] === parentId && !collected.has(n._id)
                    );
                    for (const ch of children) {
                        dag.push(ch);
                        collectChildren(ch._id, collected);
                    }
                };
                collectChildren(finalSectionId, new Set());
            }

            const nodeMap = new Map(allDagNodes.map(n => [n._id, n]));
            sections.forEach(s => nodeMap.set(s._id, s));
            const todayFlatCards: Array<{ nodeId: string; cardId: string }> = [];
            for (const node of dag) {
                const n = nodeMap.get(node._id);
                if (!n) continue;
                const cardList = (n.cards || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                for (const c of cardList) {
                    todayFlatCards.push({ nodeId: n._id, cardId: c.cardId });
                }
            }

            const cardsWithProblems: Array<{ nodeId: string; cardId: string }> = [];
            for (const item of todayFlatCards) {
                const cardDoc = await CardModel.get(finalDomainId, new ObjectId(item.cardId));
                if (cardDoc && cardDoc.problems && cardDoc.problems.length > 0) {
                    cardsWithProblems.push(item);
                }
            }

            const currentCardId = cardIdFromBody ? new ObjectId(cardIdFromBody) : (cardsWithProblems[cardIndexFromBody] ? new ObjectId(cardsWithProblems[cardIndexFromBody].cardId) : null);
            if (!currentCardId) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            const card = await CardModel.get(finalDomainId, currentCardId);
            if (!card) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            const currentCardNodeId = card.nodeId;
            await learn.setCardPassed(finalDomainId, this.user._id, currentCardId, currentCardNodeId);
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
            for (const h of answerHistory) {
                if (h.problemId) problemCount++;
            }
            const timeToAdd = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
            await learn.incConsumptionStats(finalDomainId, this.user._id, today, { nodes: 1, cards: 1, problems: problemCount, practices: 1, ...(timeToAdd > 0 ? { totalTime: timeToAdd } : {}) });

            const nextIndex = (Number.isNaN(cardIndexFromBody) ? 0 : cardIndexFromBody) + 1;
            if (nextIndex < cardsWithProblems.length) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson?today=1&cardIndex=${nextIndex}` };
            } else {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
            }
            return;
        }

        if (nodeIdFromBody) {
            const branch = 'main';
            const branchData = getBranchData(base, branch);
            const nodes = branchData.nodes || [];
            const edges = branchData.edges || [];
            if (nodes.length === 0) throw new NotFoundError('No nodes available');
            const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (k: string) => this.translate(k));
            const allDagNodes = result.dag;
            const nodeMap = new Map<string, LearnDAGNode>();
            result.sections.forEach((n: LearnDAGNode) => nodeMap.set(n._id, n));
            allDagNodes.forEach((n: LearnDAGNode) => nodeMap.set(n._id, n));
            const getChildNodes = (parentId: string): LearnDAGNode[] =>
                allDagNodes
                    .filter((n: LearnDAGNode) => n.requireNids && n.requireNids[n.requireNids.length - 1] === parentId)
                    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            const flatCardsRaw: Array<{ nodeId: string; cardId: string }> = [];
            const collectUnder = (nid: string) => {
                const node = nodeMap.get(nid);
                if (!node) return;
                for (const c of (node.cards || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
                    flatCardsRaw.push({ nodeId: node._id, cardId: c.cardId });
                }
                for (const ch of getChildNodes(nid)) collectUnder(ch._id);
            };
            collectUnder(nodeIdFromBody);
            const noImpression = body.noImpression === true;
            const currentCardId = cardIdFromBody ? new ObjectId(cardIdFromBody) : (flatCardsRaw[cardIndexFromBody] ? new ObjectId(flatCardsRaw[cardIndexFromBody].cardId) : null);
            if (!currentCardId) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            const card = await CardModel.get(finalDomainId, currentCardId);
            if (!card) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            const currentCardNodeId = card.nodeId;
            const totalTimeMs = (typeof totalTime === 'number' && totalTime >= 0) ? totalTime : 0;
            const dudocPass = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const timesMs: number[] = Array.isArray(dudocPass?.lessonCardTimesMs) ? [...dudocPass.lessonCardTimesMs] : [];
            timesMs.push(totalTimeMs);
            if (noImpression) {
                const reviewIds: string[] = Array.isArray(dudocPass?.lessonReviewCardIds) ? [...dudocPass.lessonReviewCardIds] : [];
                if (!reviewIds.includes(currentCardId.toString())) reviewIds.push(currentCardId.toString());
                await learn.setUserLearnState(finalDomainId, this.user._id, { lessonReviewCardIds: reviewIds, lessonCardTimesMs: timesMs, lessonUpdatedAt: new Date() });
            } else if (answerHistory.length > 0) {
                await learn.setCardPassed(finalDomainId, this.user._id, currentCardId, currentCardNodeId);
                const score = answerHistory.length * 5;
                await learn.addResult(finalDomainId, this.user._id, {
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
                for (const h of answerHistory) {
                    if ((h as any).problemId) problemCount++;
                }
                const timeToAdd = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
                await learn.incConsumptionStats(finalDomainId, this.user._id, today, { nodes: 1, cards: 1, problems: problemCount, practices: 1, ...(timeToAdd > 0 ? { totalTime: timeToAdd } : {}) });
                const reviewIdsPass: string[] = Array.isArray(dudocPass?.lessonReviewCardIds) ? dudocPass.lessonReviewCardIds : [];
                const nextReviewIds = reviewIdsPass.filter(id => id !== currentCardId.toString());
                await learn.setUserLearnState(finalDomainId, this.user._id, { lessonReviewCardIds: nextReviewIds, lessonCardTimesMs: timesMs, lessonUpdatedAt: new Date() });
            } else {
                // 卡片 view「Know it」：无题目时当作判断题通过，记 pass 并写入 result（不跳 result 页，走下方下一张 / node-result）
                await learn.setCardPassed(finalDomainId, this.user._id, currentCardId, currentCardNodeId);
                const browseHistory = [{ problemId: 'browse_judge', correct: true, selected: 0, timeSpent: totalTime || 0, attempts: 1 }];
                await learn.addResult(finalDomainId, this.user._id, {
                    cardId: currentCardId,
                    nodeId: currentCardNodeId,
                    answerHistory: browseHistory,
                    totalTime: totalTime || 0,
                    score: 5,
                    createdAt: new Date(),
                });
                await bus.parallel('learn_result/add', finalDomainId);
                const timeToAdd = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
                await learn.incConsumptionStats(finalDomainId, this.user._id, moment.utc().format('YYYY-MM-DD'), { nodes: 1, cards: 1, problems: 1, practices: 1, ...(timeToAdd > 0 ? { totalTime: timeToAdd } : {}) });
                const reviewIdsKnow: string[] = Array.isArray(dudocPass?.lessonReviewCardIds) ? dudocPass.lessonReviewCardIds : [];
                const nextReviewIdsKnow = reviewIdsKnow.filter(id => id !== currentCardId.toString());
                await learn.setUserLearnState(finalDomainId, this.user._id, { lessonReviewCardIds: nextReviewIdsKnow, lessonCardTimesMs: timesMs, lessonUpdatedAt: new Date() });
            }
            const nextIndex = cardIndexFromBody + 1;
            if (nextIndex < flatCardsRaw.length) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson?nodeId=${encodeURIComponent(nodeIdFromBody)}&cardIndex=${nextIndex}` };
                return;
            }
            const dudoc2 = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const reviewIds2: string[] = Array.isArray(dudoc2?.lessonReviewCardIds) ? dudoc2.lessonReviewCardIds : [];
            if (reviewIds2.length > 0) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson?nodeId=${encodeURIComponent(nodeIdFromBody)}&reviewCardId=${encodeURIComponent(reviewIds2[0])}` };
            } else {
                await learn.setUserLearnState(finalDomainId, this.user._id, {
                    lessonMode: null,
                    lessonNodeId: null,
                    lessonCardIndex: 0,
                    lessonCardTimesMs: [],
                    lessonUpdatedAt: new Date(),
                });
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson/node-result?nodeId=${encodeURIComponent(nodeIdFromBody)}` };
            }
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

        if (currentCardNodeId) {
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

        let problemStats: Array<{ problem: any; totalTime: number; attempts: number; correct: boolean }>;
        if (allProblems.length === 0 && result.answerHistory && result.answerHistory.length > 0) {
            // 卡片 view 判断题结果（无题目，仅 Know it / No impression）
            const judgeLabel = this.translate('Know it') + ' / ' + this.translate('No impression');
            problemStats = result.answerHistory.map((h: any) => ({
                problem: { stem: h.problemId === 'browse_judge' ? judgeLabel : String(h.problemId), pid: h.problemId, options: [], answer: 0 },
                totalTime: h.timeSpent || 0,
                attempts: h.attempts || 1,
                correct: !!h.correct,
            }));
        } else {
            problemStats = allProblems.map(problem => {
                const history = (result.answerHistory || []).filter((h: any) => h.problemId === problem.pid);
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
        }

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

class LessonNodeResultHandler extends Handler {
    async after(domainId: string) {
        if (this.request.json || !this.response.template) return;
        this.response.body.overrideNav = [
            { name: 'homepage', args: {}, displayName: this.translate('Home'), checker: () => true },
            { name: 'learn', args: {}, displayName: this.translate('Learn'), checker: () => true },
        ];
    }

    async get(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const nodeId = this.request.query?.nodeId as string | undefined;
        if (!nodeId) throw new ValidationError('nodeId is required');

        const base = await BaseModel.getByDomain(finalDomainId);
        if (!base) throw new NotFoundError('Base not found for this domain');

        const branch = 'main';
        const branchData = getBranchData(base, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        if (nodes.length === 0) throw new NotFoundError('No nodes available');

        const result = await generateDAG(finalDomainId, base.docId, nodes, edges, (k: string) => this.translate(k));
        const allDagNodes = result.dag;
        const nodeMap = new Map<string, LearnDAGNode>();
        result.sections.forEach((n: LearnDAGNode) => nodeMap.set(n._id, n));
        allDagNodes.forEach((n: LearnDAGNode) => nodeMap.set(n._id, n));
        const rootNode = nodeMap.get(nodeId);
        if (!rootNode) throw new NotFoundError('Node not found');

        const getChildNodes = (parentId: string): LearnDAGNode[] =>
            allDagNodes
                .filter((n: LearnDAGNode) => n.requireNids && n.requireNids[n.requireNids.length - 1] === parentId)
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const flatCards: Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string }> = [];
        const collectUnder = (nid: string) => {
            const node = nodeMap.get(nid);
            if (!node) return;
            for (const c of (node.cards || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
                flatCards.push({ nodeId: node._id, cardId: c.cardId, nodeTitle: node.title || '', cardTitle: c.title || '' });
            }
            for (const ch of getChildNodes(nid)) collectUnder(ch._id);
        };
        collectUnder(nodeId);
        const cardIdsSet = new Set(flatCards.map(c => c.cardId));
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
        const allResults = await learn.getResults(finalDomainId, this.user._id, {
            createdAt: { $gte: thirtyMinAgo, $lte: new Date() },
        });
        const recentForNode = allResults
            .filter((r: any) => cardIdsSet.has(String(r.cardId)))
            .sort((a: any, b: any) => (a.createdAt?.getTime?.() ?? 0) - (b.createdAt?.getTime?.() ?? 0));
        const seenCardIds = new Set<string>();
        const resultsInOrder: any[] = [];
        for (const r of recentForNode) {
            const cid = String(r.cardId);
            if (!seenCardIds.has(cid)) {
                seenCardIds.add(cid);
                resultsInOrder.push(r);
            }
        }

        const cardResults: Array<{
            card: any;
            node: any;
            problemStats: Array<{ problem: any; totalTime: number; attempts: number; correct: boolean }>;
            totalTime: number;
            resultId: string;
            cardTitle: string;
        }> = [];
        let totalCorrect = 0;
        let totalProblems = 0;
        let totalTime = 0;
        const judgeLabel = this.translate('Know it') + ' / ' + this.translate('No impression');

        for (let i = 0; i < flatCards.length; i++) {
            const item = flatCards[i];
            const res = resultsInOrder.find((r: any) => String(r.cardId) === item.cardId);
            if (!res) continue;
            const cardDoc = await CardModel.get(finalDomainId, res.cardId);
            if (!cardDoc) continue;
            const nodeDoc = (getBranchData(base, 'main').nodes || []).find((n: BaseNode) => n.id === res.nodeId);
            const allProblems = (cardDoc.problems || []).map((p: any, idx: number) => ({ ...p, index: idx }));
            let problemStats: Array<{ problem: any; totalTime: number; attempts: number; correct: boolean }>;
            if (allProblems.length === 0 && res.answerHistory && res.answerHistory.length > 0) {
                problemStats = (res.answerHistory as any[]).map((h: any) => {
                    totalCorrect += h.correct ? 1 : 0;
                    totalProblems++;
                    return {
                        problem: { stem: h.problemId === 'browse_judge' ? judgeLabel : String(h.problemId), pid: h.problemId },
                        totalTime: h.timeSpent || 0,
                        attempts: h.attempts || 1,
                        correct: !!h.correct,
                    };
                });
            } else {
                problemStats = allProblems.map((problem: any) => {
                    const history = (res.answerHistory || []).filter((h: any) => h.problemId === problem.pid);
                    const correctHistory = history.filter((h: any) => h.correct);
                    const problemTime = history.reduce((sum: number, h: any) => sum + (h.timeSpent || 0), 0);
                    const attempts = history.length > 0 ? Math.max(...history.map((h: any) => h.attempts || 1)) : 0;
                    if (correctHistory.length > 0) totalCorrect++;
                    totalProblems++;
                    return { problem, totalTime: problemTime, attempts, correct: correctHistory.length > 0 };
                });
            }
            totalTime += res.totalTime || 0;
            cardResults.push({
                card: cardDoc,
                node: nodeDoc,
                problemStats,
                totalTime: res.totalTime || 0,
                resultId: res._id.toString(),
                cardTitle: item.cardTitle || cardDoc.title || '',
            });
        }

        const accuracy = totalProblems > 0 ? Math.round((totalCorrect / totalProblems) * 100) : 0;

        this.response.template = 'lesson_node_result.html';
        this.response.body = {
            domainId: finalDomainId,
            baseDocId: base.docId.toString(),
            rootNodeTitle: rootNode.title || '',
            rootNodeId: nodeId,
            cardResults,
            aggregate: { totalCorrect, totalProblems, totalTime, accuracy },
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
        // 原样保存，不去重：每人 learnSectionOrder 可含重复 section id
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
    ctx.Route('learn_lesson_result', '/learn/lesson/result/:resultId', LessonHandler);
    ctx.Route('learn_lesson_pass', '/learn/lesson/pass', LessonHandler);
    ctx.Route('learn_lesson_node_result', '/learn/lesson/node-result', LessonNodeResultHandler);
}

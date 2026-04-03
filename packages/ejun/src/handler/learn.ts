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
import { appendUserCheckinDay, countConsecutiveCheckinDays } from '../lib/checkin';
import { getModeBaseDocId, getModeDailyGoal } from '../lib/learnModePrefs';
import TrainingModel from '../model/training';
import SessionModel, { type LessonCardQueueItem, type SessionDoc } from '../model/session';
import {
    appendLessonSessionToUrl,
    lessonSessionIdFromDoc,
    mergeDomainLessonState,
    resolveLessonSessionDoc,
    touchLessonSession,
} from '../lib/lessonSession';
import { deriveSessionLearnStatus, deriveSessionRecordType } from '../lib/sessionListDisplay';
import RecordModel, { type RecordDoc } from '../model/record';
import {
    buildSessionRecordHistoryRows,
    lessonHistoryRowsToWire,
    summarizeRecordDoc,
} from './record';
import { sessionDocToWire } from './session';

function utcLessonQueueDayString(): string {
    return moment.utc().format('YYYY-MM-DD');
}

const LESSON_QUEUE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True if today's frozen queue matches current UTC calendar day (lessonQueueDay). */
function lessonTodayFrozenQueueIsValid(sdoc: { lessonQueueDay?: string | null; lessonMode?: string | null } | null | undefined): boolean {
    if (!sdoc || sdoc.lessonMode !== 'today') return false;
    const ymd = utcLessonQueueDayString();
    const raw = sdoc.lessonQueueDay;
    if (typeof raw !== 'string' || !LESSON_QUEUE_DAY_RE.test(raw.trim())) return false;
    return raw.trim() === ymd;
}

function learnRecordProblemIds(card: { problems?: Array<{ pid?: string }> } | null | undefined): string[] {
    const raw = (card?.problems || [])
        .map((p) => p.pid)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return raw.length > 0 ? raw : ['browse_judge'];
}

function learnRecordScoreFromDoc(doc: Pick<RecordDoc, 'problems'> | null | undefined): number {
    if (!doc?.problems?.length) return 0;
    return doc.problems.filter((p) => p.status === 'correct').length * 5;
}

async function ensureLearnRecordForCard(
    cardDomainId: string,
    uid: number,
    querySessionId: string | undefined | null,
    card: { docId: ObjectId; nodeId: string; problems?: Array<{ pid?: string }> },
    baseDocId: number,
    branch: string,
): Promise<string | null> {
    const sdoc = await resolveLessonSessionDoc(cardDomainId, uid, querySessionId || undefined);
    if (!sdoc?._id) return null;
    const trainingDocId = sdoc.lessonQueueTrainingDocId
        ? String(sdoc.lessonQueueTrainingDocId).trim()
        : undefined;
    const rec = await RecordModel.ensureForCard(
        cardDomainId,
        uid,
        sdoc._id,
        card.docId.toString(),
        card.nodeId || '',
        baseDocId,
        branch,
        learnRecordProblemIds(card),
        trainingDocId || undefined,
    );
    return rec._id.toHexString();
}

async function syncLearnPassToRecord(
    cardDomainId: string,
    uid: number,
    querySessionId: string | undefined | null,
    card: { docId: ObjectId; nodeId: string; problems?: Array<{ pid?: string }> },
    baseDocId: number,
    branch: string,
    answerHistory: Array<{
        problemId?: string;
        correct?: boolean;
        selected?: number;
        timeSpent?: number;
        attempts?: number;
    }>,
): Promise<number | null> {
    const sdoc = await resolveLessonSessionDoc(cardDomainId, uid, querySessionId || undefined);
    if (!sdoc?._id) return null;
    const trainingDocId = sdoc.lessonQueueTrainingDocId
        ? String(sdoc.lessonQueueTrainingDocId).trim()
        : undefined;
    const rec = await RecordModel.ensureForCard(
        cardDomainId,
        uid,
        sdoc._id,
        card.docId.toString(),
        card.nodeId || '',
        baseDocId,
        branch,
        learnRecordProblemIds(card),
        trainingDocId || undefined,
    );
    for (const h of answerHistory) {
        const pid = h.problemId;
        if (!pid) continue;
        const status =
            h.correct === true ? ('correct' as const)
            : h.correct === false ? ('wrong' as const)
            : ('skipped' as const);
        await RecordModel.patchProblem(cardDomainId, rec._id, pid, {
            status,
            selected: typeof h.selected === 'number' ? h.selected : undefined,
            attempts: typeof h.attempts === 'number' ? h.attempts : undefined,
            timeSpentMs: typeof h.timeSpent === 'number' ? h.timeSpent : undefined,
        });
    }
    const fresh = await RecordModel.get(cardDomainId, rec._id);
    return learnRecordScoreFromDoc(fresh);
}

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

async function ensureLearnPageSessionId(domainId: string, uid: number): Promise<string> {
    let s = await SessionModel.get(domainId, uid);
    if (!s) {
        s = await touchLessonSession(domainId, uid, { appRoute: 'learn', route: 'learn' }, { silent: true });
    }
    return lessonSessionIdFromDoc(s);
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

/** 将数组循环填充到指定长度（daily goal > card 数量时循环消费） */
function cycleList<T>(arr: T[], length: number): T[] {
    if (length <= 0 || arr.length === 0) return [];
    const out: T[] = [];
    for (let i = 0; i < length; i++) out.push(arr[i % arr.length]);
    return out;
}

async function getLearnTrainingSelection(domainId: string, uid: number, priv: number) {
    const trainings = await TrainingModel.getByDomain(domainId);
    trainings.sort((a, b) => {
        const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return tb - ta;
    });
    if (!trainings.length) {
        return {
            trainings,
            selectedTraining: null as any,
            selectedTrainingDocId: null as string | null,
            selectedBase: null as BaseDoc | null,
        };
    }
    const dudoc = await learn.getUserLearnState(domainId, { _id: uid, priv }) as any;
    const selectedTrainingDocId = dudoc?.learnTrainingDocId ? String(dudoc.learnTrainingDocId) : null;
    const selectedTraining = selectedTrainingDocId
        ? (trainings.find((t: any) => String(t.docId) === selectedTrainingDocId) || null)
        : null;
    let selectedBase: BaseDoc | null = null;
    let selectedBaseDocId = selectedTraining
        ? Number(dudoc?.learnBaseDocId || 0)
        : (getModeBaseDocId(dudoc, 'learn') ?? null);

    // Auto-correct training base/branch selection:
    // prefer a plan source that has ANY cards in its target branch (no-problem cards included).
    if (selectedTraining) {
        const sources = TrainingModel.resolvePlanSources(selectedTraining as any);
        let picked = sources?.[0];
        for (const s of (sources || [])) {
            const b = Number((s as any)?.baseDocId || 0);
            const br = String((s as any)?.targetBranch || 'main') || 'main';
            if (!Number.isFinite(b) || b <= 0) continue;
            const filter: any = { domainId, docType: 71, baseDocId: b };
            if (br === 'main') {
                filter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
            } else {
                filter.branch = br;
            }
            const anyCard = await db.collection('document' as any).find(filter).limit(1).toArray();
            if (anyCard.length) {
                picked = s;
                break;
            }
        }
        const pickedBaseDocId = Number(picked?.baseDocId || 0);
        const pickedBranch = String(picked?.targetBranch || 'main') || 'main';
        if (Number.isFinite(pickedBaseDocId) && pickedBaseDocId > 0) {
            if (Number(dudoc?.learnBaseDocId || 0) !== pickedBaseDocId || String(dudoc?.learnBranch || 'main') !== pickedBranch) {
                await learn.setUserLearnState(domainId, uid, { learnBaseDocId: pickedBaseDocId, learnBranch: pickedBranch } as any);
            }
            selectedBaseDocId = pickedBaseDocId;
        }
    }
    if (selectedBaseDocId !== null && Number.isFinite(selectedBaseDocId) && selectedBaseDocId > 0) {
        selectedBase = await BaseModel.get(domainId, Number(selectedBaseDocId));
    }
    return { trainings, selectedTraining, selectedTrainingDocId, selectedBase };
}

async function requireSelectedLearnBase(domainId: string, uid: number, priv: number): Promise<BaseDoc> {
    const { selectedBase } = await getLearnTrainingSelection(domainId, uid, priv);
    if (!selectedBase) throw new ValidationError('Please select a base for learning first');
    return selectedBase;
}

async function saveLearnTrainingForUser(
    domainId: string,
    uid: number,
    trainingDocId: string,
    translate: (key: string) => string,
) {
    if (!ObjectId.isValid(trainingDocId)) throw new ValidationError('Invalid trainingDocId');
    const training = await TrainingModel.get(domainId, new ObjectId(trainingDocId));
    if (!training) throw new NotFoundError('Training not found');
    const sources = TrainingModel.resolvePlanSources(training as any);

    // Prefer a plan source that actually has cards in its target branch (no-problem cards included).
    // Otherwise, fall back to the first source (legacy behavior).
    let picked = sources?.[0];
    for (const s of (sources || [])) {
        const b = Number((s as any)?.baseDocId || 0);
        const br = String((s as any)?.targetBranch || 'main') || 'main';
        if (!Number.isFinite(b) || b <= 0) continue;
        const filter: any = { domainId, docType: 71, baseDocId: b };
        if (br === 'main') {
            filter.$or = [{ branch: 'main' }, { branch: { $exists: false } }];
        } else {
            filter.branch = br;
        }
        const anyCard = await db.collection('document' as any).find(filter).limit(1).toArray();
        if (anyCard.length) {
            picked = s;
            break;
        }
    }

    const baseDocId = Number(picked?.baseDocId || 0);
    const branch = String(picked?.targetBranch || 'main') || 'main';
    if (!Number.isFinite(baseDocId) || baseDocId <= 0) throw new ValidationError('Invalid training base');
    const base = await BaseModel.get(domainId, baseDocId);
    if (base) {
        const branchData = getBranchData(base, branch);
        const nodes = branchData.nodes || [];
        const edges = branchData.edges || [];
        if (nodes.length > 0) {
            const generated = await generateDAG(domainId, base.docId, nodes, edges, translate);
            const baseVersion = base.updateAt ? base.updateAt.getTime() : 0;
            await learn.setDAG(domainId, base.docId, branch, {
                sections: generated.sections,
                dag: generated.dag,
                version: baseVersion,
                updateAt: new Date(),
            });
        }
    }
    await learn.setUserLearnState(domainId, uid, {
        learnTrainingDocId: training.docId,
        learnBaseDocId: baseDocId,
        learnBranch: branch,
        currentLearnSectionId: null,
        currentLearnSectionIndex: 0,
        lessonUpdatedAt: new Date(),
    });
    await touchLessonSession(domainId, uid, {
        appRoute: 'learn',
        route: 'learn',
        lessonMode: null,
        nodeId: null,
        cardIndex: null,
        currentLearnSectionIndex: 0,
        currentLearnSectionId: null,
        lessonReviewCardIds: [],
        lessonCardTimesMs: [],
    }, { silent: true });
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
    baseDocId: number | ObjectId,
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
                name: 'learn_sections',
                args: {},
                displayName: this.translate('Sections'),
                checker: () => true,
            },
        ];
    }

    async post(domainId: string) {
        if (this.request.path.includes('/base')) {
            return this.postSetBase(domainId);
        }
        if (this.request.path.includes('/daily-goal')) {
            return this.postSetDailyGoal(domainId);
        }
    }

    async postSetBase(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body: any = this.request?.body || {};
        const trainingDocId = String(body.trainingDocId || '').trim();
        if (!ObjectId.isValid(trainingDocId)) {
            throw new ValidationError('Invalid trainingDocId');
        }
        await saveLearnTrainingForUser(finalDomainId, this.user._id, trainingDocId, (key: string) => this.translate(key));
        this.response.body = { success: true, trainingDocId };
    }

    async postSetDailyGoal(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body: any = this.request?.body || {};
        const dailyGoal = parseInt(body.dailyGoal || '0', 10);

        if (isNaN(dailyGoal) || dailyGoal < 0) {
            throw new ValidationError('Invalid daily goal');
        }

        if (dailyGoal > 0) {
            const base = await requireSelectedLearnBase(finalDomainId, this.user._id, this.user.priv);
            if (!base) throw new NotFoundError('Base not found');
            const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const branch = (dudoc as any)?.learnBranch || 'main';
            const branchData = getBranchData(base, branch);
            const nodes = branchData.nodes || [];
            const edges = branchData.edges || [];

            let existingDAG = await learn.getDAG(finalDomainId, base.docId, branch);
            const baseVersion = base.updateAt ? base.updateAt.getTime() : 0;
            const needsRegenerate = !existingDAG || (existingDAG.version || 0) < baseVersion;
            if (needsRegenerate && nodes.length > 0) {
                const generated = await generateDAG(finalDomainId, base.docId, nodes, edges, (key: string) => this.translate(key));
                await learn.setDAG(finalDomainId, base.docId, branch, {
                    sections: generated.sections,
                    dag: generated.dag,
                    version: baseVersion,
                    updateAt: new Date(),
                });
                existingDAG = await learn.getDAG(finalDomainId, base.docId, branch);
            }

            const sections: LearnDAGNode[] = existingDAG?.sections || [];
            const allDagNodes: LearnDAGNode[] = existingDAG?.dag || [];
            if (sections.length === 0) {
                throw new ValidationError(this.translate('No cards in this domain') || '该域暂无题目卡片');
            }
            const savedSectionIndex = (dudoc as any)?.currentLearnSectionIndex;
            const currentSectionIndex = typeof savedSectionIndex === 'number' && savedSectionIndex >= 0 && savedSectionIndex < sections.length
                ? savedSectionIndex
                : 0;
            const finalSectionId = sections[currentSectionIndex]?._id ?? sections[0]._id;
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
            const cardIdsToCheck: string[] = [];
            for (const node of dag) {
                const n = nodeMap.get(node._id);
                if (!n) continue;
                for (const c of (n.cards || [])) cardIdsToCheck.push(c.cardId);
            }
            let hasCardWithProblems = false;
            for (const cid of cardIdsToCheck) {
                const cardDoc = await CardModel.get(finalDomainId, new ObjectId(cid));
                if (cardDoc?.problems?.length) {
                    hasCardWithProblems = true;
                    break;
                }
            }
            // Fallback: if section-local scan doesn't hit, check the selected base globally.
            if (!hasCardWithProblems) {
                const cardColl = this.ctx.db.db.collection('document');
                const anyProblemCard = await cardColl.findOne({
                    domainId: finalDomainId,
                    docType: 71,
                    baseDocId: base.docId,
                    problems: { $exists: true, $ne: [] },
                });
                hasCardWithProblems = !!anyProblemCard;
            }
            if (!hasCardWithProblems) {
                throw new ValidationError(this.translate('No cards with problems in this domain') || '该域暂无带题目的卡片');
            }
        }

        await learn.setUserLearnState(finalDomainId, this.user._id, { learnDailyGoal: dailyGoal });

        this.response.body = { success: true, dailyGoal };
    }

    @param('sectionId', Types.String, true)
    async get(domainId: string, sectionId?: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const { trainings, selectedTraining, selectedTrainingDocId, selectedBase } = await getLearnTrainingSelection(finalDomainId, this.user._id, this.user.priv);
        const learnTrainings = trainings.map((item: any) => {
            const first = TrainingModel.resolvePlanSources(item as any)?.[0];
            return { docId: String(item.docId), name: item.name || '', baseDocId: Number(first?.baseDocId) || 0 };
        });
        // If the selected training has been deleted, clear selection so UI shows "pending selection".
        if (selectedTrainingDocId && !selectedTraining) {
            await learn.setUserLearnState(finalDomainId, this.user._id, {
                learnTrainingDocId: null,
                learnBaseDocId: null,
                learnBranch: 'main',
                currentLearnSectionId: null,
                currentLearnSectionIndex: 0,
            });
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                lessonMode: null,
                nodeId: null,
                cardIndex: null,
                currentLearnSectionIndex: 0,
                currentLearnSectionId: null,
            }, { silent: true });
        }
        let base = selectedBase;
        if (!trainings.length) {
            this.response.template = 'learn.html';
            this.response.body = {
                dag: [],
                domainId: finalDomainId,
                baseDocId: null,
                learnTrainings: [],
                selectedLearnTrainingDocId: null,
                requireBaseSelection: false,
                lessonSessionId: await ensureLearnPageSessionId(finalDomainId, this.user._id),
            };
            return;
        }
        if (!base) {
            this.response.template = 'learn.html';
            this.response.body = {
                dag: [],
                fullDag: [],
                sections: [],
                currentSectionId: null,
                currentSectionIndex: 0,
                domainId: finalDomainId,
                baseDocId: null,
                learnTrainings,
                selectedLearnTrainingDocId: selectedTraining ? String((selectedTraining as any).docId) : null,
                requireBaseSelection: true,
                pendingNodeList: [],
                completedSections: [],
                completedCardsToday: [],
                passedCardIds: [],
                lessonSessionId: await ensureLearnPageSessionId(finalDomainId, this.user._id),
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
                learnTrainings,
                selectedLearnTrainingDocId: selectedTraining ? String((selectedTraining as any).docId) : selectedTrainingDocId,
                requireBaseSelection: false,
                lessonSessionId: await ensureLearnPageSessionId(finalDomainId, this.user._id),
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
        const sdocMain = await SessionModel.get(finalDomainId, this.user._id);
        const Lsec = mergeDomainLessonState(dudoc, sdocMain);
        const savedSectionIndex = Lsec.currentLearnSectionIndex;
        const savedSectionId = Lsec.currentLearnSectionId;
        const dailyGoal = getModeDailyGoal(dudoc as any, 'learn');
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
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                currentLearnSectionIndex: currentSectionIndex,
                currentLearnSectionId: finalSectionId,
            }, { silent: true });
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
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                currentLearnSectionIndex: currentSectionIndex,
                currentLearnSectionId: sectionId,
            }, { silent: true });
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
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                currentLearnSectionIndex: currentSectionIndex,
                currentLearnSectionId: savedSectionId,
            }, { silent: true });
        } else if (sections.length > 0) {
            finalSectionId = sections[0]._id;
            currentSectionIndex = 0;
            await learn.setUserLearnState(finalDomainId, this.user._id, {
                currentLearnSectionId: finalSectionId,
                currentLearnSectionIndex: 0,
                learnProgressPosition: 0,
                learnProgressTotal: totalSectionsForProgress,
            });
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                currentLearnSectionIndex: 0,
                currentLearnSectionId: finalSectionId,
            }, { silent: true });
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

        const learnActivityDates: string[] = Array.isArray((dudoc as any)?.learnActivityDates)
            ? (dudoc as any).learnActivityDates.map((x: unknown) => String(x))
            : [];

        const todayStart = moment.utc().startOf('day').toDate();
        const todayEnd = moment.utc().add(1, 'day').startOf('day').toDate();
        let todayCompletedCount = 0;
        const todayResultCardIds = new Set<string>();
        for (const result of allResults) {
            if (result.createdAt) {
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

        const totalCheckinDays = learnActivityDates.length;
        const consecutiveDays = countConsecutiveCheckinDays(learnActivityDates);

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
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                currentLearnSectionIndex: nextIndex,
                currentLearnSectionId: nextSectionId,
            }, { silent: true });
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
            learnTrainings,
            selectedLearnTrainingDocId: selectedTraining ? String((selectedTraining as any).docId) : selectedTrainingDocId,
            requireBaseSelection: false,
            lessonSessionId: await ensureLearnPageSessionId(finalDomainId, this.user._id),
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
        const base = await requireSelectedLearnBase(finalDomainId, this.user._id, this.user.priv);
        
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
        const base = await requireSelectedLearnBase(domainId, this.user._id, this.user.priv);
        
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

type LessonTranslate = (key: string) => string;

function lessonSnapshotToJson(snapshot: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(snapshot, (_key, value) => {
        if (value instanceof ObjectId) return value.toHexString();
        if (value instanceof Date) return value.toISOString();
        return value;
    })) as Record<string, unknown>;
}

/** Pass 后无刷新「下一题」：构造与 lesson.html 注入一致的 body（再 JSON 安全化） */
async function buildSpaLessonSnapshotToday(
    translate: LessonTranslate,
    finalDomainId: string,
    uid: number,
    priv: number,
    qSession: string | undefined,
): Promise<Record<string, unknown> | null> {
    const sToday = await resolveLessonSessionDoc(finalDomainId, uid, qSession || undefined);
    if (!sToday?.lessonCardQueue?.length || sToday.lessonMode !== 'today' || !lessonTodayFrozenQueueIsValid(sToday)) return null;
    const cardsForToday = sToday.lessonCardQueue.map((q) => ({
        domainId: q.domainId || finalDomainId,
        nodeId: q.nodeId,
        cardId: q.cardId,
        nodeTitle: q.nodeTitle || '',
        cardTitle: q.cardTitle || '',
    }));
    let currentCardIndex = typeof sToday.cardIndex === 'number' ? sToday.cardIndex : 0;
    if (currentCardIndex >= cardsForToday.length) return null;
    const currentItem = cardsForToday[currentCardIndex];
    const cardDomain = currentItem.domainId || finalDomainId;
    const dudocSpaToday = await learn.getUserLearnState(cardDomain, { _id: uid, priv }) as any;
    const branch = dudocSpaToday?.learnBranch || 'main';
    let baseCard: BaseDoc;
    try {
        baseCard = await requireSelectedLearnBase(cardDomain, uid, priv);
    } catch {
        return null;
    }
    const currentCard = await CardModel.get(cardDomain, new ObjectId(currentItem.cardId));
    if (!currentCard) return null;
    const currentNode = (getBranchData(baseCard, branch).nodes || []).find((n: BaseNode) => n.id === currentItem.nodeId);
    if (!currentNode) return null;
    const currentCardList = await CardModel.getByNodeId(cardDomain, baseCard.docId, currentItem.nodeId);
    const currentIndexInNode = currentCardList.findIndex((c: any) => c.docId.toString() === currentItem.cardId);
    const todayNodeTree = [{
        type: 'node' as const,
        id: 'today',
        title: translate('Today task') || '今日任务',
        children: cardsForToday.map(c => ({ type: 'card' as const, id: c.cardId, title: c.cardTitle })),
    }];
    const sid = lessonSessionIdFromDoc(sToday);
    const learnRecordIdSpaToday = await ensureLearnRecordForCard(
        cardDomain,
        uid,
        qSession,
        currentCard as any,
        baseCard.docId,
        branch,
    );
    return {
        card: currentCard,
        node: currentNode,
        cards: currentCardList,
        currentIndex: currentIndexInNode >= 0 ? currentIndexInNode : 0,
        domainId: cardDomain,
        baseDocId: baseCard.docId.toString(),
        isAlonePractice: false,
        isSingleNodeMode: false,
        isTodayMode: true,
        rootNodeId: 'today',
        rootNodeTitle: translate('Today task') || '今日任务',
        flatCards: cardsForToday,
        nodeTree: todayNodeTree,
        currentCardIndex,
        hasProblems: !!(currentCard?.problems?.length),
        lessonSessionId: sid,
        lessonSessionDomainId: finalDomainId,
        learnRecordId: learnRecordIdSpaToday || '',
    };
}

async function buildSpaLessonSnapshotNode(
    translate: LessonTranslate,
    finalDomainId: string,
    lessonNodeId: string,
    uid: number,
    priv: number,
    qSession: string | undefined,
): Promise<Record<string, unknown> | null> {
    let base: BaseDoc;
    try {
        base = await requireSelectedLearnBase(finalDomainId, uid, priv);
    } catch {
        return null;
    }
    const dudoc = await learn.getUserLearnState(finalDomainId, { _id: uid, priv }) as any;
    const branch = dudoc?.learnBranch || 'main';
    const sNode = await resolveLessonSessionDoc(finalDomainId, uid, qSession || undefined);
    const queue = sNode?.lessonCardQueue ?? [];
    if (!queue.length || sNode?.lessonMode !== 'node') return null;
    const flatCards = queue.map((q) => ({
        nodeId: q.nodeId,
        cardId: q.cardId,
        nodeTitle: q.nodeTitle || '',
        cardTitle: q.cardTitle || '',
    }));
    let currentCardIndex = typeof sNode.cardIndex === 'number' ? sNode.cardIndex : 0;
    if (currentCardIndex >= flatCards.length) return null;
    const anchor = (sNode.lessonQueueAnchorNodeId as string) || lessonNodeId;
    const branchData = getBranchData(base, branch);
    const nodes = branchData.nodes || [];
    const edges = branchData.edges || [];
    if (!nodes.length) return null;
    const dagResult = await generateDAG(finalDomainId, base.docId, nodes, edges, translate);
    const sections = dagResult.sections;
    const allDagNodes = dagResult.dag;
    const nodeMap = new Map<string, LearnDAGNode>();
    sections.forEach(n => nodeMap.set(n._id, n));
    allDagNodes.forEach(n => nodeMap.set(n._id, n));
    const rootNode = nodeMap.get(anchor);
    if (!rootNode) return null;
    const nodeTree = [{
        type: 'node' as const,
        id: rootNode._id,
        title: rootNode.title || '',
        children: flatCards.map((c) => ({ type: 'card' as const, id: c.cardId, title: c.cardTitle })),
    }];
    const currentItem = flatCards[currentCardIndex];
    const L = mergeDomainLessonState(dudoc, sNode);
    const lessonReviewCardIds = [...L.lessonReviewCardIds];
    const lessonCardTimesMs = [...L.lessonCardTimesMs];
    const currentCard = await CardModel.get(finalDomainId, new ObjectId(currentItem.cardId));
    if (!currentCard) return null;
    const currentNode = (getBranchData(base, branch).nodes || []).find((n: BaseNode) => n.id === currentItem.nodeId);
    if (!currentNode) return null;
    const currentCardList = await CardModel.getByNodeId(finalDomainId, base.docId, currentItem.nodeId);
    const currentIndexInNode = currentCardList.findIndex((c: any) => c.docId.toString() === currentItem.cardId);
    const sid = lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, uid));
    const learnRecordIdSpaNode = await ensureLearnRecordForCard(
        finalDomainId,
        uid,
        qSession,
        currentCard as any,
        base.docId,
        branch,
    );
    return {
        card: currentCard,
        node: currentNode,
        cards: currentCardList,
        currentIndex: currentIndexInNode >= 0 ? currentIndexInNode : 0,
        domainId: finalDomainId,
        baseDocId: base.docId.toString(),
        isAlonePractice: false,
        isSingleNodeMode: true,
        isTodayMode: false,
        rootNodeId: anchor,
        rootNodeTitle: rootNode.title || '',
        flatCards,
        nodeTree,
        currentCardIndex,
        hasProblems: !!(currentCard?.problems?.length),
        lessonReviewCardIds,
        lessonCardTimesMs,
        reviewCardId: '',
        lessonSessionId: sid,
        lessonSessionDomainId: finalDomainId,
        learnRecordId: learnRecordIdSpaNode || '',
    };
}

/** 仅用于 ?format=json：按当前 Mongo session 生成与 pass 后 SPA 一致的快照（无刷下一卡 / 恢复界面）。 */
async function tryLessonSpaSnapshotForHandler(
    h: { translate: (key: string) => string },
    finalDomainId: string,
    uid: number,
    priv: number,
    qSession: string | undefined,
): Promise<Record<string, unknown> | null> {
    const dudoc = await learn.getUserLearnState(finalDomainId, { _id: uid, priv }) as any;
    const sdoc = await resolveLessonSessionDoc(finalDomainId, uid, qSession || undefined);
    const L = mergeDomainLessonState(dudoc, sdoc);
    const t = (k: string) => h.translate(k);
    if (L.lessonMode === 'today') {
        return await buildSpaLessonSnapshotToday(t, finalDomainId, uid, priv, qSession);
    }
    if (L.lessonMode === 'node' && L.lessonNodeId) {
        return await buildSpaLessonSnapshotNode(t, finalDomainId, L.lessonNodeId, uid, priv, qSession);
    }
    return null;
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
        if (this.request.path.endsWith('/start')) {
            return this.postLessonStart(domainId);
        }
        throw new MethodNotAllowedError('POST');
    }

    @param('resultId', Types.ObjectId, true)
    async get(domainId: string, resultId?: ObjectId) {
        if (resultId) {
            return this.getResult(domainId, resultId);
        }
        
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const qLessonSession = typeof this.request.query?.session === 'string' ? this.request.query.session.trim() : '';
        const queryCardId = this.request.query?.cardId;

        if (String(this.request.query?.format || '') === 'json') {
            this.response.template = null;
            if (qLessonSession && ObjectId.isValid(qLessonSession)) {
                const sJson = await resolveLessonSessionDoc(finalDomainId, this.user._id, qLessonSession);
                if (sJson && deriveSessionLearnStatus(sJson as SessionDoc) === 'timed_out') {
                    const recordHistoryRows = await buildSessionRecordHistoryRows(
                        finalDomainId,
                        sJson.recordIds,
                        (name, kwargs) => this.url(name, kwargs as any),
                    );
                    const recordSummaries = recordHistoryRows.map((row) => {
                        const s = summarizeRecordDoc(row.rdoc);
                        return {
                            _id: row.rdoc._id,
                            cardId: row.rdoc.cardId,
                            color: s.color,
                            label: s.label,
                            code: s.code,
                        };
                    });
                    this.response.body = {
                        success: false,
                        spaNext: false,
                        error: 'session_timed_out',
                        session: sessionDocToWire(sJson as SessionDoc),
                        recordSummaries,
                        recordHistoryRows: lessonHistoryRowsToWire(recordHistoryRows),
                    };
                    return;
                }
            }
            const snap = await tryLessonSpaSnapshotForHandler(
                this,
                finalDomainId,
                this.user._id,
                this.user.priv,
                qLessonSession || undefined,
            );
            if (!snap) {
                this.response.body = {
                    success: false,
                    spaNext: false,
                    error: 'no_lesson_snapshot',
                };
                return;
            }
            this.response.body = {
                success: true,
                spaNext: true,
                lesson: lessonSnapshotToJson(snap),
            };
            return;
        }

        if (qLessonSession && ObjectId.isValid(qLessonSession) && !queryCardId) {
            const sExpired = await resolveLessonSessionDoc(finalDomainId, this.user._id, qLessonSession);
            if (sExpired && deriveSessionLearnStatus(sExpired as SessionDoc) === 'timed_out') {
                const recordHistoryRows = await buildSessionRecordHistoryRows(
                    finalDomainId,
                    sExpired.recordIds,
                    (name, kwargs) => this.url(name, kwargs as any),
                );
                const recordSummaries = recordHistoryRows.map((row) => {
                    const s = summarizeRecordDoc(row.rdoc);
                    return {
                        _id: row.rdoc._id,
                        cardId: row.rdoc.cardId,
                        color: s.color,
                        label: s.label,
                        code: s.code,
                    };
                });
                const rt = deriveSessionRecordType(sExpired as SessionDoc);
                this.response.template = 'lesson_session_history.html';
                this.response.body = {
                    domainId: finalDomainId,
                    page_name: 'learn_lesson',
                    session: {
                        ...(sExpired as SessionDoc),
                        status: 'timed_out' as const,
                        statusLabel: this.translate('session_status_timed_out'),
                        recordType: rt,
                        recordTypeLabel: this.translate(`session_record_type_${rt}`),
                        recordSummaries,
                    },
                    recordHistoryRows,
                    learnHomeUrl: this.url('learn', { domainId: finalDomainId }),
                };
                return;
            }
        }

        const base = await requireSelectedLearnBase(finalDomainId, this.user._id, this.user.priv);
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }

        const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
        const branch = (dudoc as any)?.learnBranch || 'main';
        const sdocLesson = await resolveLessonSessionDoc(finalDomainId, this.user._id, qLessonSession || undefined);
        const L = mergeDomainLessonState(dudoc, sdocLesson);
        // Lesson mode and position live in Mongo session (+ optional ?session=).
        if ((L.lessonMode as string) === 'allDomains') {
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                route: 'learn',
                lessonMode: null,
                cardIndex: null,
                nodeId: null,
                lessonCardQueue: [],
                lessonQueueDay: null,
            }, { silent: true });
            this.response.redirect = this.url('learn', { domainId: finalDomainId });
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

            const hasCardProblems = !!(card.problems && card.problems.length > 0);
            const node = (getBranchData(base, branch).nodes || []).find(n => n.id === card.nodeId);
            if (hasCardProblems && !node) {
                throw new NotFoundError('Node not found');
            }

            const queryReviewCardId = (this.request.query?.reviewCardId as string) || '';
            const lessonReviewCardIds = [...L.lessonReviewCardIds];
            const lessonCardTimesMs = [...L.lessonCardTimesMs];
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                route: 'learn',
                lessonMode: null,
                nodeId: null,
                cardIndex: null,
            }, { silent: true });

            const nodeForResponse = node || { id: card.nodeId || '', title: '', text: '' };
            const cards = node
                ? await CardModel.getByNodeId(finalDomainId, base.docId, card.nodeId)
                : [card];
            const currentIndex = cards.findIndex((c: any) => c.docId.toString() === cardId.toString());

            const flatCards = [{
                nodeId: nodeForResponse.id || '',
                cardId: card.docId.toString(),
                nodeTitle: (nodeForResponse as any).title || '',
                cardTitle: card.title || '',
            }];

            const learnRecordId = await ensureLearnRecordForCard(
                finalDomainId,
                this.user._id,
                qLessonSession,
                card as any,
                base.docId,
                branch,
            );

            this.response.template = 'lesson.html';
            this.response.body = {
                card,
                node: nodeForResponse,
                cards,
                currentIndex: currentIndex >= 0 ? currentIndex : 0,
                domainId: finalDomainId,
                baseDocId: base.docId.toString(),
                isAlonePractice: true,
                hasProblems: hasCardProblems,
                flatCards,
                nodeTree: [],
                currentCardIndex: 0,
                rootNodeId: nodeForResponse.id || '',
                rootNodeTitle: (nodeForResponse as any).title || '',
                lessonReviewCardIds,
                lessonCardTimesMs,
                reviewCardId: queryReviewCardId,
                lessonSessionId: lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, this.user._id)),
                lessonSessionDomainId: finalDomainId,
                learnRecordId: learnRecordId || '',
            };
            return;
        }

        if (L.lessonMode === 'node' && L.lessonNodeId) {
            const lessonNodeId = L.lessonNodeId;
            const sNode = await resolveLessonSessionDoc(finalDomainId, this.user._id, qLessonSession || undefined);
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
            const rootNode = nodeMap.get(lessonNodeId);
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

            const frozenNode = sNode?.lessonMode === 'node'
                && (sNode.lessonCardQueue?.length ?? 0) > 0
                && sNode.lessonQueueAnchorNodeId === lessonNodeId;
            if (frozenNode) {
                flatCards.push(...sNode!.lessonCardQueue!.map((q) => ({
                    nodeId: q.nodeId,
                    cardId: q.cardId,
                    nodeTitle: q.nodeTitle || '',
                    cardTitle: q.cardTitle || '',
                })));
                nodeTree.push({
                    type: 'node',
                    id: rootNode._id,
                    title: rootNode.title || '',
                    children: flatCards.map((c) => ({ type: 'card' as const, id: c.cardId, title: c.cardTitle })),
                });
            } else {
                nodeTree.push({
                    type: 'node',
                    id: rootNode._id,
                    title: rootNode.title || '',
                    children: collectUnder(lessonNodeId),
                });
                const queueItems: LessonCardQueueItem[] = flatCards.map((fc) => ({
                    domainId: finalDomainId,
                    nodeId: fc.nodeId,
                    cardId: fc.cardId,
                    nodeTitle: fc.nodeTitle,
                    cardTitle: fc.cardTitle,
                }));
                const trainId = (dudoc as any)?.learnTrainingDocId;
                await touchLessonSession(finalDomainId, this.user._id, {
                    appRoute: 'learn',
                    lessonCardQueue: queueItems,
                    lessonQueueAnchorNodeId: lessonNodeId,
                    lessonQueueBaseDocId: base.docId,
                    lessonQueueTrainingDocId: trainId ? String(trainId) : null,
                    lessonQueueDay: null,
                }, { silent: true });
            }

            let currentCardIndex = Math.max(0, L.lessonCardIndex);

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
                    const sReview = await SessionModel.get(finalDomainId, this.user._id);
                    const Rv = mergeDomainLessonState(dudocReview, sReview);
                    const reviewIds: string[] = [...Rv.lessonReviewCardIds];
                    lessonReviewCardIds = reviewIds.filter(id => id !== reviewCardId);
                    lessonCardTimesMs = [...Rv.lessonCardTimesMs];
                    await touchLessonSession(finalDomainId, this.user._id, { appRoute: 'learn', lessonReviewCardIds, lessonCardTimesMs }, { silent: true });
                } else {
                    currentItem = flatCards[currentCardIndex];
                    lessonReviewCardIds = [...L.lessonReviewCardIds];
                    lessonCardTimesMs = [...L.lessonCardTimesMs];
                }
            } else {
                currentItem = flatCards[currentCardIndex];
                lessonReviewCardIds = [...L.lessonReviewCardIds];
                lessonCardTimesMs = [...L.lessonCardTimesMs];
            }

            const currentCard = await CardModel.get(finalDomainId, new ObjectId(currentItem.cardId));
            if (!currentCard) throw new NotFoundError('Card not found');
            const currentNode = (getBranchData(base, branch).nodes || []).find(n => n.id === currentItem.nodeId);
            if (!currentNode) throw new NotFoundError('Node not found');
            const currentCardList = await CardModel.getByNodeId(finalDomainId, base.docId, currentItem.nodeId);
            const currentIndexInNode = currentCardList.findIndex(c => c.docId.toString() === currentItem.cardId);

            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                route: 'learn',
                lessonMode: 'node',
                nodeId: lessonNodeId,
                cardIndex: currentCardIndex,
                baseDocId: base.docId,
                branch,
            }, { silent: false });

            const learnRecordIdNode = await ensureLearnRecordForCard(
                finalDomainId,
                this.user._id,
                qLessonSession,
                currentCard as any,
                base.docId,
                branch,
            );

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
                rootNodeId: lessonNodeId,
                rootNodeTitle: rootNode.title || '',
                flatCards: flatCards,
                nodeTree,
                currentCardIndex,
                hasProblems: !!(currentCard?.problems?.length),
                lessonReviewCardIds,
                lessonCardTimesMs,
                reviewCardId: reviewCardId || '',
                lessonSessionId: lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, this.user._id)),
                lessonSessionDomainId: finalDomainId,
                learnRecordId: learnRecordIdNode || '',
            };
            return;
        }

        if (L.lessonMode === 'today' || L.lessonMode === null) {
            const sToday = await resolveLessonSessionDoc(finalDomainId, this.user._id, qLessonSession || undefined);
            const LT = mergeDomainLessonState(dudoc, sToday);
            const useFrozenToday = sToday?.lessonMode === 'today'
                && Array.isArray(sToday.lessonCardQueue)
                && sToday.lessonCardQueue.length > 0
                && lessonTodayFrozenQueueIsValid(sToday);
            let cardsForToday: Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string; domainId?: string }>;
            if (useFrozenToday) {
                cardsForToday = sToday!.lessonCardQueue!.map((q) => ({
                    domainId: q.domainId || finalDomainId,
                    nodeId: q.nodeId,
                    cardId: q.cardId,
                    nodeTitle: q.nodeTitle || '',
                    cardTitle: q.cardTitle || '',
                }));
            } else {
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

            const savedSectionIndex = LT.currentLearnSectionIndex;
            const savedSectionId = LT.currentLearnSectionId;
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
            // Include the current section itself; some bases are single-level and have no child DAG nodes.
            const nodesForToday = finalSectionId
                ? [{ _id: finalSectionId } as LearnDAGNode, ...dag]
                : dag;
            for (const node of nodesForToday) {
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
            // Fallback: if no problem cards exist, allow "card view mode" (Know it / No impression) to continue learning.
            const candidateCards = cardsWithProblems.length > 0 ? cardsWithProblems : todayFlatCards;
            const dailyGoalToday = Math.max(0, getModeDailyGoal(dudoc as any, 'learn'));
            cardsForToday = dailyGoalToday > 0 ? cycleList(candidateCards, dailyGoalToday) : candidateCards;

            if (cardsForToday.length === 0) {
                if (sections.length > 0 && currentSectionIndex + 1 < sections.length) {
                    await learn.setUserLearnState(finalDomainId, this.user._id, {
                        currentLearnSectionIndex: currentSectionIndex + 1,
                        currentLearnSectionId: sections[currentSectionIndex + 1]._id,
                        lessonUpdatedAt: new Date(),
                    });
                    await touchLessonSession(finalDomainId, this.user._id, {
                        appRoute: 'learn',
                        currentLearnSectionIndex: currentSectionIndex + 1,
                        currentLearnSectionId: sections[currentSectionIndex + 1]._id,
                        lessonMode: 'today',
                        nodeId: null,
                        cardIndex: 0,
                        lessonCardQueue: [],
                        lessonQueueDay: null,
                        baseDocId: base.docId,
                        branch,
                    }, { silent: true });
                    this.response.redirect = appendLessonSessionToUrl(
                        `/d/${finalDomainId}/learn/lesson`,
                        lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, this.user._id)),
                    );
                    return;
                }
                await touchLessonSession(finalDomainId, this.user._id, {
                    appRoute: 'learn',
                    lessonMode: null,
                    nodeId: null,
                    cardIndex: null,
                    lessonCardQueue: [],
                    lessonQueueDay: null,
                }, { silent: true });
                this.response.redirect = this.url('learn', { domainId: finalDomainId });
                return;
            }

            const queuePersist: LessonCardQueueItem[] = cardsForToday.map((c) => ({
                domainId: finalDomainId,
                nodeId: c.nodeId,
                cardId: c.cardId,
                nodeTitle: c.nodeTitle,
                cardTitle: c.cardTitle,
            }));
            const trainIdToday = (dudoc as any)?.learnTrainingDocId;
            await touchLessonSession(finalDomainId, this.user._id, {
                lessonCardQueue: queuePersist,
                lessonQueueBaseDocId: base.docId,
                lessonQueueTrainingDocId: trainIdToday ? String(trainIdToday) : null,
                lessonQueueAnchorNodeId: null,
                lessonMode: 'today',
                lessonQueueDay: utcLessonQueueDayString(),
            }, { silent: true });
            }

            let currentCardIndex = Math.max(0, LT.lessonCardIndex);
            if (currentCardIndex >= cardsForToday.length) currentCardIndex = 0;

            const currentItem = cardsForToday[currentCardIndex];
            const currentCard = await CardModel.get(finalDomainId, new ObjectId(currentItem.cardId));
            // Allow no-problem cards in today's lesson (card view mode).
            if (!currentCard) {
                throw new NotFoundError('Card not found');
            }
            const currentNode = (getBranchData(base, branch).nodes || []).find((n: any) => n.id === currentItem.nodeId);
            if (!currentNode) throw new NotFoundError('Node not found');
            const currentCardList = await CardModel.getByNodeId(finalDomainId, base.docId, currentItem.nodeId);
            const currentIndexInNode = currentCardList.findIndex(c => c.docId.toString() === currentItem.cardId);

            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                route: 'learn',
                lessonMode: 'today',
                nodeId: null,
                cardIndex: currentCardIndex,
                baseDocId: base.docId,
                branch,
            }, { silent: false });

            const todayNodeTree = [{
                type: 'node' as const,
                id: 'today',
                title: this.translate('Today task') || '今日任务',
                children: cardsForToday.map(c => ({ type: 'card' as const, id: c.cardId, title: c.cardTitle })),
            }];

            const learnRecordIdToday = await ensureLearnRecordForCard(
                finalDomainId,
                this.user._id,
                qLessonSession,
                currentCard as any,
                base.docId,
                branch,
            );

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
                rootNodeId: 'today',
                rootNodeTitle: this.translate('Today task') || '今日任务',
                flatCards: cardsForToday,
                nodeTree: todayNodeTree,
                currentCardIndex,
                hasProblems: !!(currentCard?.problems?.length),
                lessonSessionId: lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, this.user._id)),
                lessonSessionDomainId: finalDomainId,
                learnRecordId: learnRecordIdToday || '',
            };
            return;
        }

        this.response.redirect = this.url('learn', { domainId: finalDomainId });
        return;
    }

    async postLessonStart(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body: any = this.request?.body || {};
        const mode = body.mode === 'node' ? 'node' : 'today';
        const nodeIdStart = typeof body.nodeId === 'string' ? body.nodeId : '';
        if (mode === 'node' && !nodeIdStart) throw new ValidationError('nodeId required for node mode');

        if (mode === 'node') {
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                route: 'learn',
                lessonMode: 'node',
                nodeId: nodeIdStart,
                cardIndex: 0,
                lessonCardQueue: [],
                lessonQueueAnchorNodeId: null,
                lessonQueueDay: null,
            }, { silent: false });
        } else {
            await touchLessonSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                route: 'learn',
                lessonMode: 'today',
                nodeId: null,
                cardIndex: 0,
                lessonCardQueue: [],
                lessonQueueAnchorNodeId: null,
                lessonQueueDay: null,
            }, { silent: false });
        }
        const sid = lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, this.user._id));
        this.response.body = {
            success: true,
            redirect: appendLessonSessionToUrl(`/d/${finalDomainId}/learn/lesson`, sid),
        };
    }


    async postPass(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body: any = this.request?.body || {};
        const answerHistory = body.answerHistory || [];
        const totalTime = body.totalTime || 0;
        const isAlonePractice = body.isAlonePractice || false;
        const isSingleNodeMode = body.singleNodeMode === true;
        const noImpressionBody = body.noImpression === true;
        const nodeIdFromBody = body.nodeId as string | undefined;
        const cardIndexFromBody = typeof body.cardIndex === 'number' ? body.cardIndex : parseInt(body.cardIndex, 10);
        const cardIdFromBody = body.cardId;

        const spaNext = body.spaNext === true || body.spaNext === 'true';

        const base = await requireSelectedLearnBase(finalDomainId, this.user._id, this.user.priv);
        if (!base) {
            throw new NotFoundError('Base not found for this domain');
        }

        const isTodayMode = body.todayMode === true;

        if (isTodayMode) {
            const qPass = typeof body.session === 'string' ? body.session.trim() : '';
            const sBr = await resolveLessonSessionDoc(finalDomainId, this.user._id, qPass || undefined);
            if (!lessonTodayFrozenQueueIsValid(sBr)) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            const queue: LessonCardQueueItem[] = sBr?.lessonCardQueue ?? [];
            const idx = typeof sBr?.cardIndex === 'number' ? sBr.cardIndex : 0;
            if (!queue.length || idx >= queue.length) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            const slot = queue[idx];
            const expectId = String(slot.cardId);
            let currentCardId: ObjectId;
            try {
                currentCardId = cardIdFromBody ? new ObjectId(cardIdFromBody) : new ObjectId(expectId);
            } catch {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            if (currentCardId.toString() !== expectId) {
                const sidMis = lessonSessionIdFromDoc(sBr);
                this.response.body = {
                    success: true,
                    redirect: appendLessonSessionToUrl(`/d/${finalDomainId}/learn/lesson`, sidMis),
                };
                return;
            }
            const cardDomain = slot.domainId || finalDomainId;
            const card = await CardModel.get(cardDomain, currentCardId);
            if (!card) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            const currentCardNodeId = card.nodeId;
            await learn.setCardPassed(cardDomain, this.user._id, currentCardId, currentCardNodeId);
            const finalAnswerHistory = (Array.isArray(answerHistory) && answerHistory.length > 0)
                ? answerHistory
                : (card.problems && card.problems.length > 0)
                    ? []
                    : [{ problemId: 'browse_judge', correct: true, selected: 0, timeSpent: totalTime || 0, attempts: 1 }];
            const dudocLR = await learn.getUserLearnState(cardDomain, { _id: this.user._id, priv: this.user.priv }) as any;
            const branchLR = dudocLR?.learnBranch || 'main';
            let baseDocLR = Number((card as any).baseDocId);
            if (!baseDocLR) {
                const bLR = await BaseModel.getByDomain(cardDomain);
                baseDocLR = bLR?.docId || 0;
            }
            if (!baseDocLR && cardDomain === finalDomainId) baseDocLR = base.docId;
            const recScoreToday = await syncLearnPassToRecord(
                cardDomain,
                this.user._id,
                qPass,
                card as any,
                baseDocLR,
                branchLR,
                finalAnswerHistory as any[],
            );
            const score = recScoreToday !== null
                ? recScoreToday
                : (Array.isArray(finalAnswerHistory) ? finalAnswerHistory.length * 5 : 0);
            await learn.addResult(cardDomain, this.user._id, {
                cardId: currentCardId,
                nodeId: currentCardNodeId,
                answerHistory: finalAnswerHistory,
                totalTime,
                score,
                createdAt: new Date(),
            });
            await bus.parallel('learn_result/add', cardDomain);
            await appendUserCheckinDay(cardDomain, this.user._id, this.user.priv, 'learnActivityDates');
            const today = moment.utc().format('YYYY-MM-DD');
            let problemCount = 0;
            for (const h of (finalAnswerHistory as any[])) {
                if (h.problemId) problemCount++;
            }
            const timeToAdd = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
            await learn.incConsumptionStats(cardDomain, this.user._id, today, { nodes: 1, cards: 1, problems: problemCount, practices: 1, ...(timeToAdd > 0 ? { totalTime: timeToAdd } : {}) });

            const nextIndex = idx + 1;
            const sidLesson = lessonSessionIdFromDoc(sBr);
            if (nextIndex < queue.length) {
                await touchLessonSession(finalDomainId, this.user._id, { cardIndex: nextIndex, lessonMode: 'today' }, { silent: false });
                if (spaNext) {
                    const snap = await buildSpaLessonSnapshotToday(
                        (k) => this.translate(k),
                        finalDomainId,
                        this.user._id,
                        this.user.priv,
                        qPass || undefined,
                    );
                    if (snap) {
                        this.response.body = {
                            success: true,
                            spaNext: true,
                            lesson: lessonSnapshotToJson(snap),
                        };
                        return;
                    }
                }
                this.response.body = {
                    success: true,
                    redirect: appendLessonSessionToUrl(`/d/${finalDomainId}/learn/lesson`, sidLesson),
                };
            } else {
                await touchLessonSession(finalDomainId, this.user._id, {
                    lessonMode: null,
                    cardIndex: null,
                    lessonCardQueue: [],
                    lessonQueueDay: null,
                }, { silent: false });
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
            }
            return;
        }

        if (nodeIdFromBody) {
            const qNodePass = typeof body.session === 'string' ? body.session.trim() : '';
            const sNodePass = await resolveLessonSessionDoc(finalDomainId, this.user._id, qNodePass || undefined);
            const flatCardsRaw: Array<{ nodeId: string; cardId: string }> = (sNodePass?.lessonCardQueue ?? []).map((q) => ({
                nodeId: q.nodeId,
                cardId: q.cardId,
            }));
            if (!flatCardsRaw.length) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            const idxNode = typeof sNodePass?.cardIndex === 'number' ? sNodePass.cardIndex : 0;
            const noImpression = body.noImpression === true;
            const currentCardId = cardIdFromBody ? new ObjectId(cardIdFromBody) : (flatCardsRaw[idxNode] ? new ObjectId(flatCardsRaw[idxNode].cardId) : null);
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
            const sPassN = await SessionModel.get(finalDomainId, this.user._id);
            const Lpn = mergeDomainLessonState(dudocPass, sPassN);
            const timesMs: number[] = [...Lpn.lessonCardTimesMs];
            const isReviewCard = Lpn.lessonReviewCardIds.includes(currentCardId.toString());
            if (isReviewCard && idxNode >= 0 && idxNode < timesMs.length) {
                timesMs[idxNode] = (timesMs[idxNode] ?? 0) + totalTimeMs;
            } else {
                timesMs.push(totalTimeMs);
            }
            if (noImpression) {
                const reviewIds: string[] = [...Lpn.lessonReviewCardIds];
                if (!reviewIds.includes(currentCardId.toString())) reviewIds.push(currentCardId.toString());
                await touchLessonSession(finalDomainId, this.user._id, { appRoute: 'learn', lessonReviewCardIds: reviewIds, lessonCardTimesMs: timesMs }, { silent: true });
            } else if (answerHistory.length > 0) {
                await learn.setCardPassed(finalDomainId, this.user._id, currentCardId, currentCardNodeId);
                const baseDocN = Number((card as any).baseDocId) || base.docId;
                const branchN = dudocPass?.learnBranch || 'main';
                const recScoreN = await syncLearnPassToRecord(
                    finalDomainId,
                    this.user._id,
                    qNodePass,
                    card as any,
                    baseDocN,
                    branchN,
                    answerHistory,
                );
                const score = recScoreN !== null ? recScoreN : answerHistory.length * 5;
                await learn.addResult(finalDomainId, this.user._id, {
                    cardId: currentCardId,
                    nodeId: currentCardNodeId,
                    answerHistory,
                    totalTime,
                    score,
                    createdAt: new Date(),
                });
                await bus.parallel('learn_result/add', finalDomainId);
                await appendUserCheckinDay(finalDomainId, this.user._id, this.user.priv, 'learnActivityDates');
                const today = moment.utc().format('YYYY-MM-DD');
                let problemCount = 0;
                for (const h of answerHistory) {
                    if ((h as any).problemId) problemCount++;
                }
                const timeToAdd = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
                await learn.incConsumptionStats(finalDomainId, this.user._id, today, { nodes: 1, cards: 1, problems: problemCount, practices: 1, ...(timeToAdd > 0 ? { totalTime: timeToAdd } : {}) });
                const nextReviewIds = Lpn.lessonReviewCardIds.filter(id => id !== currentCardId.toString());
                await touchLessonSession(finalDomainId, this.user._id, { appRoute: 'learn', lessonReviewCardIds: nextReviewIds, lessonCardTimesMs: timesMs }, { silent: true });
            } else {
                // 卡片 view「Know it」：无题目时当作判断题通过，记 pass 并写入 result（不跳 result 页，走下方下一张 / node-result）
                await learn.setCardPassed(finalDomainId, this.user._id, currentCardId, currentCardNodeId);
                const browseHistory = [{ problemId: 'browse_judge', correct: true, selected: 0, timeSpent: totalTime || 0, attempts: 1 }];
                const baseDocBrowse = Number((card as any).baseDocId) || base.docId;
                const branchBrowse = dudocPass?.learnBranch || 'main';
                const recScoreBrowse = await syncLearnPassToRecord(
                    finalDomainId,
                    this.user._id,
                    qNodePass,
                    card as any,
                    baseDocBrowse,
                    branchBrowse,
                    browseHistory,
                );
                const score = recScoreBrowse !== null ? recScoreBrowse : 5;
                await learn.addResult(finalDomainId, this.user._id, {
                    cardId: currentCardId,
                    nodeId: currentCardNodeId,
                    answerHistory: browseHistory,
                    totalTime: totalTime || 0,
                    score,
                    createdAt: new Date(),
                });
                await bus.parallel('learn_result/add', finalDomainId);
                await appendUserCheckinDay(finalDomainId, this.user._id, this.user.priv, 'learnActivityDates');
                const timeToAdd = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
                await learn.incConsumptionStats(finalDomainId, this.user._id, moment.utc().format('YYYY-MM-DD'), { nodes: 1, cards: 1, problems: 1, practices: 1, ...(timeToAdd > 0 ? { totalTime: timeToAdd } : {}) });
                const nextReviewIdsKnow = Lpn.lessonReviewCardIds.filter(id => id !== currentCardId.toString());
                await touchLessonSession(finalDomainId, this.user._id, { appRoute: 'learn', lessonReviewCardIds: nextReviewIdsKnow, lessonCardTimesMs: timesMs }, { silent: true });
            }
            const nextIndex = idxNode + 1;
            const sidNode = lessonSessionIdFromDoc(sNodePass);
            if (nextIndex < flatCardsRaw.length) {
                await touchLessonSession(finalDomainId, this.user._id, { cardIndex: nextIndex, lessonMode: 'node', nodeId: nodeIdFromBody }, { silent: false });
                if (spaNext && nodeIdFromBody) {
                    const snap = await buildSpaLessonSnapshotNode(
                        (k) => this.translate(k),
                        finalDomainId,
                        nodeIdFromBody,
                        this.user._id,
                        this.user.priv,
                        qNodePass || undefined,
                    );
                    if (snap) {
                        this.response.body = {
                            success: true,
                            spaNext: true,
                            lesson: lessonSnapshotToJson(snap),
                        };
                        return;
                    }
                }
                this.response.body = {
                    success: true,
                    redirect: appendLessonSessionToUrl(`/d/${finalDomainId}/learn/lesson`, sidNode),
                };
                return;
            }
            const dudoc2n = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const s2n = await SessionModel.get(finalDomainId, this.user._id);
            const L2n = mergeDomainLessonState(dudoc2n, s2n);
            const reviewIds2: string[] = [...L2n.lessonReviewCardIds];
            if (reviewIds2.length > 0) {
                const baseNodeLesson = appendLessonSessionToUrl(`/d/${finalDomainId}/learn/lesson`, sidNode);
                const qsep = baseNodeLesson.includes('?') ? '&' : '?';
                this.response.body = {
                    success: true,
                    redirect: `${baseNodeLesson}${qsep}reviewCardId=${encodeURIComponent(reviewIds2[0])}`,
                };
            } else {
                await touchLessonSession(finalDomainId, this.user._id, {
                    appRoute: 'learn',
                    lessonMode: null,
                    nodeId: null,
                    cardIndex: null,
                    lessonCardTimesMs: [],
                    lessonCardQueue: [],
                    lessonQueueDay: null,
                }, { silent: false });
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

        const dudocPostMain = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const sPostMain = await SessionModel.get(finalDomainId, this.user._id);
        const Lpm = mergeDomainLessonState(dudocPostMain, sPostMain);
        const savedSectionId = Lpm.currentLearnSectionId;
        
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

        const hasCardProblems = !!(card.problems && card.problems.length > 0);
        const isBrowseOnly = isAlonePractice && !hasCardProblems && answerHistory.length === 0;

        // 单卡片「不认识」：与 node 一致——不记 result、加入复习列表，并重定向回同一张卡（复习滚动）
        if (isBrowseOnly && noImpressionBody) {
            const dudocA = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const sA = await SessionModel.get(finalDomainId, this.user._id);
            const La = mergeDomainLessonState(dudocA, sA);
            const reviewIds: string[] = [...La.lessonReviewCardIds];
            if (!reviewIds.includes(currentCardId!.toString())) reviewIds.push(currentCardId!.toString());
            const timesMs: number[] = [...La.lessonCardTimesMs];
            timesMs.push(typeof totalTime === 'number' && totalTime >= 0 ? totalTime : 0);
            await touchLessonSession(finalDomainId, this.user._id, { appRoute: 'learn', lessonReviewCardIds: reviewIds, lessonCardTimesMs: timesMs }, { silent: true });
            const cardIdStr = currentCardId!.toString();
            this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson?cardId=${cardIdStr}&reviewCardId=${encodeURIComponent(cardIdStr)}` };
            return;
        }

        if (currentCardNodeId) {
            await learn.setCardPassed(finalDomainId, this.user._id, currentCardId, currentCardNodeId);
        }

        const node = (getBranchData(base, 'main').nodes || []).find(n => n.id === currentCardNodeId);
        const cards = await CardModel.getByNodeId(finalDomainId, base.docId, currentCardNodeId);
        const cardIndex = cards.findIndex(c => c.docId.toString() === currentCardId.toString());
        const currentCardDoc = cards[cardIndex];

        // 单卡片无题目时（卡片 view「认识」）：写入 browse_judge correct: true
        const effectiveHistory = isBrowseOnly
            ? [{ problemId: 'browse_judge', correct: true, selected: 0, timeSpent: totalTime || 0, attempts: 1 }]
            : answerHistory;

        const qPassMain = typeof body.session === 'string' ? body.session.trim() : '';
        let baseDocM = Number((card as any).baseDocId);
        if (!baseDocM) {
            const bM = await BaseModel.getByDomain(finalDomainId);
            baseDocM = bM?.docId || base.docId;
        }
        const dudocM = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
        const branchM = dudocM?.learnBranch || 'main';
        const recScoreM = await syncLearnPassToRecord(
            finalDomainId,
            this.user._id,
            qPassMain,
            card as any,
            baseDocM,
            branchM,
            effectiveHistory as any[],
        );
        const score = recScoreM !== null ? recScoreM : effectiveHistory.length * 5;
        const resultId = await learn.addResult(finalDomainId, this.user._id, {
            cardId: currentCardId,
            nodeId: currentCardNodeId,
            answerHistory: effectiveHistory,
            totalTime,
            score,
            createdAt: new Date(),
        });

        await bus.parallel('learn_result/add', finalDomainId);
        await appendUserCheckinDay(finalDomainId, this.user._id, this.user.priv, 'learnActivityDates');

        const today = moment.utc().format('YYYY-MM-DD');
        let problemCount = 0;
        for (const history of effectiveHistory) {
            if ((history as any).problemId) problemCount++;
        }
        const timeToAdd = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
        await learn.incConsumptionStats(finalDomainId, this.user._id, today, {
            nodes: currentCardNodeId ? 1 : 0,
            cards: 1,
            problems: problemCount,
            practices: 1,
            ...(timeToAdd > 0 ? { totalTime: timeToAdd } : {}),
        });

        // 单卡片「认识」后：若该卡在复习列表中则移除（与 node 一致）
        if (isAlonePractice) {
            const dudocAfter = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const sAfter = await SessionModel.get(finalDomainId, this.user._id);
            const Lafter = mergeDomainLessonState(dudocAfter, sAfter);
            const nextReviewIds = Lafter.lessonReviewCardIds.filter(id => id !== currentCardId!.toString());
            if (nextReviewIds.length !== Lafter.lessonReviewCardIds.length) {
                await touchLessonSession(finalDomainId, this.user._id, { appRoute: 'learn', lessonReviewCardIds: nextReviewIds }, { silent: true });
            }
        }

        this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson/result/${resultId}` };
    }

    async getResult(domainId: string, resultId: ObjectId) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const result = await learn.getResultById(finalDomainId, this.user._id, resultId);

        if (!result) {
            throw new NotFoundError('Result not found');
        }

        const base = await requireSelectedLearnBase(finalDomainId, this.user._id, this.user.priv);
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

        const base = await requireSelectedLearnBase(finalDomainId, this.user._id, this.user.priv);
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

        const base = await requireSelectedLearnBase(finalDomainId, this.user._id, this.user.priv);
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
            const sEd = await SessionModel.get(finalDomainId, targetUid);
            const Led = mergeDomainLessonState(dudoc, sEd);
            const saved = Led.currentLearnSectionIndex;
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
        await touchLessonSession(finalDomainId, targetUid, {
            appRoute: 'learn',
            currentLearnSectionIndex: currentLearnSectionIndexFinal,
            currentLearnSectionId: sectionOrder[currentLearnSectionIndexFinal],
        }, { silent: true });

        this.response.body = { success: true, sectionOrder, currentLearnSectionIndex: currentLearnSectionIndexFinal };
    }

    async get(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const targetUid = await this.resolveTargetUid(finalDomainId);
        const base = await requireSelectedLearnBase(finalDomainId, this.user._id, this.user.priv);
        
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
        const base = await requireSelectedLearnBase(finalDomainId, this.user._id, this.user.priv);
        
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

class LearnBaseSelectHandler extends Handler {
    async get(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const { trainings, selectedTrainingDocId } = await getLearnTrainingSelection(finalDomainId, this.user._id, this.user.priv);
        const redirect = typeof this.request.query?.redirect === 'string' && this.request.query.redirect
            ? this.request.query.redirect
            : `/d/${finalDomainId}/learn`;
        this.response.template = 'learn_base_select.html';
        this.response.body = {
            domainId: finalDomainId,
            trainings: trainings.map((item: any) => ({ docId: String(item.docId), name: item.name || '', baseDocId: Number(item.baseDocId) || 0 })),
            selectedTrainingDocId,
            redirect,
        };
    }

    async post(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body: any = this.request?.body || {};
        const trainingDocId = String(body.trainingDocId || '').trim();
        if (!ObjectId.isValid(trainingDocId)) throw new ValidationError('Invalid trainingDocId');
        const redirect = typeof body.redirect === 'string' && body.redirect
            ? body.redirect
            : `/d/${finalDomainId}/learn`;

        await saveLearnTrainingForUser(finalDomainId, this.user._id, trainingDocId, (key: string) => this.translate(key));
        this.response.redirect = redirect;
    }
}

export async function apply(ctx: Context) {
    ctx.Route('learn', '/learn', LearnHandler);
    ctx.Route('learn_set_base', '/learn/base', LearnHandler);
    ctx.Route('learn_base_select', '/learn/training/select', LearnBaseSelectHandler);
    ctx.Route('learn_set_daily_goal', '/learn/daily-goal', LearnHandler);
    ctx.Route('learn_sections', '/learn/sections', LearnSectionsHandler);
    ctx.Route('learn_section_edit', '/learn/section/edit', LearnSectionEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_edit', '/learn/edit', LearnEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_lesson', '/learn/lesson', LessonHandler);
    ctx.Route('learn_lesson_result', '/learn/lesson/result/:resultId', LessonHandler);
    ctx.Route('learn_lesson_pass', '/learn/lesson/pass', LessonHandler);
    ctx.Route('learn_lesson_start', '/learn/lesson/start', LessonHandler);
    ctx.Route('learn_lesson_node_result', '/learn/lesson/node-result', LessonNodeResultHandler);
}
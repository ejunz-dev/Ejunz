import type { Context } from '../context';
import { Handler, param, post, Types } from '../service/server';
import { BaseModel, CardModel } from '../model/base';
import type { BaseDoc, BaseNode, BaseEdge, TrainingDoc } from '../interface';
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
import { getModeDailyGoal } from '../lib/learnModePrefs';
import TrainingModel from '../model/training';
import { isTrainingRootNodeId, loadTrainingMergedGraph, parseTrainingNodeId } from '../lib/trainingMergedGraph';
import SessionModel, { type LessonCardQueueItem, type SessionDoc, type SessionPatch } from '../model/session';
import {
    appendLessonSessionToUrl,
    frozenTodayQueueMatchesLearnSettings,
    isLearnHomePlaceholderSession,
    isLessonSessionAbandoned,
    lessonSessionIdFromDoc,
    mergeDomainLessonState,
    resolveLessonSessionDoc,
    touchLessonSession,
} from '../lib/lessonSession';
import {
    deriveSessionLearnStatus,
    deriveSessionRecordType,
    formatSessionCardProgress,
    isLearnSessionRow,
} from '../lib/sessionListDisplay';
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

/** Mongo / JSON may yield Long, Decimal128, or string; merge + learn home must not drop valid indices. */
function normalizeDomainUserLearnIndex(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && v.trim() !== '') {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) return n;
    }
    if (v != null && typeof (v as { valueOf?: () => unknown }).valueOf === 'function') {
        const n = Number((v as { valueOf: () => unknown }).valueOf());
        if (Number.isFinite(n)) return Math.trunc(n);
    }
    return null;
}

/** True when domain-aligned patch would change learning-start slot vs what the session row still has (stale queue risk). */
function sessionTodaySectionFieldsMismatch(s: SessionDoc, patch: SessionPatch): boolean {
    const preI = normalizeDomainUserLearnIndex(s.currentLearnSectionIndex);
    const pinI = normalizeDomainUserLearnIndex(patch.currentLearnSectionIndex);
    const preId = typeof s.currentLearnSectionId === 'string' ? s.currentLearnSectionId.trim() : '';
    const pinId = typeof patch.currentLearnSectionId === 'string' ? String(patch.currentLearnSectionId).trim() : '';
    const idxDiff = (preI !== null || pinI !== null) && preI !== pinI;
    const idDiff = preId !== pinId;
    return idxDiff || idDiff;
}

/** Card ids with a learn_result row today (UTC day) — used to advance daily queue, not repeat the same slice. */
async function learnResultCardIdsTodayUtc(domainId: string, userId: number): Promise<Set<string>> {
    const todayStart = moment.utc().startOf('day').toDate();
    const todayEndInclusive = moment.utc().endOf('day').toDate();
    const rows = await learn.getResults(domainId, userId, {
        createdAt: { $gte: todayStart, $lte: todayEndInclusive },
    });
    const ids = new Set<string>();
    for (const r of rows) {
        if (r.cardId) ids.add(String(r.cardId));
    }
    return ids;
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

async function clearLearnDailySessionPointer(domainId: string, uid: number): Promise<void> {
    await learn.setUserLearnState(domainId, uid, {
        learnDailySessionId: null,
        learnDailySessionDay: null,
    });
}

async function setLearnDailySessionPointer(domainId: string, uid: number, sessionHex: string): Promise<void> {
    await learn.setUserLearnState(domainId, uid, {
        learnDailySessionId: sessionHex,
        learnDailySessionDay: utcLessonQueueDayString(),
    });
}

/**
 * Single source for “today’s daily practice” row: `domain.user` pointer + UTC calendar day.
 * Clears pointer when the day rolls over (lazy on read), session missing, abandoned, finished, or timed_out.
 * Batch cleanup of old session rows + pointers: `settleStaleDailyLessonSessionsUtc` (`task.session.utc0`).
 */
async function resolveLearnDailySessionDoc(domainId: string, uid: number, dudoc: any): Promise<SessionDoc | null> {
    const todayYmd = utcLessonQueueDayString();
    const ptrId = typeof dudoc?.learnDailySessionId === 'string' ? dudoc.learnDailySessionId.trim() : '';
    const ptrDay = typeof dudoc?.learnDailySessionDay === 'string' ? dudoc.learnDailySessionDay.trim() : '';

    if (ptrDay && (!LESSON_QUEUE_DAY_RE.test(ptrDay) || ptrDay !== todayYmd)) {
        await clearLearnDailySessionPointer(domainId, uid);
        return null;
    }
    if (!ptrId || !ObjectId.isValid(ptrId)) {
        if (ptrId) await clearLearnDailySessionPointer(domainId, uid);
        return null;
    }
    if (ptrDay !== todayYmd) {
        await clearLearnDailySessionPointer(domainId, uid);
        return null;
    }

    const doc = await SessionModel.coll.findOne({ _id: new ObjectId(ptrId), domainId, uid }) as SessionDoc | null;
    if (!doc) {
        await clearLearnDailySessionPointer(domainId, uid);
        return null;
    }
    if (isLessonSessionAbandoned(doc)) {
        await clearLearnDailySessionPointer(domainId, uid);
        return null;
    }
    const st = deriveSessionLearnStatus(doc);
    if (st === 'finished' || st === 'timed_out' || st === 'abandoned') {
        await clearLearnDailySessionPointer(domainId, uid);
        return null;
    }
    return doc;
}

async function resolveLessonSessionForMerge(
    domainId: string,
    uid: number,
    querySessionId: string | undefined,
    dudoc: any,
): Promise<SessionDoc | null> {
    const q = typeof querySessionId === 'string' ? querySessionId.trim() : '';
    if (q && ObjectId.isValid(q)) {
        const ex = await SessionModel.coll.findOne({ _id: new ObjectId(q), domainId, uid }) as SessionDoc | null;
        if (ex && !isLessonSessionAbandoned(ex)) {
            const mode = ex.lessonMode;
            if (mode === 'card' || mode === 'node') return ex;
            if (mode === 'today') {
                const daily = await resolveLearnDailySessionDoc(domainId, uid, dudoc);
                if (daily && daily._id.toString() === ex._id.toString()) return ex;
                return null;
            }
        }
    }
    const daily = await resolveLearnDailySessionDoc(domainId, uid, dudoc);
    if (daily) return daily;
    return await SessionModel.get(domainId, uid);
}

/** Clear domain pointer and mark every active daily (`today`) session abandoned (daily goal / section order change). */
async function clearDailyPracticeSessionAfterSettingsChange(domainId: string, uid: number, _priv: number): Promise<void> {
    await clearLearnDailySessionPointer(domainId, uid);
    const now = new Date();
    await SessionModel.coll.updateMany(
        {
            domainId,
            uid,
            lessonMode: 'today',
            $or: [{ lessonAbandonedAt: { $exists: false } }, { lessonAbandonedAt: null }],
        },
        { $set: { lessonAbandonedAt: now, lastActivityAt: now } },
    );
    const rows = (await SessionModel.coll
        .find({ domainId, uid })
        .sort({ lastActivityAt: -1 })
        .limit(15)
        .toArray()) as SessionDoc[];
    const top = rows[0];
    if (top && isLearnHomePlaceholderSession(top) && !isLessonSessionAbandoned(top)) {
        const abandonedBelow = rows.find(
            (r, i) => i > 0
                && isLessonSessionAbandoned(r)
                && r.appRoute === 'learn'
                && r.route === 'learn',
        );
        if (abandonedBelow) {
            await mergeLearnGhostRecordsIntoSessionAndDelete(domainId, uid, top, abandonedBelow._id);
        }
    }
}

/** Learn flow always uses the base main graph; training only picks baseDocId, not a named branch. */
const LEARN_GRAPH_BRANCH = 'main';

function baseNumericId(v: number | ObjectId | undefined | null): number {
    if (v == null) return 0;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return 0;
}

/** Bump when merged-DAG generation rules change so `learn_dag` `training_merged` cache invalidates and rebuilds. */
const TRAINING_MERGED_DAG_CACHE_REVISION = 1;

async function computeTrainingLearnDAGVersion(domainId: string, training: TrainingDoc): Promise<number> {
    let v = training.updatedAt instanceof Date ? training.updatedAt.getTime() : 0;
    for (const s of TrainingModel.resolvePlanSources(training as any)) {
        const b = await BaseModel.get(domainId, s.baseDocId);
        if (b?.updateAt instanceof Date) {
            const t = b.updateAt.getTime();
            if (t > v) v = t;
        }
    }
    return v + TRAINING_MERGED_DAG_CACHE_REVISION * 1_000_000_000;
}

async function ensureTrainingLearnDAGCached(
    domainId: string,
    training: TrainingDoc,
    translate: (key: string) => string,
): Promise<{ sections: LearnDAGNode[]; allDagNodes: LearnDAGNode[] }> {
    const version = await computeTrainingLearnDAGVersion(domainId, training);
    const cached = await learn.getTrainingLearnDAG(domainId, training.docId);
    if (cached?.sections?.length && (cached.version || 0) >= version) {
        const sectionsClean = (cached.sections || []).filter((s) => !isTrainingRootNodeId(String(s._id)));
        return { sections: sectionsClean, allDagNodes: cached.dag || [] };
    }
    const branchByBase = new Map<number, string>();
    for (const s of TrainingModel.resolvePlanSources(training as any)) {
        branchByBase.set(s.baseDocId, s.targetBranch || 'main');
    }
    const { nodes: mNodes, edges: mEdges } = await loadTrainingMergedGraph(domainId, training);
    const pr = await generatePathDAGFromMerged(domainId, branchByBase, mNodes, mEdges, translate);
    await learn.setTrainingLearnDAG(domainId, training.docId, {
        sections: pr.sections,
        dag: pr.dag,
        version,
        updateAt: new Date(),
    });
    return { sections: pr.sections, allDagNodes: pr.dag };
}

async function nodeTitleForLearnCard(
    domainId: string,
    card: { baseDocId: number; nodeId: string; branch?: string },
): Promise<string> {
    const b = await BaseModel.get(domainId, card.baseDocId);
    if (!b) return '';
    const br = typeof card.branch === 'string' && card.branch.trim() ? card.branch.trim() : 'main';
    const { nodes } = getBranchData(b, br);
    const n = (nodes || []).find((x: BaseNode) => String((x as any).id) === String(card.nodeId));
    return (n as BaseNode | undefined)?.text || '';
}

function cardStorageBranch(card: { branch?: string } | null | undefined): string {
    return typeof card?.branch === 'string' && card.branch.trim() ? card.branch.trim() : 'main';
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
    card: { docId: ObjectId; nodeId: string; problems?: Array<{ pid?: string }>; branch?: string },
    baseDocId: number,
    branchHint: string,
): Promise<string | null> {
    const branch = typeof card.branch === 'string' && card.branch.trim()
        ? card.branch.trim()
        : branchHint;
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

const LEARN_PLACEHOLDER_REVIVE_PATCH: SessionPatch = {
    appRoute: 'learn',
    route: 'learn',
    lessonAbandonedAt: null,
    lessonMode: null,
    nodeId: null,
    cardId: null,
    cardIndex: null,
    branch: null,
    baseDocId: null,
    lessonCardQueue: [],
    lessonQueueDay: null,
    lessonReviewCardIds: [],
    lessonCardTimesMs: [],
    lessonQueueAnchorNodeId: null,
    lessonQueueBaseDocId: null,
    lessonQueueTrainingDocId: null,
};

/**
 * Learn-home ghost row may still have `recordIds` if the client used that session id when creating records.
 * Repoint records onto the canonical session before deleting the shell.
 * Unique index `(domainId, uid, sessionId, cardId)` forbids two rows for the same card on the target — drop the ghost copy when the target already has one.
 */
async function mergeLearnGhostRecordsIntoSessionAndDelete(
    domainId: string,
    uid: number,
    ghost: SessionDoc,
    targetSessionId: ObjectId,
): Promise<void> {
    const ghostId = ghost._id;
    const now = new Date();
    const ghostRecords = await RecordModel.coll
        .find({ domainId, uid, sessionId: ghostId })
        .toArray();
    const idsToAddToTarget: ObjectId[] = [];
    for (const rec of ghostRecords) {
        const cardId = String((rec as RecordDoc).cardId || '');
        const dup = await RecordModel.coll.findOne({
            domainId,
            uid,
            sessionId: targetSessionId,
            cardId,
        });
        if (dup && !dup._id.equals((rec as RecordDoc)._id)) {
            await RecordModel.coll.deleteOne({ _id: (rec as RecordDoc)._id, domainId });
        } else {
            await RecordModel.coll.updateOne(
                { _id: (rec as RecordDoc)._id, domainId },
                { $set: { sessionId: targetSessionId, updatedAt: now, lastActivityAt: now } },
            );
            idsToAddToTarget.push((rec as RecordDoc)._id);
        }
    }
    if (idsToAddToTarget.length > 0) {
        await SessionModel.coll.updateOne(
            { _id: targetSessionId, domainId, uid },
            {
                $set: { updatedAt: now, lastActivityAt: now },
                $addToSet: { recordIds: { $each: idsToAddToTarget } },
            },
        );
    }
    await SessionModel.coll.deleteOne({ _id: ghostId, domainId, uid });
}

/** Learn-home placeholder shell — redundant when a real abandoned learn row sits below (records merged on delete). */
function isRedundantLearnGhostShell(doc: SessionDoc): boolean {
    return isLearnHomePlaceholderSession(doc);
}

/** Abandoned daily (`today`) row must not be revived — user expects a new session after goal / section-order change. */
function isAbandonedDailySession(doc: SessionDoc | null | undefined): boolean {
    return !!(doc && doc.lessonMode === 'today' && isLessonSessionAbandoned(doc));
}

/** First learn-home placeholder in recent rows (non-abandoned), or null. */
function firstLearnHomePlaceholderInRows(rows: SessionDoc[]): SessionDoc | null {
    for (const r of rows) {
        if (isLearnHomePlaceholderSession(r)) return r;
    }
    return null;
}

async function recentLearnSessionRows(domainId: string, uid: number, limit = 15): Promise<SessionDoc[]> {
    return SessionModel.coll
        .find({ domainId, uid })
        .sort({ lastActivityAt: -1 })
        .limit(limit)
        .toArray() as Promise<SessionDoc[]>;
}

/** Prefer upgrading learn-home placeholder row so we do not stack a second session per start action. */
async function insertOrUpgradeLearnSession(domainId: string, uid: number, patch: SessionPatch): Promise<string> {
    const rows = await recentLearnSessionRows(domainId, uid);
    const latest = rows[0];
    if (latest && isRedundantLearnGhostShell(latest)) {
        const abandonedBelow = rows.find(
            (r, i) => i > 0
                && isLessonSessionAbandoned(r)
                && r.appRoute === 'learn'
                && r.route === 'learn',
        );
        if (abandonedBelow) {
            await mergeLearnGhostRecordsIntoSessionAndDelete(domainId, uid, latest, abandonedBelow._id);
            if (isAbandonedDailySession(abandonedBelow)) {
                const ph = firstLearnHomePlaceholderInRows(rows.filter((r) => !r._id.equals(latest._id)));
                if (ph) {
                    const bumped = await SessionModel.touchById(domainId, uid, ph._id, patch, { silent: false });
                    return (bumped ?? ph)._id.toString();
                }
                const doc = await SessionModel.insertSession(domainId, uid, patch, { silent: false });
                return doc._id.toString();
            }
            const bumped = await SessionModel.touchById(
                domainId,
                uid,
                abandonedBelow._id,
                { ...patch, lessonAbandonedAt: null },
                { silent: false },
            );
            return (bumped ?? abandonedBelow)._id.toString();
        }
    }
    if (latest && isLessonSessionAbandoned(latest)) {
        if (isAbandonedDailySession(latest)) {
            const ph = firstLearnHomePlaceholderInRows(rows.filter((r) => !r._id.equals(latest._id)));
            if (ph) {
                const bumped = await SessionModel.touchById(domainId, uid, ph._id, patch, { silent: false });
                return (bumped ?? ph)._id.toString();
            }
            const doc = await SessionModel.insertSession(domainId, uid, patch, { silent: false });
            return doc._id.toString();
        }
        const bumped = await SessionModel.touchById(
            domainId,
            uid,
            latest._id,
            { ...patch, lessonAbandonedAt: null },
            { silent: false },
        );
        return (bumped ?? latest)._id.toString();
    }
    if (latest && isLearnHomePlaceholderSession(latest)) {
        const bumped = await SessionModel.touchById(domainId, uid, latest._id, patch, { silent: false });
        return (bumped ?? latest)._id.toString();
    }
    const doc = await SessionModel.insertSession(domainId, uid, patch, { silent: false });
    return doc._id.toString();
}

/**
 * Only one daily row should look「进行中 / 暂停」per user: those are non-abandoned `today` sessions that are not finished
 * (`cardIndex` still inside `lessonCardQueue`). Abandon all such rows before inserting a new daily run.
 */
async function abandonInProgressOrPausedTodaySessions(domainId: string, uid: number): Promise<void> {
    const now = new Date();
    await SessionModel.coll.updateMany(
        {
            domainId,
            uid,
            lessonMode: 'today',
            $or: [{ lessonAbandonedAt: { $exists: false } }, { lessonAbandonedAt: null }],
            $expr: {
                $not: {
                    $and: [
                        { $gt: [{ $size: { $ifNull: ['$lessonCardQueue', []] } }, 0] },
                        {
                            $gte: [
                                { $ifNull: ['$cardIndex', 0] },
                                { $size: { $ifNull: ['$lessonCardQueue', []] } },
                            ],
                        },
                    ],
                },
            },
        },
        { $set: { lessonAbandonedAt: now, lastActivityAt: now } },
    );
}

/**
 * Daily practice: every「开始学习」creates a **new** session document — never revive abandoned rows or upgrade placeholders.
 * Only runs ghost-shell merge (records → row below) so stray shells do not block a clean insert.
 */
async function insertNewTodayLearnSession(domainId: string, uid: number, patch: SessionPatch): Promise<string> {
    await abandonInProgressOrPausedTodaySessions(domainId, uid);
    const rows = await recentLearnSessionRows(domainId, uid);
    const latest = rows[0];
    if (latest && isRedundantLearnGhostShell(latest)) {
        const abandonedBelow = rows.find(
            (r, i) => i > 0
                && isLessonSessionAbandoned(r)
                && r.appRoute === 'learn'
                && r.route === 'learn',
        );
        if (abandonedBelow) {
            await mergeLearnGhostRecordsIntoSessionAndDelete(domainId, uid, latest, abandonedBelow._id);
        }
    }
    const doc = await SessionModel.insertSession(domainId, uid, patch, { silent: false });
    return doc._id.toString();
}

/**
 * Align session learn-progress with `domain.user` using the same rules as learn GET `today` / home
 * after `applyUserSectionOrder`: learning start is an index (or id) into **saved** `learnSectionOrder`,
 * and `currentLearnSectionId` must match that slot (not a stale id left after reorder).
 */
function sessionTodayProgressPatchFromDomainUser(dudoc: any): SessionPatch {
    const du = dudoc || {};
    const sectionOrderSnap = Array.isArray(du.learnSectionOrder)
        ? du.learnSectionOrder.map((id: unknown) => String(id))
        : [];
    const duIdx = normalizeDomainUserLearnIndex(du.currentLearnSectionIndex);
    const duId =
        typeof du.currentLearnSectionId === 'string' && du.currentLearnSectionId.trim()
            ? du.currentLearnSectionId.trim()
            : null;

    if (sectionOrderSnap.length === 0) {
        return {
            currentLearnSectionIndex: duIdx !== null ? duIdx : null,
            currentLearnSectionId: duId,
            lessonQueueLearnSectionOrder: sectionOrderSnap,
        } as SessionPatch;
    }

    let currentSectionIndex = 0;
    let finalSectionId: string | null = null;
    if (duIdx !== null && duIdx >= 0 && duIdx < sectionOrderSnap.length) {
        finalSectionId = sectionOrderSnap[duIdx];
        currentSectionIndex = duIdx;
    } else if (duId && sectionOrderSnap.some((id) => id === duId)) {
        const idx = sectionOrderSnap.findIndex((id) => id === duId);
        finalSectionId = duId;
        currentSectionIndex = idx >= 0 ? idx : 0;
    } else {
        finalSectionId = sectionOrderSnap[0];
        currentSectionIndex = 0;
    }

    return {
        currentLearnSectionIndex: currentSectionIndex,
        currentLearnSectionId: finalSectionId,
        lessonQueueLearnSectionOrder: sectionOrderSnap,
    } as SessionPatch;
}

async function buildTodayDailyLessonResumeFields(
    _domainId: string,
    _uid: number,
    _priv: number,
): Promise<{
    todayLessonResumableSessionId: string | null;
    todayLessonResumeUrl: string | null;
    todayLessonCardProgressText: string | null;
}> {
    return {
        todayLessonResumableSessionId: null,
        todayLessonResumeUrl: null,
        todayLessonCardProgressText: null,
    };
}

/**
 * Apply the user's saved section queue (`learnSectionOrder`): which training section roots are in the lesson
 * and in what order (editable in Section Order UI; may repeat ids). If missing, fall back to DAG order.
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
    const listedOnce = new Set(learnSectionOrder.map((id) => String(id)));
    const rest = [...sections]
        .filter((s) => !listedOnce.has(String(s._id)))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const s of rest) {
        result.push({ ...s, order: result.length });
    }
    return result;
}

/** Tile `arr` cyclically to reach `length` (e.g. daily goal exceeds available cards). */
function cycleList<T>(arr: T[], length: number): T[] {
    if (length <= 0 || arr.length === 0) return [];
    const out: T[] = [];
    for (let i = 0; i < length; i++) out.push(arr[i % arr.length]);
    return out;
}

function dagSubtreeUnderRootFromNodes(allDagNodes: LearnDAGNode[], rootId: string): LearnDAGNode[] {
    const dag: LearnDAGNode[] = [];
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
    collectChildren(rootId, new Set());
    return dag;
}

/**
 * Build today's card queue from training DAG + `learnSectionOrder` + learning start (`domain.user`).
 * Used by GET /learn/lesson and by post「开始学习」so the new session is created with `lessonCardQueue` already set.
 */
async function buildTodayLessonQueueFromDomain(
    domainId: string,
    uid: number,
    dudoc: any,
    training: TrainingDoc,
    translate: (key: string) => string,
    opts?: { excludeTodayPassedCards?: boolean },
): Promise<{
    branchByBaseToday: Map<number, string>;
    firstBaseToday: number;
    sections: LearnDAGNode[];
    allDagNodes: LearnDAGNode[];
    currentSectionIndex: number;
    finalSectionId: string | null;
    learnSectionOrder: string[] | undefined;
    sectionOrderSnapshot: string[];
    cardsForToday: Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string; domainId?: string; baseDocId?: number }>;
    queuePersist: LessonCardQueueItem[];
}> {
    const planSourcesToday = TrainingModel.resolvePlanSources(training as any);
    const branchByBaseToday = new Map<number, string>();
    for (const s of planSourcesToday) {
        branchByBaseToday.set(s.baseDocId, s.targetBranch || 'main');
    }
    const firstBaseToday = planSourcesToday[0]?.baseDocId ?? 0;

    const { sections: sectionsBuilt, allDagNodes: allDagBuilt } = await ensureTrainingLearnDAGCached(
        domainId,
        training,
        translate,
    );
    let sections: LearnDAGNode[] = sectionsBuilt;
    const allDagNodes: LearnDAGNode[] = allDagBuilt;
    if (sections.length === 0) throw new NotFoundError('No nodes available');

    const duSec = dudoc as any;
    const duIdx = normalizeDomainUserLearnIndex(duSec.currentLearnSectionIndex);
    const duId =
        typeof duSec.currentLearnSectionId === 'string' && duSec.currentLearnSectionId.trim()
            ? duSec.currentLearnSectionId.trim()
            : null;
    const savedSectionIndex: number | null = duIdx;
    const savedSectionId = duId;
    const learnSectionOrder = duSec?.learnSectionOrder as string[] | undefined;
    sections = applyUserSectionOrder(sections, learnSectionOrder);

    let finalSectionId: string | null = null;
    let currentSectionIndex = 0;
    if (savedSectionIndex !== null && savedSectionIndex >= 0 && savedSectionIndex < sections.length) {
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

    const startNorm =
        currentSectionIndex >= 0 && currentSectionIndex < sections.length ? currentSectionIndex : 0;
    const sectionsForDailyPool =
        sections.length === 0
            ? []
            : [...sections.slice(startNorm), ...sections.slice(0, startNorm)];

    const todayFlatCards: Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string; baseDocId?: number }> = [];
    const nodeMap = new Map(allDagNodes.map(n => [n._id, n]));
    sections.forEach(s => nodeMap.set(s._id, s));
    for (const sec of sectionsForDailyPool) {
        const subDag = dagSubtreeUnderRootFromNodes(allDagNodes, sec._id);
        const nodesForSection = [{ _id: sec._id } as LearnDAGNode, ...subDag];
        for (const node of nodesForSection) {
            const n = nodeMap.get(node._id);
            if (!n) continue;
            const cardList = (n.cards || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            for (const c of cardList) {
                const p = parseTrainingNodeId(n._id);
                todayFlatCards.push({
                    nodeId: p ? p.nodeId : n._id,
                    cardId: c.cardId,
                    nodeTitle: n.title || '',
                    cardTitle: c.title || '',
                    baseDocId: p?.baseDocId,
                });
            }
        }
    }

    const candidateCards = todayFlatCards;
    const excludeTodayPassed = opts?.excludeTodayPassedCards !== false;
    const completedCardIdsTodayUtc = excludeTodayPassed
        ? await learnResultCardIdsTodayUtc(domainId, uid)
        : new Set<string>();
    const poolCards = candidateCards.filter((c) => !completedCardIdsTodayUtc.has(String(c.cardId)));
    const dailyGoalToday = Math.max(0, getModeDailyGoal(dudoc as any, 'learn'));
    let cardsForToday: typeof todayFlatCards;
    if (dailyGoalToday > 0) {
        if (poolCards.length >= dailyGoalToday) {
            cardsForToday = poolCards.slice(0, dailyGoalToday);
        } else if (poolCards.length > 0) {
            cardsForToday = cycleList(poolCards, dailyGoalToday);
        } else {
            cardsForToday = [];
        }
    } else {
        cardsForToday = poolCards;
    }

    const queuePersist: LessonCardQueueItem[] = cardsForToday.map((c) => ({
        domainId,
        nodeId: c.nodeId,
        cardId: c.cardId,
        nodeTitle: c.nodeTitle,
        cardTitle: c.cardTitle,
        baseDocId: c.baseDocId,
    }));
    const sectionOrderSnapshot = Array.isArray(learnSectionOrder)
        ? learnSectionOrder.map((id: unknown) => String(id))
        : [];

    return {
        branchByBaseToday,
        firstBaseToday,
        sections,
        allDagNodes,
        currentSectionIndex,
        finalSectionId,
        learnSectionOrder,
        sectionOrderSnapshot,
        cardsForToday,
        queuePersist,
    };
}

function queueItemsToTodayFlatCards(
    q: LessonCardQueueItem[],
    fallbackDomainId: string,
): Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string; domainId?: string; baseDocId?: number }> {
    return q.map((it) => ({
        nodeId: it.nodeId,
        cardId: it.cardId,
        nodeTitle: it.nodeTitle || '',
        cardTitle: it.cardTitle || '',
        baseDocId: it.baseDocId,
        domainId: it.domainId || fallbackDomainId,
    }));
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
            selectedTraining: null as TrainingDoc | null,
            selectedTrainingDocId: null as string | null,
        };
    }
    const dudoc = await learn.getUserLearnState(domainId, { _id: uid, priv }) as any;
    const selectedTrainingDocId = dudoc?.learnTrainingDocId ? String(dudoc.learnTrainingDocId) : null;
    const selectedTraining = selectedTrainingDocId
        ? (trainings.find((t: any) => String(t.docId) === selectedTrainingDocId) || null)
        : null;
    return { trainings, selectedTraining: selectedTraining as TrainingDoc | null, selectedTrainingDocId };
}

async function requireSelectedTraining(domainId: string, uid: number, priv: number): Promise<TrainingDoc> {
    const { selectedTraining } = await getLearnTrainingSelection(domainId, uid, priv);
    if (!selectedTraining) throw new ValidationError('Please select a training for learning first');
    return selectedTraining;
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
    if (!sources.length) throw new ValidationError('Training has no plan sources');
    await ensureTrainingLearnDAGCached(domainId, training as TrainingDoc, translate);
    await learn.setUserLearnState(domainId, uid, {
        learnTrainingDocId: training.docId,
        learnBaseDocId: null,
        learnSectionOrder: null,
        learnProgressPosition: 0,
        learnProgressTotal: 0,
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
    /** Position in the ordered list (disambiguates duplicate section ids in keys and navigation). */
    slotIndex: number;
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

/** Sections with at least one card completed today (from learn_result), independent of learning point. */
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

/** Pending nodes from the current learning point: ordered rows with cards and problem stems under each subtree. */
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
    // Also honor node.parentId when the base uses it instead of edges for hierarchy.
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

        // Each DAG node lists only its own cards (not descendants) to avoid duplicate tree rendering.
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
            const rootListed = sections.some((s) => s._id === rootNode.id)
                || dagNodes.some((n) => n._id === rootNode.id);
            if (!rootListed) {
                const rootOnlyCards = await CardModel.getByNodeId(domainId, baseDocId, rootNode.id);
                const rootCardList = rootOnlyCards.map((card) => toCardItem(card)).sort((a, b) => (a.order || 0) - (b.order || 0));
                sections.push({
                    _id: rootNode.id,
                    title: rootNode.text || translate('Unnamed Node'),
                    requireNids: [],
                    cards: rootCardList,
                    order: rootNode.order || nodeIndex++,
                });
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

/** Full Learn path overview: merged graph matching the training editor plus each source's targetBranch cards. */
async function generatePathDAGFromMerged(
    domainId: string,
    branchByBase: Map<number, string>,
    nodes: BaseNode[],
    edges: BaseEdge[],
    translate: (key: string) => string,
): Promise<{ sections: LearnDAGNode[]; dag: LearnDAGNode[] }> {
    const fetchCards = async (mergedNodeId: string) => {
        if (isTrainingRootNodeId(mergedNodeId)) return [];
        const p = parseTrainingNodeId(mergedNodeId);
        if (!p) return [];
        const br = branchByBase.get(p.baseDocId) || 'main';
        return CardModel.getByNodeId(domainId, p.baseDocId, p.nodeId, br);
    };

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

        const rawCards = await fetchCards(nodeId);
        const cardList = rawCards.map(card => toCardItem(card)).sort((a, b) => (a.order || 0) - (b.order || 0));

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
            const rootListed = sections.some((s) => s._id === rootNode.id)
                || dagNodes.some((n) => n._id === rootNode.id);
            // Virtual training roots (training_root_*) have no real cards; title is the training name.
            // Otherwise they would be appended as unlisted roots and duplicate the training at the path bottom.
            if (!rootListed && !isTrainingRootNodeId(rootNode.id)) {
                const rootOnlyCards = await fetchCards(rootNode.id);
                const rootCardList = rootOnlyCards.map((card) => toCardItem(card)).sort((a, b) => (a.order || 0) - (b.order || 0));
                sections.push({
                    _id: rootNode.id,
                    title: rootNode.text || translate('Unnamed Node'),
                    requireNids: [],
                    cards: rootCardList,
                    order: rootNode.order || nodeIndex++,
                });
            }
        } else {
            const allOtherNodes = nodes.filter(n => n.id !== rootNode.id);

            if (allOtherNodes.length > 0) {
                for (const otherNode of allOtherNodes) {
                    if (isTrainingRootNodeId(otherNode.id)) continue;
                    const c = await fetchCards(otherNode.id);
                    const cardList = c.map(card => toCardItem(card)).sort((a, b) => (a.order || 0) - (b.order || 0));

                    sections.push({
                        _id: otherNode.id,
                        title: otherNode.text || translate('Unnamed Node'),
                        requireNids: [],
                        cards: cardList,
                        order: otherNode.order || nodeIndex++,
                    });
                }
            } else {
                const rootCards = await fetchCards(rootNode.id);
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
            const training = await requireSelectedTraining(finalDomainId, this.user._id, this.user.priv);
            const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const { sections, allDagNodes } = await ensureTrainingLearnDAGCached(
                finalDomainId,
                training,
                (key: string) => this.translate(key),
            );
            if (sections.length === 0) {
                throw new ValidationError(this.translate('No cards in this domain') || 'No cards in this domain');
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
            const sectionNode = nodeMap.get(finalSectionId);
            if (sectionNode) {
                for (const c of (sectionNode.cards || [])) cardIdsToCheck.push(c.cardId);
            }
            for (const node of dag) {
                const n = nodeMap.get(node._id);
                if (!n) continue;
                for (const c of (n.cards || [])) cardIdsToCheck.push(c.cardId);
            }
            if (cardIdsToCheck.length === 0) {
                const planBases = TrainingModel.resolvePlanSources(training as any).map((s) => s.baseDocId).filter((b) => b > 0);
                const cardColl = this.ctx.db.db.collection('document');
                const anyCard = planBases.length
                    ? await cardColl.findOne({
                        domainId: finalDomainId,
                        docType: 71,
                        baseDocId: { $in: planBases },
                    })
                    : null;
                if (!anyCard) {
                    throw new ValidationError(this.translate('No cards in this domain') || 'No cards in this domain');
                }
            }
        }

        await learn.setUserLearnState(finalDomainId, this.user._id, { learnDailyGoal: dailyGoal });
        await clearDailyPracticeSessionAfterSettingsChange(finalDomainId, this.user._id, this.user.priv);

        this.response.body = { success: true, dailyGoal };
    }

    @param('sectionId', Types.String, true)
    async get(domainId: string, sectionId?: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const { trainings, selectedTraining, selectedTrainingDocId } = await getLearnTrainingSelection(finalDomainId, this.user._id, this.user.priv);
        const learnTrainings = trainings.map((item: any) => ({
            docId: String(item.docId),
            name: item.name || '',
        }));
        const trainingDocIdStr = selectedTraining ? String((selectedTraining as any).docId) : '';
        // If the selected training has been deleted, clear selection so UI shows "pending selection".
        if (selectedTrainingDocId && !selectedTraining) {
            await learn.setUserLearnState(finalDomainId, this.user._id, {
                learnTrainingDocId: null,
                learnBaseDocId: null,
                learnSectionOrder: null,
                learnProgressPosition: 0,
                learnProgressTotal: 0,
                currentLearnSectionId: null,
                currentLearnSectionIndex: 0,
            });
        }
        if (!trainings.length) {
            this.response.template = 'learn.html';
            this.response.body = {
                dag: [],
                fullDag: [],
                sections: [],
                domainId: finalDomainId,
                trainingDocId: null,
                learnTrainings: [],
                selectedLearnTrainingDocId: null,
                requireTrainingSelection: false,
                requireBaseSelection: false,
                lessonSessionId: '',
                ...(await buildTodayDailyLessonResumeFields(finalDomainId, this.user._id, this.user.priv)),
            };
            return;
        }
        if (!selectedTraining) {
            this.response.template = 'learn.html';
            this.response.body = {
                dag: [],
                fullDag: [],
                sections: [],
                currentSectionId: null,
                currentSectionIndex: 0,
                domainId: finalDomainId,
                trainingDocId: null,
                learnTrainings,
                selectedLearnTrainingDocId: null,
                requireTrainingSelection: true,
                requireBaseSelection: true,
                pendingNodeList: [],
                completedSections: [],
                completedCardsToday: [],
                passedCardIds: [],
                lessonSessionId: '',
                ...(await buildTodayDailyLessonResumeFields(finalDomainId, this.user._id, this.user.priv)),
            };
            return;
        }

        const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
        let sections: LearnDAGNode[] = [];
        let allDagNodes: LearnDAGNode[] = [];
        try {
            const built = await ensureTrainingLearnDAGCached(
                finalDomainId,
                selectedTraining as TrainingDoc,
                (k: string) => this.translate(k),
            );
            sections = built.sections;
            allDagNodes = built.allDagNodes;
        } catch {
            sections = [];
            allDagNodes = [];
        }

        if (sections.length === 0) {
            this.response.template = 'learn.html';
            this.response.body = {
                dag: [],
                fullDag: [],
                sections: [],
                currentSectionId: null,
                currentSectionIndex: 0,
                domainId: finalDomainId,
                trainingDocId: trainingDocIdStr,
                pendingNodeList: [],
                completedSections: [],
                completedCardsToday: [],
                passedCardIds: [],
                learnTrainings,
                selectedLearnTrainingDocId: trainingDocIdStr,
                requireTrainingSelection: false,
                requireBaseSelection: false,
                lessonSessionId: '',
                ...(await buildTodayDailyLessonResumeFields(finalDomainId, this.user._id, this.user.priv)),
            };
            return;
        }

        const sdocMain = await SessionModel.get(finalDomainId, this.user._id);
        const Lsec = mergeDomainLessonState(dudoc, sdocMain);
        const savedSectionIndex = normalizeDomainUserLearnIndex(Lsec.currentLearnSectionIndex);
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
        } else if (sectionId) {
            const idx = sections.findIndex(s => s._id === sectionId);
            finalSectionId = sectionId;
            currentSectionIndex = idx >= 0 ? idx : 0;
            // Progress: completed count equals currentSectionIndex (0-based slot in section order).
            await learn.setUserLearnState(finalDomainId, this.user._id, {
                currentLearnSectionId: sectionId,
                currentLearnSectionIndex: currentSectionIndex,
                learnProgressPosition: Math.max(0, currentSectionIndex),
                learnProgressTotal: totalSectionsForProgress,
            });
        } else {
            // Section Order / learn settings live on domain.user; session merge can be stale — prefer dudoc and do not GET-overwrite from session id.
            const duIdx = normalizeDomainUserLearnIndex((dudoc as any).currentLearnSectionIndex);
            const duIdRaw = (dudoc as any).currentLearnSectionId;
            const duId = typeof duIdRaw === 'string' && duIdRaw.trim() ? duIdRaw.trim() : null;
            if (duIdx !== null && duIdx >= 0 && duIdx < sections.length) {
                finalSectionId = sections[duIdx]._id;
                currentSectionIndex = duIdx;
            } else if (duId && sections.some(s => s._id === duId)) {
                const idx = sections.findIndex(s => s._id === duId);
                finalSectionId = duId;
                currentSectionIndex = idx >= 0 ? idx : 0;
            } else if (savedSectionIndex !== null && savedSectionIndex >= 0 && savedSectionIndex < sections.length) {
                finalSectionId = sections[savedSectionIndex]._id;
                currentSectionIndex = savedSectionIndex;
            } else if (savedSectionId && sections.find(s => s._id === savedSectionId)) {
                const idx = sections.findIndex(s => s._id === savedSectionId);
                finalSectionId = savedSectionId;
                currentSectionIndex = idx >= 0 ? idx : 0;
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

        // Section progress numerator/denominator from learnProgressPosition / learnProgressTotal only.
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
        for (const [cardIdStr, { createdAt, resultId }] of latestByCardId) {
            if (!resultId) continue;
            const cardDoc = await CardModel.get(finalDomainId, new ObjectId(cardIdStr));
            if (!cardDoc) continue;
            const nodeTitle = await nodeTitleForLearnCard(finalDomainId, cardDoc as any);
            completedCardsToday.push({
                cardId: cardIdStr,
                resultId,
                cardTitle: cardDoc.title || '',
                nodeTitle,
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

        // Do not auto-advance section on GET: passedCardIds is domain-global while flatCards is only the
        // current section DAG — moving "Learning start" backward makes every earlier section look "fully
        // passed" and we would chain-advance + persist until the first section with a gap (e.g. ancient),
        // overwriting Section Order. Current section stays as set in domain.user / Section Order.

        this.response.template = 'learn.html';
        this.response.body = {
            dag: dagWithProgress,
            fullDag: allDagNodes,
            sections: sections,
            currentSectionId: finalSectionId,
            currentSectionIndex,
            domainId: finalDomainId,
            trainingDocId: trainingDocIdStr,
            baseDocId: null,
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
            selectedLearnTrainingDocId: trainingDocIdStr,
            requireTrainingSelection: false,
            requireBaseSelection: false,
            lessonSessionId: '',
            ...(await buildTodayDailyLessonResumeFields(finalDomainId, this.user._id, this.user.priv)),
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
        const training = await requireSelectedTraining(finalDomainId, this.user._id, this.user.priv);
        this.response.template = 'learn_edit.html';
        this.response.body = {
            domainId,
            trainingDocId: String(training.docId),
            trainingTitle: training.name || '',
        };
    }

    @post('branch', Types.String)
    async postSetBranch(_domainId: string, _branch: string) {
        await requireSelectedTraining(_domainId, this.user._id, this.user.priv);
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

/** SPA next-card: reuse frozen `lessonCardQueue` + `cardIndex` on the daily session (same rules as GET today reuse path). */
async function buildSpaLessonSnapshotToday(
    translate: LessonTranslate,
    finalDomainId: string,
    uid: number,
    priv: number,
    qSession: string | undefined,
): Promise<Record<string, unknown> | null> {
    let training: TrainingDoc;
    try {
        training = await requireSelectedTraining(finalDomainId, uid, priv);
    } catch {
        return null;
    }
    const dudocSpaToday = await learn.getUserLearnState(finalDomainId, { _id: uid, priv }) as any;
    const sDaily = await resolveLearnDailySessionDoc(finalDomainId, uid, dudocSpaToday);
    if (!sDaily || !lessonTodayFrozenQueueIsValid(sDaily)) return null;
    const qTrim = typeof qSession === 'string' ? qSession.trim() : '';
    if (qTrim && sDaily._id.toString() !== qTrim) return null;
    const q = sDaily.lessonCardQueue ?? [];
    if (q.length === 0) return null;
    if (!frozenTodayQueueMatchesLearnSettings(dudocSpaToday, sDaily)) return null;
    if (isLessonSessionAbandoned(sDaily)) return null;
    const idx = typeof sDaily.cardIndex === 'number' ? sDaily.cardIndex : 0;
    if (idx >= q.length) return null;
    const flatCards = queueItemsToTodayFlatCards(q, finalDomainId);
    const currentItem = flatCards[idx];
    const currentCard = await CardModel.get(finalDomainId, new ObjectId(currentItem.cardId));
    if (!currentCard) return null;
    const planSpa = TrainingModel.resolvePlanSources(training as any);
    const branchByBaseToday = new Map<number, string>();
    for (const s of planSpa) {
        branchByBaseToday.set(s.baseDocId, s.targetBranch || 'main');
    }
    const firstBaseToday = planSpa[0]?.baseDocId ?? 0;
    const todayResolvedBase = (typeof currentItem.baseDocId === 'number' && currentItem.baseDocId > 0)
        ? currentItem.baseDocId
        : (baseNumericId(currentCard.baseDocId) > 0 ? baseNumericId(currentCard.baseDocId) : firstBaseToday);
    if (!todayResolvedBase) return null;
    const todayLessonBranch = branchByBaseToday.get(todayResolvedBase) || 'main';
    const baseDocToday = await BaseModel.get(finalDomainId, todayResolvedBase);
    if (!baseDocToday) return null;
    const currentNode = (getBranchData(baseDocToday, todayLessonBranch).nodes || []).find((n: BaseNode) => n.id === currentItem.nodeId)
        || ({ id: currentItem.nodeId, title: currentItem.nodeTitle, text: '' } as BaseNode);
    const currentCardList = await CardModel.getByNodeId(finalDomainId, todayResolvedBase, currentItem.nodeId, todayLessonBranch);
    const currentIndexInNode = currentCardList.findIndex((c: any) => c.docId.toString() === currentItem.cardId);
    const L = mergeDomainLessonState(dudocSpaToday, sDaily);
    const lessonReviewCardIds = [...L.lessonReviewCardIds];
    const lessonCardTimesMs = [...L.lessonCardTimesMs];
    const sessionHex = sDaily._id.toString();
    const learnRecordIdToday = await ensureLearnRecordForCard(
        finalDomainId,
        uid,
        sessionHex,
        currentCard as any,
        todayResolvedBase,
        cardStorageBranch(currentCard as any) || todayLessonBranch,
    );
    const todayNodeTree = [{
        type: 'node' as const,
        id: 'today',
        title: translate('Today task') || 'Today task',
        children: flatCards.map(c => ({ type: 'card' as const, id: c.cardId, title: c.cardTitle })),
    }];
    return {
        card: currentCard,
        node: currentNode,
        cards: currentCardList,
        currentIndex: currentIndexInNode >= 0 ? currentIndexInNode : 0,
        domainId: finalDomainId,
        baseDocId: String(todayResolvedBase),
        isAlonePractice: false,
        isTodayMode: true,
        rootNodeId: 'today',
        rootNodeTitle: translate('Today task') || 'Today task',
        flatCards,
        nodeTree: todayNodeTree,
        currentCardIndex: idx,
        hasProblems: !!(currentCard?.problems?.length),
        lessonReviewCardIds,
        lessonCardTimesMs,
        reviewCardId: '',
        lessonSessionId: sessionHex,
        lessonSessionDomainId: finalDomainId,
        learnRecordId: learnRecordIdToday || '',
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
    let training: TrainingDoc;
    try {
        training = await requireSelectedTraining(finalDomainId, uid, priv);
    } catch {
        return null;
    }
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
    const { sections, allDagNodes } = await ensureTrainingLearnDAGCached(finalDomainId, training, translate);
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
    const dudocSpaNode = await learn.getUserLearnState(finalDomainId, { _id: uid, priv }) as any;
    const L = mergeDomainLessonState(dudocSpaNode, sNode);
    const lessonReviewCardIds = [...L.lessonReviewCardIds];
    const lessonCardTimesMs = [...L.lessonCardTimesMs];
    const currentCard = await CardModel.get(finalDomainId, new ObjectId(currentItem.cardId));
    if (!currentCard) return null;
    const br = cardStorageBranch(currentCard as any);
    const cardBaseIdNode = baseNumericId(currentCard.baseDocId);
    const baseOfCard = await BaseModel.get(finalDomainId, cardBaseIdNode);
    if (!baseOfCard) return null;
    const currentNode = (getBranchData(baseOfCard, br).nodes || []).find((n: BaseNode) => n.id === currentCard.nodeId);
    if (!currentNode) return null;
    const currentCardList = await CardModel.getByNodeId(finalDomainId, cardBaseIdNode, currentCard.nodeId, br);
    const currentIndexInNode = currentCardList.findIndex((c: any) => c.docId.toString() === currentItem.cardId);
    const sid = lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, uid));
    const learnRecordIdSpaNode = await ensureLearnRecordForCard(
        finalDomainId,
        uid,
        qSession,
        currentCard as any,
        cardBaseIdNode,
        br,
    );
    return {
        card: currentCard,
        node: currentNode,
        cards: currentCardList,
        currentIndex: currentIndexInNode >= 0 ? currentIndexInNode : 0,
        domainId: finalDomainId,
        baseDocId: String(cardBaseIdNode),
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

/** Used with ?format=json: lesson snapshot from Mongo session (SPA next card / restore). */
async function tryLessonSpaSnapshotForHandler(
    h: { translate: (key: string) => string },
    finalDomainId: string,
    uid: number,
    priv: number,
    qSession: string | undefined,
): Promise<Record<string, unknown> | null> {
    const dudoc = await learn.getUserLearnState(finalDomainId, { _id: uid, priv }) as any;
    const sdoc = await resolveLessonSessionForMerge(finalDomainId, uid, qSession || undefined, dudoc);
    const L = mergeDomainLessonState(dudoc, sdoc);
    const t = (k: string) => h.translate(k);
    if (L.lessonMode === 'today') {
        return await buildSpaLessonSnapshotToday(t, finalDomainId, uid, priv, qSession);
    }
    if (L.lessonMode === 'node' && L.lessonNodeId) {
        return await buildSpaLessonSnapshotNode(t, finalDomainId, L.lessonNodeId, uid, priv, qSession);
    }
    if (L.lessonMode === 'card') {
        return null;
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
                if (sJson) {
                    const listSt = deriveSessionLearnStatus(sJson as SessionDoc);
                    if (listSt === 'timed_out' || listSt === 'finished' || listSt === 'abandoned') {
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
                        const errKey =
                            listSt === 'timed_out'
                                ? 'session_timed_out'
                                : listSt === 'abandoned'
                                    ? 'session_abandoned'
                                    : 'session_finished';
                        this.response.body = {
                            success: false,
                            spaNext: false,
                            error: errKey,
                            session: sessionDocToWire(sJson as SessionDoc),
                            recordSummaries,
                            recordHistoryRows: lessonHistoryRowsToWire(recordHistoryRows),
                        };
                        return;
                    }
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

        if (qLessonSession && ObjectId.isValid(qLessonSession)) {
            const sExpired = await SessionModel.coll.findOne({
                _id: new ObjectId(qLessonSession),
                domainId: finalDomainId,
                uid: this.user._id,
            }) as SessionDoc | null;
            const historySt = sExpired ? deriveSessionLearnStatus(sExpired as SessionDoc) : null;
            if (sExpired && (historySt === 'timed_out' || historySt === 'finished' || historySt === 'abandoned')) {
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
                const isTimedOut = historySt === 'timed_out';
                const isAbandoned = historySt === 'abandoned';
                const histStatus = isAbandoned ? ('abandoned' as const) : isTimedOut ? ('timed_out' as const) : ('finished' as const);
                const histLabelKey = isAbandoned
                    ? 'session_status_abandoned'
                    : isTimedOut
                        ? 'session_status_timed_out'
                        : 'session_status_finished';
                this.response.template = 'lesson_session_history.html';
                this.response.body = {
                    domainId: finalDomainId,
                    page_name: 'learn_lesson',
                    session: {
                        ...(sExpired as SessionDoc),
                        status: histStatus,
                        statusLabel: this.translate(histLabelKey),
                        recordType: rt,
                        recordTypeLabel: this.translate(`session_record_type_${rt}`),
                        recordSummaries,
                        cardProgressText: formatSessionCardProgress(sExpired as SessionDoc),
                    },
                    recordHistoryRows,
                    learnHomeUrl: this.url('learn', { domainId: finalDomainId }),
                };
                return;
            }
        }

        const training = await requireSelectedTraining(finalDomainId, this.user._id, this.user.priv);

        const dudoc = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
        const branch = LEARN_GRAPH_BRANCH;
        const sdocLesson = await resolveLessonSessionForMerge(finalDomainId, this.user._id, qLessonSession || undefined, dudoc);
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

        if (qLessonSession && ObjectId.isValid(qLessonSession)) {
            const sCardLesson = await SessionModel.coll.findOne({
                _id: new ObjectId(qLessonSession),
                domainId: finalDomainId,
                uid: this.user._id,
            }) as SessionDoc | null;
            if (!isLessonSessionAbandoned(sCardLesson)
                && sCardLesson?.lessonMode === 'card'
                && typeof sCardLesson.cardId === 'string'
                && sCardLesson.cardId.trim()) {
                const cidStr = sCardLesson.cardId.trim();
                if (queryCardId && String(queryCardId).trim() !== cidStr) {
                    throw new ValidationError('cardId does not match session');
                }
                let cardId: ObjectId;
                try {
                    cardId = new ObjectId(cidStr);
                } catch {
                    throw new ValidationError('Invalid cardId');
                }

                const card = await CardModel.get(finalDomainId, cardId);
                if (!card) {
                    throw new NotFoundError('Card not found');
                }

                const hasCardProblems = !!(card.problems && card.problems.length > 0);
                const cardBr = cardStorageBranch(card as any);
                const cardBid = baseNumericId(card.baseDocId);
                const cardBase = await BaseModel.get(finalDomainId, cardBid);
                if (!cardBase) throw new NotFoundError('Base not found for card');
                const node = (getBranchData(cardBase, cardBr).nodes || []).find(n => n.id === card.nodeId);
                if (hasCardProblems && !node) {
                    throw new NotFoundError('Node not found');
                }

                const queryReviewCardId = (this.request.query?.reviewCardId as string) || '';
                const lessonReviewCardIds = [...L.lessonReviewCardIds];
                const lessonCardTimesMs = [...L.lessonCardTimesMs];

                await SessionModel.touchById(
                    finalDomainId,
                    this.user._id,
                    sCardLesson._id,
                    {
                        appRoute: 'learn',
                        route: 'learn',
                        lessonMode: 'card',
                        cardId: cidStr,
                        baseDocId: cardBid,
                        branch: cardBr,
                    },
                    { silent: true },
                );

                const nodeForResponse = node || { id: card.nodeId || '', title: '', text: '' };
                const cards = node
                    ? await CardModel.getByNodeId(finalDomainId, cardBid, card.nodeId, cardBr)
                    : [card];
                const currentIndex = cards.findIndex((c: any) => c.docId.toString() === cardId.toString());

                const flatCards = [{
                    nodeId: nodeForResponse.id || '',
                    cardId: card.docId.toString(),
                    nodeTitle: (nodeForResponse as any).title || '',
                    cardTitle: card.title || '',
                }];

                const sidHex = sCardLesson._id.toString();
                const learnRecordId = await ensureLearnRecordForCard(
                    finalDomainId,
                    this.user._id,
                    sidHex,
                    card as any,
                    cardBid,
                    cardBr,
                );

                this.response.template = 'lesson.html';
                this.response.body = {
                    card,
                    node: nodeForResponse,
                    cards,
                    currentIndex: currentIndex >= 0 ? currentIndex : 0,
                    domainId: finalDomainId,
                    baseDocId: String(cardBid),
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
                    lessonSessionId: sidHex,
                    lessonSessionDomainId: finalDomainId,
                    learnRecordId: learnRecordId || '',
                };
                return;
            }
        }

        if (queryCardId) {
            this.response.redirect = this.url('learn_sections', { domainId: finalDomainId });
            return;
        }

        if (L.lessonMode === 'node' && L.lessonNodeId) {
            const lessonNodeId = L.lessonNodeId;
            const sNode = await resolveLessonSessionDoc(finalDomainId, this.user._id, qLessonSession || undefined);
            const planSourcesNode = TrainingModel.resolvePlanSources(training as any);
            const branchByBaseNode = new Map<number, string>();
            for (const s of planSourcesNode) {
                branchByBaseNode.set(s.baseDocId, s.targetBranch || 'main');
            }
            const queueBaseHint = (typeof sNode?.lessonQueueBaseDocId === 'number' && sNode.lessonQueueBaseDocId > 0)
                ? sNode.lessonQueueBaseDocId
                : (parseTrainingNodeId(lessonNodeId)?.baseDocId ?? planSourcesNode[0]?.baseDocId ?? 0);

            const { sections: trainSecNode, allDagNodes } = await ensureTrainingLearnDAGCached(
                finalDomainId,
                training,
                (k: string) => this.translate(k),
            );
            const nodeMap = new Map<string, LearnDAGNode>();
            trainSecNode.forEach(n => nodeMap.set(n._id, n));
            allDagNodes.forEach(n => nodeMap.set(n._id, n));
            const rootNode = nodeMap.get(lessonNodeId);
            if (!rootNode) throw new NotFoundError('Node not found');

            const getChildNodes = (parentId: string): LearnDAGNode[] => {
                return allDagNodes
                    .filter(n => n.requireNids && n.requireNids[n.requireNids.length - 1] === parentId)
                    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            };

            type NodeFlat = { nodeId: string; cardId: string; nodeTitle: string; cardTitle: string; baseDocId?: number };
            const flatCards: NodeFlat[] = [];
            const nodeTree: Array<{ type: 'node'; id: string; title: string; children: Array<{ type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }> }> = [];

            const collectUnder = (dagNodeId: string): Array<{ type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }> => {
                const node = nodeMap.get(dagNodeId);
                if (!node) return [];
                const parsed = parseTrainingNodeId(node._id);
                const rawNodeId = parsed ? parsed.nodeId : node._id;
                const cardBase = parsed?.baseDocId;
                const children: Array<{ type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }> = [];
                const cardList = (node.cards || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                for (const c of cardList) {
                    flatCards.push({
                        nodeId: rawNodeId,
                        cardId: c.cardId,
                        nodeTitle: node.title || '',
                        cardTitle: c.title || '',
                        baseDocId: cardBase,
                    });
                    children.push({ type: 'card', id: c.cardId, title: c.title || '' });
                }
                const childNodes = getChildNodes(dagNodeId);
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
                const sidB = (typeof sNode?.lessonQueueBaseDocId === 'number' && sNode.lessonQueueBaseDocId > 0)
                    ? sNode.lessonQueueBaseDocId
                    : undefined;
                for (const q of sNode!.lessonCardQueue!) {
                    const p = parseTrainingNodeId(q.nodeId);
                    flatCards.push({
                        nodeId: p ? p.nodeId : q.nodeId,
                        cardId: q.cardId,
                        nodeTitle: q.nodeTitle || '',
                        cardTitle: q.cardTitle || '',
                        baseDocId: (typeof q.baseDocId === 'number' && q.baseDocId > 0)
                            ? q.baseDocId
                            : (p?.baseDocId ?? sidB),
                    });
                }
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
                    baseDocId: fc.baseDocId,
                }));
                const trainId = (dudoc as any)?.learnTrainingDocId;
                const persistBase = queueBaseHint || planSourcesNode[0]?.baseDocId || 0;
                const persistBranch = persistBase ? (branchByBaseNode.get(persistBase) || 'main') : LEARN_GRAPH_BRANCH;
                const touchNodeQueue = sNode?._id
                    ? SessionModel.touchById(finalDomainId, this.user._id, sNode._id, {
                        appRoute: 'learn',
                        lessonCardQueue: queueItems,
                        lessonQueueAnchorNodeId: lessonNodeId,
                        lessonQueueBaseDocId: persistBase || null,
                        lessonQueueTrainingDocId: trainId ? String(trainId) : null,
                        lessonQueueDay: null,
                        branch: persistBranch,
                    }, { silent: true })
                    : touchLessonSession(finalDomainId, this.user._id, {
                        appRoute: 'learn',
                        lessonCardQueue: queueItems,
                        lessonQueueAnchorNodeId: lessonNodeId,
                        lessonQueueBaseDocId: persistBase || null,
                        lessonQueueTrainingDocId: trainId ? String(trainId) : null,
                        lessonQueueDay: null,
                        branch: persistBranch,
                    }, { silent: true });
                await touchNodeQueue;
            }

            let currentCardIndex = Math.max(0, L.lessonCardIndex);

            if (flatCards.length === 0) {
                throw new NotFoundError('No cards under this node');
            }
            if (currentCardIndex >= flatCards.length) currentCardIndex = 0;

            const reviewCardId = this.request.query?.reviewCardId as string | undefined;
            let currentItem: NodeFlat;
            let lessonReviewCardIds: string[] = [];
            let lessonCardTimesMs: number[] = [];
            if (reviewCardId) {
                const fromReview = flatCards.find(c => c.cardId === reviewCardId);
                if (fromReview) {
                    currentItem = fromReview;
                    currentCardIndex = flatCards.findIndex(c => c.cardId === reviewCardId);
                    const dudocReview = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
                    const sReview = sNode ?? await SessionModel.get(finalDomainId, this.user._id);
                    const Rv = mergeDomainLessonState(dudocReview, sReview);
                    const reviewIds: string[] = [...Rv.lessonReviewCardIds];
                    lessonReviewCardIds = reviewIds.filter(id => id !== reviewCardId);
                    lessonCardTimesMs = [...Rv.lessonCardTimesMs];
                    if (sNode?._id) {
                        await SessionModel.touchById(finalDomainId, this.user._id, sNode._id, { appRoute: 'learn', lessonReviewCardIds, lessonCardTimesMs }, { silent: true });
                    } else {
                        await touchLessonSession(finalDomainId, this.user._id, { appRoute: 'learn', lessonReviewCardIds, lessonCardTimesMs }, { silent: true });
                    }
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
            const resolvedBase = (typeof currentItem.baseDocId === 'number' && currentItem.baseDocId > 0)
                ? currentItem.baseDocId
                : (baseNumericId(currentCard.baseDocId) > 0
                    ? baseNumericId(currentCard.baseDocId)
                    : (queueBaseHint || planSourcesNode[0]?.baseDocId));
            if (!resolvedBase) throw new NotFoundError('Base not found for this domain');
            const nodeLessonBranch = branchByBaseNode.get(resolvedBase) || 'main';
            const baseDocForNode = await BaseModel.get(finalDomainId, resolvedBase);
            if (!baseDocForNode) throw new NotFoundError('Base not found');
            const currentNode = (getBranchData(baseDocForNode, nodeLessonBranch).nodes || []).find(n => n.id === currentItem.nodeId)
                || ({ id: currentItem.nodeId, title: currentItem.nodeTitle, text: '' } as any);
            const currentCardList = await CardModel.getByNodeId(finalDomainId, resolvedBase, currentItem.nodeId, nodeLessonBranch);
            const currentIndexInNode = currentCardList.findIndex(c => c.docId.toString() === currentItem.cardId);

            const touchNodeActive = sNode?._id
                ? SessionModel.touchById(finalDomainId, this.user._id, sNode._id, {
                    appRoute: 'learn',
                    route: 'learn',
                    lessonMode: 'node',
                    nodeId: lessonNodeId,
                    cardIndex: currentCardIndex,
                    baseDocId: resolvedBase,
                    branch: nodeLessonBranch,
                }, { silent: false })
                : touchLessonSession(finalDomainId, this.user._id, {
                    appRoute: 'learn',
                    route: 'learn',
                    lessonMode: 'node',
                    nodeId: lessonNodeId,
                    cardIndex: currentCardIndex,
                    baseDocId: resolvedBase,
                    branch: nodeLessonBranch,
                }, { silent: false });
            await touchNodeActive;

            const learnRecordIdNode = await ensureLearnRecordForCard(
                finalDomainId,
                this.user._id,
                qLessonSession,
                currentCard as any,
                resolvedBase,
                cardStorageBranch(currentCard as any) || nodeLessonBranch,
            );

            this.response.template = 'lesson.html';
            this.response.body = {
                card: currentCard,
                node: currentNode,
                cards: currentCardList,
                currentIndex: currentIndexInNode >= 0 ? currentIndexInNode : 0,
                domainId: finalDomainId,
                baseDocId: resolvedBase.toString(),
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
                lessonSessionId: lessonSessionIdFromDoc(sNode ?? await SessionModel.get(finalDomainId, this.user._id)),
                lessonSessionDomainId: finalDomainId,
                learnRecordId: learnRecordIdNode || '',
            };
            return;
        }

        if (L.lessonMode === 'today' || L.lessonMode === null) {
            const progressFromDomain = sessionTodayProgressPatchFromDomainUser(dudoc);
            const sDailyAlign = await resolveLearnDailySessionDoc(finalDomainId, this.user._id, dudoc);
            let sTodayForFreeze: SessionDoc | null = sdocLesson as SessionDoc | null;
            if (sDailyAlign?._id) {
                let patchAlign: SessionPatch = { ...progressFromDomain };
                if (
                    (sDailyAlign.lessonCardQueue?.length ?? 0) > 0
                    && sessionTodaySectionFieldsMismatch(sDailyAlign, progressFromDomain)
                ) {
                    patchAlign = {
                        ...patchAlign,
                        lessonCardQueue: [],
                        cardIndex: 0,
                        lessonQueueDay: null,
                    };
                }
                await SessionModel.touchById(finalDomainId, this.user._id, sDailyAlign._id, patchAlign, { silent: true });
                if (sdocLesson && sdocLesson._id.equals(sDailyAlign._id)) {
                    const refToday = await SessionModel.coll.findOne({
                        _id: sDailyAlign._id,
                        domainId: finalDomainId,
                        uid: this.user._id,
                    }) as SessionDoc | null;
                    if (refToday) sTodayForFreeze = refToday;
                }
            }
            /** `SessionModel.touch` updates latest by lastActivityAt — not necessarily the daily row; always patch the resolved lesson session. */
            const touchTodayResolvedRow = async (patch: SessionPatch, opts?: { silent?: boolean }) => {
                const rid = sdocLesson?._id;
                if (rid) {
                    await SessionModel.touchById(finalDomainId, this.user._id, rid, patch, opts);
                } else {
                    await touchLessonSession(finalDomainId, this.user._id, patch, opts);
                }
            };

            const sToday = sTodayForFreeze;
            const qFrozen = sToday?.lessonCardQueue ?? [];
            const idxRawFrozen = typeof sToday?.cardIndex === 'number' ? sToday.cardIndex : 0;
            const canReuseTodayFreeze =
                !!sToday
                && sToday.lessonMode === 'today'
                && qFrozen.length > 0
                && lessonTodayFrozenQueueIsValid(sToday)
                && frozenTodayQueueMatchesLearnSettings(dudoc, sToday)
                && !isLessonSessionAbandoned(sToday);

            let branchByBaseToday: Map<number, string>;
            let firstBaseToday: number;
            let sections: LearnDAGNode[];
            let currentSectionIndex: number;
            let finalSectionId: string | null;
            let sectionOrderSnapshot: string[];
            let cardsForToday: Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string; domainId?: string; baseDocId?: number }>;
            let queuePersist: LessonCardQueueItem[];
            let todayQueueSlotIndex: number;

            if (canReuseTodayFreeze && idxRawFrozen >= qFrozen.length) {
                this.response.redirect = this.url('learn', { domainId: finalDomainId });
                return;
            }

            if (canReuseTodayFreeze) {
                const planSourcesToday = TrainingModel.resolvePlanSources(training as any);
                branchByBaseToday = new Map<number, string>();
                for (const s of planSourcesToday) {
                    branchByBaseToday.set(s.baseDocId, s.targetBranch || 'main');
                }
                firstBaseToday = planSourcesToday[0]?.baseDocId ?? 0;
                sections = [];
                queuePersist = qFrozen;
                cardsForToday = queueItemsToTodayFlatCards(qFrozen, finalDomainId);
                const snapOrd = sToday.lessonQueueLearnSectionOrder;
                sectionOrderSnapshot = Array.isArray(snapOrd) ? snapOrd.map((id: unknown) => String(id)) : [];
                currentSectionIndex = typeof sToday.currentLearnSectionIndex === 'number' ? sToday.currentLearnSectionIndex : 0;
                const csid = typeof sToday.currentLearnSectionId === 'string' ? sToday.currentLearnSectionId.trim() : '';
                finalSectionId = csid || null;
                todayQueueSlotIndex = Math.max(0, Math.min(idxRawFrozen, qFrozen.length - 1));
            } else {
                const excludeTodayPassedCards = !!(
                    sToday
                    && !isLessonSessionAbandoned(sToday)
                    && lessonTodayFrozenQueueIsValid(sToday)
                    && frozenTodayQueueMatchesLearnSettings(dudoc, sToday)
                    && (sToday.lessonCardQueue?.length ?? 0) > 0
                );
                const builtToday = await buildTodayLessonQueueFromDomain(
                    finalDomainId,
                    this.user._id,
                    dudoc,
                    training,
                    (k: string) => this.translate(k),
                    { excludeTodayPassedCards },
                );
                branchByBaseToday = builtToday.branchByBaseToday;
                firstBaseToday = builtToday.firstBaseToday;
                sections = builtToday.sections;
                currentSectionIndex = builtToday.currentSectionIndex;
                finalSectionId = builtToday.finalSectionId;
                sectionOrderSnapshot = builtToday.sectionOrderSnapshot;
                cardsForToday = builtToday.cardsForToday;
                queuePersist = builtToday.queuePersist;
                todayQueueSlotIndex = 0;

                if (cardsForToday.length === 0) {
                    if (sections.length > 0 && currentSectionIndex + 1 < sections.length) {
                        await learn.setUserLearnState(finalDomainId, this.user._id, {
                            currentLearnSectionIndex: currentSectionIndex + 1,
                            currentLearnSectionId: sections[currentSectionIndex + 1]._id,
                            lessonUpdatedAt: new Date(),
                        });
                        await touchTodayResolvedRow({
                            appRoute: 'learn',
                            currentLearnSectionIndex: currentSectionIndex + 1,
                            currentLearnSectionId: sections[currentSectionIndex + 1]._id,
                            lessonMode: 'today',
                            nodeId: null,
                            cardIndex: 0,
                            lessonCardQueue: [],
                            lessonQueueDay: null,
                            baseDocId: firstBaseToday || null,
                            branch: firstBaseToday ? (branchByBaseToday.get(firstBaseToday) || 'main') : LEARN_GRAPH_BRANCH,
                            lessonAbandonedAt: null,
                        }, { silent: true });
                        this.response.redirect = appendLessonSessionToUrl(
                            `/d/${finalDomainId}/learn/lesson`,
                            sdocLesson?._id ? sdocLesson._id.toString() : lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, this.user._id)),
                        );
                        return;
                    }
                    await touchTodayResolvedRow({
                        appRoute: 'learn',
                        lessonMode: null,
                        nodeId: null,
                        cardIndex: null,
                        lessonCardQueue: [],
                        lessonQueueDay: null,
                        lessonAbandonedAt: null,
                    }, { silent: true });
                    this.response.redirect = this.url('learn', { domainId: finalDomainId });
                    return;
                }

                const trainIdToday = (dudoc as any)?.learnTrainingDocId;
                await touchTodayResolvedRow({
                    lessonCardQueue: queuePersist,
                    lessonQueueBaseDocId: firstBaseToday || null,
                    lessonQueueTrainingDocId: trainIdToday ? String(trainIdToday) : null,
                    lessonQueueLearnSectionOrder: sectionOrderSnapshot,
                    lessonQueueAnchorNodeId: null,
                    lessonMode: 'today',
                    lessonQueueDay: utcLessonQueueDayString(),
                    cardIndex: 0,
                    currentLearnSectionIndex: currentSectionIndex,
                    currentLearnSectionId: finalSectionId ?? sections[currentSectionIndex]?._id ?? null,
                    lessonAbandonedAt: null,
                }, { silent: true });
            }

            const currentCardIndex = todayQueueSlotIndex;

            const currentItem = cardsForToday[currentCardIndex];
            const currentCard = await CardModel.get(finalDomainId, new ObjectId(currentItem.cardId));
            // Allow no-problem cards in today's lesson (card view mode).
            if (!currentCard) {
                throw new NotFoundError('Card not found');
            }
            const todayResolvedBase = (typeof currentItem.baseDocId === 'number' && currentItem.baseDocId > 0)
                ? currentItem.baseDocId
                : (baseNumericId(currentCard.baseDocId) > 0 ? baseNumericId(currentCard.baseDocId) : firstBaseToday);
            if (!todayResolvedBase) throw new NotFoundError('Base not found for this domain');
            const todayLessonBranch = branchByBaseToday.get(todayResolvedBase) || 'main';
            const baseDocToday = await BaseModel.get(finalDomainId, todayResolvedBase);
            if (!baseDocToday) throw new NotFoundError('Base not found');
            const currentNode = (getBranchData(baseDocToday, todayLessonBranch).nodes || []).find((n: any) => n.id === currentItem.nodeId)
                || ({ id: currentItem.nodeId, title: currentItem.nodeTitle, text: '' } as any);
            const currentCardList = await CardModel.getByNodeId(finalDomainId, todayResolvedBase, currentItem.nodeId, todayLessonBranch);
            const currentIndexInNode = currentCardList.findIndex(c => c.docId.toString() === currentItem.cardId);

            await touchTodayResolvedRow({
                appRoute: 'learn',
                route: 'learn',
                lessonMode: 'today',
                nodeId: null,
                cardIndex: currentCardIndex,
                baseDocId: todayResolvedBase,
                branch: todayLessonBranch,
                lessonAbandonedAt: null,
            }, { silent: false });

            const sidToday = sdocLesson?._id
                ? sdocLesson._id.toString()
                : lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, this.user._id));
            if (sidToday) await setLearnDailySessionPointer(finalDomainId, this.user._id, sidToday);

            const todayNodeTree = [{
                type: 'node' as const,
                id: 'today',
                title: this.translate('Today task') || 'Today task',
                children: cardsForToday.map(c => ({ type: 'card' as const, id: c.cardId, title: c.cardTitle })),
            }];

            const learnRecordIdToday = await ensureLearnRecordForCard(
                finalDomainId,
                this.user._id,
                sidToday,
                currentCard as any,
                todayResolvedBase,
                cardStorageBranch(currentCard as any) || todayLessonBranch,
            );

            this.response.template = 'lesson.html';
            this.response.body = {
                card: currentCard,
                node: currentNode,
                cards: currentCardList,
                currentIndex: currentIndexInNode >= 0 ? currentIndexInNode : 0,
                domainId: finalDomainId,
                baseDocId: todayResolvedBase.toString(),
                isAlonePractice: false,
                isTodayMode: true,
                rootNodeId: 'today',
                rootNodeTitle: this.translate('Today task') || 'Today task',
                flatCards: cardsForToday,
                nodeTree: todayNodeTree,
                currentCardIndex,
                hasProblems: !!(currentCard?.problems?.length),
                lessonSessionId: sidToday,
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
        const mode: 'node' | 'card' | 'today' = body.mode === 'node'
            ? 'node'
            : body.mode === 'card'
                ? 'card'
                : 'today';
        const nodeIdStart = typeof body.nodeId === 'string' ? body.nodeId : '';
        const cardIdStartRaw = typeof body.cardId === 'string' ? body.cardId.trim() : '';
        if (mode === 'node' && !nodeIdStart) throw new ValidationError('nodeId required for node mode');
        if (mode === 'card' && (!cardIdStartRaw || !ObjectId.isValid(cardIdStartRaw))) {
            throw new ValidationError('cardId required for card mode');
        }

        const dudocSt = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
        const trainIdSt = dudocSt?.learnTrainingDocId ? String(dudocSt.learnTrainingDocId) : null;

        let sid: string;
        let redirectPath: string;
        if (mode === 'node') {
            const trainingNode = await requireSelectedTraining(finalDomainId, this.user._id, this.user.priv);
            const planN = TrainingModel.resolvePlanSources(trainingNode as any);
            const hintBaseNode = parseTrainingNodeId(nodeIdStart)?.baseDocId ?? planN[0]?.baseDocId ?? 0;
            const branchByN = new Map<number, string>();
            for (const s of planN) branchByN.set(s.baseDocId, s.targetBranch || 'main');
            const brN = hintBaseNode ? (branchByN.get(hintBaseNode) || 'main') : LEARN_GRAPH_BRANCH;
            sid = await insertOrUpgradeLearnSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                route: 'learn',
                lessonMode: 'node',
                nodeId: nodeIdStart,
                cardIndex: 0,
                lessonCardQueue: [],
                lessonQueueAnchorNodeId: null,
                lessonQueueDay: null,
                branch: brN,
                baseDocId: hintBaseNode || undefined,
                lessonQueueBaseDocId: hintBaseNode || null,
                lessonQueueTrainingDocId: trainIdSt,
            } as SessionPatch);
            redirectPath = `/d/${finalDomainId}/learn/lesson`;
        } else if (mode === 'card') {
            await requireSelectedTraining(finalDomainId, this.user._id, this.user.priv);
            const cardSt = await CardModel.get(finalDomainId, new ObjectId(cardIdStartRaw));
            if (!cardSt) throw new NotFoundError('Card not found');
            const brCard = cardStorageBranch(cardSt as any);
            sid = await insertOrUpgradeLearnSession(finalDomainId, this.user._id, {
                appRoute: 'learn',
                route: 'learn',
                lessonMode: 'card',
                cardId: cardIdStartRaw,
                nodeId: null,
                cardIndex: 0,
                lessonCardQueue: [],
                lessonQueueAnchorNodeId: null,
                lessonQueueDay: null,
                branch: brCard,
                baseDocId: cardSt.baseDocId,
                lessonQueueBaseDocId: cardSt.baseDocId,
                lessonQueueTrainingDocId: trainIdSt,
            } as SessionPatch);
            redirectPath = `/d/${finalDomainId}/learn/lesson?cardId=${encodeURIComponent(cardIdStartRaw)}`;
        } else {
            const trainingToday = await requireSelectedTraining(finalDomainId, this.user._id, this.user.priv);
            const sBeforeToday = await resolveLearnDailySessionDoc(finalDomainId, this.user._id, dudocSt);
            const excludeTodayPassedCards = !!(
                sBeforeToday
                && !isLessonSessionAbandoned(sBeforeToday)
                && lessonTodayFrozenQueueIsValid(sBeforeToday)
                && frozenTodayQueueMatchesLearnSettings(dudocSt, sBeforeToday)
                && (sBeforeToday.lessonCardQueue?.length ?? 0) > 0
            );
            const progressToday = sessionTodayProgressPatchFromDomainUser(dudocSt);
            let todayPatch: SessionPatch = {
                appRoute: 'learn',
                route: 'learn',
                lessonMode: 'today',
                nodeId: null,
                cardIndex: 0,
                lessonQueueAnchorNodeId: null,
                lessonQueueTrainingDocId: trainIdSt,
                lessonCardQueue: [],
                ...progressToday,
            };
            try {
                const builtStart = await buildTodayLessonQueueFromDomain(
                    finalDomainId,
                    this.user._id,
                    dudocSt,
                    trainingToday,
                    (k: string) => this.translate(k),
                    { excludeTodayPassedCards },
                );
                if (builtStart.queuePersist.length > 0) {
                    todayPatch = {
                        ...todayPatch,
                        lessonCardQueue: builtStart.queuePersist,
                        lessonQueueBaseDocId: builtStart.firstBaseToday || null,
                        lessonQueueLearnSectionOrder: builtStart.sectionOrderSnapshot,
                        lessonQueueDay: utcLessonQueueDayString(),
                        currentLearnSectionIndex: builtStart.currentSectionIndex,
                        currentLearnSectionId:
                            builtStart.finalSectionId
                            ?? builtStart.sections[builtStart.currentSectionIndex]?._id
                            ?? null,
                    };
                }
            } catch (e) {
                if (e instanceof NotFoundError) throw e;
            }
            sid = await insertNewTodayLearnSession(finalDomainId, this.user._id, todayPatch);
            await setLearnDailySessionPointer(finalDomainId, this.user._id, sid);
            redirectPath = `/d/${finalDomainId}/learn/lesson`;
        }
        this.response.body = {
            success: true,
            redirect: appendLessonSessionToUrl(redirectPath, sid),
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

        const trainingPass = await requireSelectedTraining(finalDomainId, this.user._id, this.user.priv);
        const planSourcesPass = TrainingModel.resolvePlanSources(trainingPass as any);
        const firstBasePass = planSourcesPass[0]?.baseDocId ?? 0;
        const branchByBasePass = new Map<number, string>();
        for (const s of planSourcesPass) {
            branchByBasePass.set(s.baseDocId, s.targetBranch || 'main');
        }

        const isTodayMode = body.todayMode === true;

        if (isTodayMode) {
            const qPass = typeof body.session === 'string' ? body.session.trim() : '';
            const dudocPassToday = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const sBr = await resolveLearnDailySessionDoc(finalDomainId, this.user._id, dudocPassToday);
            if (!sBr || !lessonTodayFrozenQueueIsValid(sBr)) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            if (qPass && sBr._id.toString() !== qPass) {
                this.response.body = {
                    success: true,
                    redirect: appendLessonSessionToUrl(`/d/${finalDomainId}/learn/lesson`, sBr._id.toString()),
                };
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
            const branchLR = LEARN_GRAPH_BRANCH;
            let baseDocLR = Number((card as any).baseDocId);
            if (!baseDocLR) {
                const bLR = await BaseModel.getByDomain(cardDomain);
                baseDocLR = bLR?.docId || 0;
            }
            if (!baseDocLR && cardDomain === finalDomainId) baseDocLR = firstBasePass;
            const sessionHexToday = sBr._id.toString();
            const recScoreToday = await syncLearnPassToRecord(
                cardDomain,
                this.user._id,
                sessionHexToday,
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
                await SessionModel.touchById(
                    finalDomainId,
                    this.user._id,
                    sBr._id,
                    { cardIndex: nextIndex, lessonMode: 'today' },
                    { silent: false },
                );
                if (spaNext) {
                    const snap = await buildSpaLessonSnapshotToday(
                        (k) => this.translate(k),
                        finalDomainId,
                        this.user._id,
                        this.user.priv,
                        sessionHexToday,
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
                // Keep queue and set index past last card so list shows finished (deriveSessionLearnStatus: idx >= qLen).
                await SessionModel.touchById(
                    finalDomainId,
                    this.user._id,
                    sBr._id,
                    {
                        appRoute: 'learn',
                        route: 'learn',
                        lessonMode: 'today',
                        cardIndex: queue.length,
                    },
                    { silent: false },
                );
                await clearLearnDailySessionPointer(finalDomainId, this.user._id);
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
            }
            return;
        }

        const qCardEarly = typeof body.session === 'string' ? body.session.trim() : '';
        const sCardEarly = await resolveLessonSessionDoc(finalDomainId, this.user._id, qCardEarly || undefined);
        if (sCardEarly?.lessonMode === 'card' && typeof sCardEarly.cardId === 'string' && sCardEarly.cardId.trim()) {
            const expectC = sCardEarly.cardId.trim();
            if (!ObjectId.isValid(expectC)) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            if (cardIdFromBody && String(cardIdFromBody) !== expectC) {
                this.response.body = {
                    success: true,
                    redirect: appendLessonSessionToUrl(
                        `/d/${finalDomainId}/learn/lesson?cardId=${encodeURIComponent(expectC)}`,
                        qCardEarly,
                    ),
                };
                return;
            }
            const currentCardIdCE = new ObjectId(expectC);
            const cardCE = await CardModel.get(finalDomainId, currentCardIdCE);
            if (!cardCE) {
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn` };
                return;
            }
            const currentCardNodeIdCE = cardCE.nodeId;
            const hasCardProblemsCE = !!(cardCE.problems && cardCE.problems.length > 0);
            const isBrowseOnlyCE = !hasCardProblemsCE && answerHistory.length === 0;
            const noImpressionCE = body.noImpression === true;

            if (isBrowseOnlyCE && noImpressionCE) {
                const dudocCE = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
                const Lce = mergeDomainLessonState(dudocCE, sCardEarly);
                const reviewIdsCE: string[] = [...Lce.lessonReviewCardIds];
                if (!reviewIdsCE.includes(currentCardIdCE.toString())) reviewIdsCE.push(currentCardIdCE.toString());
                const timesMsCE: number[] = [...Lce.lessonCardTimesMs];
                timesMsCE.push(typeof totalTime === 'number' && totalTime >= 0 ? totalTime : 0);
                await SessionModel.touchById(
                    finalDomainId,
                    this.user._id,
                    sCardEarly._id,
                    { appRoute: 'learn', lessonReviewCardIds: reviewIdsCE, lessonCardTimesMs: timesMsCE },
                    { silent: true },
                );
                const cardIdStrCE = currentCardIdCE.toString();
                const baseUrlCE = `/d/${finalDomainId}/learn/lesson?cardId=${cardIdStrCE}&reviewCardId=${encodeURIComponent(cardIdStrCE)}`;
                this.response.body = { success: true, redirect: appendLessonSessionToUrl(baseUrlCE, qCardEarly) };
                return;
            }

            if (currentCardNodeIdCE) {
                await learn.setCardPassed(finalDomainId, this.user._id, currentCardIdCE, currentCardNodeIdCE);
            }

            const effectiveHistoryCE = isBrowseOnlyCE
                ? [{ problemId: 'browse_judge', correct: true, selected: 0, timeSpent: totalTime || 0, attempts: 1 }]
                : answerHistory;

            let baseDocCE = Number((cardCE as any).baseDocId);
            if (!baseDocCE) {
                const bCE = await BaseModel.getByDomain(finalDomainId);
                baseDocCE = bCE?.docId || firstBasePass;
            }
            const recScoreCE = await syncLearnPassToRecord(
                finalDomainId,
                this.user._id,
                qCardEarly,
                cardCE as any,
                baseDocCE,
                cardStorageBranch(cardCE as any) || branchByBasePass.get(baseDocCE) || 'main',
                effectiveHistoryCE as any[],
            );
            const scoreCE = recScoreCE !== null ? recScoreCE : effectiveHistoryCE.length * 5;
            const resultIdCE = await learn.addResult(finalDomainId, this.user._id, {
                cardId: currentCardIdCE,
                nodeId: currentCardNodeIdCE,
                answerHistory: effectiveHistoryCE,
                totalTime,
                score: scoreCE,
                createdAt: new Date(),
            });

            await bus.parallel('learn_result/add', finalDomainId);
            await appendUserCheckinDay(finalDomainId, this.user._id, this.user.priv, 'learnActivityDates');

            const todayCE = moment.utc().format('YYYY-MM-DD');
            let problemCountCE = 0;
            for (const h of effectiveHistoryCE) {
                if ((h as any).problemId) problemCountCE++;
            }
            const timeToAddCE = (totalTime && typeof totalTime === 'number' && totalTime > 0) ? totalTime : 0;
            await learn.incConsumptionStats(finalDomainId, this.user._id, todayCE, {
                nodes: currentCardNodeIdCE ? 1 : 0,
                cards: 1,
                problems: problemCountCE,
                practices: 1,
                ...(timeToAddCE > 0 ? { totalTime: timeToAddCE } : {}),
            });

            const dudocAfterCE = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
            const LafterCE = mergeDomainLessonState(dudocAfterCE, sCardEarly);
            const nextReviewCE = LafterCE.lessonReviewCardIds.filter(id => id !== currentCardIdCE.toString());
            if (nextReviewCE.length !== LafterCE.lessonReviewCardIds.length) {
                await SessionModel.touchById(
                    finalDomainId,
                    this.user._id,
                    sCardEarly._id,
                    { lessonReviewCardIds: nextReviewCE },
                    { silent: true },
                );
            }

            await SessionModel.touchById(
                finalDomainId,
                this.user._id,
                sCardEarly._id,
                { lessonMode: 'card', cardIndex: 1, cardId: expectC },
                { silent: false },
            );

            this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson/result/${resultIdCE}` };
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
                const baseDocN = Number((card as any).baseDocId) || firstBasePass;
                const branchN = cardStorageBranch(card as any) || branchByBasePass.get(baseDocN) || 'main';
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
                // Card view "Know it": no problems -> synthetic browse_judge pass, record result, then next card / node-result (no result page).
                await learn.setCardPassed(finalDomainId, this.user._id, currentCardId, currentCardNodeId);
                const browseHistory = [{ problemId: 'browse_judge', correct: true, selected: 0, timeSpent: totalTime || 0, attempts: 1 }];
                const baseDocBrowse = Number((card as any).baseDocId) || firstBasePass;
                const branchBrowse = cardStorageBranch(card as any) || branchByBasePass.get(baseDocBrowse) || 'main';
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
                await SessionModel.touchById(
                    finalDomainId,
                    this.user._id,
                    sNodePass._id,
                    { cardIndex: nextIndex, lessonMode: 'node', nodeId: nodeIdFromBody },
                    { silent: false },
                );
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
                await SessionModel.touchById(
                    finalDomainId,
                    this.user._id,
                    sNodePass._id,
                    {
                        appRoute: 'learn',
                        route: 'learn',
                        lessonMode: 'node',
                        nodeId: nodeIdFromBody,
                        cardIndex: flatCardsRaw.length,
                        lessonCardTimesMs: [],
                        lessonReviewCardIds: [],
                    },
                    { silent: false },
                );
                this.response.body = { success: true, redirect: `/d/${finalDomainId}/learn/lesson/node-result?nodeId=${encodeURIComponent(nodeIdFromBody)}` };
            }
            return;
        }

        const builtPassMain = await ensureTrainingLearnDAGCached(
            finalDomainId,
            trainingPass,
            (k: string) => this.translate(k),
        );
        let sections = builtPassMain.sections;
        let allDagNodes = builtPassMain.allDagNodes;
        if (sections.length === 0) {
            throw new NotFoundError('No nodes available');
        }

        const dudocPostMain = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const sPostMain = await SessionModel.get(finalDomainId, this.user._id);
        const Lpm = mergeDomainLessonState(dudocPostMain, sPostMain);
        sections = applyUserSectionOrder(sections, (dudocPostMain as any)?.learnSectionOrder);
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
        currentCardNodeId = card.nodeId;

        const hasCardProblems = !!(card.problems && card.problems.length > 0);
        const isBrowseOnly = isAlonePractice && !hasCardProblems && answerHistory.length === 0;

        // Single-card "No impression": no result row; add to review queue and redirect back to the same card.
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
            const sidNi = lessonSessionIdFromDoc(await SessionModel.get(finalDomainId, this.user._id));
            const baseNi = `/d/${finalDomainId}/learn/lesson?cardId=${cardIdStr}&reviewCardId=${encodeURIComponent(cardIdStr)}`;
            this.response.body = { success: true, redirect: appendLessonSessionToUrl(baseNi, sidNi) };
            return;
        }

        if (currentCardNodeId) {
            await learn.setCardPassed(finalDomainId, this.user._id, currentCardId, currentCardNodeId);
        }

        const baseDocMain = baseNumericId(card.baseDocId) > 0 ? baseNumericId(card.baseDocId) : firstBasePass;
        const bMain = await BaseModel.get(finalDomainId, baseDocMain);
        if (!bMain) throw new NotFoundError('Base not found');
        const brMain = cardStorageBranch(card as any) || branchByBasePass.get(baseDocMain) || 'main';
        const node = (getBranchData(bMain, brMain).nodes || []).find(n => n.id === currentCardNodeId);
        const cards = await CardModel.getByNodeId(finalDomainId, baseDocMain, currentCardNodeId!, brMain);
        const cardIndex = cards.findIndex(c => c.docId.toString() === currentCardId.toString());
        const currentCardDoc = cards[cardIndex];

        // Single card without problems ("Know it"): persist browse_judge as correct.
        const effectiveHistory = isBrowseOnly
            ? [{ problemId: 'browse_judge', correct: true, selected: 0, timeSpent: totalTime || 0, attempts: 1 }]
            : answerHistory;

        let qPassMain = typeof body.session === 'string' ? body.session.trim() : '';
        if (isAlonePractice) {
            let sAlonePass = await resolveLessonSessionDoc(finalDomainId, this.user._id, qPassMain || undefined);
            if (!sAlonePass?._id) {
                const dudocAlonePass = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
                const tidPass = dudocAlonePass?.learnTrainingDocId ? String(dudocAlonePass.learnTrainingDocId) : null;
                await touchLessonSession(finalDomainId, this.user._id, {
                    appRoute: 'learn',
                    route: 'learn',
                    lessonMode: null,
                    nodeId: null,
                    cardIndex: null,
                    baseDocId: baseDocMain,
                    branch: brMain,
                    lessonQueueBaseDocId: baseDocMain,
                    lessonQueueTrainingDocId: tidPass,
                }, { silent: true });
                sAlonePass = await SessionModel.get(finalDomainId, this.user._id);
            }
            if (sAlonePass?._id) qPassMain = sAlonePass._id.toString();
        }
        let baseDocM = baseNumericId(card.baseDocId);
        if (!baseDocM) {
            const bM = await BaseModel.getByDomain(finalDomainId);
            baseDocM = bM?.docId || firstBasePass;
        }
        const brM = cardStorageBranch(card as any) || branchByBasePass.get(baseDocM) || 'main';
        const recScoreM = await syncLearnPassToRecord(
            finalDomainId,
            this.user._id,
            qPassMain,
            card as any,
            baseDocM,
            brM,
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

        // After single-card "Know it", drop this card from the review list if present (same as node mode).
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

        const card = await CardModel.get(finalDomainId, result.cardId);
        if (!card) {
            throw new NotFoundError('Card not found');
        }

        const trainingRes = await requireSelectedTraining(finalDomainId, this.user._id, this.user.priv);
        const planRes = TrainingModel.resolvePlanSources(trainingRes as any);
        const branchMapRes = new Map<number, string>();
        for (const s of planRes) branchMapRes.set(s.baseDocId, s.targetBranch || 'main');
        const baseDocRes = baseNumericId(card.baseDocId) > 0 ? baseNumericId(card.baseDocId) : (planRes[0]?.baseDocId ?? 0);
        const bRes = await BaseModel.get(finalDomainId, baseDocRes);
        if (!bRes) throw new NotFoundError('Base not found');
        const brRes = cardStorageBranch(card as any) || branchMapRes.get(baseDocRes) || 'main';
        const node = (getBranchData(bRes, brRes).nodes || []).find(n => n.id === result.nodeId)
            || ({ id: result.nodeId, title: '', text: '' } as any);

        const allProblems = (card.problems || []).map((p, idx) => ({
            ...p,
            index: idx,
        }));

        let problemStats: Array<{ problem: any; totalTime: number; attempts: number; correct: boolean }>;
        if (allProblems.length === 0 && result.answerHistory && result.answerHistory.length > 0) {
            // Card-view browse_judge row when the card has no problems (Know it / No impression).
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
            baseDocId: baseDocRes.toString(),
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

        const trainingNr = await requireSelectedTraining(finalDomainId, this.user._id, this.user.priv);
        const planNr = TrainingModel.resolvePlanSources(trainingNr as any);
        const branchMapNr = new Map<number, string>();
        for (const s of planNr) branchMapNr.set(s.baseDocId, s.targetBranch || 'main');

        const { sections: secNr, allDagNodes: dagNr } = await ensureTrainingLearnDAGCached(
            finalDomainId,
            trainingNr,
            (k: string) => this.translate(k),
        );
        const allDagNodes = dagNr;
        const nodeMap = new Map<string, LearnDAGNode>();
        secNr.forEach((n: LearnDAGNode) => nodeMap.set(n._id, n));
        allDagNodes.forEach((n: LearnDAGNode) => nodeMap.set(n._id, n));
        const rootNode = nodeMap.get(nodeId);
        if (!rootNode) throw new NotFoundError('Node not found');

        const getChildNodes = (parentId: string): LearnDAGNode[] =>
            allDagNodes
                .filter((n: LearnDAGNode) => n.requireNids && n.requireNids[n.requireNids.length - 1] === parentId)
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const flatCards: Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string; baseDocId?: number }> = [];
        const collectUnder = (nid: string) => {
            const node = nodeMap.get(nid);
            if (!node) return;
            const p = parseTrainingNodeId(node._id);
            const rawId = p ? p.nodeId : node._id;
            const bId = p?.baseDocId;
            for (const c of (node.cards || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
                flatCards.push({
                    nodeId: rawId,
                    cardId: c.cardId,
                    nodeTitle: node.title || '',
                    cardTitle: c.title || '',
                    baseDocId: bId,
                });
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
            const bNrItem = (typeof item.baseDocId === 'number' && item.baseDocId > 0)
                ? item.baseDocId
                : (Number((cardDoc as any).baseDocId) || planNr[0]?.baseDocId || 0);
            const bNrDoc = bNrItem ? await BaseModel.get(finalDomainId, bNrItem) : null;
            const brNr = cardStorageBranch(cardDoc as any) || branchMapNr.get(bNrItem) || 'main';
            const nodeDoc = bNrDoc
                ? (getBranchData(bNrDoc, brNr).nodes || []).find((n: BaseNode) => n.id === res.nodeId)
                : undefined;
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
                node: nodeDoc || { id: res.nodeId, title: item.nodeTitle, text: '' },
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
            baseDocId: String(planNr[0]?.baseDocId ?? ''),
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
        const uidParam = this.request.query?.uid
            || (this.request.body as any)?.uid
            || (this.args as any)?.uid;
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
        // Body may be missing on this.request.body (proxy/layer quirks) but fields are merged into args; also handle string JSON.
        let reqBody: any = this.request?.body;
        if (typeof reqBody === 'string') {
            try {
                reqBody = JSON.parse(reqBody);
            } catch {
                reqBody = {};
            }
        }
        if (!reqBody || typeof reqBody !== 'object' || Array.isArray(reqBody)) {
            reqBody = {};
        }
        const argsAny = this.args as Record<string, unknown>;
        const fromReq = Array.isArray(reqBody.sectionOrder) ? reqBody.sectionOrder : null;
        const fromArgs = Array.isArray(argsAny.sectionOrder) ? argsAny.sectionOrder : null;
        let sectionOrder: string[] = (fromReq?.length ? fromReq : fromArgs?.length ? fromArgs : []).map((x: unknown) => String(x));
        const rawIndex = reqBody.currentLearnSectionIndex ?? argsAny.currentLearnSectionIndex;
        const currentLearnSectionIndexParsed =
            typeof rawIndex === 'number' && Number.isFinite(rawIndex)
                ? rawIndex
                : parseInt(String(rawIndex ?? ''), 10);

        const { selectedTraining: trainingOrder } = await getLearnTrainingSelection(finalDomainId, targetUid, this.user.priv);
        if (!trainingOrder) {
            throw new NotFoundError('No training selected');
        }
        const { sections: refSectionsOrder } = await ensureTrainingLearnDAGCached(
            finalDomainId,
            trainingOrder as TrainingDoc,
            (k: string) => this.translate(k),
        );
        if (!refSectionsOrder.length) {
            throw new NotFoundError('No sections to reorder');
        }

        if (!sectionOrder.length) {
            const dudocPrev = await learn.getUserLearnState(finalDomainId, { _id: targetUid, priv: this.user.priv }) as any;
            const prev = dudocPrev?.learnSectionOrder;
            if (Array.isArray(prev) && prev.length) {
                sectionOrder = prev.map((x: unknown) => String(x));
            }
        }
        if (!sectionOrder.length) {
            throw new ValidationError(this.translate('Invalid section order') || 'Invalid section order');
        }

        const totalSections = sectionOrder.length;
        let indexToUse = Number.isNaN(currentLearnSectionIndexParsed) || currentLearnSectionIndexParsed < 0 || currentLearnSectionIndexParsed >= totalSections
            ? null
            : currentLearnSectionIndexParsed;
        if (indexToUse === null) {
            const dudoc = await domain.getDomainUser(finalDomainId, { _id: targetUid, priv: this.user.priv });
            const sEd = await SessionModel.get(finalDomainId, targetUid);
            const Led = mergeDomainLessonState(dudoc, sEd);
            const saved = normalizeDomainUserLearnIndex(Led.currentLearnSectionIndex);
            if (saved !== null && saved >= 0 && saved < totalSections) indexToUse = saved;
            else indexToUse = 0;
        }
        const currentLearnSectionIndexFinal = indexToUse;

        // sectionOrder[0] is first to learn; completed section count == currentLearnSectionIndex.
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
        await clearDailyPracticeSessionAfterSettingsChange(finalDomainId, targetUid, this.user.priv);
        const latestAfterAbandon = await SessionModel.get(finalDomainId, targetUid) as SessionDoc | null;
        // Only sync section fields onto learn rows that carry daily / home state — never touch card/node rows.
        if (
            latestAfterAbandon
            && isLearnSessionRow(latestAfterAbandon)
            && !isLessonSessionAbandoned(latestAfterAbandon)
            && (isLearnHomePlaceholderSession(latestAfterAbandon) || latestAfterAbandon.lessonMode === 'today')
        ) {
            await touchLessonSession(finalDomainId, targetUid, {
                appRoute: 'learn',
                currentLearnSectionIndex: currentLearnSectionIndexFinal,
                currentLearnSectionId: sectionOrder[currentLearnSectionIndexFinal],
            }, { silent: true });
        }

        this.response.body = { success: true, sectionOrder, currentLearnSectionIndex: currentLearnSectionIndexFinal };
    }

    async get(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const targetUid = await this.resolveTargetUid(finalDomainId);
        const { selectedTraining: trainingEdit } = await getLearnTrainingSelection(finalDomainId, targetUid, this.user.priv);

        if (!trainingEdit) {
            this.response.template = 'learn_section_edit.html';
            this.response.body = {
                sections: [],
                allSections: [],
                dag: [],
                domainId: finalDomainId,
                baseDocId: null,
                trainingDocId: null,
                targetUid,
                targetUser: null,
            };
            return;
        }

        const builtEdit = await ensureTrainingLearnDAGCached(
            finalDomainId,
            trainingEdit as TrainingDoc,
            (k: string) => this.translate(k),
        );
        const allSections: LearnDAGNode[] = builtEdit.sections.length
            ? [...builtEdit.sections].sort((a, b) => (a.order || 0) - (b.order || 0))
            : [];
        const dag: LearnDAGNode[] = builtEdit.allDagNodes.length
            ? [...builtEdit.allDagNodes].sort((a, b) => (a.order || 0) - (b.order || 0))
            : [];

        const dudoc = await domain.getDomainUser(finalDomainId, { _id: targetUid, priv: this.user.priv });
        const learnSectionOrder = (dudoc as any)?.learnSectionOrder;
        const sections = applyUserSectionOrder(allSections.length ? [...allSections] : [], learnSectionOrder);
        const rawLearnIdx = (dudoc as any)?.currentLearnSectionIndex;
        const idxNorm = normalizeDomainUserLearnIndex(rawLearnIdx);
        const currentLearnSectionIndexOut =
            idxNorm !== null && idxNorm >= 0 && idxNorm < sections.length ? idxNorm : null;
        const currentLearnSectionId = (dudoc as any)?.currentLearnSectionId;

        const udoc = await user.getById(finalDomainId, targetUid);

        this.response.template = 'learn_section_edit.html';
        this.response.body = {
            sections,
            allSections,
            dag,
            domainId: finalDomainId,
            baseDocId: String(TrainingModel.resolvePlanSources(trainingEdit as any)[0]?.baseDocId ?? ''),
            trainingDocId: String((trainingEdit as any).docId),
            targetUid,
            targetUser: udoc ? { uname: udoc.uname, _id: udoc._id } : null,
            currentLearnSectionIndex: currentLearnSectionIndexOut,
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
        const { selectedTraining: trainingSec } = await getLearnTrainingSelection(finalDomainId, this.user._id, this.user.priv);

        if (!trainingSec) {
            this.response.template = 'learn_sections.html';
            this.response.body = {
                sections: [],
                domainId: finalDomainId,
                baseDocId: null,
            };
            return;
        }

        const builtSec = await ensureTrainingLearnDAGCached(
            finalDomainId,
            trainingSec as TrainingDoc,
            (k: string) => this.translate(k),
        );
        let sections: LearnDAGNode[] = builtSec.sections;
        let dag: LearnDAGNode[] = builtSec.allDagNodes;

        if (sections.length === 0) {
            this.response.template = 'learn_sections.html';
            this.response.body = {
                sections: [],
                dag: [],
                domainId: finalDomainId,
                baseDocId: String(TrainingModel.resolvePlanSources(trainingSec as any)[0]?.baseDocId ?? '') || null,
                currentSectionId: null,
                currentLearnSectionIndex: null,
            };
            return;
        }

        const dudocSections = await learn.getUserLearnState(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
        const learnSectionOrder = dudocSections?.learnSectionOrder;
        sections = applyUserSectionOrder(sections, learnSectionOrder);

        sections = sections.map(section => ({
            ...section,
            cards: section.cards || [],
        }));

        const idxSections = normalizeDomainUserLearnIndex(dudocSections?.currentLearnSectionIndex);
        const currentLearnSectionIndexOut =
            idxSections !== null && idxSections >= 0 && idxSections < sections.length ? idxSections : null;
        const currentSectionId = dudocSections?.currentLearnSectionId || null;

        this.response.template = 'learn_sections.html';
        this.response.body = {
            sections: sections,
            dag: dag,
            domainId: finalDomainId,
            baseDocId: String(TrainingModel.resolvePlanSources(trainingSec as any)[0]?.baseDocId ?? ''),
            currentSectionId: currentSectionId,
            currentLearnSectionIndex: currentLearnSectionIndexOut,
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
            trainings: trainings.map((item: any) => {
                const sources = TrainingModel.resolvePlanSources(item as any);
                return { docId: String(item.docId), name: item.name || '', baseDocId: Number(sources?.[0]?.baseDocId) || 0 };
            }),
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
    ctx.Route('learn', '/learn', LearnHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_set_base', '/learn/base', LearnHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_base_select', '/learn/training/select', LearnBaseSelectHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_set_daily_goal', '/learn/daily-goal', LearnHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_sections', '/learn/sections', LearnSectionsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_section_edit', '/learn/section/edit', LearnSectionEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_edit', '/learn/edit', LearnEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_lesson', '/learn/lesson', LessonHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_lesson_result', '/learn/lesson/result/:resultId', LessonHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_lesson_pass', '/learn/lesson/pass', LessonHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_lesson_start', '/learn/lesson/start', LessonHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('learn_lesson_node_result', '/learn/lesson/node-result', LessonNodeResultHandler, PRIV.PRIV_USER_PROFILE);
}
import { throttle } from 'lodash';
import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import { NotFoundError } from '../error';
import {
    ConnectionHandler,
    Handler,
    param,
    query,
    subscribe,
    Types,
} from '../service/server';
import { PERM, PRIV } from '../model/builtin';
import type { BaseDoc, BaseNode, CardDoc } from '../interface';
import { BaseModel, CardModel } from '../model/base';
import RecordModel, { type RecordDoc, type RecordProblemState } from '../model/record';
import SessionModel, { type SessionDoc } from '../model/session';
import user from '../model/user';
import {
    deriveSessionRecordType,
    formatRecordProgressInSession,
} from '../lib/sessionListDisplay';

export function summarizeRecordDoc(r: RecordDoc): { code: string; color: string; label: string } {
    const probs = r.problems || [];
    if (!probs.length) return { code: 'pending', color: '#9fa0a0', label: 'Pending' };
    if (probs.some(p => p.status === 'wrong')) return { code: 'fail', color: '#fb5555', label: 'Wrong' };
    if (probs.some(p => p.status === 'pending')) return { code: 'progress', color: '#f39800', label: 'In progress' };
    if (probs.every(p => p.status === 'correct')) return { code: 'pass', color: '#25ad40', label: 'Correct' };
    if (probs.every(p => p.status === 'skipped')) return { code: 'skipped', color: '#9fa0a0', label: 'Skipped' };
    return { code: 'progress', color: '#f39800', label: 'Mixed' };
}

type RecordRowDisplay = {
    cardTitle: string;
    cardUrl: string;
    trainingTitle: string;
    trainingUrl: string;
};

function recordCardOutlineUrl(
    buildUrl: (name: string, kwargs: Record<string, unknown>) => string,
    domainId: string,
    baseDocId: number,
    branch: string,
    cardIdHex: string,
): string {
    const pathUrl = buildUrl('base_outline_doc_branch', {
        domainId,
        docId: String(baseDocId),
        branch,
    });
    if (!pathUrl || pathUrl === '#') return '#';
    const sep = pathUrl.includes('?') ? '&' : '?';
    return `${pathUrl}${sep}cardId=${encodeURIComponent(cardIdHex)}`;
}

async function loadSessionDocForRecord(rd: RecordDoc): Promise<SessionDoc | null> {
    try {
        const doc = await SessionModel.coll.findOne({
            _id: rd.sessionId,
            domainId: rd.domainId,
            uid: rd.uid,
        });
        return doc as SessionDoc | null;
    } catch {
        return null;
    }
}

async function buildRecordMainListRow(
    rd: RecordDoc,
    buildUrl: (name: string, kwargs: Record<string, unknown>) => string,
    translate: (k: string) => string,
) {
    const s = summarizeRecordDoc(rd);
    const disp = await enrichRecordRowDisplay(rd, buildUrl);
    const sess = await loadSessionDocForRecord(rd);
    const sessionIdHex = rd.sessionId ? rd.sessionId.toHexString() : '';
    let sessionResumeUrl = '#';
    let sessionTypeLabel: string | null = null;
    let recordSessionProgress: string | null = null;
    let sessionDisplayId = '';
    if (sessionIdHex) {
        sessionDisplayId = sessionIdHex.length > 8 ? `…${sessionIdHex.slice(-8)}` : sessionIdHex;
        const base = buildUrl('learn_lesson', { domainId: rd.domainId });
        const sep = base.includes('?') ? '&' : '?';
        sessionResumeUrl = `${base}${sep}session=${encodeURIComponent(sessionIdHex)}`;
    }
    if (sess) {
        const rt = deriveSessionRecordType(sess);
        sessionTypeLabel = translate(`session_record_type_${rt}`);
        recordSessionProgress = formatRecordProgressInSession(rd, sess);
    }

    return {
        ...rd,
        summaryLabel: s.label,
        summaryCode: s.code,
        summaryColor: s.color,
        cardTitle: disp.cardTitle,
        cardUrl: disp.cardUrl,
        trainingTitle: disp.trainingTitle,
        trainingUrl: disp.trainingUrl,
        sessionIdHex,
        sessionDisplayId,
        sessionResumeUrl,
        sessionTypeLabel,
        recordSessionProgress,
    };
}

async function enrichRecordRowDisplay(
    rd: RecordDoc,
    buildUrl: (name: string, kwargs: Record<string, unknown>) => string,
): Promise<RecordRowDisplay> {
    const domainId = rd.domainId;
    const branch = rd.branch && rd.branch.length > 0 ? rd.branch : 'main';
    const baseDocId = typeof rd.baseDocId === 'number' && rd.baseDocId > 0 ? rd.baseDocId : 0;
    let cardTitle = rd.cardId;
    let cardUrl = '#';

    if (baseDocId && ObjectId.isValid(rd.cardId)) {
        try {
            const card = await CardModel.get(domainId, new ObjectId(rd.cardId));
            if (card && typeof card.title === 'string' && card.title.length > 0) {
                cardTitle = card.title;
            }
            cardUrl = recordCardOutlineUrl(buildUrl, domainId, baseDocId, branch, rd.cardId);
        } catch {
        }
    }

    let trainingTitle = '';
    let trainingUrl = '#';
    if (baseDocId) {
        try {
            const b = await BaseModel.get(domainId, baseDocId);
            if (b) {
                const t = (b.title || '').trim();
                trainingTitle = t || String(baseDocId);
                trainingUrl = buildUrl('base_outline_doc_branch', {
                    domainId,
                    docId: String(baseDocId),
                    branch,
                }) || '#';
            }
        } catch {
        }
    }

    return { cardTitle, cardUrl, trainingTitle, trainingUrl };
}

function nodesOnBranch(base: BaseDoc, branch: string): BaseNode[] {
    const branchName = branch || 'main';
    if (base.branchData?.[branchName]?.nodes) return base.branchData[branchName].nodes;
    if (branchName === 'main') return base.nodes || [];
    return [];
}

async function nodeTitleForRecord(rd: RecordDoc): Promise<string> {
    const bid = typeof rd.baseDocId === 'number' && rd.baseDocId > 0 ? rd.baseDocId : 0;
    if (!bid || !rd.nodeId) return rd.nodeId || '';
    const base = await BaseModel.get(rd.domainId, bid);
    if (!base) return rd.nodeId;
    const br = rd.branch && rd.branch.length ? rd.branch : 'main';
    const nodes = nodesOnBranch(base, br);
    const n = nodes.find((x) => x.id === rd.nodeId);
    const t = (n as { title?: string } | undefined)?.title ?? n?.text;
    return t ? String(t) : rd.nodeId;
}

function stripHtmlOneLine(s: string, maxLen: number): string {
    const t = String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length <= maxLen ? t : `${t.slice(0, maxLen)}…`;
}

export type LessonHistoryProblemRow = {
    pid: string;
    stemPreview: string;
    status: RecordProblemState['status'];
    selectedIndex?: number;
    selectedText?: string;
    correctOptionIndex?: number;
    correctOptionText?: string;
    attempts?: number;
    timeSpentMs?: number;
};

export type LessonHistoryRecordRow = {
    rdoc: RecordDoc;
    recordDisp: RecordRowDisplay;
    nodeTitle: string;
    problems: LessonHistoryProblemRow[];
};

async function problemRowsForRecord(rd: RecordDoc): Promise<LessonHistoryProblemRow[]> {
    let card: CardDoc | null = null;
    if (ObjectId.isValid(rd.cardId)) {
        try {
            card = await CardModel.get(rd.domainId, new ObjectId(rd.cardId));
        } catch {
            /* ignore */
        }
    }
    const byPid = new Map((card?.problems || []).map((pr) => [pr.pid, pr]));
    return (rd.problems || []).map((p) => {
        const pr = byPid.get(p.pid);
        const stemPreview = pr ? stripHtmlOneLine(pr.stem || '', 160) : p.pid;
        let selectedText: string | undefined;
        if (typeof p.selected === 'number' && pr?.options && p.selected >= 0 && p.selected < pr.options.length) {
            selectedText = stripHtmlOneLine(String(pr.options[p.selected]), 120);
        } else if (typeof p.selected === 'number') {
            selectedText = `#${p.selected}`;
        }
        let correctOptionText: string | undefined;
        const ans = pr?.answer;
        if (typeof ans === 'number' && pr?.options && ans >= 0 && ans < pr.options.length) {
            correctOptionText = stripHtmlOneLine(String(pr.options[ans]), 120);
        }
        return {
            pid: p.pid,
            stemPreview,
            status: p.status,
            selectedIndex: p.selected,
            selectedText,
            correctOptionIndex: typeof ans === 'number' ? ans : undefined,
            correctOptionText,
            attempts: p.attempts,
            timeSpentMs: p.timeSpentMs,
        };
    });
}

/** Ordered rows for a learn session history page (full problem state + card/node labels). */
export async function buildSessionRecordHistoryRows(
    domainId: string,
    recordIds: ObjectId[] | null | undefined,
    buildUrl: (name: string, kwargs: Record<string, unknown>) => string,
): Promise<LessonHistoryRecordRow[]> {
    const ridList = recordIds || [];
    if (!ridList.length) return [];
    const recordsMap = await RecordModel.getList(domainId, ridList);
    const out: LessonHistoryRecordRow[] = [];
    for (const oid of ridList) {
        const r = recordsMap[oid.toHexString()] as RecordDoc | undefined;
        if (!r) continue;
        const recordDisp = await enrichRecordRowDisplay(r, buildUrl);
        const nodeTitle = await nodeTitleForRecord(r);
        const problems = await problemRowsForRecord(r);
        out.push({ rdoc: r, recordDisp, nodeTitle, problems });
    }
    return out;
}

export function lessonHistoryRowsToWire(rows: LessonHistoryRecordRow[]): Record<string, unknown>[] {
    return rows.map((row) => ({
        recordId: row.rdoc._id.toHexString(),
        cardId: row.rdoc.cardId,
        nodeId: row.rdoc.nodeId,
        nodeTitle: row.nodeTitle,
        branch: row.rdoc.branch,
        recordDisp: row.recordDisp,
        lastActivityAt: row.rdoc.lastActivityAt instanceof Date
            ? row.rdoc.lastActivityAt.toISOString()
            : row.rdoc.lastActivityAt,
        problems: row.problems,
    }));
}

export async function recordSummariesForSessionRow(
    domainId: string,
    recordIds?: ObjectId[] | null,
): Promise<Array<{ _id: ObjectId; cardId: string; color: string; label: string; code: string }>> {
    const ridList = recordIds || [];
    if (!ridList.length) return [];
    const recordsMap = await RecordModel.getList(domainId, ridList);
    const out: Array<{ _id: ObjectId; cardId: string; color: string; label: string; code: string }> = [];
    for (const oid of ridList) {
        const r = recordsMap[oid.toHexString()] as RecordDoc | undefined;
        if (!r) continue;
        const s = summarizeRecordDoc(r);
        out.push({ _id: r._id, cardId: r.cardId, color: s.color, label: s.label, code: s.code });
    }
    return out;
}

class RecordMainHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('uidOrName', Types.UidOrName, true)
    async get(domainId: string, page = 1, uidOrName?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        let filterUid: number | undefined;
        let recordConnUidOrName: string | undefined;
        if (uidOrName) {
            const udoc = await user.getById(domainId, +uidOrName)
                || await user.getByUname(domainId, uidOrName)
                || await user.getByEmail(domainId, uidOrName);
            if (udoc) {
                filterUid = udoc._id;
                recordConnUidOrName = uidOrName;
            }
            if (filterUid !== this.user._id) {
                this.checkPerm(PERM.PERM_VIEW_RECORD);
            }
        } else {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        const pageSize = 20;
        const filter: Record<string, unknown> = { domainId };
        if (filterUid != null) (filter as any).uid = filterUid;

        const coll = RecordModel.coll;
        const [rawRows, count] = await Promise.all([
            coll.find(filter).sort({ lastActivityAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
            coll.countDocuments(filter),
        ]);
        const records = await Promise.all(rawRows.map(async (r) => buildRecordMainListRow(
            r as RecordDoc,
            (name, kwargs) => this.url(name, kwargs as any),
            (k) => this.translate(k),
        )));
        const userIds = [...new Set(records.map((r) => r.uid))];
        const udict = await user.getList(domainId, userIds);

        this.response.template = 'record_main.html';
        this.response.body = {
            records,
            page,
            page_name: 'record_main',
            count,
            pageCount: Math.ceil(count / pageSize) || 1,
            filterUidOrName: uidOrName,
            recordConnUidOrName,
            udict,
        };
    }
}

class RecordListConnectionHandler extends ConnectionHandler {
    watchUid?: number;
    queue: Map<string, () => Promise<any>> = new Map();
    throttleQueueClear: () => void;

    @param('domainId', Types.String, true)
    @param('uidOrName', Types.UidOrName, true)
    async prepare(domainId?: string, uidOrName?: string) {
        try {
            const q = (this.request.query.domainId as string) || domainId || this.args.domainId;
            if (!q) {
                this.close(4000, 'Domain ID is required');
                return;
            }
            this.args.domainId = q;
            this.checkPriv(PRIV.PRIV_USER_PROFILE);

            if (uidOrName) {
                const udoc = await user.getById(q, +uidOrName)
                    || await user.getByUname(q, uidOrName)
                    || await user.getByEmail(q, uidOrName);
                if (udoc) {
                    this.watchUid = udoc._id;
                    if (this.watchUid !== this.user._id) {
                        this.checkPerm(PERM.PERM_VIEW_RECORD);
                    }
                } else {
                    this.watchUid = undefined;
                    this.checkPerm(PERM.PERM_VIEW_RECORD);
                }
            } else {
                this.checkPerm(PERM.PERM_VIEW_RECORD);
                this.watchUid = undefined;
            }

            this.throttleQueueClear = throttle(this.queueClear, 100, { trailing: true });
        } catch (e: any) {
            try {
                this.close(4000, e.message || String(e));
            } catch {
            }
        }
    }

    async message(msg: { rids: string[] }) {
        if (!(msg.rids instanceof Array)) return;
        for (const ridStr of msg.rids) {
            let rid: ObjectId;
            try {
                rid = new ObjectId(ridStr);
            } catch {
                continue;
            }
            const rdoc = await RecordModel.get(this.args.domainId, rid);
            if (rdoc) await this.sendRecordRow(rdoc);
        }
    }

    @subscribe('record/change')
    async onRecordListChange(rdoc: RecordDoc) {
        if (rdoc.domainId !== this.args.domainId) return;
        if (this.watchUid != null && rdoc.uid !== this.watchUid) return;
        await this.sendRecordRow(rdoc);
    }

    async sendRecordRow(rdoc: RecordDoc) {
        const udoc = await user.getById(this.args.domainId, rdoc.uid);
        const record = await buildRecordMainListRow(
            rdoc,
            (name, kwargs) => this.url(name, kwargs as any),
            (k) => this.translate(k),
        );
        const key = rdoc._id.toHexString();
        this.queue.set(key, async () => ({
            html: await this.renderHTML('record_main_tr.html', { record, udoc }),
        }));
        this.throttleQueueClear();
    }

    async queueClear() {
        await Promise.all([...this.queue.values()].map(async (fn) => this.send(await fn())));
        this.queue.clear();
    }

    async cleanup() {
        this.queue.clear();
    }
}

class RecordDetailHandler extends Handler {
    rdoc!: RecordDoc;

    @param('rid', Types.ObjectId)
    async prepare(domainId: string, rid: ObjectId) {
        const doc = await RecordModel.get(domainId, rid);
        if (!doc) throw new NotFoundError('Record');
        if (doc.uid !== this.user._id) this.checkPerm(PERM.PERM_VIEW_RECORD);
        this.rdoc = doc;
    }

    @param('rid', Types.ObjectId)
    async get(domainId: string, rid: ObjectId) {
        const udoc = await user.getById(domainId, this.rdoc.uid);
        const disp = await enrichRecordRowDisplay(this.rdoc, (name, kwargs) => this.url(name, kwargs as any));
        this.response.template = 'record_detail.html';
        this.response.body = { rdoc: this.rdoc, udoc, recordDisp: disp };
    }
}

class RecordDetailConnectionHandler extends ConnectionHandler {
    rid = '';
    throttleSend!: ReturnType<typeof throttle>;

    @param('rid', Types.ObjectId)
    async prepare(domainId: string, rid: ObjectId) {
        try {
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            const doc = await RecordModel.get(domainId, rid);
            if (!doc) {
                this.close(4000, 'Record not found');
                return;
            }
            if (doc.uid !== this.user._id) this.checkPerm(PERM.PERM_VIEW_RECORD);
            this.rid = rid.toString();
            this.throttleSend = throttle((d: RecordDoc) => this.sendUpdate(d), 400, { trailing: true });
            await this.sendUpdate(doc);
        } catch (e: any) {
            try {
                this.close(4000, e.message || String(e));
            } catch {
            }
        }
    }

    async sendUpdate(d: RecordDoc) {
        this.send({
            status_html: await this.renderHTML('record_detail_status.html', { rdoc: d }),
        });
    }

    @subscribe('record/change')
    async onRecordDetailChange(doc: RecordDoc) {
        if (doc.domainId !== this.args.domainId) return;
        if (doc._id.toString() !== this.rid) return;
        this.throttleSend(doc);
    }
}

export async function apply(ctx: Context) {
    ctx.Route('record_main', '/record', RecordMainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('record_detail', '/record/:rid', RecordDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('record_conn', '/record-conn', RecordListConnectionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection(
        'record_detail_conn',
        '/record-detail-conn',
        RecordDetailConnectionHandler,
        PRIV.PRIV_USER_PROFILE,
    );
}

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
import { CardModel } from '../model/base';
import RecordModel, { type RecordDoc } from '../model/record';
import SessionModel from '../model/session';
import TrainingModel from '../model/training';
import user from '../model/user';

function summarizeRecordDoc(r: RecordDoc): { code: string; color: string; label: string } {
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

async function resolveRecordTrainingDocId(rd: RecordDoc): Promise<string | null> {
    const direct = rd.trainingDocId;
    if (direct && String(direct).trim()) return String(direct).trim();
    try {
        const sess = await SessionModel.coll.findOne({
            _id: rd.sessionId,
            domainId: rd.domainId,
        });
        const t = sess?.lessonQueueTrainingDocId;
        if (t && String(t).trim()) return String(t).trim();
    } catch {
    }
    return null;
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
    try {
        const tid = await resolveRecordTrainingDocId(rd);
        if (tid && ObjectId.isValid(tid)) {
            const tr = await TrainingModel.get(domainId, tid);
            if (tr) {
                const name = (tr as { name?: string }).name;
                trainingTitle = (typeof name === 'string' && name.length > 0) ? name : tid;
                trainingUrl = buildUrl('training_editor', {
                    domainId,
                    trainingDocId: new ObjectId(tid),
                });
            }
        }
    } catch {
    }

    return { cardTitle, cardUrl, trainingTitle, trainingUrl };
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
        const records = await Promise.all(rawRows.map(async (r) => {
            const rd = r as RecordDoc;
            const s = summarizeRecordDoc(rd);
            const disp = await enrichRecordRowDisplay(rd, (name, kwargs) => this.url(name, kwargs as any));
            return {
                ...rd,
                summaryLabel: s.label,
                summaryCode: s.code,
                summaryColor: s.color,
                cardTitle: disp.cardTitle,
                cardUrl: disp.cardUrl,
                trainingTitle: disp.trainingTitle,
                trainingUrl: disp.trainingUrl,
            };
        }));
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
        const s = summarizeRecordDoc(rdoc);
        const disp = await enrichRecordRowDisplay(rdoc, (name, kwargs) => this.url(name, kwargs as any));
        const record = {
            ...rdoc,
            summaryLabel: s.label,
            summaryCode: s.code,
            summaryColor: s.color,
            cardTitle: disp.cardTitle,
            cardUrl: disp.cardUrl,
            trainingTitle: disp.trainingTitle,
            trainingUrl: disp.trainingUrl,
        };
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

import { ObjectId } from 'mongodb';
import { Handler, query, Types } from '../service/server';
import { PRIV, PERM } from '../model/builtin';
import { NotFoundError, ValidationError } from '../error';
import { BaseModel } from '../model/base';
import * as document from '../model/document';
import SessionModel, {
    readDevelopSessionEditTotals,
    type SessionDoc,
} from '../model/session';
import { readDevelopSessionDeadlineMs } from '../lib/sessionUtcDaily';
import { deriveSessionLearnStatus } from '../lib/sessionListDisplay';

/** GET `/edit/card?session=&cardId=` — SSR-rendered single-card editor. */
class CardEditorHandler extends Handler {
    @query('session', Types.String, true)
    @query('cardId', Types.String, true)
    async get(domainId: string, sessionHex?: string, cardIdStr?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);

        const sid = (sessionHex || '').trim();
        const rawCardId = (cardIdStr || '').trim();
        if (!sid || !ObjectId.isValid(sid)) {
            throw new ValidationError('Invalid session');
        }
        if (!rawCardId || !ObjectId.isValid(rawCardId)) {
            throw new ValidationError('Invalid cardId');
        }

        // Load and validate session
        const sess = await SessionModel.coll.findOne({
            _id: new ObjectId(sid),
            domainId,
            uid: this.user._id,
            appRoute: 'develop',
        }) as SessionDoc | null;
        if (!sess) {
            throw new NotFoundError('Session not found');
        }
        const histSt = deriveSessionLearnStatus(sess);
        if (histSt === 'timed_out' || histSt === 'finished' || histSt === 'abandoned') {
            throw new ValidationError('Session expired');
        }

        // Load base from session
        const baseDocId = Number(sess.baseDocId);
        if (!Number.isFinite(baseDocId) || baseDocId <= 0) {
            throw new NotFoundError('Session base not found');
        }
        const base = await BaseModel.get(domainId, baseDocId);
        if (!base) throw new NotFoundError('Base not found');
        if (!this.user.own(base)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        // Load the single card
        const cardDocId = new ObjectId(rawCardId);
        const card = await document.get(domainId, document.TYPE_CARD, cardDocId) as any;
        if (!card) throw new NotFoundError('Card not found');

        const branch = sess.branch && String(sess.branch).trim() ? String(sess.branch).trim() : 'main';
        const nodeId = typeof (sess as any).nodeId === 'string' ? String((sess as any).nodeId).trim() : '';
        const deadlineMs = readDevelopSessionDeadlineMs(sess);
        const createdAt = sess.createdAt instanceof Date
            ? sess.createdAt
            : new Date(sess.createdAt as Date);

        this.response.template = 'card_editor.html';
        this.response.body = {
            card,
            base: {
                domainId,
                docId: base.docId,
                bid: (base as any).bid,
                title: base.title,
                currentBranch: branch,
            },
            sessionId: sid,
            nodeId,
            branch,
            domainId,
            developSessionEditTotals: readDevelopSessionEditTotals(sess),
            developSessionDeadlineIso: deadlineMs != null ? new Date(deadlineMs).toISOString() : null,
            developSessionStartedAtIso: Number.isNaN(createdAt.getTime()) ? null : createdAt.toISOString(),
        };
    }
}

export async function apply(ctx: any) {
    ctx.Route('card_editor', '/edit/card', CardEditorHandler, PRIV.PRIV_USER_PROFILE);
}

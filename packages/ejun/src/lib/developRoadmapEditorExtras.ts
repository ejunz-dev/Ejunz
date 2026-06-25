import RoadmapModel from '../model/roadmap';
import {
    readDevelopSessionEditTotals,
    type SessionDoc,
} from '../model/session';
import { readDevelopSessionDeadlineMs } from './sessionUtcDaily';
import { inferDevelopSessionKind } from './sessionListDisplay';
import {
    buildDevelopEditorContextWire,
    loadUserDevelopPoolByMode,
} from './developPoolShared';

/** HTML payload extras for roadmap editor bound to a develop session (mirrors base `buildBaseEditorPageBody` develop fields). */
export async function buildDevelopRoadmapEditorExtras(params: {
    db: { collection: (n: string) => any };
    domainId: string;
    uid: number;
    priv: number;
    sess: SessionDoc;
    makeEditorUrl: (docId: number, branch: string) => string;
}): Promise<Record<string, unknown>> {
    const { db, domainId, uid, priv, sess, makeEditorUrl } = params;
    const baseDocId = Number(sess.baseDocId);
    const branch = sess.branch && String(sess.branch).trim() ? String(sess.branch).trim() : 'main';
    const kind = inferDevelopSessionKind(sess);
    const developEditorContext = kind === 'outline_node'
        ? null
        : await buildDevelopEditorContextWire({
            db,
            domainId,
            uid,
            pool: await loadUserDevelopPoolByMode(domainId, uid, priv, 'roadmap'),
            baseDocId,
            branch,
            getBaseTitle: async (docId) => {
                const rm = await RoadmapModel.get(domainId, docId);
                return rm ? ((rm.title || '').trim() || String(docId)) : `Roadmap ${docId}`;
            },
            makeEditorUrl,
        });
    const deadlineMs = readDevelopSessionDeadlineMs(sess);
    const createdAt = sess.createdAt instanceof Date
        ? sess.createdAt
        : new Date(sess.createdAt as Date);
    return {
        editorDevelopSessionKind: kind,
        developSessionEditTotals: readDevelopSessionEditTotals(sess),
        developSessionDeadlineIso: deadlineMs != null ? new Date(deadlineMs).toISOString() : null,
        developSessionStartedAtIso: Number.isNaN(createdAt.getTime()) ? null : createdAt.toISOString(),
        developEditorContext,
    };
}

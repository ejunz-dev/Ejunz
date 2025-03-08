import { omit } from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { HubNodeNotFoundError, DocumentNotFoundError } from '../error';
import {
    HubHistoryDoc, HubReplyDoc, HubTailReplyDoc, Document
} from '../interface';
import * as bus from '../service/bus';
import db from '../service/db';
import { NumberKeys } from '../typeutils';
import { buildProjection } from '../utils';
import { PERM } from './builtin';
import * as contest from './contest';
import * as document from './document';
import problem from './problem';
import * as training from './training';
import { User } from './user';
import DocsModel from './doc';
export interface HubDoc extends Document { }
export type Field = keyof HubDoc;

export const PROJECTION_LIST: Field[] = [
    '_id', 'domainId', 'docType', 'docId', 'highlight',
    'nReply', 'views', 'pin', 'updateAt', 'owner',
    'parentId', 'parentType', 'title', 'hidden',
];
export const PROJECTION_PUBLIC: Field[] = [
    ...PROJECTION_LIST, 'content', 'edited', 'react', 'maintainer',
    'lock',
];
export const HISTORY_PROJECTION_PUBLIC: (keyof HubHistoryDoc)[] = [
    'title', 'content', 'docId', 'uid', 'time',
];

export const typeDisplay = {
    [document.TYPE_PROBLEM]: 'problem',
    [document.TYPE_CONTEST]: 'contest',
    [document.TYPE_HUB_NODE]: 'node',
    [document.TYPE_TRAINING]: 'training',
    [document.TYPE_HOMEWORK]: 'homework',
    [document.TYPE_DOCS]: 'docs',
};

export const coll = db.collection('hub.history');

export async function add(
    domainId: string, parentType: number, parentId: ObjectId | number | string,
    owner: number, title: string, content: string,
    ip: string | null = null, highlight: boolean, pin: boolean, hidden = false,
): Promise<ObjectId> {
    const time = new Date();
    const payload: Partial<HubDoc> = {
        domainId,
        content,
        owner,
        editor: owner,
        parentType,
        parentId,
        title,
        ip,
        nReply: 0,
        highlight,
        pin,
        updateAt: time,
        views: 0,
        sort: 100,
        hidden,
    };
    await bus.parallel('hub/before-add', payload);
    const res = await document.add(
        payload.domainId!, payload.content!, payload.owner!, document.TYPE_HUB,
        null, payload.parentType, payload.parentId, omit(payload, ['domainId', 'content', 'owner', 'parentType', 'parentId']),
    );
    await coll.insertOne({
        domainId, docId: res, content, uid: owner, ip, time: new Date(),
    });
    payload.docId = res;
    await bus.parallel('hub/add', payload);
    return payload.docId;
}

export async function get<T extends Field>(
    domainId: string, did: ObjectId, projection: T[] = PROJECTION_PUBLIC as any,
): Promise<Pick<HubDoc, T>> {
    return await document.get(domainId, document.TYPE_HUB, did, projection);
}

export async function edit(domainId: string, did: ObjectId, $set: Partial<HubDoc>) {
    await coll.insertOne({
        domainId, docId: did, content: $set.content, uid: $set.editor, ip: $set.ip, time: new Date(),
    });
    return document.set(domainId, document.TYPE_HUB, did, $set);
}

export function inc(
    domainId: string, did: ObjectId, key: NumberKeys<HubDoc>, value: number,
): Promise<HubDoc | null> {
    return document.inc(domainId, document.TYPE_HUB, did, key, value);
}

export async function del(domainId: string, did: ObjectId): Promise<void> {
    const [ddoc, drdocs] = await Promise.all([
        document.get(domainId, document.TYPE_HUB, did),
        document.getMulti(domainId, document.TYPE_HUB_REPLY, {
            parentType: document.TYPE_HUB, parentId: did,
        }).project({ _id: 1, 'reply._id': 1 }).toArray(),
    ]) as any;
    await Promise.all([
        document.deleteOne(domainId, document.T, did),
        document.deleteMulti(domainId, document.TYPE_HUB_REPLY, {
            parentType: document.TYPE_HUB, parentId: did,
        }),
        document.deleteMultiStatus(domainId, document.TYPE_HUB, { docId: did }),
        coll.deleteMany({ domainId, docId: { $in: [ddoc._id, ...(drdocs.reply?.map((i) => i._id) || [])] } }),
    ]) as any;
}

export function count(domainId: string, query: Filter<HubDoc>) {
    return document.count(domainId, document.TYPE_HUB, query);
}

export function getMulti(domainId: string, query: Filter<HubDoc> = {}, projection = PROJECTION_LIST) {
    return document.getMulti(domainId, document.TYPE_HUB, query)
        .sort({ pin: -1, docId: -1 })
        .project<HubDoc>(buildProjection(projection));
}

export async function addReply(
    domainId: string, did: ObjectId, owner: number,
    content: string, ip: string,
    x: number, y: number
): Promise<ObjectId> {
    const time = new Date();
    const [drid] = await Promise.all([
        document.add(
            domainId, content, owner, document.TYPE_HUB_REPLY,
            null, document.TYPE_HUB, did, { ip, editor: owner,x,y },
        ),
        document.incAndSet(domainId, document.TYPE_HUB, did, 'nReply', 1, { updateAt: time }),
    ]);
    await coll.insertOne({
        domainId, docId: drid, content, uid: owner, ip, time,
        x, y
    });
    return drid;
}

export function getReply(domainId: string, drid: ObjectId): Promise<HubReplyDoc | null> {
    return document.get(domainId, document.TYPE_HUB_REPLY, drid);
}

export async function editReply(
    domainId: string, drid: ObjectId, content: string, uid: number, ip: string,
): Promise<HubReplyDoc | null> {
    await coll.insertOne({
        domainId, docId: drid, content, uid, ip, time: new Date(),
    });
    return document.set(domainId, document.TYPE_HUB_REPLY, drid, { content, edited: true, editor: uid });
}

export async function editReplyCoordinates(
    domainId: string, drid: ObjectId, x: number, y: number, uid: number, ip: string,
): Promise<HubReplyDoc | null> {
    return document.set(domainId, document.TYPE_HUB_REPLY, drid, { x, y,  edited: true, editor: uid});
}

export async function delReply(domainId: string, drid: ObjectId) {
    const drdoc = await getReply(domainId, drid);
    if (!drdoc) throw new DocumentNotFoundError(domainId, drid);
    return await Promise.all([
        document.deleteOne(domainId, document.TYPE_HUB_REPLY, drid),
        document.inc(domainId, document.TYPE_HUB, drdoc.parentId, 'nReply', -1),
        coll.deleteMany({ domainId, docId: { $in: [drid, ...(drdoc.reply?.map((i) => i._id) || [])] } }),
    ]);
}

export function getMultiReply(domainId: string, did: ObjectId) {
    return document.getMulti(
        domainId, document.TYPE_HUB_REPLY,
        { parentType: document.TYPE_HUB, parentId: did },
    ).sort('_id', -1);
}

export function getListReply(domainId: string, did: ObjectId): Promise<HubReplyDoc[]> {
    return getMultiReply(domainId, did).toArray();
}

export async function react(domainId: string, docType: keyof document.DocType, did: ObjectId, id: string, uid: number, reverse = false) {
    let doc;
    const sdoc = await document.setIfNotStatus(domainId, docType, did, uid, `react.${id}`, reverse ? 0 : 1, reverse ? 0 : 1, {});
    if (sdoc) doc = await document.inc(domainId, docType, did, `react.${id}`, reverse ? -1 : 1);
    else doc = await document.get(domainId, docType, did, ['react']);
    return [doc, sdoc];
}

export async function getReaction(domainId: string, docType: keyof document.DocType, did: ObjectId, uid: number) {
    const doc = await document.getStatus(domainId, docType, did, uid);
    return doc?.react || {};
}

export async function addTailReply(
    domainId: string, drid: ObjectId,
    owner: number, content: string, ip: string,
    x: number, y: number
): Promise<[HubReplyDoc, ObjectId]> {
    const time = new Date();
    console.log('Inserting reply with coordinates:', { x, y });
    const [drdoc, subId] = await document.push(
        domainId, document.TYPE_HUB_REPLY, drid,
        'reply', content, owner, { ip, editor: owner, x, y },
    );
    await Promise.all([
        coll.insertOne({
            domainId, docId: subId, content, uid: owner, ip, time: new Date(),
            x, y
        }),
        document.set(
            domainId, document.TYPE_HUB, drdoc.parentId,
            { updateAt: time },
        ),
    ]);
    console.log('Document inserted:', await coll.findOne({ docId: subId }));
    return [drdoc, subId];
}

export function getTailReply(
    domainId: string, drid: ObjectId, drrid: ObjectId,
): Promise<[HubReplyDoc, HubTailReplyDoc] | [null, null]> {
    return document.getSub(domainId, document.TYPE_HUB_REPLY, drid, 'reply', drrid);
}

export async function editTailReply(
    domainId: string, drid: ObjectId, drrid: ObjectId, content: string, uid: number, ip: string,
): Promise<HubTailReplyDoc> {
    const [, drrdoc] = await Promise.all([
        coll.insertOne({
            domainId, docId: drrid, content, uid, time: new Date(), ip,
        }),
        document.setSub(domainId, document.TYPE_HUB_REPLY, drid,
            'reply', drrid, { content, edited: true, editor: uid }),
    ]);
    return drrdoc;
}

export async function delTailReply(domainId: string, drid: ObjectId, drrid: ObjectId) {
    return Promise.all([
        document.deleteSub(domainId, document.TYPE_HUB_REPLY, drid, 'reply', drrid),
        coll.deleteMany({ domainId, docId: drrid }),
    ]);
}

export function getHistory(
    domainId: string, docId: ObjectId, query: Filter<HubHistoryDoc> = {},
    projection = HISTORY_PROJECTION_PUBLIC,
) {
    return coll.find({ domainId, docId, ...query })
        .sort({ time: -1 }).project(buildProjection(projection))
        .toArray();
}

export function setStar(domainId: string, did: ObjectId, uid: number, star: boolean) {
    return document.setStatus(domainId, document.TYPE_HUB, did, uid, { star });
}

export function getStatus(domainId: string, did: ObjectId, uid: number) {
    return document.getStatus(domainId, document.TYPE_HUB, did, uid);
}

export function setStatus(domainId: string, did: ObjectId, uid: number, $set) {
    return document.setStatus(domainId, document.TYPE_HUB, did, uid, $set);
}

export function addNode(domainId: string, _id: string, category: string, args: any = {}) {
    return document.add(
        domainId, category, 1, document.TYPE_HUB_NODE,
        _id, null, null, args,
    );
}

export function getNode(domainId: string, _id: string) {
    return document.get(domainId, document.TYPE_HUB_NODE, _id);
}

export function flushNodes(domainId: string) {
    return document.deleteMulti(domainId, document.TYPE_HUB_NODE);
}

export async function getVnode(domainId: string, type: number, id: string, uid?: number) {
    if (type === document.TYPE_PROBLEM) {
        const pdoc = await problem.get(domainId, Number.isSafeInteger(+id) ? +id : id, problem.PROJECTION_LIST);
        if (!pdoc) throw new HubNodeNotFoundError(id);
        return { ...pdoc, type, id: pdoc.docId };
    }
    if ([document.TYPE_CONTEST, document.TYPE_TRAINING].includes(type as any)) {
        const model = type === document.TYPE_TRAINING ? training : contest;
        if (!ObjectId.isValid(id)) throw new HubNodeNotFoundError(id);
        const _id = new ObjectId(id);
        const tdoc = await model.get(domainId, _id);
        if (!tdoc) throw new HubNodeNotFoundError(id);
        if (uid) {
            const tsdoc = await model.getStatus(domainId, _id, uid);
            tdoc.attend = tsdoc?.attend || tsdoc?.enroll;
        }
        return {
            ...tdoc, type, id: _id, hidden: false,
        };
    }

if (type === document.TYPE_DOCS) {

    // 检查 id 是否为数字类型
    let ddoc;
    if (/^\d+$/.test(id)) {
        console.log(`ID ${id} is a numeric lid.`);
        ddoc = await DocsModel.get(domainId, parseInt(id, 10)); // 根据 lid 获取文档
    } else if (ObjectId.isValid(id)) {
        console.log(`ID ${id} is a valid ObjectId.`);
        ddoc = await DocsModel.get(domainId, new ObjectId(id));
    } else {
        console.error(`Invalid ID format: ${id}`);
        throw new Error(`Invalid ID format: ${id}`);
    }

    if (!ddoc) {
        throw new Error(`Docs document not found for id: ${id}`);
    }

    const result = {
        title: ddoc.title,
        type: ddoc.docType,
        id: ddoc.docId, // 使用 lid 返回
        owner: ddoc.owner,
        content: ddoc.content,
        views: ddoc.views,
        replies: ddoc.nReply,
    };
    return result;
}
    return {
        title: id,
        ...await getNode(domainId, id),
        type,
        id,
        owner: 1,
    };
}


export function getNodes(domainId: string) {
    return document.getMulti(domainId, document.TYPE_HUB_NODE).toArray();
}

export async function getListVnodes(domainId: string, ddocs: any, getHidden = false, assign: string[] = []) {
    const res = {};
    async function task(ddoc: HubDoc) {
        const vnode = await getVnode(domainId, ddoc.parentType, ddoc.parentId.toString());
        res[ddoc.parentType] ||= {};
        if (!getHidden && vnode.hidden) return;
        if (vnode.assign?.length && Set.intersection(vnode.assign, assign).size) return;
        res[ddoc.parentType][ddoc.parentId] = vnode;
    }
    await Promise.all(ddocs.map((ddoc) => task(ddoc)));
    return res;
}

export function checkVNodeVisibility(type: number, vnode: any, user: User) {
    if (type === document.TYPE_PROBLEM) {
        if (vnode.hidden && !(user.own(vnode) || user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN))) return false;
    }
    if ([document.TYPE_CONTEST, document.TYPE_TRAINING].includes(type as any)) {
        if (!user.own(vnode) && vnode.assign?.length && !Set.intersection(vnode.assign, user.group).size) return false;
    }
    return true;
}

export function apply(ctx: Context) {
    ctx.on('problem/delete', async (domainId, docId) => {
        const dids = await document.getMulti(
            domainId, document.TYPE_HUB,
            { parentType: document.TYPE_PROBLEM, parentId: docId },
        ).project({ docId: 1 }).map((ddoc) => ddoc.docId).toArray();
        const drids = await document.getMulti(
            domainId, document.TYPE_HUB_REPLY,
            { parentType: document.TYPE_HUB, parentId: { $in: dids } },
        ).project({ docId: 1 }).map((drdoc) => drdoc.docId).toArray();
        return await Promise.all([
            document.deleteMultiStatus(domainId, document.TYPE_HUB, { docId: { $in: dids } }),
            document.deleteMulti(domainId, document.TYPE_HUB, { docId: { $in: dids } }),
            document.deleteMulti(domainId, document.TYPE_HUB_REPLY, { docId: { $in: drids } }),
        ]);
    });
    ctx.on('problem/edit', async (result) => {
        const dids = await document.getMulti(
            result.domainId, document.TYPE_HUB,
            { parentType: document.TYPE_PROBLEM, parentId: result.docId },
        ).project({ docId: 1 }).map((ddoc) => ddoc.docId).toArray();
        return await document.coll.updateMany({ _id: { $in: dids } }, { $set: { hidden: result.hidden } });
    });
}

global.Ejunz.model.hub = {
    coll,
    typeDisplay,
    PROJECTION_LIST,
    PROJECTION_PUBLIC,
    HISTORY_PROJECTION_PUBLIC,

    apply,
    add,
    get,
    inc,
    edit,
    del,
    count,
    getMulti,
    addReply,
    getReply,
    editReply,
    delReply,
    getMultiReply,
    getListReply,
    addTailReply,
    getTailReply,
    editTailReply,
    delTailReply,
    react,
    getReaction,
    getHistory,
    setStar,
    getStatus,
    setStatus,
    addNode,
    getNode,
    flushNodes,
    getNodes,
    getVnode,
    getListVnodes,
    checkVNodeVisibility,
};

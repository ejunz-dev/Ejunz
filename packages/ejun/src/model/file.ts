import { omit } from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { DiscussionNodeNotFoundError, DocumentNotFoundError } from '../error';
import {
    DiscussionHistoryDoc, DiscussionReplyDoc, DiscussionTailReplyDoc, Document, FileHistoryDoc
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

export interface FileDoc extends Document { }
export type Field = keyof FileDoc;

export const PROJECTION_LIST: Field[] = [
    '_id', 'domainId', 'docType', 'docId', 'fid',
    'owner', 'title', 'filename', 'version', 'path',
    'size', 'lastModified', 'etag', 'tag', 'parentId', 'parentType','hidden'
];

export const PROJECTION_PUBLIC: Field[] = [
    ...PROJECTION_LIST, 'content',
];

export const FILE_HISTORY_PROJECTION_PUBLIC: (keyof FileHistoryDoc)[] = [
    'title', 'content', 'docId'
];

export const typeDisplay = {
    [document.TYPE_PROBLEM]: 'problem',
    [document.TYPE_CONTEST]: 'contest',
    [document.TYPE_FILE_NODE]: 'node',
    [document.TYPE_TRAINING]: 'training',
    [document.TYPE_HOMEWORK]: 'homework',
    [document.TYPE_DOCS]: 'docs',
};


export const coll = db.collection('file.history');


export async function add(
    domainId: string, docId: ObjectId, parentType: number, parentId: ObjectId | number | string,
    owner: number, title: string, content: string, filename: string,
    version: string, path: string, size: number, lastModified: Date, 
    ip: string | null = null, etag?: string, tag: string[] = [], hidden = false,    
): Promise<ObjectId> {
    const time = new Date();
    const payload: Partial<FileDoc> = {
        domainId,
        docId,
        content,
        owner,
        parentType,
        parentId,
        title,
        filename,
        version,
        path,
        size,
        lastModified,
        etag,
        tag,
        hidden,
    };
    await bus.parallel('file/before-add', payload);
    const res = await document.add(
        payload.domainId!, payload.content!, payload.owner!, document.TYPE_FILE,
        null, payload.parentType, payload.parentId, omit(payload, ['domainId', 'content', 'owner', 'parentType', 'parentId']),
    );
    payload.docId = res;
    await bus.parallel('file/add', payload);
    return payload.docId;
}

export async function get<T extends Field>(
    domainId: string, docId: ObjectId, projection: T[] = PROJECTION_PUBLIC as any,
): Promise<Pick<FileDoc, T>> {
    return await document.get(domainId, document.TYPE_FILE, docId, projection);
}

export async function edit(domainId: string, docId: ObjectId, $set: Partial<FileDoc>) {
    return document.set(domainId, document.TYPE_FILE, docId, $set);
}

export function inc(
    domainId: string, docId: ObjectId, key: NumberKeys<FileDoc>, value: number,
): Promise<FileDoc | null> {
    return document.inc(domainId, document.TYPE_FILE, docId, key, value);
}

export async function del(domainId: string, docId: ObjectId): Promise<void> {
    const [ddoc, drdocs] = await Promise.all([
        document.get(domainId, document.TYPE_FILE, docId),
        document.getMulti(domainId, document.TYPE_FILE, {   
            parentType: document.TYPE_FILE, parentId: docId,
        }).project({ _id: 1, 'reply._id': 1 }).toArray(),
    ]) as any;
    await Promise.all([
        document.deleteOne(domainId, document.TYPE_FILE, docId),
        document.deleteMulti(domainId, document.TYPE_FILE, {
            parentType: document.TYPE_FILE, parentId: docId,
        }),
        document.deleteMultiStatus(domainId, document.TYPE_FILE, { docId: docId }),
        coll.deleteMany({ domainId, docId: { $in: [ddoc._id, ...(drdocs.reply?.map((i) => i._id) || [])] } }),
    ]) as any;
}

export function count(domainId: string, query: Filter<FileDoc>) {
    return document.count(domainId, document.TYPE_FILE, query);
}

export function getMulti(domainId: string, query: Filter<FileDoc> = {}, projection = PROJECTION_LIST) {
    return document.getMulti(domainId, document.TYPE_FILE, query)
        .sort({ pin: -1, docId: -1 })
        .project<FileDoc>(buildProjection(projection));
}


export function addNode(domainId: string, _id: string, category: string, args: any = {}) {
    return document.add(
        domainId, category, 1, document.TYPE_FILE_NODE,
        _id, null, null, args,
    );
}

export function getNode(domainId: string, _id: string) {
    return document.get(domainId, document.TYPE_FILE_NODE, _id);
}

export function flushNodes(domainId: string) {
    return document.deleteMulti(domainId, document.TYPE_FILE_NODE);
}

export async function getVnode(domainId: string, type: number, id: string, uid?: number) {
    if (type === document.TYPE_PROBLEM) {
        const pdoc = await problem.get(domainId, Number.isSafeInteger(+id) ? +id : id, problem.PROJECTION_LIST);
        if (!pdoc) throw new DiscussionNodeNotFoundError(id);
        return { ...pdoc, type, id: pdoc.docId };
    }
    if ([document.TYPE_CONTEST, document.TYPE_TRAINING].includes(type as any)) {
        const model = type === document.TYPE_TRAINING ? training : contest;
        if (!ObjectId.isValid(id)) throw new DiscussionNodeNotFoundError(id);
        const _id = new ObjectId(id);
        const tdoc = await model.get(domainId, _id);
        if (!tdoc) throw new DiscussionNodeNotFoundError(id);
        if (uid) {
            const tsdoc = await model.getStatus(domainId, _id, uid);
            tdoc.attend = tsdoc?.attend || tsdoc?.enroll;
        }
        return {
            ...tdoc, type, id: _id, hidden: false,
        };
    }

if (type === document.TYPE_DOCS) {
    console.log(`Processing TYPE_DOCS node with id: ${id}`); // Log the ID being processed

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
        console.error(`Docs document not found for id: ${id}`);
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
    console.log(`Returning Docs node:`, result); // Log the final result
    console.log('ddoc',ddoc)
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
    return document.getMulti(domainId, document.TYPE_FILE_NODE).toArray();
}

export async function getListVnodes(domainId: string, ddocs: any, getHidden = false, assign: string[] = []) {
    const res = {};
    async function task(ddoc: FileDoc) {
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
            domainId, document.TYPE_DISCUSSION,
            { parentType: document.TYPE_PROBLEM, parentId: docId },
        ).project({ docId: 1 }).map((ddoc) => ddoc.docId).toArray();
        const drids = await document.getMulti(
            domainId, document.TYPE_DISCUSSION_REPLY,
            { parentType: document.TYPE_DISCUSSION, parentId: { $in: dids } },
        ).project({ docId: 1 }).map((drdoc) => drdoc.docId).toArray();
        return await Promise.all([
            document.deleteMultiStatus(domainId, document.TYPE_DISCUSSION, { docId: { $in: dids } }),
            document.deleteMulti(domainId, document.TYPE_DISCUSSION, { docId: { $in: dids } }),
            document.deleteMulti(domainId, document.TYPE_DISCUSSION_REPLY, { docId: { $in: drids } }),
        ]);
    });
    ctx.on('problem/edit', async (result) => {
        const dids = await document.getMulti(
            result.domainId, document.TYPE_DISCUSSION,
            { parentType: document.TYPE_PROBLEM, parentId: result.docId },
        ).project({ docId: 1 }).map((ddoc) => ddoc.docId).toArray();
        return await document.coll.updateMany({ _id: { $in: dids } }, { $set: { hidden: result.hidden } });
    });
}

global.Ejunz.model.file = {
    coll,
    typeDisplay,
    PROJECTION_LIST,
    PROJECTION_PUBLIC,
    FILE_HISTORY_PROJECTION_PUBLIC,

    apply,
    add,
    get,
    inc,
    edit,
    del,
    count,
    getMulti,
    addNode,
    getNode,
    flushNodes,
    getNodes,
    getVnode,
    getListVnodes,
    checkVNodeVisibility,
};

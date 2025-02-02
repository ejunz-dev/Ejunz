import child from 'child_process';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import { pick } from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import type { Readable } from 'stream';
import { Logger, size, streamToBuffer } from '@ejunz/utils/lib/utils';
import { Context } from '../context';
import { FileUploadError, ProblemNotFoundError } from '../error';
import type {
    Document, ProblemDict, ProblemStatusDoc, User, DocsDict
} from '../interface';
import { parseConfig } from '../lib/testdataConfig';
import * as bus from '../service/bus';
import {
    ArrayKeys, MaybeArray, NumberKeys, Projection,
} from '../typeutils';
import { buildProjection } from '../utils';
import { PERM, STATUS } from './builtin';
import DomainModel from './domain';
import RecordModel from './record';
import storage from './storage';
import * as SystemModel from './system';
import user from './user';
import * as document from './document';
import _ from 'lodash';

export interface RepoDoc extends Document {}
export type Field = keyof RepoDoc;

export class RepoModel {
    static PROJECTION_LIST: Field[] = [
        'docId', 'rid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply','files'
    ];

    static PROJECTION_DETAIL: Field[] = [
        ...RepoModel.PROJECTION_LIST,
       'docId', 'rid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply','files'
    ];

    static PROJECTION_PUBLIC: Field[] = [
        ...RepoModel.PROJECTION_DETAIL,
        'docId', 'rid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply','files'
    ];

    static async generateNextDocId(domainId: string): Promise<number> {
        const lastRepo = await document.getMulti(domainId, document.TYPE_REPO, {})
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();

        const lastDocId = Number(lastRepo[0]?.docId) || 0;
        return lastDocId + 1;
    }

    static async generateNextRid(domainId: string): Promise<string> {
        const lastDoc = await document.getMulti(domainId, document.TYPE_REPO, {})
            .sort({ rid: -1 })
            .limit(1)
            .project({ rid: 1 })
            .toArray();

        if (!lastDoc.length || !lastDoc[0]?.rid) {
            return "R1";
        }

        const lastRid = String(lastDoc[0].rid);
        const lastRidNumber = parseInt(lastRid.match(/\d+/)?.[0] || "0", 10);

        return `R${lastRidNumber + 1}`;
    }

    static async addWithId(
        domainId: string,
        docId: number,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<RepoDoc> = {},
    ): Promise<string> {
        const rid = await RepoModel.generateNextRid(domainId);

        if (typeof ip !== 'string') {
            ip = String(ip);
        }

        const payload: Partial<RepoDoc> = {
            domainId,
            docId,
            rid,
            content,
            owner,
            title: String(title),
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            isIterative: false,
            ...meta, 
        };

        await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            document.TYPE_REPO,
            docId,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        return rid;
    }

    static async add(
        domainId: string, owner: number, title: string, content: string, ip?: string, isIterative: boolean = true
    ): Promise<string> {
        const docId = await RepoModel.generateNextDocId(domainId);
        return RepoModel.addWithId(domainId, docId, owner, title, content, ip, {}, isIterative);
    }

    static async getByRid(domainId: string, rid: string): Promise<RepoDoc | null> {
        const query = /^\d+$/.test(rid) ? { docId: Number(rid) } : { rid };
    
        console.log(`[RepoModel.getByRid] Querying repository with`, query);
    
        const doc = await document.getMulti(domainId, document.TYPE_REPO, query)
            .project<RepoDoc>(buildProjection(RepoModel.PROJECTION_DETAIL)) 
            .limit(1)
            .next();
    
        if (!doc) {
            console.warn(`[RepoModel.getByRid] No document found for query=`, query);
        } else {
            console.log(`[RepoModel.getByRid] Retrieved document:`, JSON.stringify(doc, null, 2));
        }
    
        return doc || null;
    }
    

    static async get(domainId: string, rid: number | string): Promise<RepoDoc | null> {
        const query = typeof rid === 'number' ? { docId: rid } : { rid: String(rid) };

        console.log(`[RepoModel.get] Querying document with ${typeof rid === 'number' ? 'docId' : 'rid'}=${rid}`);

        const res = await document.getMulti(domainId, document.TYPE_REPO, query)
            .project({ files: 1, rid: 1, title: 1, content: 1, docId: 1 })
            .limit(1)
            .toArray();

        if (!res.length) {
            console.error(`[RepoModel.get] No document found for ${typeof rid === 'number' ? 'docId' : 'rid'}=${rid}`);
            return null;
        }

        const repoDoc = res[0] as RepoDoc;

        if (!Array.isArray(repoDoc.files)) {
            console.warn(`[RepoModel.get] Warning: repoDoc.files is not an array, resetting to empty array.`);
            repoDoc.files = [];
        }

        console.log(`[RepoModel.get] Retrieved document:`, JSON.stringify(repoDoc, null, 2));

        return repoDoc;
    }

    static getMulti(domainId: string, query: Filter<RepoDoc> = {}, projection = RepoModel.PROJECTION_LIST) {
        return document.getMulti(domainId, document.TYPE_REPO, query, projection).sort({ docId: -1 });
    }

    static async list(
        domainId: string,
        query: Filter<RepoDoc>,
        page: number,
        pageSize: number,
        projection = RepoModel.PROJECTION_LIST,
        uid?: number
    ): Promise<[RepoDoc[], number, number]> {
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union?.union || [])];

        let totalCount = 0;
        const repoList: RepoDoc[] = [];

        for (const id of domainIds) {
            if (typeof uid === 'number') {
                const userDoc = await user.getById(id, uid);
                if (!userDoc.hasPerm(PERM.PERM_VIEW)) continue;
            }

            const currentCount = await document.count(id, document.TYPE_REPO, query);

            if (repoList.length < pageSize && (page - 1) * pageSize - totalCount <= currentCount) {
                repoList.push(
                    ...await document.getMulti(id, document.TYPE_REPO, query, projection)
                        .sort({ docId: -1 })
                        .skip(Math.max((page - 1) * pageSize - totalCount, 0))
                        .limit(pageSize - repoList.length)
                        .toArray()
                );
            }

            totalCount += currentCount;
        }

        return [repoList, Math.ceil(totalCount / pageSize), totalCount];
    }
    static async getList(
        domainId: string, 
        docIds: number[],
        projection = RepoModel.PROJECTION_PUBLIC, 
        indexByDocIdOnly = false,
    ): Promise<Record<number | string, RepoDoc>> {
        if (!docIds?.length) {
            return {};
        }
    
        const r: Record<number, RepoDoc> = {};
        const l: Record<string, RepoDoc> = {};
    
        const q: any = { docId: { $in: docIds } };
    
        let repos = await document.getMulti(domainId, document.TYPE_REPO, q)
            .project<RepoDoc>(buildProjection(projection))
            .toArray();
    
        for (const repo of repos) {
            r[repo.docId] = repo;
            if (repo.rid) l[repo.rid] = repo;
        }
    
        return indexByDocIdOnly ? r : Object.assign(r, l);
    }
    
    static async edit(domainId: string, rid: string, updates: Partial<RepoDoc>): Promise<RepoDoc> {
        const repo = await document.getMulti(domainId, document.TYPE_REPO, { rid }).next();
        if (!repo) throw new Error(`Document with rid=${rid} not found`);

        return document.set(domainId, document.TYPE_REPO, repo.docId, updates);
    }
static async addVersion(
        domainId: string,
        docId: number,
        filename: string,
        version: string,
        path: string,
        size: number,
        lastModified: Date,
        etag: string,
        tag: string[] = [],
    ): Promise<RepoDoc> {
        const repoDoc = await RepoModel.get(domainId, docId);
        if (!repoDoc) throw new Error(`Repository with docId=${docId} not found`);

        const payload = {
            filename,
            version,
            path,
            size,
            lastModified,
            etag,
            tag,
        };

        const [updatedRepo] = await document.push(domainId, document.TYPE_REPO, docId, 'files', payload);

        return updatedRepo;
    }
    static async addFile(
        domainId: string,
        docId: number,
        filename: string,
        path: string,
        size: number,
        lastModified: Date,
        etag: string,
        tag: string[] = [],
    ): Promise<RepoDoc> {
        const repoDoc = await RepoModel.get(domainId, docId);
        if (!repoDoc) throw new Error(`Repository with docId=${docId} not found`);


        const payload = {
            filename,
            path,
            size,
            lastModified,
            etag,
            tag,
        };

        const [updatedRepo] = await document.push(domainId, document.TYPE_REPO, docId, 'files', payload);

        return updatedRepo;
    }


    static async inc(domainId: string, rid: string, key: NumberKeys<RepoDoc>, value: number): Promise<RepoDoc | null> {
        const doc = await RepoModel.getByRid(domainId, rid);
        if (!doc) throw new Error(`Repository with rid=${rid} not found`);

        return document.inc(domainId, document.TYPE_REPO, doc.docId, key, value);
    }

    static async del(domainId: string, rid: string): Promise<boolean> {
        const doc = await RepoModel.getByRid(domainId, rid);
        if (!doc) throw new Error(`Repository with rid=${rid} not found`);

        await Promise.all([
            document.deleteOne(domainId, document.TYPE_REPO, doc.docId),
            document.deleteMultiStatus(domainId, document.TYPE_REPO, { docId: doc.docId }),
        ]);
        return true;
    }

    static async count(domainId: string, query: Filter<RepoDoc>) {
        return document.count(domainId, document.TYPE_REPO, query);
    }

    static async setStar(domainId: string, rid: string, uid: number, star: boolean) {
        const doc = await RepoModel.getByRid(domainId, rid);
        if (!doc) throw new Error(`Repository with rid=${rid} not found`);

        return document.setStatus(domainId, document.TYPE_REPO, doc.docId, uid, { star });
    }

    static async getStatus(domainId: string, rid: string, uid: number) {
        const doc = await RepoModel.getByRid(domainId, rid);
        if (!doc) throw new Error(`Repository with rid=${rid} not found`);

        return document.getStatus(domainId, document.TYPE_REPO, doc.docId, uid);
    }

    static async setStatus(domainId: string, rid: string, uid: number, updates) {
        const doc = await RepoModel.getByRid(domainId, rid);
        if (!doc) throw new Error(`Repository with rid=${rid} not found`);

        return document.setStatus(domainId, document.TYPE_REPO, doc.docId, uid, updates);
    }
}

export function apply(ctx: Context) {}

global.Ejunz.model.repo = RepoModel;
export default RepoModel;

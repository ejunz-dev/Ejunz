/* eslint-disable no-await-in-loop */
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
        'docId', 'rid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static PROJECTION_DETAIL: Field[] = [
        ...RepoModel.PROJECTION_LIST,
       'docId', 'rid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static PROJECTION_PUBLIC: Field[] = [
        ...RepoModel.PROJECTION_DETAIL,
        'docId', 'rid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];
    static async generateNextDocId(domainId: string): Promise<number> {
        const lastRepo = await document.getMulti(domainId, document.TYPE_REPO, {})
            .sort({ docId: -1 }) // 降序获取最新的文档
            .limit(1)
            .project({ docId: 1 })
            .toArray();
    
        // 这里确保 docId 是数字，而不是字符串
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
            return "R1"; // 如果没有文档，返回 R1
        }
    
        const lastRid = String(lastDoc[0].rid); // 强制转换为字符串
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
    
        // 确保 IP 是字符串
        if (typeof ip !== 'string') {
            ip = String(ip);
        }
    
        const payload: Partial<RepoDoc> = {
            domainId,
            docId,
            rid,
            content,
            owner,
            title: String(title),  // 确保 title 是字符串
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
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
        domainId: string, owner: number, title: string, content: string, ip?: string,
    ): Promise<string> {
        const docId = await RepoModel.generateNextDocId(domainId);
        return RepoModel.addWithId(domainId, docId, owner, title, content, ip);
    }

    static async getByRid(domainId: string, rid: string): Promise<RepoDoc | null> {
        const doc = await document.getMulti(domainId, document.TYPE_REPO, { rid })
            .project<RepoDoc>(buildProjection(RepoModel.PROJECTION_DETAIL))
            .limit(1)
            .next();
    
        return doc || null;
    }
    

    static async get(domainId: string, rid: number | string): Promise<RepoDoc | null> {
        const query = typeof rid === 'number' ? { docId: rid } : { rid: String(rid) };
    
        console.log(`[RepoModel.get] Querying document with ${typeof rid === 'number' ? 'docId' : 'rid'}=${rid}`);
    
        const res = await document.getMulti(domainId, document.TYPE_REPO, query)
            .project(buildProjection(RepoModel.PROJECTION_PUBLIC))
            .limit(1)
            .toArray();
    
        if (!res.length) {
            console.error(`[RepoModel.get] No document found for ${typeof rid === 'number' ? 'docId' : 'rid'}=${rid}`);
            return null;
        }
        return res[0] as RepoDoc;
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
    static async edit(domainId: string, rid: string, updates: Partial<RepoDoc>): Promise<RepoDoc> {
        const repo = await document.getMulti(domainId, document.TYPE_REPO, { rid }).next();
        if (!repo) throw new Error(`Document with rid=${rid} not found`);

        return document.set(domainId, document.TYPE_REPO, repo.docId, updates);
    }
    static async addVersion(
        domainId: string,
        docId: number,  // ✅ 这里改为 `docId`
        filename: string,
        version: string,
        path: string,
        size: number,
        lastModified: Date,
        etag: string
    ): Promise<RepoDoc> {
        const repoDoc = await RepoModel.get(domainId, docId);  // ✅ 这里用 `docId` 获取 repo
        if (!repoDoc) throw new Error(`Repository with docId=${docId} not found`);
    
        const payload = {
            filename,
            version,
            path,
            size,
            lastModified,
            etag,
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

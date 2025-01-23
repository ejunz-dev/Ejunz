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
import { FileUploadError, ProblemNotFoundError, ValidationError } from '../error';
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
    static async generateNextRid(domainId: string): Promise<number> {
        const lastDoc = await document.getMulti(domainId, document.TYPE_REPO, {})
            .sort({ rid: -1 }) // 按 rid 降序排列
            .limit(1)
            .project({ rid: 1 })
            .toArray();
        return (lastDoc[0]?.rid || 0) + 1; // 若不存在文档，从 1 开始
    }

    static async addWithId(
        domainId: string,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<RepoDoc> = {},
    ): Promise<ObjectId> {
        const rid = await RepoModel.generateNextRid(domainId); // 生成新的 rid
        const payload: Partial<RepoDoc> = {
            domainId,
            content,
            owner,
            title,
            ip,
            rid,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            ...meta, // 合并其他元信息
        };

        const res = await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            document.TYPE_REPO,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        payload.docId = res; // 添加生成的 docId
        return payload.docId;
    }

    static async getByRid(domainId: string, rid: number): Promise<RepoDoc | null> {
        const cursor = document.getMulti(domainId, document.TYPE_REPO, { rid });
        const doc = await cursor.next();
        return doc ? (doc as RepoDoc) : null;
    }

    static async get(domainId: string, did: ObjectId): Promise<RepoDoc> {
        return await document.get(domainId, document.TYPE_REPO, did);
    }

    static edit(domainId: string, did: ObjectId, title: string, content: string): Promise<RepoDoc> {
        const payload = { title, content };
        return document.set(domainId, document.TYPE_REPO, did, payload);
    }

    static async addversion(
        domainId: string,
        did: ObjectId,
        filename: string,
        version: string,
        path: string,
        size: number,
        lastModified: Date,
        etag: string
    ): Promise<RepoDoc> {
        const payload = {
            filename,
            version,
            path,
            size,
            lastModified,
            etag,
        };
    
        // 使用解构赋值提取 RepoDoc
        const [updatedRepo] = await document.push(domainId, document.TYPE_REPO, did, 'files', payload);
    
        return updatedRepo;
    }
    

    static inc(domainId: string, did: ObjectId, key: NumberKeys<RepoDoc>, value: number): Promise<RepoDoc | null> {
        return document.inc(domainId, document.TYPE_REPO, did, key, value);
    }

    static del(domainId: string, did: ObjectId): Promise<never> {
        return Promise.all([
            document.deleteOne(domainId, document.TYPE_REPO, did),
            document.deleteMultiStatus(domainId, document.TYPE_REPO, { docId: did }),
        ]) as any;
    }

    static count(domainId: string, query: Filter<RepoDoc>) {
        return document.count(domainId, document.TYPE_REPO, query);
    }

    static getMulti(domainId: string, query: Filter<RepoDoc> = {}) {
        return document.getMulti(domainId, document.TYPE_REPO, query)
            .sort({ _id: -1 });
    }

    static async addReply(domainId: string, did: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [[, rrid]] = await Promise.all([
            document.push(domainId, document.TYPE_REPO, did, 'reply', content, owner, { ip }),
            document.incAndSet(domainId, document.TYPE_REPO, did, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return rrid;
    }

    static setStar(domainId: string, did: ObjectId, uid: number, star: boolean) {
        return document.setStatus(domainId, document.TYPE_REPO, did, uid, { star });
    }

    static getStatus(domainId: string, did: ObjectId, uid: number) {
        return document.getStatus(domainId, document.TYPE_REPO, did, uid);
    }

    static setStatus(domainId: string, did: ObjectId, uid: number, $set) {
        return document.setStatus(domainId, document.TYPE_REPO, did, uid, $set);
    }
}

export function apply(ctx: Context) {}

global.Ejunz.model.repo = RepoModel;
export default RepoModel;

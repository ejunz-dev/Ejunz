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
    Document, ProblemDict, ProblemStatusDoc, User,
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
// import SolutionModel from './solution';
import storage from './storage';
import * as SystemModel from './system';
import user from './user';
import * as document from './document';
import _ from 'lodash';


export interface DocsDoc extends Document { }
export type Field = keyof DocsDoc;

const logger = new Logger('docs');


export class DocsModel {

    static async generateNextLid(domainId: string): Promise<number> {
        const lastDoc = await document.getMulti(domainId, document.TYPE_DOCS, {})
            .sort({ lid: -1 }) // 按 lid 降序排列
            .limit(1)
            .project({ lid: 1 })
            .toArray();
        return (lastDoc[0]?.lid || 0) + 1; // 若不存在文档，从 1 开始
    }

    // 添加 addWithId 方法
    static async addWithId(
        domainId: string,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<DocsDoc> = {},
    ): Promise<ObjectId> {
        const lid = await DocsModel.generateNextLid(domainId); // 生成新的 lid
        const payload: Partial<DocsDoc> = {
            domainId,
            content,
            owner,
            title,
            ip,
            lid,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            ...meta, // 合并其他元信息
        };

        const res = await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            document.TYPE_DOCS,
            null,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        payload.docId = res; // 添加生成的 docId
        return payload.docId;
    }
    static async add(
        domainId:string, owner: number, title: string, content: string, ip?: string,
    ): Promise<ObjectId> {
        const payload: Partial<DocsDoc> = {
            domainId,
            content,
            owner,
            title,
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
        };
        const res = await document.add(
            domainId, payload.content!, payload.owner!, document.TYPE_DOCS,
            null, null, null, _.omit(payload, ['domainId', 'content', 'owner']),
        );
        payload.docId = res;
        return payload.docId;
    }
    static async getByLid(domainId: string, lid: number): Promise<DocsDoc | null> {

        const cursor = document.getMulti(domainId, document.TYPE_DOCS, { lid });

        const doc = await cursor.next();
  
        if (!doc) {
            console.warn(`No Docs document found for lid: ${lid} in domain: ${domainId}`);
            return null;
        }
    
        return doc as DocsDoc;
    }
    

    static async get(domainId: string, did: ObjectId): Promise<DocsDoc> {
        return await document.get(domainId, document.TYPE_DOCS, did);
    }

    static edit(domainId: string, did: ObjectId, title: string, content: string): Promise<DocsDoc> {
        const payload = { title, content };
        return document.set(domainId, document.TYPE_DOCS, did, payload);
    }

    static inc(domainId: string, did: ObjectId, key: NumberKeys<DocsDoc>, value: number): Promise<DocsDoc | null> {
        return document.inc(domainId, document.TYPE_DOCS, did, key, value);
    }

    static del(domainId: string, did: ObjectId): Promise<never> {
        return Promise.all([
            document.deleteOne(domainId, document.TYPE_DOCS, did),
            document.deleteMultiStatus(domainId, document.TYPE_DOCS, { docId: did }),
        ]) as any;
    }

    static count(domainId: string, query: Filter<DocsDoc>) {
        return document.count(domainId, document.TYPE_DOCS, query);
    }

    static getMulti(domainId: string, query: Filter<DocsDoc> = {}) {
        return document.getMulti(domainId, document.TYPE_DOCS, query)
            .sort({ _id: -1 });
    }

    static async addReply(domainId: string, did: ObjectId, owner: number, content: string, ip: string): Promise<ObjectId> {
        const [[, drid]] = await Promise.all([
            document.push(domainId, document.TYPE_DOCS, did, 'reply', content, owner, { ip }),
            document.incAndSet(domainId, document.TYPE_DOCS, did, 'nReply', 1, { updateAt: new Date() }),
        ]);
        return drid;
    }

    static setStar(domainId: string, did: ObjectId, uid: number, star: boolean) {
        return document.setStatus(domainId, document.TYPE_DOCS, did, uid, { star });
    }

    static getStatus(domainId: string, did: ObjectId, uid: number) {
        return document.getStatus(domainId, document.TYPE_DOCS, did, uid);
    }

    static setStatus(domainId: string, did: ObjectId, uid: number, $set) {
        return document.setStatus(domainId, document.TYPE_DOCS, did, uid, $set);
    }

    static async getList(domainId: string, ids: number[]): Promise<DocsDoc[]> {
        if (!ids || ids.length === 0) return [];
    
        const query = { domainId, lid: { $in: ids } };
        const docs = await document.getMulti(domainId, document.TYPE_DOCS, query).toArray();
    
        return docs.map(doc => ({
            ...doc,
            lid: doc.lid ? String(doc.lid) : '0',  // 确保 lid 永远是字符串
        }));
    }
    static async list(
        domainId: string,
        query: Filter<DocsDoc>,
        page: number,
        pageSize: number,
        projection = DocsModel.PROJECTION_LIST,
        uid?: number
    ): Promise<[DocsDoc[], number, number]> {
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union?.union || [])];
        
        let totalCount = 0;
        const docsList: DocsDoc[] = [];
    
        for (const id of domainIds) {
            // 🔹 确保用户有权限查看文档
            if (typeof uid === 'number') {
                const userDoc = await user.getById(id, uid);
                if (!userDoc.hasPerm(PERM.PERM_VIEW)) continue;
            }
    
            // 🔹 计算当前 `domainId` 里的文档总数
            const currentCount = await document.count(id, document.TYPE_DOCS, query);
    
            if (docsList.length < pageSize && (page - 1) * pageSize - totalCount <= currentCount) {
                // 🔹 查询 `docs` 并进行分页
                docsList.push(
                    ...await document.getMulti(id, document.TYPE_DOCS, query, projection)
                        .sort({ _id: -1 })  // 按 `_id` 降序排列
                        .skip(Math.max((page - 1) * pageSize - totalCount, 0))
                        .limit(pageSize - docsList.length)
                        .toArray()
                );
            }
    
            totalCount += currentCount;
        }
    
        return [docsList, Math.ceil(totalCount / pageSize), totalCount];
    }
    
}
export function apply(ctx: Context) {
   
}
global.Ejunz.model.doc = DocsModel;
export default DocsModel;

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


export interface DocsDoc extends Document {}
export type Field = keyof DocsDoc;

const logger = new Logger('docs');
function sortable(source: string) {
    return source.replace(/(\d+)/g, (str) => (str.length >= 6 ? str : ('0'.repeat(6 - str.length) + str)));
}

export class DocsModel {
    /** 🔹 投影定义 */
    static PROJECTION_LIST: Field[] = [
        'docId', 'lid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static PROJECTION_DETAIL: Field[] = [
        ...DocsModel.PROJECTION_LIST,
        'docId', 'lid', 'title'
    ];

    static PROJECTION_PUBLIC: Field[] = [
        ...DocsModel.PROJECTION_DETAIL,
        'docId', 'lid',
    ];

    /** 🔹 生成下一个 `docId` */
    static async generateNextDocId(domainId: string): Promise<number> {
        const lastDoc = await document.getMulti(domainId, document.TYPE_DOCS, {})
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();
        return (lastDoc[0]?.docId || 0) + 1;
    }

    /** 🔹 生成下一个 `lid`（字符串类型） */
    static async generateNextLid(domainId: string): Promise<string> {
        const lastDoc = await document.getMulti(domainId, document.TYPE_DOCS, {})
            .sort({ lid: -1 })
            .limit(1)
            .project({ lid: 1 })
            .toArray();
        
        const lastLidNumber = parseInt(lastDoc[0]?.lid?.match(/\d+/)?.[0] || '0', 10);
        return `D${lastLidNumber + 1}`;
    }

    /** 🔹 添加文档（指定 `docId` 和 `lid`） */
    static async addWithId(
        domainId: string,
        docId: number,
        owner: number,
        title: string,
        content: string,
        ip?: string,
        meta: Partial<DocsDoc> = {},
    ): Promise<string> {
        const lid = await DocsModel.generateNextLid(domainId);

        const payload: Partial<DocsDoc> = {
            domainId,
            docId,
            lid,
            content,
            owner,
            title,
            ip,
            nReply: 0,
            updateAt: new Date(),
            views: 0,
            ...meta
        };

        await document.add(
            domainId,
            payload.content!,
            payload.owner!,
            document.TYPE_DOCS,
            docId,
            null,
            null,
            _.omit(payload, ['domainId', 'content', 'owner']),
        );

        return lid;
    }

    /** 🔹 添加文档（自动生成 `docId` 和 `lid`） */
    static async add(
        domainId: string, owner: number, title: string, content: string, ip?: string,
    ): Promise<string> {
        const docId = await DocsModel.generateNextDocId(domainId);
        return DocsModel.addWithId(domainId, docId, owner, title, content, ip);
    }

    static async get(domainId: string, lid: string | number): Promise<DocsDoc | null> {
        console.log(`[DocsModel] Fetching doc with lid=${lid} in domain=${domainId}`);
    
        const query = typeof lid === 'number' ? { docId: lid } : { lid: String(lid) };
    
        const res = await document.getMulti(domainId, document.TYPE_DOCS, query)
            .project(buildProjection(DocsModel.PROJECTION_PUBLIC))
            .limit(1)
            .toArray();
    
        if (!res.length) {
            console.warn(`[DocsModel] Document not found for lid=${lid} in domain=${domainId}`);
            return null;
        }
        
        return res[0];
    }
    
    

    /** 🔹 获取多个文档 */
    static getMulti(domainId: string, query: Filter<DocsDoc> = {}, projection = DocsModel.PROJECTION_LIST) {
        return document.getMulti(domainId, document.TYPE_DOCS, query, projection).sort({ docId: -1 });
    }

    /** 🔹 分页获取文档 */
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
            if (typeof uid === 'number') {
                const userDoc = await user.getById(id, uid);
                if (!userDoc.hasPerm(PERM.PERM_VIEW)) continue;
            }

            const currentCount = await document.count(id, document.TYPE_DOCS, query);

            if (docsList.length < pageSize && (page - 1) * pageSize - totalCount <= currentCount) {
                docsList.push(
                    ...await document.getMulti(id, document.TYPE_DOCS, query, projection)
                        .sort({ docId: -1 })
                        .skip(Math.max((page - 1) * pageSize - totalCount, 0))
                        .limit(pageSize - docsList.length)
                        .toArray()
                );
            }

            totalCount += currentCount;
        }

        return [docsList, Math.ceil(totalCount / pageSize), totalCount];
    }

    /** 🔹 通过 `lid` 编辑文档 */
    static async edit(domainId: string, lid: string, updates: Partial<DocsDoc>): Promise<DocsDoc> {
        const doc = await document.getMulti(domainId, document.TYPE_DOCS, { lid }).next();
        if (!doc) throw new Error(`Document with lid=${lid} not found`);

        return document.set(domainId, document.TYPE_DOCS, doc.docId, updates);
    }

    /** 🔹 通过 `lid` 删除文档 */
    static async del(domainId: string, lid: string): Promise<boolean> {
        const doc = await document.getMulti(domainId, document.TYPE_DOCS, { lid }).next();
        if (!doc) throw new Error(`Document with lid=${lid} not found`);

        await Promise.all([
            document.deleteOne(domainId, document.TYPE_DOCS, doc.docId),
            document.deleteMultiStatus(domainId, document.TYPE_DOCS, { docId: doc.docId }),
        ]);
        return true;
    }

    /** 🔹 统计文档总数 */
    static async count(domainId: string, query: Filter<DocsDoc>) {
        return document.count(domainId, document.TYPE_DOCS, query);
    }

    /** 🔹 获取文档状态 */
    static async getStatus(domainId: string, lid: string, uid: number) {
        return document.getStatus(domainId, document.TYPE_DOCS, lid, uid);
    }

    /** 🔹 设置文档状态 */
    static async setStatus(domainId: string, lid: string, uid: number, updates) {
        return document.setStatus(domainId, document.TYPE_DOCS, lid, uid, updates);
    }

        /** 🔹 通过 `lid` 批量获取文档 */
    static async getList(domainId: string, lids: string[]): Promise<DocsDoc[]> {
        if (!lids || lids.length === 0) return [];

        const query = { domainId, lid: { $in: lids } };
        
        // 🔹 查询文档并应用投影
        const docs = await document.getMulti(domainId, document.TYPE_DOCS, query, DocsModel.PROJECTION_PUBLIC)
            .toArray();

        // 🔹 确保 `lid` 始终是字符串
        return docs.map(doc => ({
            ...doc,
            lid: String(doc.lid),
        }));
    }
    /** 🔹 递增文档字段 */
    static async inc(domainId: string, lid: string, key: NumberKeys<DocsDoc>, value: number): Promise<DocsDoc | null> {
        // 🔹 先根据 lid 获取对应的 docId
        const doc = await document.getMulti(domainId, document.TYPE_DOCS, { lid }).next();
        if (!doc) throw new Error(`Document with lid=${lid} not found`);

        // 🔹 递增字段
        return document.inc(domainId, document.TYPE_DOCS, doc.docId, key, value);
    }


}

export function apply(ctx: Context) {}

global.Ejunz.model.doc = DocsModel;
export default DocsModel;

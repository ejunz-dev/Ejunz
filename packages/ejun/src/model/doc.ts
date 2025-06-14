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

export interface DocsDoc extends Document {}
export type Field = keyof DocsDoc;

const logger = new Logger('docs');

function sortable(source: string) {
    return source.replace(/(\d+)/g, (str) => (str.length >= 6 ? str : ('0'.repeat(6 - str.length) + str)));
}

export class DocsModel {
    static PROJECTION_LIST: Field[] = [
        'docId', 'lid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static PROJECTION_DETAIL: Field[] = [
        ...DocsModel.PROJECTION_LIST,
       'docId', 'lid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply'
    ];

    static PROJECTION_PUBLIC: Field[] = [
        ...DocsModel.PROJECTION_DETAIL,
        'docId', 'lid', 'title', 'content', 'owner', 'updateAt', 'views', 'nReply','docType'
    ];

    static async generateNextDocId(domainId: string): Promise<number> {
        const lastDoc = await document.getMulti(domainId, document.TYPE_DOCS, {})
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();
        return (lastDoc[0]?.docId || 0) + 1;
    }

    static async generateNextLid(domainId: string): Promise<string> {
        const docs = await document.getMulti(domainId, document.TYPE_DOCS, {})
            .project({ lid: 1 })
            .toArray();
        
        const numbers = docs
            .map(doc => {
                const match = doc.lid?.match(/\d+/);
                return match ? parseInt(match[0], 10) : 0;
            })
            .filter(n => !isNaN(n));
        
        const maxNumber = Math.max(0, ...numbers);
        return `D${maxNumber + 1}`;
    }

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

    static async add(
        domainId: string, owner: number, title: string, content: string, ip?: string,
    ): Promise<string> {
        const docId = await DocsModel.generateNextDocId(domainId);
        return DocsModel.addWithId(domainId, docId, owner, title, content, ip);
    }

    static async get(domainId: string, lid: number | string): Promise<DocsDoc | null> {

        const docIdNumber = Number(lid);

        const query = !isNaN(docIdNumber) ? { docId: docIdNumber } : { lid: String(lid) };
    
        
    
        const res = await document.getMulti(domainId, document.TYPE_DOCS, query)
            .project(buildProjection(DocsModel.PROJECTION_PUBLIC))
            .limit(1)
            .toArray();
    
        if (!res.length) {
            
            return null;
        }
    
        
        return res[0] as DocsDoc;
    }
    
    

    static getMulti(domainId: string, query: Filter<DocsDoc> = {}, projection = DocsModel.PROJECTION_LIST) {
        return document.getMulti(domainId, document.TYPE_DOCS, query, projection).sort({ docId: -1 });
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

    static async edit(domainId: string, lid: string, updates: Partial<DocsDoc>): Promise<DocsDoc> {
        const doc = await document.getMulti(domainId, document.TYPE_DOCS, { lid }).next();
        if (!doc) throw new Error(`Document with lid=${lid} not found`);

        return document.set(domainId, document.TYPE_DOCS, doc.docId, updates);
    }

    static async del(domainId: string, lid: string): Promise<boolean> {
        const doc = await document.getMulti(domainId, document.TYPE_DOCS, { lid }).next();
        if (!doc) throw new Error(`Document with lid=${lid} not found`);

        await Promise.all([
            document.deleteOne(domainId, document.TYPE_DOCS, doc.docId),
            document.deleteMultiStatus(domainId, document.TYPE_DOCS, { docId: doc.docId }),
        ]);
        return true;
    }

    static async count(domainId: string, query: Filter<DocsDoc>) {
        return document.count(domainId, document.TYPE_DOCS, query);
    }

    static async getStatus(domainId: string, lid: string, uid: number) {
        return document.getStatus(domainId, document.TYPE_DOCS, lid, uid);
    }

    static async setStatus(domainId: string, lid: string, uid: number, updates) {
        return document.setStatus(domainId, document.TYPE_DOCS, lid, uid, updates);
    }

    static async getList(
        domainId: string, 
        docIds: number[],
        projection = DocsModel.PROJECTION_PUBLIC, 
        indexByDocIdOnly = false,
    ): Promise<DocsDict> {
        if (!docIds?.length) {
            return {};
        }

        const r: Record<number, DocsDoc> = {};
        const l: Record<string, DocsDoc> = {};

        const q: any = { docId: { $in: docIds } }; 

        let ddocs = await document.getMulti(domainId, document.TYPE_DOCS, q)
            .project<DocsDoc>(buildProjection(projection))
            .toArray();

        for (const ddoc of ddocs) {
            r[ddoc.docId] = ddoc;
            if (ddoc.lid) l[ddoc.lid] = ddoc;
        }

        return indexByDocIdOnly ? r : Object.assign(r, l);
    }

    static async inc(domainId: string, lid: string, key: NumberKeys<DocsDoc>, value: number): Promise<DocsDoc | null> {
        const doc = await document.getMulti(domainId, document.TYPE_DOCS, { lid }).next();
        if (!doc) throw new Error(`Document with lid=${lid} not found`);

        return document.inc(domainId, document.TYPE_DOCS, doc.docId, key, value);
    }
}

export function apply(ctx: Context) {}

global.Ejunz.model.doc = DocsModel;
export default DocsModel;

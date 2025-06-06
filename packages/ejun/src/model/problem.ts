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
import * as document from './document';
import DomainModel from './domain';
import RecordModel from './record';
// import SolutionModel from './solution';
import storage from './storage';
import * as SystemModel from './system';
import user from './user';

export interface ProblemDoc extends Document { }
export type Field = keyof ProblemDoc;

const logger = new Logger('problem');
function sortable(source: string) {
    return source.replace(/(\d+)/g, (str) => (str.length >= 6 ? str : ('0'.repeat(6 - str.length) + str)));
}

function findOverrideContent(dir: string, base: string) {
    let files = fs.readdirSync(dir);
    if (files.includes(`${base}.md`)) return fs.readFileSync(path.join(dir, `${base}.md`), 'utf8');
    const languages = {};
    files = files.filter((i) => new RegExp(`^${base}_[a-zA-Z_]+\\.md$`).test(i));
    if (!files.length) return null;
    for (const file of files) {
        const lang = file.slice(8, -3);
        let content: string | any[] = fs.readFileSync(path.join(dir, file), 'utf8');
        try {
            content = JSON.parse(content);
            if (!(content instanceof Array)) content = JSON.stringify(content);
        } catch (e) { }
        languages[lang] = content;
    }
    return JSON.stringify(languages);
}

interface ProblemImportOptions {
    preferredPrefix?: string;
    progress?: any;
    override?: boolean;
    operator?: number;
    delSource?: boolean;
}

interface ProblemCreateOptions {
    difficulty?: number;
    hidden?: boolean;
    reference?: { domainId: string, pid: number };
    associatedDocumentId?: number | null;
}

export class ProblemModel {
    static PROJECTION_CONTEST_LIST: Field[] = [
        '_id', 'domainId', 'docType', 'docId', 'pid',
        'owner', 'title','options', 'answer',
    ];

    static PROJECTION_LIST: Field[] = [
        ...ProblemModel.PROJECTION_CONTEST_LIST,
        'nSubmit', 'nAccept', 'difficulty', 'tag', 'hidden',
        'stats',
    ];

    static PROJECTION_CONTEST_DETAIL: Field[] = [
        ...ProblemModel.PROJECTION_CONTEST_LIST,
        'content', 'html', 'data', 'config', 'additional_file',
        'reference', 'maintainer',
    ];

    static PROJECTION_PUBLIC: Field[] = [
        ...ProblemModel.PROJECTION_LIST,
        'content', 'html', 'data', 'config', 'additional_file',
        'reference', 'maintainer','options', 'answer','associatedDocumentId'
    ];

    static default = {
        _id: new ObjectId(),
        domainId: 'system',
        docType: document.TYPE_PROBLEM,
        docId: 0,
        pid: '',
        owner: 1,
        title: '*',
        content: '',
        html: false,
        nSubmit: 0,
        nAccept: 0,
        tag: [],
        data: [],
        additional_file: [],
        stats: {},
        hidden: true,
        config: '',
        difficulty: 0,
        options: [],
        answer: null,
    };

    static deleted = {
        _id: new ObjectId(),
        domainId: 'system',
        docType: document.TYPE_PROBLEM,
        docId: -1,
        pid: null,
        owner: 1,
        title: '*',
        content: 'Deleted Problem',
        html: false,
        nSubmit: 0,
        nAccept: 0,
        tag: [],
        data: [],
        additional_file: [],
        stats: {},
        hidden: true,
        config: '',
        difficulty: 0,
    };

    static async add(
        domainId: string,
        pid: string = '',
        title: string,
        content: string,
        owner: number,
        tag: string[] = [],
        options: { label: string; value: string }[] = [], 
        answer: { label: string; value: string } | null = null, 
        meta: ProblemCreateOptions = {}
    ) {
        const [doc] = await ProblemModel.getMulti(domainId, {})
            .sort({ docId: -1 })
            .limit(1)
            .project({ docId: 1 })
            .toArray();
    
        const result = await ProblemModel.addWithId(
            domainId,
            (doc?.docId || 0) + 1,
            pid,
            title,
            content,
            owner,
            tag,
            options,
            answer, 
            meta
        );
        return result;
    }
    
    static async addWithId(
        domainId: string,
        docId: number,
        pid: string = '',
        title: string,
        content: string,
        owner: number,
        tag: string[] = [], // 标签字段
        options: { label: string; value: string }[] = [], // 选项字段
        answer: { label: string; value: string } | null = null, // 答案字段
        meta: ProblemCreateOptions = {}
    ) {
        const args: Partial<ProblemDoc> = {
            title,
            content,
            owner,
            tag,
            options, 
            answer, 
            hidden: meta.hidden || false,
            nSubmit: 0,
            nAccept: 0,
            sort: sortable(pid || `P${docId}`),
            difficulty: meta.difficulty || 1,
            associatedDocumentId: meta.associatedDocumentId ?? null,
        };
    
        if (pid) args.pid = pid;

        await bus.parallel('problem/before-add', domainId, content, owner, docId, args);
    
        const result = await document.add(
            domainId,
            content,
            owner,
            document.TYPE_PROBLEM,
            docId,
            null,
            null,
            args
        );

        await bus.emit('problem/add', args, result);
    
        return result;
    }
    
    

    static async get(
        domainId: string, pid: string | number,
        projection: Projection<ProblemDoc> = ProblemModel.PROJECTION_PUBLIC,
        rawConfig = false,
    ): Promise<ProblemDoc | null> {
        if (Number.isSafeInteger(+pid)) pid = +pid;
        const res = typeof pid === 'number'
            ? await document.get(domainId, document.TYPE_PROBLEM, pid, projection)
            : (await document.getMulti(domainId, document.TYPE_PROBLEM, { sort: sortable(pid), pid })
                .project(buildProjection(projection)).limit(1).toArray())[0];
        if (!res) return null;
        try {
            if (!rawConfig) res.config = await parseConfig(res.config);
        } catch (e) {
            res.config = `Cannot parse: ${e.message}`;
        }
        return res;
    }

    static getMulti(domainId: string, query: Filter<ProblemDoc>, projection = ProblemModel.PROJECTION_LIST) {
        return document.getMulti(domainId, document.TYPE_PROBLEM, query, projection).sort({ sort: 1 });
    }

    static async list(
        domainId: string, query: Filter<ProblemDoc>,
        page: number, pageSize: number,
        projection = ProblemModel.PROJECTION_LIST, uid?: number,
    ): Promise<[ProblemDoc[], number, number]> {
        const union = await DomainModel.get(domainId);
        const domainIds = [domainId, ...(union.union || [])];
        let count = 0;
        const pdocs = [];
        for (const id of domainIds) {
            // TODO enhance performance
            if (typeof uid === 'number') {
                // eslint-disable-next-line no-await-in-loop
                const udoc = await user.getById(id, uid);
                if (!udoc.hasPerm(PERM.PERM_VIEW_PROBLEM)) continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const ccount = await document.count(id, document.TYPE_PROBLEM, query);
            if (pdocs.length < pageSize && (page - 1) * pageSize - count <= ccount) {
                // eslint-disable-next-line no-await-in-loop
                pdocs.push(...await document.getMulti(id, document.TYPE_PROBLEM, query, projection)
                    .sort({ sort: 1, docId: 1 })
                    .skip(Math.max((page - 1) * pageSize - count, 0)).limit(pageSize - pdocs.length).toArray());
            }
            count += ccount;
        }
        return [pdocs, Math.ceil(count / pageSize), count];
    }

    static getStatus(domainId: string, docId: number, uid: number) {
        return document.getStatus(domainId, document.TYPE_PROBLEM, docId, uid);
    }

    static getMultiStatus(domainId: string, query: Filter<ProblemStatusDoc>) {
        return document.getMultiStatus(domainId, document.TYPE_PROBLEM, query);
    }

    static async edit(domainId: string, _id: number, $set: Partial<ProblemDoc>): Promise<ProblemDoc> {
        const delpid = $set.pid === '';
        if (delpid) {
            delete $set.pid;
            $set.sort = sortable(`P${_id}`);
        } else if ($set.pid) {
            $set.sort = sortable($set.pid);
        }
        await bus.parallel('problem/before-edit', $set);
        const result = await document.set(domainId, document.TYPE_PROBLEM, _id, $set, delpid ? { pid: '' } : undefined);
        await bus.emit('problem/edit', result);
        return result;
    }

    static async copy(domainId: string, _id: number, target: string, pid?: string) {
        const original = await ProblemModel.get(domainId, _id);
        if (!original) throw new ProblemNotFoundError(domainId, _id);
        if (original.reference) throw new ValidationError('reference');
        if (pid && (/^[0-9]+$/.test(pid) || await ProblemModel.get(target, pid))) pid = '';
        if (!pid && original.pid && !await ProblemModel.get(target, original.pid)) pid = original.pid;
        return await ProblemModel.add(
            target, pid, original.title, original.content,
            original.owner, original.tag, { hidden: original.hidden, reference: { domainId, pid: _id } },
        );
    }

    static push<T extends ArrayKeys<ProblemDoc>>(domainId: string, _id: number, key: ArrayKeys<ProblemDoc>, value: ProblemDoc[T][0]) {
        return document.push(domainId, document.TYPE_PROBLEM, _id, key, value);
    }

    static pull<T extends ArrayKeys<ProblemDoc>>(domainId: string, pid: number, key: ArrayKeys<ProblemDoc>, values: ProblemDoc[T][0][]) {
        return document.deleteSub(domainId, document.TYPE_PROBLEM, pid, key, values);
    }

    static inc(domainId: string, _id: number, field: NumberKeys<ProblemDoc> | string, n: number): Promise<ProblemDoc> {
        return document.inc(domainId, document.TYPE_PROBLEM, _id, field as any, n);
    }

    static count(domainId: string, query: Filter<ProblemDoc>) {
        return document.count(domainId, document.TYPE_PROBLEM, query);
    }

    static async del(domainId: string, docId: number) {
        await bus.parallel('problem/before-del', domainId, docId);
        const res = await Promise.all([
            document.deleteOne(domainId, document.TYPE_PROBLEM, docId),
            document.deleteMultiStatus(domainId, document.TYPE_PROBLEM, { docId }),
            storage.list(`problem/${domainId}/${docId}/`)
                .then((items) => storage.del(items.map((item) => `problem/${domainId}/${docId}/${item.name}`))),
            bus.parallel('problem/delete', domainId, docId),
        ]);
        await bus.emit('problem/del', domainId, docId);
        return !!res[0][0].deletedCount;
    }

    static async addTestdata(domainId: string, pid: number, name: string, f: Readable | Buffer | string, operator = 1) {
        name = name.trim();
        if (!name) throw new ValidationError('name');
        const [[, fileinfo]] = await Promise.all([
            document.getSub(domainId, document.TYPE_PROBLEM, pid, 'data', name),
            storage.put(`problem/${domainId}/${pid}/testdata/${name}`, f, operator),
        ]);
        const meta = await storage.getMeta(`problem/${domainId}/${pid}/testdata/${name}`);
        if (!meta) throw new FileUploadError();
        const payload = { name, ...pick(meta, ['size', 'lastModified', 'etag']) };
        payload.lastModified ||= new Date();
        if (!fileinfo) await ProblemModel.push(domainId, pid, 'data', { _id: name, ...payload });
        else await document.setSub(domainId, document.TYPE_PROBLEM, pid, 'data', name, payload);
        await bus.emit('problem/addTestdata', domainId, pid, name, payload);
    }

    static async renameTestdata(domainId: string, pid: number, file: string, newName: string, operator = 1) {
        if (file === newName) return;
        const [, sdoc] = await document.getSub(domainId, document.TYPE_PROBLEM, pid, 'data', newName);
        if (sdoc) await ProblemModel.delTestdata(domainId, pid, newName);
        const payload = { _id: newName, name: newName, lastModified: new Date() };
        await Promise.all([
            storage.rename(
                `problem/${domainId}/${pid}/testdata/${file}`,
                `problem/${domainId}/${pid}/testdata/${newName}`,
                operator,
            ),
            document.setSub(domainId, document.TYPE_PROBLEM, pid, 'data', file, payload),
        ]);
        await bus.emit('problem/renameTestdata', domainId, pid, file, newName);
    }

    static async delTestdata(domainId: string, pid: number, name: string | string[], operator = 1) {
        const names = (name instanceof Array) ? name : [name];
        await Promise.all([
            storage.del(names.map((t) => `problem/${domainId}/${pid}/testdata/${t}`), operator),
            ProblemModel.pull(domainId, pid, 'data', names),
        ]);
        await bus.emit('problem/delTestdata', domainId, pid, names);
    }

    static async addAdditionalFile(
        domainId: string, pid: number, name: string,
        f: Readable | Buffer | string, operator = 1, skipUpload = false,
    ) {
        name = name.trim();
        const [[, fileinfo]] = await Promise.all([
            document.getSub(domainId, document.TYPE_PROBLEM, pid, 'additional_file', name),
            skipUpload ? '' : storage.put(`problem/${domainId}/${pid}/additional_file/${name}`, f, operator),
        ]);
        const meta = await storage.getMeta(`problem/${domainId}/${pid}/additional_file/${name}`);
        const payload = { name, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!fileinfo) await ProblemModel.push(domainId, pid, 'additional_file', { _id: name, ...payload });
        else await document.setSub(domainId, document.TYPE_PROBLEM, pid, 'additional_file', name, payload);
        await bus.emit('problem/addAdditionalFile', domainId, pid, name, payload);
    }

    static async renameAdditionalFile(domainId: string, pid: number, file: string, newName: string, operator = 1) {
        if (file === newName) return;
        const [, sdoc] = await document.getSub(domainId, document.TYPE_PROBLEM, pid, 'additional_file', newName);
        if (sdoc) await ProblemModel.delAdditionalFile(domainId, pid, newName);
        const payload = { _id: newName, name: newName, lastModified: new Date() };
        await Promise.all([
            storage.rename(
                `problem/${domainId}/${pid}/additional_file/${file}`,
                `problem/${domainId}/${pid}/additional_file/${newName}`,
                operator,
            ),
            document.setSub(domainId, document.TYPE_PROBLEM, pid, 'additional_file', file, payload),
        ]);
        await bus.emit('problem/renameAdditionalFile', domainId, pid, file, newName);
    }

    static async delAdditionalFile(domainId: string, pid: number, name: MaybeArray<string>, operator = 1) {
        const names = (name instanceof Array) ? name : [name];
        await Promise.all([
            storage.del(names.map((t) => `problem/${domainId}/${pid}/additional_file/${t}`), operator),
            ProblemModel.pull(domainId, pid, 'additional_file', names),
        ]);
        await bus.emit('problem/delAdditionalFile', domainId, pid, names);
    }

    static async random(domainId: string, query: Filter<ProblemDoc>) {
        const pcount = await document.count(domainId, document.TYPE_PROBLEM, query);
        if (!pcount) return null;
        const pdoc = await document.getMulti(domainId, document.TYPE_PROBLEM, query)
            .skip(Math.floor(Math.random() * pcount)).limit(1).toArray();
        return pdoc[0].pid || pdoc[0].docId;
    }

    static async getList(
        domainId: string, pids: number[], canViewHidden: number | boolean = false,
        doThrow = true, projection = ProblemModel.PROJECTION_PUBLIC, indexByDocIdOnly = false,
    ): Promise<ProblemDict> {
        if (!pids?.length) return {};
        const r: Record<number, ProblemDoc> = {};
        const l: Record<string, ProblemDoc> = {};
        const q: any = { docId: { $in: pids } };
        let pdocs = await document.getMulti(domainId, document.TYPE_PROBLEM, q)
            .project<ProblemDoc>(buildProjection(projection)).toArray();
        if (canViewHidden !== true) {
            pdocs = pdocs.filter((i) => i.owner === canViewHidden || i.maintainer?.includes(canViewHidden as any) || !i.hidden);
        }
        for (const pdoc of pdocs) {
            try {
                // eslint-disable-next-line no-await-in-loop
                pdoc.config = await parseConfig(pdoc.config as string);
            } catch (e) {
                pdoc.config = `Cannot parse: ${e.message}`;
            }
            r[pdoc.docId] = pdoc;
            if (pdoc.pid) l[pdoc.pid] = pdoc;
        }
        // TODO enhance
        if (pdocs.length !== pids.length) {
            for (const pid of pids) {
                if (!(r[pid] || l[pid])) {
                    if (doThrow) throw new ProblemNotFoundError(domainId, pid);
                    if (!indexByDocIdOnly) r[pid] = { ...ProblemModel.default, domainId, pid: pid.toString() };
                }
            }
        }
        return indexByDocIdOnly ? r : Object.assign(r, l);
    }

    static async getListStatus(domainId: string, uid: number, pids: number[]) {
        const psdocs = await ProblemModel.getMultiStatus(
            domainId, { uid, docId: { $in: Array.from(new Set(pids)) } },
        ).toArray();
        const r: Record<string, ProblemStatusDoc> = {};
        for (const psdoc of psdocs) {
            r[psdoc.docId] = psdoc;
            r[`${psdoc.domainId}#${psdoc.docId}`] = psdoc;
        }
        return r;
    }

    static async updateStatus(
        domainId: string, pid: number, uid: number,
        rid: ObjectId, status: number, score: number,
    ) {
        const filter: Filter<ProblemStatusDoc> = { rid: { $ne: rid }, status: STATUS.STATUS_ACCEPTED };
        const res = await document.setStatusIfNotCondition(
            domainId, document.TYPE_PROBLEM, pid, uid,
            filter, { rid, status, score },
        );
        return !!res;
    }

    static async incStatus(
        domainId: string, pid: number, uid: number,
        key: NumberKeys<ProblemStatusDoc>, count: number,
    ) {
        return await document.incStatus(domainId, document.TYPE_PROBLEM, pid, uid, key, count);
    }

    static setStar(domainId: string, pid: number, uid: number, star: boolean) {
        return document.setStatus(domainId, document.TYPE_PROBLEM, pid, uid, { star });
    }

    static canViewBy(pdoc: ProblemDoc, udoc: User) {
        if (!udoc.hasPerm(PERM.PERM_VIEW_PROBLEM)) return false;
        if (udoc.own(pdoc)) return true;
        if (udoc.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) return true;
        if (pdoc.hidden) return false;
        return true;
    }

    static async import(domainId: string, filepath: string, options: ProblemImportOptions = {}) {
        let tmpdir = '';
        if (typeof options !== 'object') {
            logger.warn('ProblemModel.import: options should be an object');
            options = {};
        }
        const {
            preferredPrefix, progress, override = false, operator = 1,
        } = options;
        let problems: string[];
        try {
            if (filepath.endsWith('.zip')) {
                tmpdir = path.join(os.tmpdir(), 'ejunz', `${Math.random()}.import`);
                let zip: AdmZip;
                try {
                    zip = new AdmZip(filepath);
                } catch (e) {
                    throw new ValidationError('zip', null, e.message);
                }
                await new Promise((resolve, reject) => {
                    zip.extractAllToAsync(tmpdir, true, (err) => {
                        if (err) reject(err);
                        resolve(null);
                    });
                });
            } else if (fs.statSync(filepath).isDirectory()) {
                tmpdir = filepath;
            } else {
                throw new ValidationError('file', null, 'Invalid file');
            }
            const files = await fs.readdir(tmpdir, { withFileTypes: true });
            problems = files.filter((f) => f.isDirectory()).map((i) => i.name);
        } finally {
            if (options.delSource) await fs.remove(tmpdir);
        }
        for (const i of problems) {
            try {
                if (process.env.EJUNZ_CLI) logger.info(`Importing problem ${i}`);
                const files = await fs.readdir(path.join(tmpdir, i), { withFileTypes: true });
                if (!files.find((f) => f.name === 'problem.yaml')) continue;
                const content = fs.readFileSync(path.join(tmpdir, i, 'problem.yaml'), 'utf-8');
                const pdoc: ProblemDoc = yaml.load(content) as any;
                if (!pdoc) continue;
                let pid = pdoc.pid;
                let overridePid = null;

                const isValidPid = async (id: string) => {
                    if (!(/^[A-Za-z]+[0-9A-Za-z]*$/.test(id))) return false;
                    const doc = await ProblemModel.get(domainId, id);
                    if (doc) {
                        if (!override) return false;
                        overridePid = doc.docId;
                        return true;
                    }
                    return true;
                };
                const getFiles = async (type: string) => {
                    if (!files.find((f) => f.name === type && f.isDirectory())) return [];
                    const rs = await fs.readdir(path.join(tmpdir, i, type), { withFileTypes: true });
                    return rs.map((r) => [r, path.join(tmpdir, i, type, r.name)] as [fs.Dirent, string]);
                };

                if (pid) {
                    if (preferredPrefix) {
                        const newPid = pid.replace(/^[A-Za-z]+/, preferredPrefix);
                        if (await isValidPid(newPid)) pid = newPid;
                    }
                    if (!await isValidPid(pid)) pid = undefined;
                }
                const overrideContent = findOverrideContent(path.join(tmpdir, i), 'problem');
                if (pdoc.difficulty && !Number.isSafeInteger(pdoc.difficulty)) delete pdoc.difficulty;
                if (typeof pdoc.title !== 'string') throw new ValidationError('title', null, 'Invalid title');
                const allFiles = [...await getFiles('testdata'), ...await getFiles('additional_file')];
                const totalSize = allFiles.map((f) => fs.statSync(f[1]).size).reduce((a, b) => a + b, 0);
                if (allFiles.length > SystemModel.get('limit.problem_files')) throw new ValidationError('files', null, 'Too many files');
                if (totalSize > SystemModel.get('limit.problem_files_size')) throw new ValidationError('files', null, 'Files too large');
                const tag = (pdoc.tag || []).map((t) => t.toString());
                const docId = overridePid
                    ? (await ProblemModel.edit(domainId, overridePid, {
                        title: pdoc.title.trim(),
                        content: overrideContent || pdoc.content || 'No content',
                        tag,
                        difficulty: pdoc.difficulty,
                    })).docId
                    : await ProblemModel.add(
                        domainId, pid, pdoc.title.trim(), overrideContent || pdoc.content || 'No content',
                        operator || pdoc.owner, tag, { hidden: pdoc.hidden, difficulty: pdoc.difficulty },
                    );
                // TODO delete unused file when updating pdoc
                for (const [f, loc] of await getFiles('testdata')) {
                    if (f.isDirectory()) {
                        const sub = await fs.readdir(loc);
                        for (const s of sub) await ProblemModel.addTestdata(domainId, docId, s, path.join(tmpdir, i, 'testdata', f.name, s));
                    } else if (f.isFile()) await ProblemModel.addTestdata(domainId, docId, f.name, loc);
                }
                for (const [f, loc] of await getFiles('additional_file')) {
                    if (!f.isFile()) continue;
                    await ProblemModel.addAdditionalFile(domainId, docId, f.name, loc);
                }
                for (const [f, loc] of await getFiles('solution')) {
                    if (!f.isFile()) continue;
                    await SolutionModel.add(domainId, docId, operator, await fs.readFile(loc, 'utf-8'));
                }
                let count = 0;
                for (const [f, loc] of await getFiles('std')) {
                    if (!f.isFile()) continue;
                    count++;
                    if (count > 5) continue;
                    await RecordModel.add(domainId, docId, operator, f.name.split('.')[1], await fs.readFile(loc, 'utf-8'), true);
                }
                const message = `${overridePid ? 'Updated' : 'Imported'} problem ${pdoc.pid} (${pdoc.title})`;
                (process.env.EJUNZ_CLI ? logger.info : progress)?.(message);
            } catch (e) {
                (process.env.EJUNZ_CLI ? logger.info : progress)?.(`Error importing problem ${i}: ${e.message}`);
            }
        }
        if (options.delSource) await fs.remove(tmpdir);
    }

    static async export(domainId: string) {
        const tmpdir = path.join(os.tmpdir(), 'ejunz', `${Math.random()}.export`);
        await fs.mkdir(tmpdir);
        const pdocs = await ProblemModel.getMulti(domainId, {}, ProblemModel.PROJECTION_PUBLIC).toArray();
        for (const pdoc of pdocs) {
            if (process.env.EJUNZ_CLI) logger.info(`Exporting problem ${pdoc.pid || (`P${pdoc.docId}`)} (${pdoc.title})`);
            const problemPath = path.join(tmpdir, `${pdoc.docId}`);
            await fs.mkdir(problemPath);
            const problemYaml = path.join(problemPath, 'problem.yaml');
            const problemYamlContent = yaml.dump({
                pid: pdoc.pid || `P${pdoc.docId}`,
                owner: pdoc.owner,
                title: pdoc.title,
                tag: pdoc.tag,
                nSubmit: pdoc.nSubmit,
                nAccept: pdoc.nAccept,
                difficulty: pdoc.difficulty,
            });
            await fs.writeFile(problemYaml, problemYamlContent);
            try {
                const c = JSON.parse(pdoc.content);
                for (const key of Object.keys(c)) {
                    const problemContent = path.join(problemPath, `problem_${key}.md`);
                    await fs.writeFile(problemContent, typeof c[key] === 'string' ? c[key] : JSON.stringify(c[key]));
                }
            } catch (e) {
                const problemContent = path.join(problemPath, 'problem.md');
                await fs.writeFile(problemContent, pdoc.content);
            }
            if ((pdoc.data || []).length) {
                const testdataPath = path.join(problemPath, 'testdata');
                await fs.mkdir(testdataPath);
                for (const file of pdoc.data) {
                    const stream = await storage.get(`problem/${domainId}/${pdoc.docId}/testdata/${file.name}`);
                    const buf = await streamToBuffer(stream);
                    const testdataFile = path.join(testdataPath, file.name);
                    await fs.writeFile(testdataFile, buf);
                }
            }
            if ((pdoc.additional_file || []).length) {
                const additionalPath = path.join(problemPath, 'additional_file');
                await fs.mkdir(additionalPath);
                for (const file of pdoc.additional_file) {
                    const stream = await storage.get(`problem/${domainId}/${pdoc.docId}/additional_file/${file.name}`);
                    const buf = await streamToBuffer(stream);
                    const additionalFile = path.join(additionalPath, file.name);
                    await fs.writeFile(additionalFile, buf);
                }
            }
        }
        const target = `${process.cwd()}/problem-${domainId}-${new Date().toISOString().replace(':', '-').split(':')[0]}.zip`;
        const res = child.spawnSync('zip', ['-r', target, '.'], { cwd: tmpdir, stdio: 'inherit' });
        if (res.error) throw res.error;
        if (res.status) throw new Error(`Error: Exited with code ${res.status}`);
        const stat = fs.statSync(target);
    }
}

export function apply(ctx: Context) {
    ctx.on('problem/addTestdata', async (domainId, docId, name) => {
        if (!['config.yaml', 'config.yml', 'Config.yaml', 'Config.yml'].includes(name)) return;
        const buf = await storage.get(`problem/${domainId}/${docId}/testdata/${name}`);
        await ProblemModel.edit(domainId, docId, { config: (await streamToBuffer(buf)).toString() });
    });
    ctx.on('problem/delTestdata', async (domainId, docId, names) => {
        if (!names.includes('config.yaml')) return;
        await ProblemModel.edit(domainId, docId, { config: '' });
    });
    ctx.on('problem/renameTestdata', async (domainId, docId, file, newName) => {
        if (['config.yaml', 'config.yml', 'Config.yaml', 'Config.yml'].includes(file)) {
            await ProblemModel.edit(domainId, docId, { config: '' });
        }
        if (['config.yaml', 'config.yml', 'Config.yaml', 'Config.yml'].includes(newName)) {
            const buf = await storage.get(`problem/${domainId}/${docId}/testdata/${newName}`);
            await ProblemModel.edit(domainId, docId, { config: (await streamToBuffer(buf)).toString() });
        }
    });
}

global.Ejunz.model.problem = ProblemModel;
export default ProblemModel;

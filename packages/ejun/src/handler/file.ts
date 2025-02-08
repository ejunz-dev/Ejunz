import AdmZip from 'adm-zip';
import { readFile, statSync } from 'fs-extra';
import {
    escapeRegExp, flattenDeep, intersection, pick,
} from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import type { Context } from '../context';
import {
    BadRequestError, ContestNotAttendedError, ContestNotEndedError, ContestNotFoundError, ContestNotLiveError,
    FileLimitExceededError, HackFailedError, NoProblemError, NotFoundError,
    PermissionError, ProblemAlreadyExistError, ProblemAlreadyUsedByContestError, ProblemConfigError,
    ProblemIsReferencedError, ProblemNotAllowLanguageError, ProblemNotAllowPretestError, ProblemNotFoundError,
    RecordNotFoundError, SolutionNotFoundError, ValidationError,DiscussionNotFoundError
} from '../error';
import {
    Handler, param, post, query, route, Types,
} from '../service/server';
import { ContestDetailBaseHandler } from './contest';
import storage from '../model/storage';
import Repo from '../model/repo';
import { PERM, PRIV, STATUS } from '../model/builtin';
import { lookup } from 'mime-types';
import { encodeRFC5987ValueChars } from '../service/storage';
import { RepoDoc } from '../interface';
import domain from '../model/domain';
import { User } from '../model/user';
import * as system from '../model/system';
import parser from '@ejunz/utils/lib/search';
import { RepoSearchOptions } from '../interface';
import { QueryContext } from './repo';
import * as document from '../model/document';
import * as file from '../model/file';
import { FileDoc } from '../interface';
import user from '../model/user';
import { isSafeInteger } from 'lodash';
export const parseCategory = (value: string) => value.replace(/，/g, ',').split(',').map((e) => e.trim());

export const typeMapper = {
    problem: document.TYPE_PROBLEM,
    contest: document.TYPE_CONTEST,
    node: document.TYPE_FILE_NODE,
    training: document.TYPE_TRAINING,
    homework: document.TYPE_CONTEST,
    docs: document.TYPE_DOCS,
};

function buildQuery(udoc: User) {
    const q: Filter<RepoDoc> = {};
    if (!udoc.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) {
        q.$or = [
            { hidden: false },
            { owner: udoc._id },
            { maintainer: udoc._id },
        ];
    }
    return q;
}

const defaultSearch = async (domainId: string, q: string, options?: RepoSearchOptions) => {
    const escaped = escapeRegExp(q.toLowerCase());
    const projection: (keyof RepoDoc)[] = ['domainId', 'docId', 'rid'];
    const $regex = new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gmi');
    const filter = { $or: [{ rid: { $regex } }, { title: { $regex } }, { tag: q }] };
    const rdocs = await Repo.getMulti(domainId, filter, projection)
        .skip(options.skip || 0).limit(options.limit || system.get('pagination.problem')).toArray();
    if (!options.skip) {
        let rdoc = await Repo.get(domainId, Number.isSafeInteger(+q) ? +q : q, projection);
        if (rdoc) rdocs.unshift(rdoc);
        else if (/^R\d+$/.test(q)) {
            rdoc = await Repo.get(domainId, +q.substring(1), projection);
            if (rdoc) rdocs.unshift(rdoc);
        }
    }
    return {
        hits: Array.from(new Set(rdocs.map((i) => `${i.domainId}/${i.docId}`))),
        total: Math.max(rdocs.length, await Repo.count(domainId, filter)),
        countRelation: 'eq',
    };
};

class FileHandler extends Handler {
    ddoc?: FileDoc;
    vnode?: any;

    @param('type', Types.Range(Object.keys(typeMapper)), true)
    @param('name', Types.String, true)
    @param('did', Types.ObjectId, true)
    async _prepare(
        domainId: string, type: string, name: string,
        did: ObjectId,
    ) {
        this.checkPerm(PERM.PERM_VIEW_PROBLEM);
        if (did) {
            this.ddoc = await file.get(domainId, did);
            if (!this.ddoc) throw new NotFoundError(domainId, did);
            type = file.typeDisplay[this.ddoc.parentType];
            name = this.ddoc.parentId.toString();
            }
        
        // TODO(twd2): exclude problem/contest discussions?
        // TODO(iceboy): continuation based pagination.
        this.vnode = await file.getVnode(domainId, typeMapper[type], name, this.user._id);
        if (!file.checkVNodeVisibility(typeMapper[type], this.vnode, this.user)) throw new NotFoundError(this.vnode.id);
        if (this.ddoc) {
            this.ddoc.parentType ||= this.vnode.type;
            this.ddoc.parentId ||= this.vnode.id;
        }
    }
}

class FileMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('all', Types.Boolean)
    async get(domainId: string, page = 1, all = false) {
        console.log('Resolved domainId:', domainId);
    console.log('Request headers:', this.request.headers);
    console.log('Request query:', this.request.query);
    console.log('Context domain:', this.context.EjunzContext.domain);

        // Limit to known types
        const parentType = { $in: Object.keys(typeMapper).map((i) => typeMapper[i]) };
        all &&= this.user.hasPerm(PERM.PERM_MOD_BADGE);
        const [ddocs, dpcount] = await this.paginate(
            file.getMulti(domainId, { parentType, ...all ? {} : { hidden: false } }),
            page,
            'file',
        );
        const udict = await user.getList(domainId, ddocs.map((ddoc) => ddoc.owner));
        const [vndict, vnodes] = await Promise.all([
            file.getListVnodes(domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group),
            file.getNodes(domainId),
        ]);
        this.response.template = 'file_main_or_node.html';
        this.response.body = {
            ddocs, dpcount, udict, page, page_name: 'file_main', vndict, vnode: {}, vnodes,
        };
        console.log('response',this.response.body)
    }
}

class FileNodeHandler extends FileHandler {
    @param('type', Types.Range(Object.keys(typeMapper)))
    @param('name', Types.String)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, type: string, _name: string, page = 1) {
        let name: ObjectId | string | number;
        if (ObjectId.isValid(_name)) name = new ObjectId(_name);
        else if (isSafeInteger(parseInt(_name, 10))) name = parseInt(_name, 10);
        else name = _name;
        const hidden = this.user.own(this.vnode) || this.user.hasPerm(PERM.PERM_EDIT_DISCUSSION) ? {} : { hidden: false };
        const [ddocs, dpcount] = await this.paginate(
            file.getMulti(domainId, { parentType: typeMapper[type], parentId: name, ...hidden }),
            page,
            'file',
        );
        const uids = ddocs.map((ddoc) => ddoc.owner);
        uids.push(this.vnode.owner);
        const [udict, vnodes] = await Promise.all([
            user.getList(domainId, uids),
            file.getNodes(domainId),
        ]);
        const vndict = { [typeMapper[type]]: { [name.toString()]: this.vnode } };
        this.response.template = 'file_main_or_node.html';
        this.response.body = {
            ddocs,
            dpcount,
            udict,
            page,
            vndict,
            vnode: this.vnode,
            page_name: 'file_node',
            vnodes,
        };
        console.log('response',this.response.body)
    }
}
class FileCreateHandler extends FileHandler {
    async get({ type, name }) {
        // 强制转换 name 为数字
        const resolvedName = typeof name === 'string' ? parseInt(name, 10) : name;
        if (isNaN(resolvedName)) {
            throw new Error(`Invalid name (lid): ${name}`);
        }

        console.log('Resolved name (lid):', resolvedName, 'Type:', typeof resolvedName);

        const path = [
            ['Ejunz', 'homepage'],
            ['file_main', 'file_main'],
            [this.vnode.title, 'file_node', { type, name: resolvedName }, true],
            ['file_create', null],
        ];

        this.response.template = 'file_create.html';
        this.response.body = { path, vnode: this.vnode };
        console.log('ddoc:', this.ddoc);
console.log('vnode:', this.vnode);
    }

    @param('type', Types.Range(Object.keys(typeMapper)))
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('highlight', Types.Boolean)
    @param('pin', Types.Boolean)
    async post(
        domainId: string, type: string, title: string,
        content: string, highlight = false, pin = false,
    ) {
        await this.limitRate('add_file', 3600, 60);

        if (highlight) this.checkPerm(PERM.PERM_HIGHLIGHT_DISCUSSION);
        if (pin) this.checkPerm(PERM.PERM_PIN_DISCUSSION);

        // 确保 vnode.id 是数字
        let resolvedId = this.vnode.id;
        if (typeof resolvedId === 'string') {
            resolvedId = parseInt(resolvedId, 10);
        }
        if (isNaN(resolvedId)) {
            throw new Error(`Invalid vnode.id: ${this.vnode.id}`);
        }

        console.log('Resolved vnode.id:', resolvedId, 'Type:', typeof resolvedId);

        const hidden = this.vnode.hidden ?? false;
        const did = await file.add(
            domainId, typeMapper[type], resolvedId, this.user._id,
            title, content, this.request.ip, highlight, pin, hidden,
        );

        this.response.body = { did };
        this.response.redirect = this.url('file_detail', { did });

console.log('vnode:', this.vnode);


    }
}


class FileDetailHandler extends FileHandler {
    @param('did', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, did: ObjectId, page = 1) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await file.getStatus(domainId, did, this.user._id)
            : null;
        const [drdocs, pcount, drcount] = await this.paginate(
            file.getMultiReply(domainId, did),
            page,
            'reply',
        );
        const uids = [
            ...this.vnode.owner ? [this.vnode.owner] : [],
            this.ddoc.owner,
            ...drdocs.map((drdoc) => drdoc.owner),
        ];
        for (const drdoc of drdocs) {
            if (drdoc.reply) uids.push(...drdoc.reply.map((drrdoc) => drrdoc.owner));
        }
        const reactions = { [did.toHexString()]: dsdoc?.react || {} };
        await Promise.all(drdocs.map((drdoc) =>
            discussion.getReaction(domainId, document.TYPE_DISCUSSION_REPLY, drdoc._id, this.user._id).then((reaction) => {
                reactions[drdoc._id.toHexString()] = reaction;
            })));
        const udict = await user.getList(domainId, uids);
        if (!dsdoc?.view && this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            await Promise.all([
                discussion.inc(domainId, did, 'views', 1),
                discussion.setStatus(domainId, did, this.user._id, { view: true }),
            ]);
        }
        const path = [
            ['Ejunz', 'homepage'],
            ['discussion_main', 'discussion_main'],
            [this.vnode.title, 'discussion_node', { type: discussion.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId }, true],
            [this.ddoc.title, null, null, true],
        ];
        this.response.template = 'discussion_detail.html';
        this.response.body = {
            path, ddoc: this.ddoc, dsdoc, drdocs, page, pcount, drcount, udict, vnode: this.vnode, reactions,
        };
        console.log('typeDisplay',{ type: discussion.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId })
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

}

class FileEditHandler extends FileHandler {
    async get() {
        const path = [
            ['Ejunz', 'homepage'],
            ['file_main', 'file_main'],
            [this.vnode.title, 'file_node', { type: file.typeDisplay[this.ddoc.parentType], name: this.ddoc.parentId }, true],
            [this.ddoc.title, 'file_detail', { did: this.ddoc.docId }, true],
            ['file_edit', null],
        ];
        this.response.template = 'file_edit.html';
        this.response.body = { ddoc: this.ddoc, path };
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('highlight', Types.Boolean)
    @param('pin', Types.Boolean)
    async postUpdate(
        domainId: string, did: ObjectId, title: string, content: string,
        highlight = false, pin = false,
    ) {
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        else this.checkPerm(PERM.PERM_EDIT_DISCUSSION_SELF);
        if (!this.user.hasPerm(PERM.PERM_HIGHLIGHT_DISCUSSION)) highlight = this.ddoc.highlight;
        if (!this.user.hasPerm(PERM.PERM_PIN_DISCUSSION)) pin = this.ddoc.pin;
        const hidden = this.vnode.hidden ?? false;
        await Promise.all([
            file.edit(domainId, did, {
                title, highlight, pin, content, editor: this.user._id, edited: true, hidden,
            }),
            oplog.log(this, 'file.edit', this.ddoc),
        ]);
        this.response.body = { did };
        this.response.redirect = this.url('file_detail', { did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {
        const deleteBy = this.user.own(this.ddoc) ? 'self' : 'Admin';
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        else this.checkPerm(PERM.PERM_DELETE_DISCUSSION_SELF);
        const msg = JSON.stringify({
            message: 'Admin {0} delete your discussion "{1}".',
            params: [
                this.user.uname,
                this.ddoc.title,
            ],
        });
        await Promise.all([
            oplog.log(this, 'file.delete', this.ddoc),
            deleteBy !== 'self' && message.send(1, this.ddoc.owner, msg, message.FLAG_RICHTEXT | message.FLAG_UNREAD),
            file.del(domainId, did),
        ]);
        this.response.body = { type: this.ddoc.parentType, parent: this.ddoc.parentId };
        this.response.redirect = this.url('file_node', {
            type: file.typeDisplay[this.ddoc.parentType],
            name: this.ddoc.parentId,
        });
    }
}

export class RepoAddFileHandler extends Handler {
    @param('rid', Types.RepoId, true) 
    async get(domainId: string, rid: string) {
        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        this.response.template = 'repo_add_file.html';
        this.response.body = {
            ddoc: repo,
            domainId,
        };
    }

    @param('rid', Types.RepoId, true)
    @param('filename', Types.String, true)
    @param('version', Types.String, true)
    @post('tag', Types.Content, true, null, parseCategory)
    async post(domainId: string, rid: string, filename: string, version?: string, tag: string[] = []) {
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('A file must be uploaded.');

        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        const docId = repo.docId;
        if (typeof docId !== 'number') {
            throw new Error(`Expected docId to be a number, but got ${typeof docId}`);
        }

        const filePath = `repo/${domainId}/${docId}/${filename}`;
        await storage.put(filePath, file.filepath, this.user._id);
        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) throw new ValidationError(`Failed to retrieve metadata for the uploaded file: ${filename}`);

        const fileData = {
            filename,
            version: repo.isIterative ? version : undefined,
            path: filePath, 
            size: fileMeta.size ?? 0,
            lastModified: fileMeta.lastModified ?? new Date(),
            etag: fileMeta.etag ?? '',
            tag: tag,
        };

        if (repo.isIterative) {
            await Repo.addVersion(
                domainId,
                repo.docId,
                fileData.filename,
                fileData.version,
                fileData.path,
                fileData.size,
                fileData.lastModified,
                fileData.etag,
                fileData.tag
            );
        } else {
            await Repo.addFile(
                domainId,
                repo.docId,
                fileData.filename,
                fileData.path,
                fileData.size,
                fileData.lastModified,
                fileData.etag,
                fileData.tag
            );
        }

        console.log('File added successfully:', fileData);

        this.response.redirect = this.url('repo_detail', { domainId, rid });
    }
}
export class RepoFileHandler extends Handler {
    queryContext: QueryContext = {
        query: {},
        sort: [],
        pcountRelation: 'eq',
        parsed: null,
        category: [],
        text: '',
        total: 0,
        fail: false,
    };

    @param('rid', Types.RepoId, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('limit', Types.PositiveInt, true)
    @param('pjax', Types.Boolean)
    @param('quick', Types.Boolean)
    async get(domainId: string, rid: string, page = 1, q = '', limit: number, pjax = false, quick = false) {
        this.response.template = 'repo_history.html';
        if (!limit || limit > this.ctx.setting.get('pagination.problem') || page > 1) limit = this.ctx.setting.get('pagination.problem');
        
        console.log('Initial Query Context:', this.queryContext);

        this.queryContext.query = buildQuery(this.user);
        this.queryContext.query.rid = rid;
        console.log('Query after buildQuery:', this.queryContext.query);

        const query = this.queryContext.query;
        const psdict = {};
        const search = global.Ejunz.lib.problemSearch || defaultSearch;
        const parsed = parser.parse(q, {
            keywords: ['category', 'difficulty'],
            offsets: false,
            alwaysArray: true,
            tokenize: true,
        });

        const category = parsed.category || [];
        const text = (parsed.text || []).join(' ');
        console.log('Parsed Query:', { category, text });

        if (parsed.difficulty?.every((i) => Number.isSafeInteger(+i))) {
            query.difficulty = { $in: parsed.difficulty.map(Number) };
        }
        if (category.length) query.$and = category.map((tag) => ({ tag }));
        if (text) category.push(text);
        if (category.length) this.UiContext.extraTitleContent = category.join(',');

        let total = 0;
        if (text) {
            const result = await search(domainId, q, { skip: (page - 1) * limit, limit });
            total = result.total;
            this.queryContext.pcountRelation = result.countRelation;
            if (!result.hits.length) this.queryContext.fail = true;
            query.$and ||= [];
            query.$and.push({
                $or: result.hits.map((i) => {
                    const [did, docId] = i.split('/');
                    return { domainId: did, docId: +docId };
                }),
            });
            this.queryContext.sort = result.hits;
        }

        console.log('Final Query Context:', this.queryContext);

        const sort = this.queryContext.sort;
        await this.ctx.parallel('repofile/list', query, this, sort);

        let [docs, ppcount, pcount] = this.queryContext.fail
        ? [[], 0, 0]
        : await Repo.listFiles(
            domainId, 
            query, 
            sort.length ? 1 : page, 
            limit,
            quick 
                ? ['title', 'rid', 'domainId', 'docId', 'files'] // 只投影到顶级属性
                : undefined,
            this.user._id,
        );
        console.log('docs', docs);
    
        // 提取文件信息
        const files = docs.flatMap(doc => doc.files.map(file => ({
            ...file,
            domainId: doc.domainId,
            docId: doc.docId,
            rid: doc.rid,
            title: doc.title,
        }))).filter(file => file.rid === rid); // 过滤出特定 rid 的文件
        console.log('files', files);

        if (total) {
            pcount = total;
            ppcount = Math.ceil(total / limit);
        }
        if (sort.length) docs = docs.sort((a, b) => sort.indexOf(`${a.domainId}/${a.docId}`) - sort.indexOf(`${b.domainId}/${b.docId}`));
        if (text && pcount > docs.length) pcount = docs.length;

       

        if (pjax) {
            this.response.body = {
                title: this.renderTitle(this.translate('repo_history')),
                fragments: (await Promise.all([
                    this.renderHTML('partials/repo_file_list.html', {
                        page, ppcount, pcount, files, psdict, qs: q,
                    }),
                ])).map((i) => ({ html: i })),
            };
        } else {
            this.response.body = {
                rid,
                page,
                pcount,
                ppcount,
                pcountRelation: this.queryContext.pcountRelation,
                files,
                psdict,
                qs: q,
            };
            console.log('rid', rid);
        }
    }
}   

export class RepoHistoryHandler extends Handler {
    @param('rid', Types.RepoId, true) 
    async get(domainId: string, rid: string) {
        console.log(`[RepoHistoryHandler] Querying repository with rid=${rid}`);

        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) {
            console.error(`[RepoHistoryHandler] Repository not found for RID: ${rid}`);
            throw new NotFoundError(`Repository not found for RID: ${rid}`);
        }

        const repoRid = repo.rid ?? String(repo.docId);
        console.log(`[RepoHistoryHandler] Using rid=${repoRid}`);

        const sortedFiles = (repo.files || [])
            .map(file => ({
                ...file,
                lastModified: new Date(file.lastModified),
                tag: file.tag || []
            }))
            .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

        if (!sortedFiles.length) {
            console.warn(`[RepoHistoryHandler] No files found in repo=${repoRid}`);
            throw new NotFoundError('No files found in the repository.');
        }

        this.response.template = 'repo_history.html';
        this.response.body = {
            ddoc: repo,
            domainId,
            rid: repoRid, 
            files: sortedFiles,
            urlForFile: (filename: string) => this.url('repo_file_download', { domainId, rid: repoRid, filename }), // ✅ 确保 rid 是字符串
        };
        console.log('files', sortedFiles);
        console.log('repo', repo);
    }
}

export class RepofileDownloadHandler extends Handler {
    async get({ rid, filename }: { rid: string; filename: string }) {
        const domainId = this.context.domainId || 'default_domain';

        const repo = await Repo.getByRid(domainId, rid);
        if (!repo) throw new NotFoundError(`Repository not found for RID: ${rid}`);

        const docId = repo.docId ?? rid;  
        const filePath = `repo/${domainId}/${docId}/${filename}`;

        console.log(`[RepofileDownloadHandler] Checking filePath=${filePath}`);

        const fileMeta = await storage.getMeta(filePath);
        if (!fileMeta) throw new NotFoundError(`File "${filename}" does not exist in repository "${rid}".`);

        this.response.body = await storage.get(filePath);
        this.response.type = lookup(filename) || 'application/octet-stream';

        if (!['application/pdf', 'image/jpeg', 'image/png'].includes(this.response.type)) {
            this.response.disposition = `attachment; filename="${encodeRFC5987ValueChars(filename)}"`;
        }
    }
}
export async function apply(ctx: Context) {
 

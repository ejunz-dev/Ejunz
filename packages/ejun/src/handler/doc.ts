import AdmZip from 'adm-zip';
import { readFile, statSync } from 'fs-extra';
import {
    escapeRegExp, flattenDeep, intersection, pick,
} from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import { nanoid } from 'nanoid';
import sanitize from 'sanitize-filename';
import parser from '@ejunz/utils/lib/search';
import { sortFiles, streamToBuffer } from '@ejunz/utils/lib/utils';
import type { Context } from '../context';
import {
    BadRequestError, ContestNotAttendedError, ContestNotEndedError, ContestNotFoundError, ContestNotLiveError,
    FileLimitExceededError, HackFailedError, NoProblemError, NotFoundError,
    PermissionError, ProblemAlreadyExistError, ProblemAlreadyUsedByContestError, ProblemConfigError,
    ProblemIsReferencedError, ProblemNotAllowLanguageError, ProblemNotAllowPretestError, ProblemNotFoundError,
    RecordNotFoundError, SolutionNotFoundError, ValidationError,DiscussionNotFoundError
} from '../error';
import {
    ProblemDoc, ProblemSearchOptions, ProblemStatusDoc, RecordDoc, User,DocsDoc
} from '../interface';
import { PERM, PRIV, STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import domain from '../model/domain';
import * as oplog from '../model/oplog';
import problem from '../model/problem';
import record from '../model/record';
import * as setting from '../model/setting';
import solution from '../model/solution';
import storage from '../model/storage';
import * as system from '../model/system';
import user from '../model/user';
import {
    Handler, param, post, query, route, Types,
} from '../service/server';
import { ContestDetailBaseHandler } from './contest';
import docs from '../model/doc';

class DocsHandler extends Handler {
    ddoc?: DocsDoc;

    @param('did', Types.ObjectId, true)
    async _prepare(domainId: string, did: ObjectId) {
        if (did) {
            this.ddoc = await docs.get(domainId, did);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, did);
        }
    }
}
export class DocsDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        domainId = this.args?.domainId || this.context?.domainId || 'system';

        page = parseInt(page as any, 10) || 1;
        pageSize = parseInt(pageSize as any, 10) || 10;

        const query = {};
        try {
            console.log(`[DocsDomainHandler] Fetching domain info for domainId: ${domainId}`);
            const domainInfo = await domain.get(domainId);

            if (!domainInfo) {
                throw new Error(`Domain not found for id: ${domainId}`);
            }

            const cursor = docs.getMulti(domainId, query);
            const totalCount = await cursor.count();
            const totalPages = Math.ceil(totalCount / pageSize);

            const ddocs = await cursor.skip((page - 1) * pageSize).limit(pageSize).toArray();

            console.log(`[DocsDomainHandler] Documents fetched successfully. Total: ${totalCount}, Pages: ${totalPages}`);

            this.response.template = 'docs_domain.html';
            this.response.body = {
                ddocs,
                domainId,
                dname: domainInfo.name,
                page,
                pageSize,
                totalPages,
                totalCount,
            };
        } catch (error) {
            console.error(`[DocsDomainHandler] Error fetching documents for domainId: ${domainId}`, error);
            this.response.template = 'error.html';
            this.response.body = {
                error: `Failed to fetch documents for the domain: ${error.message}`,
                details: error.stack, 
            };
        }
    }
}





class DocsDetailHandler extends DocsHandler {
    @param('did', Types.ObjectId)
    async get(domainId: string, did: ObjectId) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await docs.getStatus(domainId, did, this.user._id)
            : null;

        const udoc = await user.getById(domainId, this.ddoc!.owner);

        if (!dsdoc?.view) {
            await Promise.all([
                docs.inc(domainId, did, 'views', 1),
                docs.setStatus(domainId, did, this.user._id, { view: true }),
            ]);
        }
        console.log('ddoc:', this.ddoc);

        let lid = this.ddoc.lid;
        console.log('Original lid:', lid, 'Type:', typeof lid);

        if (typeof lid === 'string') {
            lid = parseInt(lid, 10);
            console.log('Converted lid to number:', lid);
        }

        if (isNaN(lid)) {
            throw new Error(`Invalid lid: ${this.ddoc.lid}`);
        }

        const problems = await getProblemsByDocsId(domainId, lid);

        this.response.template = 'docs_detail.html';
        this.response.body = {
            ddoc: this.ddoc,
            dsdoc,
            udoc,
            problems,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('did', Types.ObjectId)
    async postStar(domainId: string, did: ObjectId) {
        await docs.setStar(domainId, did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectId)
    async postUnstar(domainId: string, did: ObjectId) {
        await docs.setStar(domainId, did, this.user._id, false);
        this.back({ star: false });
    }
}
export async function getProblemsByDocsId(domainId: string, lid: number) {
    console.log(`Fetching problems for docs ID: ${lid}`);
    const query = {
        domainId,
        associatedDocumentId: lid 
    };
    console.log(`Querying problems with:`, query);
    return await problem.getMulti(domainId, query).toArray();
}




export class DocsEditHandler extends DocsHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';
        const files = await storage.list(`domain/${domainId}/`);

        const urlForFile = (filename: string) => `/d/${domainId}/domainfile/${encodeURIComponent(filename)}`;

        this.response.template = 'docs_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
            files,
            urlForFile, 
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, title: string, content: string) {
        await this.limitRate('add_docs', 3600, 60);

        const did = await docs.addWithId(
            domainId,
            this.user._id,
            title,
            content,
            this.request.ip
        );
        
        this.response.body = { did };
        this.response.redirect = this.url('docs_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectId, title: string, content: string) {
       
        await Promise.all([
            docs.edit(domainId,did, title, content),
            oplog.log(this, 'docs.edit', this.ddoc),
        ]);

        this.response.body = { did };
        this.response.redirect = this.url('docs_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {

        await Promise.all([
            docs.del(domainId, did),
            oplog.log(this, 'docs.delete', this.ddoc),
        ]);

        this.response.redirect = this.url('docs_domain');
    }
}




export async function apply(ctx: Context) {
    // ctx.Route('docs', '/docs', LibHandler);
    ctx.Route('docs_domain', '/docs', DocsDomainHandler);
    ctx.Route('docs_create', '/docs/create', DocsEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('docs_detail', '/docs/:did', DocsDetailHandler);
    ctx.Route('docs_edit', '/docs/:did/edit', DocsEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('Nav', 'docs_domain', () => ({
        name: 'docs_domain',
        displayName: 'Docs',
        args: {},
        checker: (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE),
    }));
    
    ctx.i18n.load('zh', {
        "{0}'s docs": '{0} 的文档',
        Docs: '文档',
        docs_detail: '文档详情',
        docs_edit: '编辑文档',
        docs_domain: '文档',
    });
    ctx.i18n.load('zh_TW', {
        "{0}'s docs": '{0} 的部落格',
        Docs: '部落格',
        docs_detail: '部落格詳情',
        docs_edit: '編輯部落格',
        docs_main: '部落格',
    });
    ctx.i18n.load('kr', {
        "{0}'s docs": '{0}의 블로그',
        Docs: '블로그',
        docs_main: '블로그',
        docs_detail: '블로그 상세',
        docs_edit: '블로그 수정',
    });
    ctx.i18n.load('en', {
        docs_main: 'Docs',
        docs_detail: 'Docs Detail',
        docs_edit: 'Edit Docs',
    });
    ctx.inject(['api'], ({ api }) => {
        api.value('Doc', [
            ['docId', 'ObjectID!'],
            ['lid', 'String'],
            ['title', 'String!'],
            ['content', 'String!'],
        ]);
        api.resolver(
            'Query', 'doc(id: Int, title: String)', 'Doc',
            async (arg, c) => {
                c.checkPerm(PERM.PERM_VIEW);
                const ddoc = await docs.get(c.args.domainId, arg.title || arg.id);
                if (!ddoc) return null;
                c.ddoc = ddoc;
                return ddoc;
            },
        );

        api.resolver(
            'Query', 'docs(ids: [Int]!)', '[Doc]!',  // ✅ 允许传多个 lid
            async (arg, c) => {
                c.checkPerm(PERM.PERM_VIEW);
                const res = await docs.getList(c.args.domainId, arg.ids); // 🔥 这里传入的是 `lid`
                return res;
            }, 'Get a list of docs by lid');
    });
}

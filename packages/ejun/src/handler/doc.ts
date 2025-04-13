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

    @param('lid', Types.String, true)  
    async _prepare(domainId: string, lid: string) {
        if (lid) {
            const normalizedLid: number | string = /^\d+$/.test(lid) ? Number(lid) : lid;

            console.log(`[DocsHandler] Querying document with ${typeof normalizedLid === 'number' ? 'docId' : 'lid'} = ${normalizedLid}`);

            this.ddoc = await docs.get(domainId, normalizedLid);
            if (!this.ddoc) {
                console.error(`[DocsHandler] Document with ${typeof normalizedLid === 'number' ? 'docId' : 'lid'}=${normalizedLid} not found in domain=${domainId}`);
                throw new NotFoundError(domainId, lid);
            }
        }
    }
}


export class DocsDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {
        console.log(`[DocsDomainHandler] Fetching documents for domain: ${domainId}, Page: ${page}, PageSize: ${pageSize}`);

        domainId = this.args?.domainId || this.context?.domainId || 'system';
        page = parseInt(page as any, 10) || 1;
        pageSize = parseInt(pageSize as any, 10) || 10;

        const query: Filter<DocsDoc> = {};

        try {
            const domainInfo = await domain.get(domainId);
            if (!domainInfo) {
                throw new Error(`Domain not found for id: ${domainId}`);
            }

            const [ddocs, totalPages, totalCount] = await docs.list(
                domainId, query, page, pageSize, docs.PROJECTION_LIST
            );

            console.log(`[DocsDomainHandler] Documents fetched successfully.`);
            console.log(`Total Documents: ${totalCount}, Total Pages: ${totalPages}`);
            console.log(`First 3 docs:`, JSON.stringify(ddocs.slice(0, 3), null, 2));

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
    @param('lid', Types.String) 
    async get(domainId: string, lid: string) {
        console.log(`[DocsDetailHandler] Looking for doc with lid=${lid} in domain=${domainId}`);

        const normalizedLid: number | string = Number.isSafeInteger(+lid) ? +lid : lid;

        console.log(`[DocsDetailHandler] Querying document by ${typeof normalizedLid === 'number' ? 'docId' : 'lid'} = ${normalizedLid}`);

        const ddoc = await docs.get(domainId, normalizedLid);
        if (!ddoc) {
            console.error(`[DocsDetailHandler] Document with ${typeof normalizedLid === 'number' ? 'docId' : 'lid'}=${normalizedLid} not found in domain=${domainId}`);
            throw new NotFoundError(domainId, lid);
        }

        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await docs.getStatus(domainId, ddoc.lid, this.user._id)
            : null;

        const udoc = await user.getById(domainId, ddoc.owner);

        if (!dsdoc?.view) {
            await Promise.all([
                docs.inc(domainId, ddoc.lid, 'views', 1),
                docs.setStatus(domainId, ddoc.lid, this.user._id, { view: true }),
            ]);
        }

        console.log(`[DocsDetailHandler] Fetching related problems for docs lid: ${ddoc.lid}`);
        const problems = await getProblemsByDocsId(domainId, ddoc.docId);

        this.response.template = 'docs_detail.html';
        this.response.body = {
            ddoc,
            dsdoc,
            udoc,
            problems,
        };
        console.log(`ddoc:`, ddoc);
    }
}





export async function getProblemsByDocsId(domainId: string, lid: string|number) {
    console.log(`Fetching problems for docs ID: ${lid}`);
    const query = {
        domainId,
        associatedDocumentId: lid // 这里 `lid` 现在是字符串
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

        const lid = await docs.add(
            domainId,
            this.user._id,
            title,
            content,
            this.request.ip
        );

        this.response.body = { lid };
        this.response.redirect = this.url('docs_detail', { uid: this.user._id, lid });
    }

    @param('lid', Types.String)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, lid: string, title: string, content: string) {
        await Promise.all([
            docs.edit(domainId, lid, { title, content }),
            oplog.log(this, 'docs.edit', this.ddoc),
        ]);

        this.response.body = { lid };
        this.response.redirect = this.url('docs_detail', { uid: this.user._id, lid });
    }

    @param('lid', Types.String)
    async postDelete(domainId: string, lid: string) {
        await Promise.all([
            docs.del(domainId, lid),
            oplog.log(this, 'docs.delete', this.ddoc),
        ]);

        this.response.redirect = this.url('docs_domain');
    }
}





export async function apply(ctx: Context) {

    // ctx.Route('docs', '/docs', LibHandler);
    ctx.Route('docs_domain', '/docs', DocsDomainHandler);
    ctx.Route('docs_create', '/docs/create', DocsEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('docs_detail', '/docs/:lid', DocsDetailHandler);
    ctx.Route('docs_edit', '/docs/:lid/edit', DocsEditHandler, PRIV.PRIV_USER_PROFILE);
 
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
        docs_domain: '部落格',
    });
    ctx.i18n.load('kr', {
        "{0}'s docs": '{0}의 블로그',
        Docs: '블로그',
        docs_domain: '블로그',
        docs_detail: '블로그 상세',
        docs_edit: '블로그 수정',
    });
    ctx.i18n.load('en', {
        docs_domain: 'Docs',
        docs_detail: 'Docs Detail',
        docs_edit: 'Edit Docs',
    });
    ctx.inject(['api'], ({ api }) => {
        api.value('Doc', [
            ['docId', 'Int!'],
            ['lid', 'String!'],
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
        api.resolver('Query', 'docs(ids: [Int])', '[Doc]', async (arg, c) => {
            c.checkPerm(PERM.PERM_VIEW);
            const res = await docs.getList(c.args.domainId, arg.ids, undefined);
            return Object.keys(res)
                .map((id) => res[+id])
                .filter((doc) => doc !== null && doc !== undefined); 
        }, 'Get a list of docs by ids');
        
    });
}
    
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
import * as discussion from '../model/discussion';
import domain from '../model/domain';
import * as oplog from '../model/oplog';
import * as setting from '../model/setting';
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


            this.ddoc = await docs.get(domainId, normalizedLid);
            if (!this.ddoc) {
                throw new NotFoundError(domainId, lid);
            }
        }
    }
}


export class DocsDomainHandler extends Handler {
    async get({ domainId, page = 1, pageSize = 10 }) {

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

        const normalizedLid: number | string = Number.isSafeInteger(+lid) ? +lid : lid;


        const ddoc = await docs.get(domainId, normalizedLid);
        if (!ddoc) {
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

        const problems = await getProblemsByDocsId(domainId, ddoc.docId);

        this.response.template = 'docs_detail.html';
        this.response.body = {
            ddoc,
            dsdoc,
            udoc,
            problems,
        };
    }
}





export async function getProblemsByDocsId(domainId: string, lid: string|number) {
    const query = {
        domainId,
        associatedDocumentId: lid // 这里 `lid` 现在是字符串
    };
    return await problem.getMulti(domainId, query).toArray();
}




export class DocsEditHandler extends DocsHandler {
    async get() {
        const domainId = this.context.domainId || 'default_domain';

        this.response.template = 'docs_edit.html';
        this.response.body = {
            ddoc: this.ddoc,
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
 
    // ctx.inject(['api'], ({ api }) => {
    //     api.value('Doc', [
    //         ['docId', 'Int!'],
    //         ['lid', 'String!'],
    //         ['title', 'String!'],
    //         ['content', 'String!'],
    //     ]);
    
    //     api.resolver(
    //         'Query', 'doc(id: Int, title: String)', 'Doc',
    //         async (arg, c) => {
    //             c.checkPerm(PERM.PERM_VIEW);
    //             const ddoc = await docs.get(c.args.domainId, arg.title || arg.id);
    //             if (!ddoc) return null;
    //             c.ddoc = ddoc;
    //             return ddoc;
    //         },
    //     );
    //     api.resolver('Query', 'docs(ids: [Int])', '[Doc]', async (arg, c) => {
    //         c.checkPerm(PERM.PERM_VIEW);
    //         const res = await docs.getList(c.args.domainId, arg.ids, undefined);
    //         return Object.keys(res)
    //             .map((id) => res[+id])
    //             .filter((doc) => doc !== null && doc !== undefined); 
    //     }, 'Get a list of docs by ids');
        
    // });
}
    
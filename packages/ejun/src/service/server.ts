import { resolve } from 'path';
import cac from 'cac';
import fs from 'fs-extra';
import cache from 'koa-static-cache';
import { type FindCursor, ObjectId } from 'mongodb';
import {
    applyApiHandler, ConnectionHandler as ConnectionHandlerOriginal,
    Handler as HandlerOriginal, EjunzError, NotFoundError, UserFacingError,
    WebService, isExecutorChecker, type ExecutorClass,
} from '@ejunz/framework';
import { errorMessage, Time } from '@ejunz/utils';
import { Context, Service } from '../context';
import type { Disposable } from '../context';
import Schema from 'schemastery';
import { isSchema, schemaDescription, schemaToJsonSchema, validateToolArgs } from '../lib/tool-schema';
import type { ToolArgs, ToolBaseSelectPayload, ToolCalledPayload, ToolContext, ToolSpec } from '../lib/tool-types';
import type { VoidReturn } from './bus';
import { listAgentAddons } from './addons';
import { PermissionError, PrivilegeError } from '../error';
import type { DomainDoc } from '../interface';
import { Logger } from '../logger';
import { PERM, PRIV } from '../model/builtin';
import * as opcount from '../model/opcount';
import * as OplogModel from '../model/oplog';
import system from '../model/system';
import db from './db';
import baseLayer from './layers/base';
import domainLayer from './layers/domain';
import userLayer from './layers/user';

const argv = cac().parse();
const ignoredLimit = `,${argv.options.ignoredLimit},`;

const logger = new Logger('server');

declare module '@ejunz/framework' {
    export interface HandlerCommon<C> { // eslint-disable-line ts/no-unused-vars
        domain: DomainDoc;

        paginate<T>(cursor: FindCursor<T>, page: number, key: string): Promise<[docs: T[], numPages: number, count: number]>;
        paginate<T>(cursor: FindCursor<T>, page: number, limit: number): Promise<[docs: T[], numPages: number, count: number]>;
        progress(message: string, params: any[]): void;
        limitRate(op: string, periodSecs: number, maxOperations: number, defaultKey?: string): Promise<void>;
        renderTitle(str: string): string;
    }
}

export { Mutation, Query } from '@ejunz/framework/api';
export * from '@ejunz/framework/decorators';
export * from '@ejunz/framework/validator';

/*
 * For security concern, some API requires sudo privilege to access.
 * And for some superadmin operations,
 * we do not allow them using a password to perform the sudo operation,
 * as most user choose to use "remember password" option.
 * When teachers are using a superuser account, accessing from classrooms,
 * it may lead to serious security issues.
 * !!! Please make sure that all superuser accounts have two factor authentication enabled. !!!
 */
export function requireSudo(target: any, funcName: string, obj: any) {
    const originalMethod = obj.value;
    obj.value = function sudo(this: Handler, ...args: any[]) {
        if (this.session.sudo && Date.now() - this.session.sudo < Time.hour) {
            if (this.session.sudoArgs?.referer) this.request.headers.referer = this.session.sudoArgs.referer;
            this.session.sudoArgs = null;
            return originalMethod.call(this, ...args);
        }
        this.session.sudoArgs = {
            method: this.request.method,
            referer: this.request.headers.referer,
            args: this.args,
            redirect: this.request.originalPath,
        };
        this.response.redirect = this.url('user_sudo');
        return 'cleanup';
    };
    return obj;
}

export class Handler extends HandlerOriginal<Context> {
    domain: DomainDoc;
}
export class ConnectionHandler extends ConnectionHandlerOriginal<Context> {
    domain: DomainDoc;
}

export async function apply(ctx: Context) {
    ctx.plugin(WebService, {
        keys: system.get('session.keys'),
        proxy: !!system.get('server.xproxy') || !!system.get('server.xff'),
        cors: system.get('server.cors') || '',
        upload: system.get('server.upload') || '256m',
        port: argv.options.port || system.get('server.port'),
        host: argv.options.host || system.get('server.host'),
        xff: system.get('server.xff'),
        xhost: system.get('server.xhost'),
    });
    if (process.env.EJUNZ_CLI) return;
    await applyTools(ctx);
    await ctx.inject(['server', 'oauth', 'setting'], (childContext) => {
        const { server, on, oauth } = childContext;
        server.addHandlerLayer('init', async (c, next) => {
            const init = Date.now();
            try {
                await next();
            } finally {
                const finish = Date.now();
                if (finish - init > 5000) {
                    const method = c.request.method;
                    const id = await OplogModel.log(c.handler, 'slow_request', { method, processtime: finish - init });
                    logger.warn(`Slow handler: ID=${id}, `, method, c.path, `${finish - init}ms`);
                }
                // TODO metrics: calc avg response time
            }
        });

        applyApiHandler(childContext, 'api', '/api/:op');
        server.setDefaultContext(childContext);

        for (const addon of [...Object.values(global.addons)].reverse()) {
            const dir = resolve(addon, 'public');
            if (!fs.existsSync(dir)) continue;
            server.addServerLayer(`${addon}_public`, cache(dir, {
                maxAge: argv.options.public ? 0 : 24 * 3600 * 1000,
            }));
        }

        server.addServerLayer('domain', domainLayer);
        server.addWSLayer('domain', domainLayer);
        server.addLayer('base', baseLayer);
        server.addLayer('user', userLayer);

        const cachedTranslate = ctx.i18n.translate;

        server.handlerMixin({
            url(name: string, ...kwargsList: Record<string, any>[]) {
                if (name === '#') return '#';
                let res = '#';
                const args: any = Object.create(null);
                const query: any = Object.create(null);
                for (const kwargs of kwargsList) {
                    for (const key in kwargs) {
                        if (kwargs[key] instanceof ObjectId) args[key] = kwargs[key].toHexString();
                        else args[key] = kwargs[key].toString().replace(/\//g, '%2F');
                    }
                    for (const key in kwargs.query || {}) {
                        if (query[key] instanceof ObjectId) query[key] = kwargs.query[key].toHexString();
                        else query[key] = kwargs.query[key].toString();
                    }
                }
                try {
                    const { anchor } = args;
                    let withDomainId = args.domainId || false;
                    const domainId = this.args.domainId;
                    const host = this.domain?.host;
                    if (domainId !== 'system' && (
                        !this.request.host
                        || (host instanceof Array
                            ? (!host.includes(this.request.host))
                            : this.request.host !== host)
                    )) withDomainId ||= domainId;
                    res = server.router.url(name, args, { query }).toString();
                    if (anchor) res = `${res}#${anchor}`;
                    if (withDomainId) res = `/d/${withDomainId}${res}`;
                } catch (e) {
                    logger.warn(e.message);
                    logger.info('%s %o', name, args);
                    if (!e.message.includes('Expected') || !e.message.includes('to match')) logger.info('%s', e.stack);
                }
                return res;
            },
            translate(str: string) {
                if (!str) return '';
                const lang = this.user?.viewLang || this.session?.viewLang;
                const langs = lang
                    ? [lang, ...this.context.acceptsLanguages()]
                    : [...this.context.acceptsLanguages(), system.get('server.language')];
                return cachedTranslate(str.toString(), langs);
            },
            paginate<T>(cursor: FindCursor<T>, page: number, key: string | number) {
                return db.paginate(cursor, page, typeof key === 'number' ? key : (this.ctx.setting.get(`pagination.${key}`) || 20));
            },
            checkPerm(...args: bigint[]) {
                checkAccessPerm({ priv: this.user.priv, perm: this.user.perm, scope: this.user.scope }, ...args);
            },
            checkPriv(...args: number[]) {
                checkAccessPriv({ priv: this.user.priv }, ...args);
            },
            progress(message: string, params: any[] = []) {
                Ejunz.model.message.sendInfo(this.user._id, JSON.stringify({ message, params }));
            },
            async limitRate(
                op: string, periodSecs: number, maxOperations: number, defaultKey = system.get('limit.by_user') ? '{{ip}}@{{user}}' : '{{ip}}',
            ) {
                if (ignoredLimit.includes(op)) return;
                if (this.user && this.user.hasPriv(PRIV.USER_PRIV_UNLIMITED_ACCESS)) return;
                const overrideLimit = system.get(`limit.${op}`);
                if (overrideLimit) maxOperations = overrideLimit;
                // deprecated: remove boolean support in future
                if (typeof defaultKey === 'boolean') defaultKey = defaultKey ? '{{user}}' : '{{ip}}';
                const id = defaultKey.replace('{{ip}}', this.request.ip).replace('{{user}}', this.user?._id?.toString() || '0');
                await opcount.inc(op, id, periodSecs, maxOperations);
            },
            renderTitle(str: string) {
                const name = this.ctx.get('setting')?.get('server.name') || system.get('server.name');
                if (this.UiContext.extraTitleContent) return `${this.UiContext.extraTitleContent} - ${this.translate(str)} - ${name}`;
                return `${this.translate(str)} - ${name}`;
            },
        });
        server.httpHandlerMixin({
            async onerror(error: EjunzError) {
                error.msg ||= () => error.message;
                if (error instanceof UserFacingError && !process.env.DEV) error.stack = '';
                if (!(error instanceof NotFoundError) && !('nolog' in error)) {
                    // eslint-disable-next-line max-len
                    logger.error(`User: ${this.user._id}(${this.user.uname}) ${this.request.method}: /d/${this.domain._id}${this.request.path}`, error.msg(), error.params);
                    if (error.stack) logger.error(error.stack);
                }
                if (this.user?._id === 0 && (error instanceof PermissionError || error instanceof PrivilegeError)) {
                    this.response.redirect = this.url('user_login', {
                        query: {
                            redirect: (this.context.originalPath || this.request.path) + this.context.search,
                        },
                    });
                } else if (!this.user._dudoc.join && error instanceof PermissionError) {
                    this.response.redirect = this.url('domain_join', {
                        domainId: 'system',
                        query: {
                            redirect: (this.context.originalPath || this.request.path) + this.context.search,
                            target: this.domain._id,
                        },
                    });
                } else {
                    this.response.status = error instanceof UserFacingError ? error.code : 500;
                    this.response.template = error instanceof UserFacingError ? 'error.html' : 'bsod.html';
                    this.response.body = {
                        UserFacingError,
                        error: { message: error.msg(), params: error.params, stack: errorMessage(error.stack || '') },
                    };
                }
            },
        });
        server.wsHandlerMixin({
            async onerror(err: EjunzError) {
                if (![NotFoundError, PrivilegeError, PermissionError].some((i) => err instanceof i) || this.user?._id !== 0) {
                    const msg = 'msg' in err ? err.msg() : (err as any)?.message || '';
                    logger.error(`Path:${this.request.path}, User:${this.user?._id}(${this.user?.uname})`, msg, err.params);
                    logger.error(err);
                }
                if (err instanceof UserFacingError) err.stack = this.request.path;
                this.send({
                    error: {
                        name: err.name,
                        params: err.params || [],
                    },
                });
                this.close(4000, err.toString());
            },
        });

        on('handler/create', async (h) => {
            h.user = h.context.EjunzContext.user as any;
            h.domain = h.context.EjunzContext.domain as any;
            h.translate = h.translate.bind(h);
            h.url = h.url.bind(h);
            h.ctx = h.ctx.extend({ domain: h.domain });
        });
        on('handler/create/http', async (h) => {
            if (!argv.options.benchmark && !h.notUsage) await h.limitRate('global', 5, 100);
            h.loginMethods = Object.entries(oauth.providers)
                .filter(([_, v]) => !v.hidden)
                .map(([k, v]) => ({
                    id: k,
                    icon: v.icon,
                    text: v.text,
                    name: v.name,
                }));
            if ((!('noCheckPermView' in h) || !h.noCheckPermView) && !h.user.hasPriv(PRIV.USER_PRIV_VIEW_ALL_DOMAIN)) h.checkPerm(PERM.USER_PERM_VIEW);
            if (h.context.pendingError) throw h.context.pendingError;
        });
        on('handler/create/ws', async (h) => {
            if (h.context.pendingError) throw h.context.pendingError;
        });
    });
}


const toolLogger = new Logger('tools/registry');

export interface ToolDeclaration {
    addonId: string;
    name: string;
    description: string;
    inputSchema: Record<string, any>;
    agentPermissions?: readonly string[];
    executorClass?: ExecutorClass;
    mutating?: boolean;
    execute(context: ToolContext, args: ToolArgs): Promise<unknown>;
}

export type ToolInstructionsContext = Pick<ToolContext, 'domainId' | 'baseDocId' | 'sessionId'>;

export interface ToolSource {
    source: string;
    tools: readonly ToolDeclaration[];
    domains?: readonly string[];
    instructions?(context: ToolInstructionsContext): string | Promise<string>;
}

export interface RegisteredTool extends ToolSpec {
    addonId: string;
    source: string;
    mutating: boolean;
    agentPermissions?: readonly string[];
}

export type ToolExecute = (context: ToolContext, args: ToolArgs) => Promise<unknown>;

export type ToolBindBase = 'session' | 'explicit' | 'optional' | 'none';

export interface ToolRegisterOptions {
    description?: string;
    schema?: Schema;
    inputSchema?: Record<string, any>;
    mutating?: boolean;
    source?: string;
    bindBase?: ToolBindBase;
    domains?: readonly string[] | (() => readonly string[] | undefined);
    enabled?: boolean | (() => boolean);
    /** Permission IDs supplied by mounted add-ons. */
    agentPermissions?: readonly string[];
    executorClass?: ExecutorClass;
    executorChecker?: (context: ToolContext) => void;
    instructions?: (context: ToolInstructionsContext) => string | Promise<string>;
}

export type ToolDefinition = ToolRegisterOptions & { execute: ToolExecute };

export interface ToolAccess {
    priv?: number;
    perm?: bigint;
    scope?: bigint;
    agentPermissions?: ReadonlySet<string>;
}

type StoredTool = ToolDeclaration & {
    schema?: Schema;
    config?: ToolRegisterOptions;
    priv?: number | number[];
    perm?: bigint | bigint[];
    checker?: (context: ToolContext) => void;
    executorChecker?: (context: ToolContext) => void;
    agentPermissions?: readonly string[];
};

interface StoredSource {
    source: string;
    tools: StoredTool[];
    domains?: readonly string[];
    instructions?: ToolSource['instructions'];
}

function readFlag<T>(value: T | (() => T) | undefined): T | undefined {
    return typeof value === 'function' ? (value as () => T)() : value;
}

function resolveAgentPermissions(addonId: string, mutating: boolean, explicit?: readonly string[]): readonly string[] {
    if (explicit !== undefined) return [...explicit];
    const addon = listAgentAddons().find((item) => item.addonId === addonId);
    if (!addon?.permissions?.length) return [];
    const categorizedId = mutating ? 'write' : 'read';
    const permission = addon.permissions.find((item) => item.id === categorizedId)
        || (addon.permissions.length === 1 ? addon.permissions[0] : undefined);
    return permission ? [`${addonId}:${permission.id}`] : [];
}

function agentPermissionsForTool(tool: StoredTool): readonly string[] {
    return tool.agentPermissions || [];
}

function toolEnabled(tool: StoredTool): boolean {
    return readFlag(tool.config?.enabled) !== false;
}

function toolDomains(source: StoredSource, tool: StoredTool): readonly string[] | undefined {
    const fromTool = readFlag(tool.config?.domains);
    if (fromTool && fromTool.length) return fromTool;
    return source.domains;
}

function inDomain(domains: readonly string[] | undefined, domainId?: string): boolean {
    if (!domains || !domains.length) return true;
    return domainId !== undefined && domains.includes(domainId);
}

function hasPriv(access: ToolAccess | undefined, required: number | number[]): boolean {
    if (access?.priv === undefined) return false;
    const flags = Array.isArray(required) ? required : [required];
    return flags.some((flag) => (access.priv! & flag) === flag);
}

function hasPerm(access: ToolAccess | undefined, required: bigint | bigint[]): boolean {
    if (access?.perm === undefined) return false;
    const flags = Array.isArray(required) ? required : [required];
    const scope = access.scope ?? access.perm;
    return flags.some((flag) => (access.perm! & scope & flag) === flag);
}

function checkAccessPerm(access: ToolAccess | undefined, ...perms: bigint[]): void {
    if (hasPerm(access, perms)) return;
    if (hasPriv(access, PRIV.USER_PRIV_USER_PROFILE)) throw new PermissionError(...perms);
    throw new PrivilegeError(PRIV.USER_PRIV_USER_PROFILE);
}

function checkAccessPriv(access: ToolAccess | undefined, ...privs: number[]): void {
    if (!hasPriv(access, privs)) throw new PrivilegeError(...privs);
}

function canAccess(tool: StoredTool, access: ToolAccess | undefined): boolean {
    if (tool.priv !== undefined && !hasPriv(access, tool.priv)) return false;
    if (tool.perm !== undefined && !hasPerm(access, tool.perm)) return false;
    if (agentPermissionsForTool(tool).some((permission) => !access?.agentPermissions?.has(permission))) return false;
    return true;
}

function wrapBindBase(execute: ToolExecute, mode?: ToolBindBase): ToolExecute {
    if (!mode || mode === 'none') return execute;
    return async (context, args) => {
        const namedBaseId = Number(args?.baseId);
        const requested = mode === 'explicit' ? namedBaseId
            : mode === 'optional' && Number.isSafeInteger(namedBaseId) && namedBaseId > 0 ? namedBaseId
                : context.baseDocId;
        const baseDocId = Number.isSafeInteger(requested) && requested > 0 ? requested : 0;
        if (!baseDocId) throw new Error(mode === 'explicit' ? 'baseId is required' : 'This endpoint is not bound to a base.');
        return execute({ ...context, baseDocId }, args || {});
    };
}

function parseChecker(args: unknown[]) {
    let perm: bigint | bigint[] | undefined;
    let priv: number | number[] | undefined;
    let checker: ((context: ToolContext) => void) | undefined;
    let options: ToolRegisterOptions | undefined;
    let schema: Schema | undefined;
    for (const item of args) {
        if (isSchema(item)) {
            schema = item;
        } else if (typeof item === 'object' && item) {
            if (typeof (item as { call?: unknown }).call !== 'undefined' && typeof item === 'function') {
                checker = item as (context: ToolContext) => void;
            } else if (typeof (item as any)[0] === 'number') {
                priv = item as number[];
            } else if (typeof (item as any)[0] === 'bigint') {
                perm = item as bigint[];
            } else {
                options = item as ToolRegisterOptions;
            }
        } else if (typeof item === 'number') {
            priv = item;
        } else if (typeof item === 'bigint') {
            perm = item;
        } else if (typeof item === 'function') {
            checker = item as (context: ToolContext) => void;
        }
    }
    return { perm, priv, checker, options, schema };
}

async function resolveAccess(context: ToolContext): Promise<ToolAccess | undefined> {
    if (context.priv !== undefined || context.perm !== undefined) {
        return { priv: context.priv, perm: context.perm, scope: context.scope ?? context.perm, agentPermissions: context.agentPermissions };
    }
    const owner = Number(context.owner);
    if (!context.domainId || !Number.isSafeInteger(owner) || owner <= 0) {
        return context.agentPermissions === undefined ? undefined : { agentPermissions: context.agentPermissions };
    }
    try {
        const UserModel = require('ejun/src/model/user').default as {
            getById(domainId: string, uid: number): Promise<{ priv: number; perm: bigint; scope: bigint } | null>;
        };
        const user = await UserModel.getById(context.domainId, owner);
        if (!user) return undefined;
        return { priv: user.priv, perm: user.perm, scope: user.scope, agentPermissions: context.agentPermissions };
    } catch {
        return undefined;
    }
}

function assertAccess(tool: StoredTool, access: ToolAccess | undefined, checkPermissions = true): void {
    if (checkPermissions && tool.priv !== undefined && !hasPriv(access, tool.priv)) {
        const flags = Array.isArray(tool.priv) ? tool.priv : [tool.priv];
        throw new PrivilegeError(...flags);
    }
    if (checkPermissions && tool.perm !== undefined && !hasPerm(access, tool.perm)) {
        const flags = Array.isArray(tool.perm) ? tool.perm : [tool.perm];
        throw new PermissionError(...flags);
    }
    const missingAgentPermissions = agentPermissionsForTool(tool).filter((permission) => !access?.agentPermissions?.has(permission));
    if (missingAgentPermissions.length) {
        throw new Error(`Agent role is missing permission(s): ${missingAgentPermissions.join(', ')}`);
    }
}

export class ToolService extends Service {
    private readonly sources = new Map<string, StoredSource>();
    private readonly owners = new Map<string, string>();
    private readonly executors = new Map<string, ExecutorClass>();

    constructor(ctx: Context) {
        super(ctx, 'tools');
    }









    Tool(addonId: string, name: string, execute: ToolExecute, ...permPrivChecker: Array<number | bigint | Function | Schema | ToolRegisterOptions>): Disposable;
    Tool(addonId: string, name: string, definition: ToolDefinition, ...permPrivChecker: Array<number | bigint | Function | Schema | ToolRegisterOptions>): Disposable;
    Tool(
        addonId: string,
        name: string,
        executeOrDefinition: ToolExecute | ToolDefinition,
        ...permPrivChecker: Array<number | bigint | Function | Schema | ToolRegisterOptions>
    ): Disposable {
        if (typeof addonId !== 'string' || addonId.trim().length === 0) {
            throw new Error(`tool ${String(name)} must be registered with an addonId.`);
        }
        if (typeof name !== 'string' || name.trim().length === 0) throw new Error('tool name is required.');
        const parsed = parseChecker(permPrivChecker);
        const fromDefinition = typeof executeOrDefinition === 'function' ? undefined : executeOrDefinition;
        const execute = typeof executeOrDefinition === 'function' ? executeOrDefinition : executeOrDefinition.execute;
        const options = parsed.options ?? fromDefinition ?? {};
        const schema = parsed.schema ?? options.schema ?? fromDefinition?.schema;
        const description = options.description ?? fromDefinition?.description ?? schemaDescription(schema);
        const inputSchema = options.inputSchema ?? fromDefinition?.inputSchema ?? (schema ? schemaToJsonSchema(schema) : undefined);
        const mutating = options.mutating ?? fromDefinition?.mutating === true;
        const explicitAgentPermissions = options.agentPermissions ?? fromDefinition?.agentPermissions;
        const agentPermissions = resolveAgentPermissions(addonId, mutating, explicitAgentPermissions);
        const executorClass = options.executorClass ?? fromDefinition?.executorClass;
        const executorChecker = isExecutorChecker(fromDefinition?.executorChecker)
            ? fromDefinition.executorChecker
            : isExecutorChecker(options.executorChecker) ? options.executorChecker : undefined;
        if (!description) throw new Error(`tool ${name} is missing a description.`);
        if (!inputSchema) throw new Error(`tool ${name} is missing an inputSchema.`);
        if (agentPermissions?.some((permission) => typeof permission !== 'string' || permission.trim().length === 0)) {
            throw new Error(`tool ${name} has an invalid Agent permission requirement.`);
        }
        const source = options.source ?? fromDefinition?.source ?? addonId;
        const stored: StoredTool = {
            addonId,
            name,
            description,
            inputSchema,
            mutating,
            agentPermissions: [...agentPermissions],
            ...(executorClass ? { executorClass } : {}),
            execute: wrapBindBase(execute, options.bindBase ?? fromDefinition?.bindBase),
            config: options,
            ...(schema ? { schema } : {}),
            ...(parsed.priv !== undefined ? { priv: parsed.priv } : {}),
            ...(parsed.perm !== undefined ? { perm: parsed.perm } : {}),
            ...(parsed.checker ? { checker: parsed.checker } : {}),
            ...(executorChecker ? { executorChecker } : {}),
        };
        return this.ctx.effect(() => {
            this.addTool(source, stored, options);
            return () => this.removeTool(source, name);
        });
    }

    available(name: string): boolean {
        const found = this.lookup(name);
        return Boolean(found && toolEnabled(found.tool));
    }

    private addTool(source: string, tool: StoredTool, options: ToolRegisterOptions): void {
        const owner = this.owners.get(tool.name);
        if (owner) throw new Error(`tool ${tool.name} is already registered by source ${owner}.`);
        let entry = this.sources.get(source);
        if (entry && entry.tools.some((registered) => registered.addonId !== tool.addonId)) {
            throw new Error(`tool source ${source} cannot mix addon owners.`);
        }
        if (!entry) {
            entry = { source, tools: [] };
            this.sources.set(source, entry);
        }
        if (options.instructions && !entry.instructions) entry.instructions = options.instructions;
        entry.tools.push(tool);
        this.owners.set(tool.name, source);
        if (tool.executorClass) {
            const name = tool.executorClass.name.replace(/Executor$/, '');
            this.executors.set(name, tool.executorClass);
            void (this.ctx.parallel as any)(`executor/register/${name}`, tool.executorClass);
        }
    }

    private removeTool(source: string, name: string): void {
        const entry = this.sources.get(source);
        if (!entry) return;
        const removed = entry.tools.find((tool) => tool.name === name);
        entry.tools = entry.tools.filter((tool) => tool.name !== name);
        this.owners.delete(name);
        if (!entry.tools.length) this.sources.delete(source);
        if (removed?.executorClass) {
            const executorName = removed.executorClass.name.replace(/Executor$/, '');
            const stillRegistered = [...this.sources.values()].some((item) =>
                item.tools.some((tool) => tool.executorClass === removed.executorClass));
            if (!stillRegistered) this.executors.delete(executorName);
        }
    }

    private lookup(name: string): { source: StoredSource; tool: StoredTool } | undefined {
        const sourceName = this.owners.get(name);
        if (!sourceName) return undefined;
        const source = this.sources.get(sourceName);
        const tool = source?.tools.find(candidate => candidate.name === name);
        if (!source || !tool) return undefined;
        return { source, tool };
    }

    private visible(source?: string, domainId?: string, access?: ToolAccess, mountedAddons?: ReadonlySet<string>, includeRestricted = false): { source: StoredSource; tool: StoredTool }[] {
        const entries = source === undefined
            ? [...this.sources.values()]
            : this.sources.has(source) ? [this.sources.get(source)!] : [];
        const rows: { source: StoredSource; tool: StoredTool }[] = [];
        for (const entry of entries) {
            for (const tool of entry.tools) {
                if (!toolEnabled(tool)) continue;
                if (!inDomain(toolDomains(entry, tool), domainId)) continue;
                if (mountedAddons !== undefined && !mountedAddons.has(tool.addonId)) continue;
                if (!includeRestricted && (access ? !canAccess(tool, access) : agentPermissionsForTool(tool).length > 0)) continue;
                rows.push({ source: entry, tool });
            }
        }
        return rows;
    }

    private sourcesFor(source?: string, domainId?: string, mountedAddons?: ReadonlySet<string>): StoredSource[] {
        const names = new Set(this.visible(source, domainId, undefined, mountedAddons).map(row => row.source.source));
        return [...this.sources.values()].filter(entry => names.has(entry.source));
    }

    list(source?: string, domainId?: string, access?: ToolAccess, mountedAddons?: ReadonlySet<string>): RegisteredTool[] {
        return this.visible(source, domainId, access, mountedAddons).map(({ source: entry, tool }) => ({
            addonId: tool.addonId,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            source: entry.source,
            mutating: tool.mutating === true,
            ...(agentPermissionsForTool(tool).length ? { agentPermissions: [...agentPermissionsForTool(tool)] } : {}),
        }));
    }

    listForCatalog(domainId?: string): RegisteredTool[] {
        return this.visible(undefined, domainId, undefined, undefined, true).map(({ source: entry, tool }) => ({
            addonId: tool.addonId,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            source: entry.source,
            mutating: tool.mutating === true,
            ...(agentPermissionsForTool(tool).length ? { agentPermissions: [...agentPermissionsForTool(tool)] } : {}),
        }));
    }

    permissionBitsForAddon(addonId: string, domainId: string, access: ToolAccess): { perm: bigint[]; priv: number[] } {
        const perm = new Set<bigint>();
        const priv = new Set<number>();
        for (const { tool } of this.visible(undefined, domainId, undefined, undefined, true)) {
            if (tool.addonId !== addonId) continue;
            const privFlags = tool.priv === undefined ? [] : Array.isArray(tool.priv) ? tool.priv : [tool.priv];
            for (const flag of privFlags) if (flag !== 0 && hasPriv(access, flag)) priv.add(flag);
            const permFlags = tool.perm === undefined ? [] : Array.isArray(tool.perm) ? tool.perm : [tool.perm];
            for (const flag of permFlags) if (flag !== 0n && hasPerm(access, flag)) perm.add(flag);
        }
        return {
            perm: [...perm].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
            priv: [...priv].sort((left, right) => left - right),
        };
    }

    catalog(source?: string, overrides?: { name: string; description: string }[], domainId?: string, access?: ToolAccess, mountedAddons?: ReadonlySet<string>): ToolSpec[] {
        const tools: ToolSpec[] = this.list(source, domainId, access, mountedAddons).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
        if (!overrides || !overrides.length) return tools;
        const byName = new Map(overrides.map(entry => [entry.name, entry.description]));
        return tools.map(tool => {
            const description = byName.get(tool.name);
            return description ? { ...tool, description } : tool;
        });
    }

    get(name: string): RegisteredTool | undefined {
        const found = this.lookup(name);
        if (!found) return undefined;
        return {
            addonId: found.tool.addonId,
            name: found.tool.name,
            description: found.tool.description,
            inputSchema: found.tool.inputSchema,
            source: found.source.source,
            mutating: found.tool.mutating === true,
        };
    }

    withExecutorClass(name: string, callback: (ExecutorClass: ExecutorClass) => unknown): void {
        name = name.replace(/Executor$/, '');
        const executorClass = this.executors.get(name);
        if (executorClass) callback(executorClass);
        (this.ctx.on as any)(`executor/register/${name}`, callback);
    }

    has(id: string): boolean {
        return this.owners.has(id) || this.sources.has(id);
    }

    addonIds(): string[] {
        return [...new Set([...this.sources.values()].flatMap((source) => source.tools.map((tool) => tool.addonId)))];
    }

    async instructions(context: ToolInstructionsContext, source?: string, mountedAddons?: ReadonlySet<string>): Promise<string[]> {
        const entries = this.sourcesFor(source, context.domainId, mountedAddons);
        const lines: string[] = [];
        for (const entry of entries) {
            if (!entry.instructions) continue;
            const text = await entry.instructions(context);
            if (text) lines.push(text);
        }
        return lines;
    }

    async execute(name: string, args: ToolArgs, context: ToolContext): Promise<unknown> {
        const found = this.lookup(name);
        if (!found || !toolEnabled(found.tool) || !inDomain(toolDomains(found.source, found.tool), context.domainId)) {
            throw new Error(`Unknown tool: ${name}`);
        }
        if (context.mountedAddons !== undefined && !context.mountedAddons.has(found.tool.addonId)) {
            throw new Error(`Addon "${found.tool.addonId}" is not mounted in this session.`);
        }
        const access = await resolveAccess(context);
        assertAccess(found.tool, access, !found.tool.executorChecker);
        if (found.tool.executorChecker) {
            found.tool.executorChecker.call({
                checkPerm: (...perms: bigint[]) => checkAccessPerm(access, ...perms),
                checkPriv: (...privs: number[]) => checkAccessPriv(access, ...privs),
            }, context);
        } else {
            found.tool.checker?.(context);
        }
        const startedAt = Date.now();
        const parsedArgs = found.tool.schema ? validateToolArgs(found.tool.schema, args || {}) : (args || {});
        const result = await found.tool.execute(context, parsedArgs);
        toolLogger.info('tool %s from %s ok in %dms', name, found.source.source, Date.now() - startedAt);
        if (found.tool.mutating) {
            this.ctx.emit('tool/called', {
                name,
                addonId: found.tool.addonId,
                source: found.source.source,
                domainId: context.domainId,
                baseDocId: context.baseDocId,
                owner: context.owner,
            });
        }
        return result;
    }
}

declare module 'ejun/src/context' {
    interface Context {
        tools: ToolService;
    }
}

declare module 'cordis' {
    interface Context {
        tools: ToolService;
    }
}

declare module 'ejun/src/service/bus' {
    interface EventMap {
        'tool/called': (payload: ToolCalledPayload) => VoidReturn;
        'tool/base-select': (payload: ToolBaseSelectPayload) => VoidReturn;
    }
}


const providerLogger = new Logger('tools/provider');

export interface ProviderScope {
    readonly domainId: string;
    readonly owner: number;
    readonly baseDocId?: number;
    readonly sessionId?: string;
    readonly priv?: number;
    readonly perm?: bigint;
    readonly scope?: bigint;
    readonly mountedAddons?: ReadonlySet<string>;
    readonly agentPermissions?: ReadonlySet<string>;
}

export interface Provider {
    readonly scope: Readonly<ProviderScope>;
    catalog(source?: string): ToolSpec[];
    call(name: string, args: ToolArgs, signal: AbortSignal): Promise<unknown>;
}

export function createProvider(
    ctx: Context,
    scope: ProviderScope,
): Provider {
    const services = ctx as any;
    const get = (name: string) => (typeof services.get === 'function' ? services.get(name) : services[name]);
    const registry = () => {
        const tools = get('tools');
        if (!tools) throw new Error('the host tool registry is unavailable');
        return tools;
    };
    const access = (): ToolAccess | undefined => (
        scope.priv === undefined && scope.perm === undefined && scope.agentPermissions === undefined ? undefined
            : { priv: scope.priv, perm: scope.perm, scope: scope.scope ?? scope.perm, agentPermissions: scope.agentPermissions }
    );
    const toolContext = (): ToolContext => ({
        domainId: scope.domainId,
        baseDocId: scope.baseDocId ?? 0,
        owner: scope.owner,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        ...(scope.priv !== undefined ? { priv: scope.priv } : {}),
        ...(scope.perm !== undefined ? { perm: scope.perm } : {}),
        ...(scope.scope !== undefined ? { scope: scope.scope } : {}),
        ...(scope.mountedAddons !== undefined ? { mountedAddons: scope.mountedAddons } : {}),
        ...(scope.agentPermissions !== undefined ? { agentPermissions: scope.agentPermissions } : {}),
        ...(typeof ctx.broadcast === 'function' ? { broadcastAgentEvent: (event, payload) => (ctx.broadcast as any)(event, payload) } : {}),
        setting: get('setting'),
    });
    return {
        scope: Object.freeze({ ...scope }),
        catalog: (source?: string) => registry().catalog(source, undefined, scope.domainId, access(), scope.mountedAddons),
        async call(name, args, signal) {
            if (signal.aborted) throw signal.reason ?? new Error('provider call aborted');
            const startedAt = Date.now();
            providerLogger.info('[provider] call start name=%s domain=%s baseDocId=%d owner=%d', name, scope.domainId, scope.baseDocId ?? 0, scope.owner);
            try {
                const result = await registry().execute(name, args, toolContext());
                if (signal.aborted) throw signal.reason ?? new Error('provider call aborted');
                providerLogger.info('[provider] call done name=%s durationMs=%d', name, Date.now() - startedAt);
                return result;
            } catch (error) {
                providerLogger.warn('[provider] call failed name=%s domain=%s durationMs=%d error=%s', name, scope.domainId, Date.now() - startedAt, error instanceof Error ? error.message : String(error));
                throw error;
            }
        },
    };
}


async function applyTools(ctx: Context) {
    await ctx.plugin(ToolService);
    const toolsDir = resolve(__dirname, '../tools');
    for (const name of await fs.readdir(toolsDir)) {
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        const file = resolve(toolsDir, name);
        if (typeof require(file).apply !== 'function') continue;
        await ctx.loader.reloadPlugin(file, '');
    }
    const tools = ctx.get('tools') as ToolService | undefined;
    if (!tools) throw new Error('Ejunz tool registry is unavailable.');
    const declared = new Set(listAgentAddons().map((addon) => addon.addonId));
    const missing = tools.addonIds().filter((addonId) => !declared.has(addonId));
    if (missing.length) throw new Error(`Tool registrations reference undeclared add-ons: ${missing.join(', ')}.`);
}

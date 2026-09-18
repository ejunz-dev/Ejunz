import Schema from 'schemastery';
import { Logger } from 'ejun/src/logger';
import { Context, Service } from 'ejun/src/context';
import type { Disposable } from 'ejun/src/context';
import { PermissionError, PrivilegeError } from 'ejun/src/error';
import { isSchema, schemaDescription, schemaToJsonSchema, validateToolArgs } from '../lib/tool-schema';
import type { ToolArgs, ToolBaseSelectPayload, ToolCalledPayload, ToolContext, ToolSpec } from '../lib/tool-types';
import type { VoidReturn } from 'ejun/src/service/bus';

const logger = new Logger('tools/registry');

export interface ToolDeclaration {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
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
    source: string;
    mutating: boolean;
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
    instructions?: (context: ToolInstructionsContext) => string | Promise<string>;
}

export type ToolDefinition = ToolRegisterOptions & { execute: ToolExecute };

export interface ToolAccess {
    priv?: number;
    perm?: bigint;
    scope?: bigint;
}

type StoredTool = ToolDeclaration & {
    schema?: Schema;
    config?: ToolRegisterOptions;
    priv?: number | number[];
    perm?: bigint | bigint[];
    checker?: (context: ToolContext) => void;
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

function canAccess(tool: StoredTool, access: ToolAccess | undefined): boolean {
    if (tool.priv !== undefined && !hasPriv(access, tool.priv)) return false;
    if (tool.perm !== undefined && !hasPerm(access, tool.perm)) return false;
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
        return { priv: context.priv, perm: context.perm, scope: context.scope ?? context.perm };
    }
    const owner = Number(context.owner);
    if (!context.domainId || !Number.isSafeInteger(owner) || owner <= 0) return undefined;
    try {
        const UserModel = require('ejun/src/model/user').default as {
            getById(domainId: string, uid: number): Promise<{ priv: number; perm: bigint; scope: bigint } | null>;
        };
        const user = await UserModel.getById(context.domainId, owner);
        if (!user) return undefined;
        return { priv: user.priv, perm: user.perm, scope: user.scope };
    } catch {
        return undefined;
    }
}

function assertAccess(tool: StoredTool, access: ToolAccess | undefined): void {
    if (tool.priv !== undefined && !hasPriv(access, tool.priv)) {
        const flags = Array.isArray(tool.priv) ? tool.priv : [tool.priv];
        throw new PrivilegeError(...flags);
    }
    if (tool.perm !== undefined && !hasPerm(access, tool.perm)) {
        const flags = Array.isArray(tool.perm) ? tool.perm : [tool.perm];
        throw new PermissionError(...flags);
    }
}

export default class ToolService extends Service {
    private readonly sources = new Map<string, StoredSource>();
    private readonly owners = new Map<string, string>();

    constructor(ctx: Context) {
        super(ctx, 'tools');
    }









    Tool(name: string, execute: ToolExecute, ...permPrivChecker: Array<number | bigint | Function | Schema | ToolRegisterOptions>): Disposable;
    Tool(name: string, definition: ToolDefinition, ...permPrivChecker: Array<number | bigint | Function | Schema | ToolRegisterOptions>): Disposable;
    Tool(
        name: string,
        executeOrDefinition: ToolExecute | ToolDefinition,
        ...permPrivChecker: Array<number | bigint | Function | Schema | ToolRegisterOptions>
    ): Disposable {
        const parsed = parseChecker(permPrivChecker);
        const fromDefinition = typeof executeOrDefinition === 'function' ? undefined : executeOrDefinition;
        const execute = typeof executeOrDefinition === 'function' ? executeOrDefinition : executeOrDefinition.execute;
        const options = parsed.options ?? fromDefinition ?? {};
        const schema = parsed.schema ?? options.schema ?? fromDefinition?.schema;
        const description = options.description ?? fromDefinition?.description ?? schemaDescription(schema);
        const inputSchema = options.inputSchema ?? fromDefinition?.inputSchema ?? (schema ? schemaToJsonSchema(schema) : undefined);
        if (!description) throw new Error(`tool ${name} is missing a description.`);
        if (!inputSchema) throw new Error(`tool ${name} is missing an inputSchema.`);
        const source = options.source ?? fromDefinition?.source ?? this.pluginSource();
        const stored: StoredTool = {
            name,
            description,
            inputSchema,
            mutating: options.mutating ?? fromDefinition?.mutating,
            execute: wrapBindBase(execute, options.bindBase ?? fromDefinition?.bindBase),
            config: options,
            ...(schema ? { schema } : {}),
            ...(parsed.priv !== undefined ? { priv: parsed.priv } : {}),
            ...(parsed.perm !== undefined ? { perm: parsed.perm } : {}),
            ...(parsed.checker ? { checker: parsed.checker } : {}),
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

    private pluginSource(): string {
        const runtime = (this.ctx as any).runtime;
        const name = typeof runtime?.name === 'string' ? runtime.name : '';
        if (!name || name === 'unnamed') return 'plugin';
        return String(name).replace(/^@ejunz\//, '');
    }

    private addTool(source: string, tool: StoredTool, options: ToolRegisterOptions): void {
        const owner = this.owners.get(tool.name);
        if (owner) throw new Error(`tool ${tool.name} is already registered by source ${owner}.`);
        let entry = this.sources.get(source);
        if (!entry) {
            entry = { source, tools: [] };
            this.sources.set(source, entry);
        }
        if (options.instructions && !entry.instructions) entry.instructions = options.instructions;
        entry.tools.push(tool);
        this.owners.set(tool.name, source);
    }

    private removeTool(source: string, name: string): void {
        const entry = this.sources.get(source);
        if (!entry) return;
        entry.tools = entry.tools.filter(tool => tool.name !== name);
        this.owners.delete(name);
        if (!entry.tools.length) this.sources.delete(source);
    }

    private lookup(name: string): { source: StoredSource; tool: StoredTool } | undefined {
        const sourceName = this.owners.get(name);
        if (!sourceName) return undefined;
        const source = this.sources.get(sourceName);
        const tool = source?.tools.find(candidate => candidate.name === name);
        if (!source || !tool) return undefined;
        return { source, tool };
    }

    private visible(source?: string, domainId?: string, access?: ToolAccess): { source: StoredSource; tool: StoredTool }[] {
        const entries = source === undefined
            ? [...this.sources.values()]
            : this.sources.has(source) ? [this.sources.get(source)!] : [];
        const rows: { source: StoredSource; tool: StoredTool }[] = [];
        for (const entry of entries) {
            for (const tool of entry.tools) {
                if (!toolEnabled(tool)) continue;
                if (!inDomain(toolDomains(entry, tool), domainId)) continue;
                if (access && !canAccess(tool, access)) continue;
                rows.push({ source: entry, tool });
            }
        }
        return rows;
    }

    private sourcesFor(source?: string, domainId?: string): StoredSource[] {
        const names = new Set(this.visible(source, domainId).map(row => row.source.source));
        return [...this.sources.values()].filter(entry => names.has(entry.source));
    }

    list(source?: string, domainId?: string, access?: ToolAccess): RegisteredTool[] {
        return this.visible(source, domainId, access).map(({ source: entry, tool }) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            source: entry.source,
            mutating: tool.mutating === true,
        }));
    }

    catalog(source?: string, overrides?: { name: string; description: string }[], domainId?: string, access?: ToolAccess): ToolSpec[] {
        const tools: ToolSpec[] = this.list(source, domainId, access).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
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
            name: found.tool.name,
            description: found.tool.description,
            inputSchema: found.tool.inputSchema,
            source: found.source.source,
            mutating: found.tool.mutating === true,
        };
    }

    has(id: string): boolean {
        return this.owners.has(id) || this.sources.has(id);
    }

    async instructions(context: ToolInstructionsContext, source?: string): Promise<string[]> {
        const entries = this.sourcesFor(source, context.domainId);
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
        const access = await resolveAccess(context);
        assertAccess(found.tool, access);
        found.tool.checker?.(context);
        const startedAt = Date.now();
        const parsedArgs = found.tool.schema ? validateToolArgs(found.tool.schema, args || {}) : (args || {});
        const result = await found.tool.execute(context, parsedArgs);
        logger.info('tool %s from %s ok in %dms', name, found.source.source, Date.now() - startedAt);
        if (found.tool.mutating) {
            this.ctx.emit('tool/called', {
                name,
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

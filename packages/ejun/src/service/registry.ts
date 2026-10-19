import Schema from 'schemastery';
import { Logger } from 'ejun/src/logger';
import { Context, Service } from 'ejun/src/context';
import type { Disposable } from 'ejun/src/context';
import { PermissionError, PrivilegeError } from 'ejun/src/error';
import { isSchema, schemaDescription, schemaToJsonSchema, validateToolArgs } from '../lib/tool-schema';
import type { ToolArgs, ToolBaseSelectPayload, ToolCalledPayload, ToolContext, ToolSpec } from '../lib/tool-types';
import type { VoidReturn } from 'ejun/src/service/bus';
import { listAgentAddons } from './addons';

const logger = new Logger('tools/registry');

export interface ToolDeclaration {
    addonId: string;
    name: string;
    description: string;
    inputSchema: Record<string, any>;
    agentPermissions?: readonly string[];
    agentPerm?: bigint;
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
    agentPerm?: bigint;
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
    /** PERM flags the active Agent role must have to expose and invoke this tool. */
    agentPerm?: bigint;
    instructions?: (context: ToolInstructionsContext) => string | Promise<string>;
}

export type ToolDefinition = ToolRegisterOptions & { execute: ToolExecute };

export interface ToolAccess {
    priv?: number;
    perm?: bigint;
    scope?: bigint;
    agentPermissions?: ReadonlySet<string>;
    agentPerm?: bigint;
}

type StoredTool = ToolDeclaration & {
    schema?: Schema;
    config?: ToolRegisterOptions;
    priv?: number | number[];
    perm?: bigint | bigint[];
    checker?: (context: ToolContext) => void;
    agentPermissions?: readonly string[];
    agentPerm?: bigint;
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

function hasAgentPerm(access: ToolAccess | undefined, required: bigint): boolean {
    return access?.agentPerm !== undefined && (access.agentPerm & required) === required;
}

function canAccess(tool: StoredTool, access: ToolAccess | undefined): boolean {
    if (tool.priv !== undefined && !hasPriv(access, tool.priv)) return false;
    if (tool.perm !== undefined && !hasPerm(access, tool.perm)) return false;
    if (tool.agentPerm !== undefined && !hasAgentPerm(access, tool.agentPerm)) return false;
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
        return { priv: context.priv, perm: context.perm, scope: context.scope ?? context.perm, agentPermissions: context.agentPermissions, agentPerm: context.agentPerm };
    }
    const owner = Number(context.owner);
    if (!context.domainId || !Number.isSafeInteger(owner) || owner <= 0) {
        return context.agentPermissions === undefined && context.agentPerm === undefined ? undefined : {
            agentPermissions: context.agentPermissions,
            agentPerm: context.agentPerm,
        };
    }
    try {
        const UserModel = require('ejun/src/model/user').default as {
            getById(domainId: string, uid: number): Promise<{ priv: number; perm: bigint; scope: bigint } | null>;
        };
        const user = await UserModel.getById(context.domainId, owner);
        if (!user) return undefined;
        return { priv: user.priv, perm: user.perm, scope: user.scope, agentPermissions: context.agentPermissions, agentPerm: context.agentPerm };
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
    if (tool.agentPerm !== undefined && !hasAgentPerm(access, tool.agentPerm)) {
        throw new Error(`Agent role is missing permission flag: ${tool.agentPerm}`);
    }
    const missingAgentPermissions = agentPermissionsForTool(tool).filter((permission) => !access?.agentPermissions?.has(permission));
    if (missingAgentPermissions.length) {
        throw new Error(`Agent role is missing permission(s): ${missingAgentPermissions.join(', ')}`);
    }
}

export default class ToolService extends Service {
    private readonly sources = new Map<string, StoredSource>();
    private readonly owners = new Map<string, string>();

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
        const agentPerm = options.agentPerm ?? fromDefinition?.agentPerm;
        if (agentPerm !== undefined && typeof agentPerm !== 'bigint') throw new Error(`tool ${name} has an invalid Agent permission flag.`);
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
            ...(agentPerm === undefined ? {} : { agentPerm }),
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

    private visible(source?: string, domainId?: string, access?: ToolAccess, mountedAddons?: ReadonlySet<string>): { source: StoredSource; tool: StoredTool }[] {
        const entries = source === undefined
            ? [...this.sources.values()]
            : this.sources.has(source) ? [this.sources.get(source)!] : [];
        const rows: { source: StoredSource; tool: StoredTool }[] = [];
        for (const entry of entries) {
            for (const tool of entry.tools) {
                if (!toolEnabled(tool)) continue;
                if (!inDomain(toolDomains(entry, tool), domainId)) continue;
                if (mountedAddons !== undefined && !mountedAddons.has(tool.addonId)) continue;
                if (access ? !canAccess(tool, access) : tool.agentPerm !== undefined || agentPermissionsForTool(tool).length > 0) continue;
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
        assertAccess(found.tool, access);
        found.tool.checker?.(context);
        const startedAt = Date.now();
        const parsedArgs = found.tool.schema ? validateToolArgs(found.tool.schema, args || {}) : (args || {});
        const result = await found.tool.execute(context, parsedArgs);
        logger.info('tool %s from %s ok in %dms', name, found.source.source, Date.now() - startedAt);
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

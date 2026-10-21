import Schema from 'schemastery';
import { PERM, PRIV } from '../model/builtin';
import { PermissionError, PrivilegeError } from '../error';
import { isSchema, schemaDescription, schemaToJsonSchema, validateToolArgs } from '../lib/tool-schema';
import type { ToolArgs, ToolBaseSelectPayload, ToolContext, ToolSpec, ToolCalledPayload } from '../lib/tool-types';
import type { Context } from '../context';
import { listAgentAddons } from './addons';
import type { VoidReturn } from './bus';

export interface ToolDeclaration {
    addonId: string;
    name: string;
    description: string;
    inputSchema: Record<string, any>;
    agentPermissions?: readonly string[];
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
    agentPermissions?: readonly string[];
    instructions?: (context: ToolInstructionsContext) => string | Promise<string>;
}

export type ToolDefinition = ToolRegisterOptions & { execute: ToolExecute };

export interface ToolAccess {
    priv?: number;
    perm?: bigint;
    scope?: bigint;
    agentPermissions?: ReadonlySet<string>;
}

export interface FrameworkToolRegistration {
    addonId: string;
    name: string;
    execute: unknown;
    checkerArgs: unknown[];
}

export interface WebServiceToolApi {
    listTools(): FrameworkToolRegistration[];
    executeTool(
        name: string,
        context: unknown,
        args: unknown,
        checkerContext: unknown,
        prepare?: (context: unknown, args: unknown) => { context: unknown; args: unknown },
    ): Promise<unknown>;
}

export interface AgentToolView {
    list(source?: string, domainId?: string, access?: ToolAccess, mountedAddons?: ReadonlySet<string>): RegisteredTool[];
    listForCatalog(domainId?: string): RegisteredTool[];
    permissionBitsForAddon(addonId: string, domainId: string, access: ToolAccess): { perm: bigint[]; priv: number[] };
    catalog(source?: string, overrides?: { name: string; description: string }[], domainId?: string, access?: ToolAccess, mountedAddons?: ReadonlySet<string>): ToolSpec[];
    get(name: string): RegisteredTool | undefined;
    instructions(context: ToolInstructionsContext, source?: string, mountedAddons?: ReadonlySet<string>): Promise<string[]>;
    execute(name: string, args: ToolArgs, context: ToolContext): Promise<unknown>;
}

interface ParsedRegistration {
    registration: FrameworkToolRegistration;
    schema?: Schema;
    options: ToolRegisterOptions;
    perm?: bigint | bigint[];
    priv?: number | number[];
    description: string;
    inputSchema: Record<string, any>;
    source: string;
    mutating: boolean;
    agentPermissions: readonly string[];
}

function readFlag<T>(value: T | (() => T) | undefined): T | undefined {
    return typeof value === 'function' ? (value as () => T)() : value;
}

function resolveAgentPermissions(addonId: string, mutating: boolean, explicit?: readonly string[]): readonly string[] {
    if (explicit !== undefined) return [...explicit];
    const addon = listAgentAddons().find((item) => item.addonId === addonId);
    if (!addon?.permissions?.length) return [];
    const permissionId = mutating ? 'write' : 'read';
    const permission = addon.permissions.find((item) => item.id === permissionId)
        || (addon.permissions.length === 1 ? addon.permissions[0] : undefined);
    return permission ? [`${addonId}:${permission.id}`] : [];
}

function parseRegistration(registration: FrameworkToolRegistration): ParsedRegistration {
    let schema: Schema | undefined;
    let options: ToolRegisterOptions = {};
    let perm: bigint | bigint[] | undefined;
    let priv: number | number[] | undefined;
    for (const item of registration.checkerArgs || []) {
        if (isSchema(item)) schema = item;
        else if (typeof item === 'bigint') perm = item;
        else if (typeof item === 'number') priv = item;
        else if (Array.isArray(item)) {
            if (typeof item[0] === 'bigint') perm = item as bigint[];
            else if (typeof item[0] === 'number') priv = item as number[];
        } else if (item && typeof item === 'object') options = item as ToolRegisterOptions;
    }
    schema ||= options.schema;
    const description = options.description || schemaDescription(schema);
    const inputSchema = options.inputSchema || (schema ? schemaToJsonSchema(schema) : undefined);
    if (!description) throw new Error(`tool ${registration.name} is missing a description.`);
    if (!inputSchema) throw new Error(`tool ${registration.name} is missing an inputSchema.`);
    const mutating = options.mutating === true;
    const agentPermissions = resolveAgentPermissions(registration.addonId, mutating, options.agentPermissions);
    if (agentPermissions.some((permission) => typeof permission !== 'string' || !permission.trim())) {
        throw new Error(`tool ${registration.name} has an invalid Agent permission requirement.`);
    }
    return {
        registration,
        schema,
        options,
        perm,
        priv,
        description,
        inputSchema,
        source: options.source || registration.addonId,
        mutating,
        agentPermissions,
    };
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

export function checkAccessPerm(access: ToolAccess | undefined, ...perms: bigint[]): void {
    if (perms.some((permission) => access?.perm !== undefined
        && ((access.perm & (access.scope ?? access.perm) & permission) === permission))) return;
    if (hasPriv(access, PRIV.USER_PRIV_USER_PROFILE)) throw new PermissionError(...perms);
    throw new PrivilegeError(PRIV.USER_PRIV_USER_PROFILE);
}

export function checkAccessPriv(access: ToolAccess | undefined, ...privs: number[]): void {
    if (!privs.some((privilege) => hasPriv(access, privilege))) throw new PrivilegeError(...privs);
}

async function resolveAccess(context: ToolContext): Promise<ToolAccess | undefined> {
    if (context.priv !== undefined || context.perm !== undefined) {
        return {
            priv: context.priv,
            perm: context.perm,
            scope: context.scope ?? context.perm,
            agentPermissions: context.agentPermissions,
        };
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

function bindToolContext(context: ToolContext, args: ToolArgs, mode?: ToolBindBase): ToolContext {
    if (!mode || mode === 'none') return context;
    const namedBaseId = Number(args?.baseId);
    const requested = mode === 'explicit' ? namedBaseId
        : mode === 'optional' && Number.isSafeInteger(namedBaseId) && namedBaseId > 0 ? namedBaseId
            : context.baseDocId;
    const baseDocId = Number.isSafeInteger(requested) && requested > 0 ? requested : 0;
    if (!baseDocId) throw new Error(mode === 'explicit' ? 'baseId is required' : 'This endpoint is not bound to a base.');
    return { ...context, baseDocId };
}

function isEnabled(tool: ParsedRegistration): boolean {
    return readFlag(tool.options.enabled) !== false;
}

function inDomain(tool: ParsedRegistration, domainId?: string): boolean {
    const domains = readFlag(tool.options.domains);
    return !domains?.length || (domainId !== undefined && domains.includes(domainId));
}

function canAccess(tool: ParsedRegistration, access: ToolAccess | undefined): boolean {
    if (tool.priv !== undefined && !hasPriv(access, tool.priv)) return false;
    if (tool.perm !== undefined && !hasPerm(access, tool.perm)) return false;
    return tool.agentPermissions.every((permission) => access?.agentPermissions?.has(permission));
}

function publicTool(tool: ParsedRegistration): RegisteredTool {
    return {
        addonId: tool.registration.addonId,
        name: tool.registration.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        source: tool.source,
        mutating: tool.mutating,
        ...(tool.agentPermissions.length ? { agentPermissions: [...tool.agentPermissions] } : {}),
    };
}

export function createAgentToolView(server: WebServiceToolApi, ctx: Context): AgentToolView {
    const registrations = () => server.listTools().map(parseRegistration);
    const visible = (
        source?: string,
        domainId?: string,
        access?: ToolAccess,
        mountedAddons?: ReadonlySet<string>,
        includeRestricted = false,
    ) => registrations().filter((tool) => isEnabled(tool)
        && inDomain(tool, domainId)
        && (source === undefined || source === tool.source)
        && (mountedAddons === undefined || mountedAddons.has(tool.registration.addonId))
        && (includeRestricted || (access
            ? canAccess(tool, access)
            : tool.agentPermissions.length === 0)));
    const findTool = (name: string) => registrations().find((tool) => tool.registration.name === name);
    return {
        list(source, domainId, access, mountedAddons) {
            return visible(source, domainId, access, mountedAddons).map(publicTool);
        },
        listForCatalog(domainId) {
            return visible(undefined, domainId, undefined, undefined, true).map(publicTool);
        },
        permissionBitsForAddon(addonId, domainId, access) {
            const perm = new Set<bigint>();
            const priv = new Set<number>();
            for (const tool of visible(undefined, domainId, undefined, undefined, true)) {
                if (tool.registration.addonId !== addonId) continue;
                for (const flag of (tool.priv === undefined ? [] : Array.isArray(tool.priv) ? tool.priv : [tool.priv])) {
                    if (flag !== 0 && hasPriv(access, flag)) priv.add(flag);
                }
                for (const flag of (tool.perm === undefined ? [] : Array.isArray(tool.perm) ? tool.perm : [tool.perm])) {
                    if (flag !== 0n && hasPerm(access, flag)) perm.add(flag);
                }
            }
            return {
                perm: [...perm].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
                priv: [...priv].sort((left, right) => left - right),
            };
        },
        catalog(source, overrides, domainId, access, mountedAddons) {
            const tools = visible(source, domainId, access, mountedAddons).map(({ registration, description, inputSchema }) => ({
                name: registration.name,
                description,
                inputSchema,
            }));
            if (!overrides?.length) return tools;
            const byName = new Map(overrides.map((entry) => [entry.name, entry.description]));
            return tools.map((tool) => ({ ...tool, description: byName.get(tool.name) || tool.description }));
        },
        get(name) {
            const tool = findTool(name);
            return tool ? publicTool(tool) : undefined;
        },
        async instructions(context, source, mountedAddons) {
            const entries = visible(source, context.domainId, undefined, mountedAddons, true);
            const seenSources = new Set<string>();
            const lines: string[] = [];
            for (const tool of entries) {
                if (seenSources.has(tool.source)) continue;
                seenSources.add(tool.source);
                const text = await tool.options.instructions?.(context);
                if (text) lines.push(text);
            }
            return lines;
        },
        async execute(name, args, context) {
            const tool = findTool(name);
            if (!tool || !isEnabled(tool) || !inDomain(tool, context.domainId)) throw new Error(`Unknown tool: ${name}`);
            if (context.sessionId && context.mountedAddons === undefined) {
                throw new Error('Agent add-on scope is unavailable for this session.');
            }
            if (context.mountedAddons && !context.mountedAddons.has(tool.registration.addonId)) {
                throw new Error(`Addon "${tool.registration.addonId}" is not mounted in this session.`);
            }
            const access = await resolveAccess(context);
            const missing = tool.agentPermissions.filter((permission) => !access?.agentPermissions?.has(permission));
            if (missing.length) throw new Error(`Agent role is missing permission(s): ${missing.join(', ')}`);
            const result = await server.executeTool(name, context, args || {}, {
                checkPerm: (...permissions: bigint[]) => checkAccessPerm(access, ...permissions),
                checkPriv: (...privileges: number[]) => checkAccessPriv(access, ...privileges),
            }, (invocationContext, invocationArgs) => {
                const parsedArgs = tool.schema
                    ? validateToolArgs(tool.schema, (invocationArgs || {}) as ToolArgs)
                    : (invocationArgs || {});
                return {
                    context: bindToolContext(invocationContext as ToolContext, parsedArgs as ToolArgs, tool.options.bindBase),
                    args: parsedArgs,
                };
            });
            if (tool.mutating) {
                ctx.emit('tool/called', {
                    name,
                    addonId: tool.registration.addonId,
                    source: tool.source,
                    domainId: context.domainId,
                    baseDocId: context.baseDocId,
                    owner: context.owner,
                });
            }
            return result;
        },
    };
}

declare module './bus' {
    interface EventMap {
        'tool/called': (payload: ToolCalledPayload) => VoidReturn;
        'tool/base-select': (payload: ToolBaseSelectPayload) => VoidReturn;
    }
}

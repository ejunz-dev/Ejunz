import { Logger } from 'ejun/src/logger';
import { Context, Service } from 'ejun/src/context';
import type { ToolArgs, ToolCalledPayload, ToolContext, ToolSpec } from './types';
import type { VoidReturn } from 'ejun/src/service/bus';

declare module 'ejun/src/context' {
    interface Context {
        tools: ToolService;
    }
}

const logger = new Logger('ejunztools/registry');

/**
 * One tool an addon contributes: its model-facing declaration and its implementation.
 *
 * The declaration is complete on its own — a consumer never needs to know which
 * addon owns a tool, where its code lives, or how its arguments reach storage.
 */
export interface ToolDeclaration {
    /** Name callers and models use. Registered once across every source. */
    name: string;
    description: string;
    inputSchema: Record<string, any>;
    /** Successful calls change stored content, so owners refresh what they show. */
    mutating?: boolean;
    /**
     * Execute the tool.
     * @param context - domain, Base, and owner the call acts for.
     * @param args - arguments as the caller supplied them.
     * @returns the tool result.
     */
    execute(context: ToolContext, args: ToolArgs): Promise<unknown>;
}

/** One addon's contribution to the registry. */
export interface ToolSource {
    /** Owner id: groups the tools, filters them by source, and tags their calls. */
    source: string;
    /** The tools this source provides. */
    tools: readonly ToolDeclaration[];
    /**
     * Instructions for clients that hand these tools to a model.
     * @param context - domain and Base the client is bound to.
     * @returns prose for that client, or an empty string to contribute none.
     */
    instructions?(context: Pick<ToolContext, 'domainId' | 'baseDocId'>): string | Promise<string>;
}

/** A registered tool together with the source that contributed it. */
export interface RegisteredTool extends ToolSpec {
    source: string;
    mutating: boolean;
}

/**
 * The single entry every tool contribution goes through.
 *
 * An addon registers its tools here while it loads, and every consumer — the MCP
 * server, `createProvider`, HTTP handlers — reads them from here, so core holds no
 * tool declarations of its own and no consumer depends on a specific addon.
 * Registering is an effect: a source's tools disappear with the addon that
 * contributed them, and a name may belong to only one source.
 */
export default class ToolService extends Service {
    private readonly sources = new Map<string, ToolSource>();
    /** Tool name → owning source id. */
    private readonly owners = new Map<string, string>();

    constructor(ctx: Context) {
        super(ctx, 'tools');
    }

    /**
     * Register one addon's tools.
     * @param source - owner id, tools, and optional model instructions.
     * @returns the disposer that removes exactly this contribution.
     * @throws when the source id is registered already, or when any tool name is taken.
     */
    register(source: ToolSource): () => void {
        if (this.sources.has(source.source)) throw new Error(`tool source ${source.source} is already registered.`);
        if (!source.tools.length) throw new Error(`tool source ${source.source} registers no tools.`);
        for (const tool of source.tools) {
            const owner = this.owners.get(tool.name);
            if (owner) throw new Error(`tool ${tool.name} is already registered by source ${owner}.`);
        }
        return this.ctx.effect(() => {
            this.sources.set(source.source, source);
            for (const tool of source.tools) this.owners.set(tool.name, source.source);
            logger.info('Registered %d tool(s) from source %s', source.tools.length, source.source);
            return () => {
                this.sources.delete(source.source);
                for (const tool of source.tools) this.owners.delete(tool.name);
            };
        });
    }

    /**
     * List registered tools.
     * @param source - restrict to one source; omitted lists every source.
     * @returns each tool with its declaration and owning source.
     */
    list(source?: string): RegisteredTool[] {
        const entries = source === undefined
            ? [...this.sources.values()]
            : this.sources.has(source) ? [this.sources.get(source)!] : [];
        return entries.flatMap(entry => entry.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            source: entry.source,
            mutating: tool.mutating === true,
        })));
    }

    /**
     * Read the model-facing catalog.
     * @param source - restrict to one source; omitted lists every source.
     * @param overrides - per-name description replacements applied to the result.
     * @returns the tools, without their owning source.
     */
    catalog(source?: string, overrides?: { name: string; description: string }[]): ToolSpec[] {
        const tools: ToolSpec[] = this.list(source).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
        if (!overrides || !overrides.length) return tools;
        const byName = new Map(overrides.map(entry => [entry.name, entry.description]));
        return tools.map(tool => {
            const description = byName.get(tool.name);
            return description ? { ...tool, description } : tool;
        });
    }

    /**
     * Read one registered tool.
     * @param name - tool name.
     * @returns the tool with its owning source, or undefined when no source registered it.
     */
    get(name: string): RegisteredTool | undefined {
        const source = this.owners.get(name);
        if (!source) return undefined;
        return this.list(source).find(tool => tool.name === name);
    }

    /**
     * Whether a tool name or a source id is registered.
     * @param id - tool name or source id.
     * @returns true when the registry holds it.
     */
    has(id: string): boolean {
        return this.owners.has(id) || this.sources.has(id);
    }

    /**
     * Instructions contributed by registered sources, in registration order.
     * @param context - domain and Base the client is bound to.
     * @param source - restrict to one source; omitted reads every source.
     * @returns the contributed prose, empty entries dropped.
     */
    async instructions(context: Pick<ToolContext, 'domainId' | 'baseDocId'>, source?: string): Promise<string[]> {
        const entries = source === undefined
            ? [...this.sources.values()]
            : this.sources.has(source) ? [this.sources.get(source)!] : [];
        const lines: string[] = [];
        for (const entry of entries) {
            if (!entry.instructions) continue;
            const text = await entry.instructions(context);
            if (text) lines.push(text);
        }
        return lines;
    }

    /**
     * Execute one registered tool.
     * @param name - tool name.
     * @param args - tool arguments.
     * @param context - domain, Base, and owner the call acts for.
     * @returns the tool result.
     * @throws when no source registered `name`.
     */
    async execute(name: string, args: ToolArgs, context: ToolContext): Promise<unknown> {
        const tool = this.get(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        const source = this.sources.get(tool.source);
        const declaration = source?.tools.find(entry => entry.name === name);
        if (!declaration) throw new Error(`Unknown tool: ${name}`);
        const startedAt = Date.now();
        const result = await declaration.execute(context, args || {});
        logger.info('tool %s from %s ok in %dms', name, tool.source, Date.now() - startedAt);
        if (tool.mutating) {
            this.ctx.emit('tool/called', {
                name,
                source: tool.source,
                domainId: context.domainId,
                baseDocId: context.baseDocId,
                owner: context.owner,
            });
        }
        return result;
    }
}

declare module 'ejun/src/service/bus' {
    interface EventMap {
        /** Emitted after a mutating tool call succeeded, so owners refresh what they show. */
        'tool/called': (payload: ToolCalledPayload) => VoidReturn;
    }
}

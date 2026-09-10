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

export default class ToolService extends Service {
    private readonly sources = new Map<string, ToolSource>();
    private readonly owners = new Map<string, string>();

    constructor(ctx: Context) {
        super(ctx, 'tools');
    }

    register(source: ToolSource): () => void {
        if (this.sources.has(source.source)) throw new Error(`tool source ${source.source} is already registered.`);
        if (!source.tools.length) throw new Error(`tool source ${source.source} registers no tools.`);
        if (source.domains && (!source.domains.length || source.domains.some(domain => !domain))) {
            throw new Error(`tool source ${source.source} declares an empty or blank domains entry.`);
        }
        for (const tool of source.tools) {
            const owner = this.owners.get(tool.name);
            if (owner) throw new Error(`tool ${tool.name} is already registered by source ${owner}.`);
        }
        return this.ctx.effect(() => {
            this.sources.set(source.source, source);
            for (const tool of source.tools) this.owners.set(tool.name, source.source);
            logger.info('Registered %d tool(s) from source %s%s', source.tools.length, source.source,
                source.domains ? ` (domains: ${source.domains.join(', ')})` : '');
            return () => {
                this.sources.delete(source.source);
                for (const tool of source.tools) this.owners.delete(tool.name);
            };
        });
    }

    private sourcesFor(source?: string, domainId?: string): ToolSource[] {
        const entries = source === undefined
            ? [...this.sources.values()]
            : this.sources.has(source) ? [this.sources.get(source)!] : [];
        return entries.filter(entry => !entry.domains || (domainId !== undefined && entry.domains.includes(domainId)));
    }

    list(source?: string, domainId?: string): RegisteredTool[] {
        return this.sourcesFor(source, domainId).flatMap(entry => entry.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            source: entry.source,
            mutating: tool.mutating === true,
        })));
    }

    catalog(source?: string, overrides?: { name: string; description: string }[], domainId?: string): ToolSpec[] {
        const tools: ToolSpec[] = this.list(source, domainId).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
        if (!overrides || !overrides.length) return tools;
        const byName = new Map(overrides.map(entry => [entry.name, entry.description]));
        return tools.map(tool => {
            const description = byName.get(tool.name);
            return description ? { ...tool, description } : tool;
        });
    }

    get(name: string): RegisteredTool | undefined {
        const source = this.owners.get(name);
        if (!source) return undefined;
        const entry = this.sources.get(source);
        const tool = entry?.tools.find(candidate => candidate.name === name);
        if (!entry || !tool) return undefined;
        return {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            source: entry.source,
            mutating: tool.mutating === true,
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
        const tool = this.get(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        const source = this.sources.get(tool.source);
        const declaration = source?.tools.find(entry => entry.name === name);
        if (!source || !declaration || !this.sourcesFor(source.source, context.domainId).length) {
            throw new Error(`Unknown tool: ${name}`);
        }
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
        'tool/called': (payload: ToolCalledPayload) => VoidReturn;
    }
}

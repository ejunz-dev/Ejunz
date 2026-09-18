import type { Context } from 'ejun/src/context';
import type { ToolDeclaration, ToolInstructionsContext, ToolSource } from './registry';

interface ToolRegistry {
    register(source: ToolSource): () => void;
}

export interface ToolPublicationRequest {
    tools: readonly ToolDeclaration[];
    domains?: readonly string[];
    enabled?: boolean;
    instructions?: (context: ToolInstructionsContext) => string | Promise<string>;
}

export interface ToolPublication {
    readonly source: string;
    readonly published: boolean;
    sync(request: ToolPublicationRequest): boolean;
    dispose(): void;
}

interface HeldRequest {
    enabled: boolean;
    domains: readonly string[];
    names: readonly string[];
    instructions?: ToolPublicationRequest['instructions'];
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function heldRequest(request: ToolPublicationRequest): HeldRequest {
    return {
        enabled: request.enabled !== false,
        domains: request.domains ? [...request.domains] : [],
        names: request.tools.map(tool => tool.name),
        instructions: request.instructions,
    };
}

function sameRequest(left: HeldRequest, right: HeldRequest): boolean {
    return left.enabled === right.enabled
        && left.instructions === right.instructions
        && sameList(left.domains, right.domains)
        && sameList(left.names, right.names);
}

function toolRegistry(ctx: Context, source: string): ToolRegistry {
    const services = ctx as any;
    const tools = typeof services.get === 'function' ? services.get('tools') : services.tools;
    if (!tools) throw new Error(`${source}: the Ejunz tool registry is unavailable`);
    return tools as ToolRegistry;
}

export function createToolPublication(ctx: Context, source: string, request?: ToolPublicationRequest): ToolPublication {
    let held: { request: HeldRequest; withdraw: () => void } | undefined;
    let disposed = false;

    const withdraw = (): void => {
        const previous = held;
        held = undefined;
        previous?.withdraw();
    };

    const publication: ToolPublication = {
        source,
        get published() {
            return held !== undefined;
        },
        sync(next) {
            if (disposed) throw new Error(`${source}: the tool publication is disposed`);
            const wanted = heldRequest(next);
            if (!wanted.enabled) {
                const changed = held !== undefined;
                withdraw();
                return changed;
            }
            if (held && sameRequest(held.request, wanted)) return false;
            withdraw();
            held = {
                request: wanted,
                withdraw: toolRegistry(ctx, source).register({
                    source,
                    ...(wanted.domains.length ? { domains: wanted.domains.slice() } : {}),
                    tools: next.tools.slice(),
                    ...(next.instructions ? { instructions: next.instructions } : {}),
                }),
            };
            return true;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            withdraw();
            release();
        },
    };

    const release = ctx.effect(() => () => {
        withdraw();
    });
    if (request) publication.sync(request);
    return publication;
}

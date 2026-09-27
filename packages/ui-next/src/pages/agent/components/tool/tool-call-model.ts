import type { ChatMessage } from '../types';

export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'web' | 'others';
export type ToolRowState = 'running' | 'ok' | 'error';

export interface ToolRowModel {
    variant: ToolRowVariant;
    title: string;
    summary: string;
    input?: string;
    output?: string;
    errorSummary?: string;
    meta?: unknown;
    filePath?: string;
    state: ToolRowState;
}

const variants: Record<string, ToolRowVariant> = {
    bash: 'bash', pwsh: 'bash', read: 'read', web_fetch: 'web', web_search: 'web', grep: 'search', glob: 'search', write: 'write', edit: 'edit', run_code: 'code',
};

const titles: Record<string, string> = { pwsh: 'Pwsh', web_search: 'Search', web_fetch: 'Fetch', cordis_package_inspect: 'Inspect', cordis_runtime_inspect: 'Inspect', cordis_run: 'Run Cordis Plugin', cordis_stop: 'Stop Cordis Plugin', cordis_undefine: 'Remove Cordis Plugin' };

const summaryKeys: Record<ToolRowVariant, string[]> = {
    bash: ['description', 'command'],
    read: ['path', 'file_path', 'url'],
    search: ['query', 'pattern', 'url'],
    write: ['path', 'file_path'],
    edit: ['path', 'file_path'],
    code: ['description'],
    web: ['query', 'url'],
    others: [],
};

function firstLine(value: string): string {
    return value.split('\n', 1)[0] ?? value;
}

function parse(value: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export function toolVariant(name: string): ToolRowVariant {
    return variants[name] ?? 'others';
}

export function toolTitle(name: string): string {
    return titles[name] ?? (toolVariant(name) === 'others' ? 'Tool call' : toolVariant(name)[0].toUpperCase() + toolVariant(name).slice(1));
}

export function toolSummary(name: string, input: string, cwd?: string): string {
    const variant = toolVariant(name);
    const parsed = parse(input);
    let value: string | undefined;
    if (parsed) {
        for (const key of summaryKeys[variant]) {
            if (typeof parsed[key] === 'string' && parsed[key]) { value = parsed[key] as string; break; }
        }
        if (!value) value = Object.values(parsed).find((item): item is string => typeof item === 'string' && item.length > 0);
    }
    value ??= input;
    if (cwd && value.startsWith(`${cwd}/`)) value = value.slice(cwd.length + 1);
    return variant === 'others' && name ? `${name} · ${firstLine(value)}` : firstLine(value);
}

export function toolFilePath(name: string, input: string): string | undefined {
    const variant = toolVariant(name);
    if (!['read', 'write', 'edit'].includes(variant)) return undefined;
    const parsed = parse(input);
    const value = parsed?.path ?? parsed?.file_path;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function toolInput(name: string, input: string): string | undefined {
    if (!input) return undefined;
    const parsed = parse(input);
    if (toolVariant(name) === 'code' && parsed && typeof parsed.code === 'string') return parsed.code;
    return parsed ? JSON.stringify(parsed, null, 2) : input;
}

export function toolRowModel(message: ChatMessage): ToolRowModel {
    const name = message.toolName ?? 'tool';
    const input = message.toolInput ?? '';
    const output = message.toolOutput || undefined;
    const state: ToolRowState = message.toolError ? 'error' : message.running ? 'running' : 'ok';
    const errorSummary = state === 'error' ? (output ? firstLine(output) : '失败') : undefined;
    const inputText = toolInput(name, input);
    const filePath = toolFilePath(name, input);
    return {
        variant: toolVariant(name),
        title: toolTitle(name),
        summary: errorSummary ?? toolSummary(name, input),
        ...(inputText === undefined ? {} : { input: inputText }),
        ...(output === undefined ? {} : { output }),
        ...(errorSummary === undefined ? {} : { errorSummary }),
        ...(message.toolMeta === undefined ? {} : { meta: message.toolMeta }),
        ...(filePath === undefined ? {} : { filePath }),
        state,
    };
}

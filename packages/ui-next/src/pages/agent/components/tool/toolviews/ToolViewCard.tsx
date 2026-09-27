import type { ReactNode } from 'react';
import type { ToolRowVariant } from '../tool-call-model';

interface ToolViewCardProps {
    variant: ToolRowVariant;
    input?: string;
    output?: string;
    meta?: unknown;
    error?: boolean;
}

interface ReadMeta {
    lines: { number: number; text: string }[];
}

interface DiffMeta {
    diffs: { path: string; oldText: string | null; newText: string }[];
}

interface SearchMeta {
    shape: 'matches' | 'paths';
    files?: { path: string; matches: { lineNumber: number; line: string }[] }[];
    paths?: string[];
}

interface WebMeta {
    kind: 'search' | 'fetch';
    sources?: { url: string; title?: string; snippet?: string }[];
    answer?: string;
    url?: string;
    statusCode?: number;
}

const labels: Record<ToolRowVariant, string> = {
    bash: '终端',
    read: '读取',
    search: '搜索结果',
    write: '写入',
    edit: '编辑',
    code: '代码',
    web: '网页结果',
    others: '工具结果',
};

function TextBlock({ value, className = '' }: { value: string; className?: string }) {
    return <pre className={`eja-toolViewOutput ${className}`}>{value}</pre>;
}

function ReadView({ output, meta }: { output: string; meta?: ReadMeta | null }) {
    const lines = meta?.lines ?? output.split('\n').map((text, index) => ({ number: index + 1, text }));
    return <ol className="eja-readView">{lines.map((line) => <li key={`${line.number}-${line.text}`}><span>{line.number}</span><code>{line.text || ' '}</code></li>)}</ol>;
}

function DiffView({ output, meta }: { output: string; meta?: DiffMeta | null }) {
    const text = meta?.diffs.map((diff) => [
        `--- ${diff.path}`,
        `+++ ${diff.path}`,
        ...(diff.oldText === null ? diff.newText.split('\n').map((line) => `+${line}`) : [
            ...diff.oldText.split('\n').map((line) => `-${line}`),
            ...diff.newText.split('\n').map((line) => `+${line}`),
        ]),
    ].join('\n')).join('\n') ?? output;
    const lines = text.split('\n');
    return <pre className="eja-diffView">{lines.map((line, index) => <span key={`${index}-${line}`} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : ''}>{line}{index < lines.length - 1 ? '\n' : ''}</span>)}</pre>;
}

function SearchView({ output, meta }: { output: string; meta?: SearchMeta | null }) {
    const lines = meta?.shape === 'paths'
        ? meta.paths ?? []
        : meta?.files?.flatMap((file) => file.matches.map((match) => `${file.path}:${match.lineNumber}: ${match.line}`)) ?? output.split('\n').filter(Boolean);
    return <ul className="eja-searchView">{lines.map((line) => <li key={line}>{line}</li>)}</ul>;
}

function WebView({ output, meta }: { output: string; meta?: WebMeta | null }) {
    const sources = meta?.kind === 'search' ? meta.sources ?? [] : [];
    if (sources.length > 0 || meta?.answer) {
        return <div className="eja-webView">
            {meta?.answer && <p>{meta.answer}</p>}
            {sources.map((source) => <p key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a>{source.snippet && <span>：{source.snippet}</span>}</p>)}
        </div>;
    }
    if (meta?.kind === 'fetch' && meta.url) return <div className="eja-webView"><a href={meta.url} target="_blank" rel="noreferrer">{meta.url}</a>{meta.statusCode !== undefined && <span> · HTTP {meta.statusCode}</span>}<TextBlock value={output} /></div>;
    return <div className="eja-webView">{output.split(/(https?:\/\/[^\s]+)/g).map((part, index) => /^https?:\/\//.test(part) ? <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a> : <span key={index}>{part}</span>)}</div>;
}

function objectMeta(meta: unknown): Record<string, unknown> | null {
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : null;
}

function readMeta(meta: unknown): ReadMeta | null {
    const value = objectMeta(meta);
    if (value?.card !== 'read' || !Array.isArray(value.lines)) return null;
    const lines = value.lines.flatMap((line) => {
        const item = objectMeta(line);
        return typeof item?.number === 'number' && typeof item.text === 'string' ? [{ number: item.number, text: item.text }] : [];
    });
    return lines.length === value.lines.length ? { lines } : null;
}

function diffMeta(meta: unknown): DiffMeta | null {
    const value = objectMeta(meta);
    if (value?.card !== 'diff' || !Array.isArray(value.diffs)) return null;
    const diffs = value.diffs.flatMap((diff) => {
        const item = objectMeta(diff);
        return typeof item?.path === 'string' && typeof item.newText === 'string' && (item.oldText === null || typeof item.oldText === 'string')
            ? [{ path: item.path, oldText: item.oldText, newText: item.newText }] : [];
    });
    return diffs.length === value.diffs.length ? { diffs } : null;
}

function searchMeta(meta: unknown): SearchMeta | null {
    const value = objectMeta(meta);
    if (value?.card !== 'search' || (value.shape !== 'matches' && value.shape !== 'paths')) return null;
    if (value.shape === 'paths' && Array.isArray(value.paths) && value.paths.every((path) => typeof path === 'string')) return { shape: 'paths', paths: value.paths };
    if (!Array.isArray(value.files)) return null;
    const files = value.files.flatMap((file) => {
        const item = objectMeta(file);
        if (typeof item?.path !== 'string' || !Array.isArray(item.matches)) return [];
        const matches = item.matches.flatMap((match) => {
            const entry = objectMeta(match);
            return typeof entry?.lineNumber === 'number' && typeof entry.line === 'string' ? [{ lineNumber: entry.lineNumber, line: entry.line }] : [];
        });
        return matches.length === item.matches.length ? [{ path: item.path, matches }] : [];
    });
    return files.length === value.files.length ? { shape: 'matches', files } : null;
}

function webMeta(meta: unknown): WebMeta | null {
    const value = objectMeta(meta);
    if (value?.card !== 'web' || (value.kind !== 'search' && value.kind !== 'fetch')) return null;
    if (value.kind === 'fetch') return typeof value.url === 'string' ? { kind: 'fetch', url: value.url, ...(typeof value.statusCode === 'number' ? { statusCode: value.statusCode } : {}) } : null;
    if (!Array.isArray(value.sources)) return typeof value.answer === 'string' ? { kind: 'search', answer: value.answer } : null;
    const sources = value.sources.flatMap((source) => {
        const item = objectMeta(source);
        return typeof item?.url === 'string' ? [{ url: item.url, ...(typeof item.title === 'string' ? { title: item.title } : {}), ...(typeof item.snippet === 'string' ? { snippet: item.snippet } : {}) }] : [];
    });
    return sources.length === value.sources.length ? { kind: 'search', sources, ...(typeof value.answer === 'string' ? { answer: value.answer } : {}) } : null;
}

function structuredView(variant: ToolRowVariant, output: string, meta: unknown): ReactNode | null {
    if (variant === 'read') {
        const value = readMeta(meta);
        return value ? <ReadView output={output} meta={value} /> : null;
    }
    if (variant === 'write' || variant === 'edit') {
        const value = diffMeta(meta);
        return value ? <DiffView output={output} meta={value} /> : null;
    }
    if (variant === 'search') {
        const value = searchMeta(meta);
        return value ? <SearchView output={output} meta={value} /> : null;
    }
    if (variant === 'web') {
        const value = webMeta(meta);
        return value ? <WebView output={output} meta={value} /> : null;
    }
    return null;
}

export function ToolViewCard({ variant, input, output, meta, error }: ToolViewCardProps) {
    const structured = output && !error ? structuredView(variant, output, meta) : null;
    const showInput = input && (structured === null || variant === 'bash' || variant === 'code' || variant === 'others');
    return <div className={`eja-toolView eja-toolView-${variant}`}>
        <div className="eja-toolViewHeader"><span>{labels[variant]}</span><span>{error ? '失败' : output ? '完成' : '运行中…'}</span></div>
        {showInput && <pre className="eja-toolViewInput">{input}</pre>}
        {structured ?? (output && (error ? <TextBlock value={output} className="error" /> : variant === 'read' ? <ReadView output={output} /> : variant === 'edit' || variant === 'write' ? <DiffView output={output} /> : variant === 'search' ? <SearchView output={output} /> : variant === 'web' ? <WebView output={output} /> : variant === 'others' && output.includes('http') ? <WebView output={output} /> : <TextBlock value={output} />))}
    </div>;
}

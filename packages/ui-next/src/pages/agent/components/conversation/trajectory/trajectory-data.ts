import type { ChatMessage } from '../../types';

export type TrajectoryCellKind = 'system' | 'user' | 'context' | 'compacted' | 'message' | 'tool' | 'subtool';

export interface TrajectoryRow {
    key: string;
    index: number;
    message: ChatMessage;
    kind: TrajectoryCellKind;
    turn: number | null;
    group: string;
    durationSeconds: number | null;
}

export interface TrajectoryTurnModel {
    turn: number | null;
    rows: readonly TrajectoryRow[];
}

export function flattenMessages(messages: readonly ChatMessage[]): ChatMessage[] {
    return messages.flatMap((message) => {
        const { children, ...flat } = message;
        return [flat, ...(children ? flattenMessages(children) : [])];
    });
}

export function trajectoryKind(message: ChatMessage): TrajectoryCellKind {
    if (message.role === 'assistant') return 'message';
    if (message.role === 'compaction') return 'compacted';
    if (message.role === 'tool') return message.parentCallId ? 'subtool' : 'tool';
    if (message.role === 'retry') return 'system';
    return message.role;
}

function assistantStep(message: ChatMessage): number | null {
    const match = message.key.match(/^assistant-(?:stream-)?[^-]+-(\d+)-/);
    return match ? Number(match[1]) : null;
}

function buildRows(messages: readonly ChatMessage[]): TrajectoryRow[] {
    let turn = 0;
    let step = 0;
    let previousTime: number | null = null;
    let started = false;
    return flattenMessages(messages).map((message, index) => {
        const kind = trajectoryKind(message);
        if (kind === 'user') {
            turn += 1;
            step = 0;
            started = true;
        }
        const parsedStep = assistantStep(message);
        if (parsedStep !== null) step = parsedStep;
        if (kind === 'message' && parsedStep === null) step += 1;
        const durationSeconds = previousTime === null
            ? null
            : Math.max(0, (message.time - previousTime) / 1000);
        previousTime = message.time;
        const group = kind === 'user' || kind === 'context' || kind === 'system' || kind === 'compacted'
            ? 'Message'
            : `Step ${Math.max(1, step)}`;
        return {
            key: message.key,
            index,
            message,
            kind,
            turn: started ? Math.max(1, turn) : null,
            group,
            durationSeconds,
        };
    });
}

export function deriveTrajectoryLayout(messages: readonly ChatMessage[]): TrajectoryTurnModel[] {
    const groups = new Map<number | null, TrajectoryRow[]>();
    for (const row of buildRows(messages)) {
        const rows = groups.get(row.turn) ?? [];
        rows.push(row);
        groups.set(row.turn, rows);
    }
    return [...groups.entries()].map(([turn, rows]) => ({ turn, rows }));
}

export function formatElapsedSeconds(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return '—';
    if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function rowText(row: TrajectoryRow): string {
    const { message } = row;
    if (row.kind === 'compacted') return message.compactionSummary ?? 'Compacted history';
    if (row.kind === 'tool') return `${message.toolName ?? 'Tool'}${message.toolOutput ? ` · ${message.toolOutput}` : ''}`;
    if (row.kind === 'subtool') return `${message.toolName ?? 'Subtool'}${message.toolOutput ? ` · ${message.toolOutput}` : ''}`;
    return message.text || message.contextSummary || '—';
}

export function rowSearchText(row: TrajectoryRow): string {
    const message = row.message;
    return [row.kind, row.group, message.text, message.toolName, message.toolInput, message.toolOutput, message.contextLabel, message.compactionSummary]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
}

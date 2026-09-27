import type { ChatMessage, ChatSegment, QueueItem } from '../components/types';
import { FILE_INJECTION_PLUGIN, FILE_INJECTION_SECTION, parseFileInjection, type UploadedFileMeta } from './uploads';

export type JsonObject = Record<string, unknown>;

export interface ContentBlock extends JsonObject {
    type: string;
    text?: string;
}

export interface SessionEvent {
    type: string;
    seq: number;
    time: number;
    data: unknown;
}

export interface HistoryEntry {
    event: SessionEvent;
    /** Runtime provenance captured when this event was persisted. */
    runtimeId?: string;
    /** Runtime machine name captured when this event was persisted. */
    host?: string;
}

export function asObject(value: unknown): JsonObject {
    return value && typeof value === 'object' ? value as JsonObject : {};
}

export function asContent(value: unknown): ContentBlock[] {
    if (!Array.isArray(value)) return [];
    return value.filter((block): block is ContentBlock => {
        const item = asObject(block);
        return typeof item.type === 'string';
    });
}

export function blockSegment(block: ContentBlock): ChatSegment | null {
    const text = typeof block.text === 'string'
        ? block.text
        : block.type === 'thinking' && typeof block.thinking === 'string'
            ? block.thinking
            : block.type === 'input_text' && typeof block.input_text === 'string'
                ? block.input_text
                : '';
    if (!text) return null;
    return { kind: block.type === 'thinking' || block.type === 'reasoning' ? 'reasoning' : 'text', text };
}

export function contentSegments(content: unknown): ChatSegment[] {
    return asContent(content).map(blockSegment).filter((segment): segment is ChatSegment => segment !== null);
}

export function contentText(content: unknown): string {
    return contentSegments(content).map((segment) => segment.text).join('');
}

function toolResultText(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content.map((block) => {
        const value = asObject(block);
        if (typeof value.text === 'string') return value.text;
        if (Array.isArray(value.content)) return toolResultText(value.content);
        return JSON.stringify(block, null, 2);
    }).filter(Boolean).join('\n');
}

function toolResultHasError(content: unknown): boolean {
    return Array.isArray(content) && content.some((block) => {
        const value = asObject(block);
        return value.isError === true || toolResultHasError(value.content);
    });
}

function failureMessage(failure: unknown): string {
    if (failure === null || typeof failure !== 'object') return String(failure);
    const record = failure as { code?: unknown; message?: unknown };
    if (record.code === 'AUTH') return 'API key is invalid';
    if (typeof record.message === 'string') return record.message;
    return JSON.stringify(failure) || String(failure);
}

export function eventFailureMessage(event: SessionEvent): string | null {
    const data = asObject(event.data);
    if (event.type === 'turn/error') return typeof data.message === 'string' ? data.message : '回合执行失败';
    if (event.type !== 'turn/end') return null;
    const reason = asObject(data.reason);
    return reason.kind === 'error' ? failureMessage(reason.error) : null;
}

export function latestHistoryError(entries: readonly HistoryEntry[]): string | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!entry) continue;
        const message = eventFailureMessage(entry.event);
        if (message !== null) return message;
    }
    return null;
}

export function messageContent(data: unknown): unknown {
    const value = asObject(data);
    const nested = asObject(value.message);
    return value.content ?? nested.content;
}

export function contextProvenance(source: JsonObject): { role: 'inject' | 'recall'; label?: string } {
    const kind = typeof source.kind === 'string' ? source.kind : 'context';
    if (kind === 'plugin' && source.plugin === FILE_INJECTION_PLUGIN) return { role: 'inject', label: '文件注入' };
    if (kind === 'plugin' && typeof source.plugin === 'string') return { role: 'inject', label: source.plugin };
    if (kind === 'skill-invocation' && typeof source.name === 'string') return { role: 'inject', label: source.name };
    if (kind === 'session-reference' && Array.isArray(source.references)) {
        const labels = source.references.map((item) => asObject(item).label).filter((value): value is string => typeof value === 'string' && value.length > 0);
        return { role: 'recall', label: labels.join(', ') || kind };
    }
    if (kind === 'agent-instructions' && Array.isArray(source.changes)) {
        const paths = source.changes.map((item) => asObject(item).path).filter((value): value is string => typeof value === 'string' && value.length > 0);
        return { role: 'inject', label: paths.join(', ') || kind };
    }
    return { role: kind === 'session-reference' ? 'recall' : 'inject', label: kind };
}

export function fileInjectionFiles(source: JsonObject): UploadedFileMeta[] {
    if (source.plugin !== FILE_INJECTION_PLUGIN) return [];
    const sections = Array.isArray(source.sections) ? source.sections.map(asObject) : [];
    const section = sections.find((item) => item.name === FILE_INJECTION_SECTION) ?? sections[0];
    return section && typeof section.text === 'string' ? parseFileInjection(section.text) : [];
}

export function eventTurnStep(event: SessionEvent): { turn: string; step: string } {
    const data = asObject(event.data);
    return {
        turn: String(data.turn ?? '0'),
        step: String(data.step ?? '0'),
    };
}

export function assistantStreamKey(event: SessionEvent): string {
    const { turn, step } = eventTurnStep(event);
    return `assistant-stream-${turn}-${step}`;
}

export function assistantKey(event: SessionEvent): string {
    const { turn, step } = eventTurnStep(event);
    return `assistant-${turn}-${step}-${event.seq}`;
}

export function eventMessage(event: SessionEvent): ChatMessage | null {
    const data = asObject(event.data);
    if (event.type === 'user/message' || event.type === 'assistant/message') {
        const segments = contentSegments(messageContent(event.data));
        const text = segments.map((segment) => segment.text).join('');
        if (!text) return null;
        const source = asObject(asObject(event.data).source);
        const context = event.type === 'user/message' && source.kind !== 'user';
        const provenance = context ? contextProvenance(source) : undefined;
        const injectedFiles = context ? fileInjectionFiles(source) : [];
        return {
            key: context ? `context-${String(source.plugin ?? source.kind ?? 'unknown')}` : event.type === 'user/message' ? `user-${event.seq}` : assistantKey(event),
            role: context ? 'context' : event.type === 'user/message' ? 'user' : 'assistant',
            text,
            ...(event.type === 'assistant/message' ? { segments } : {}),
            ...(provenance ? { contextRole: provenance.role, contextLabel: provenance.label, contextSummary: source.form === 'notice' && typeof source.summary === 'string' ? source.summary : undefined, contextSource: source, contextForm: typeof source.form === 'string' ? source.form : undefined } : {}),
            ...(injectedFiles.length ? { contextFiles: injectedFiles } : {}),
            eventType: event.type,
            time: event.time,
            running: false,
        };
    }
    if (event.type === 'assistant/chunk') {
        const chunk = asObject(data.chunk);
        const text = typeof chunk.text === 'string'
            ? chunk.text
            : typeof data.text === 'string' ? data.text : '';
        if (!text) return null;
        const kind = String(chunk.type ?? data.kind ?? '').includes('reason') ? 'reasoning' : 'text';
        return {
            key: assistantStreamKey(event),
            role: 'assistant',
            text,
            segments: [{ kind, text } as ChatSegment],
            eventType: event.type,
            time: event.time,
            running: true,
        };
    }
    if (event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch') {
        const parentCallId = typeof data.parentCallId === 'string' ? data.parentCallId : undefined;
        const rootCallId = typeof data.rootCallId === 'string' ? data.rootCallId : parentCallId;
        const subCallId = typeof data.subCallId === 'string' ? data.subCallId : undefined;
        const name = typeof data.name === 'string' ? data.name : 'tool';
        const input = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}, null, 2);
        const content = Array.isArray(data.content) ? contentText(data.content) || JSON.stringify(data.content, null, 2) : typeof data.output === 'string' ? data.output : '';
        return { key: `tool-${subCallId ?? event.seq}`, role: 'tool', text: `${event.type === 'tool/code-dispatch' ? '结果' : '调用'} ${name}\n${event.type === 'tool/code-dispatch' ? content : input}`, toolName: name, toolInput: input, toolOutput: event.type === 'tool/code-dispatch' ? content : undefined, ...(data.meta === undefined ? {} : { toolMeta: data.meta }), parentCallId, rootCallId, subCallId, eventType: event.type, time: event.time, running: event.type === 'tool/code-dispatch-start', toolError: data.isError === true };
    }
    if (event.type === 'tool/call') {
        const callId = typeof data.callId === 'string' ? data.callId : typeof data.id === 'string' ? data.id : undefined;
        const name = typeof data.name === 'string' ? data.name : typeof data.toolName === 'string' ? data.toolName : 'tool';
        const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}, null, 2);
        return {
            key: `tool-${callId ?? event.seq}`,
            role: 'tool',
            text: `调用 ${name}\n${args}`,
            toolName: name,
            toolInput: args,
            eventType: event.type,
            time: event.time,
            callId,
            rootCallId: callId,
            running: true,
        };
    }
    if (event.type === 'tool/result') {
        const message = asObject(data.message);
        const source = asObject(message.source);
        const callId = typeof data.callId === 'string' ? data.callId : typeof source.callId === 'string' ? source.callId : typeof data.id === 'string' ? data.id : undefined;
        const result = Array.isArray(message.content)
            ? toolResultText(message.content) || (data.error ? `${String(asObject(data.error).name ?? 'Error')}: ${String(asObject(data.error).code ?? 'UNKNOWN')}` : JSON.stringify(message.content, null, 2))
            : typeof data.result === 'string' ? data.result : JSON.stringify(data.result ?? data, null, 2);
        const toolError = data.error !== undefined || toolResultHasError(message.content);
        return {
            key: `tool-${callId ?? event.seq}`,
            role: 'tool',
            text: `结果${toolError ? '（错误）' : ''}\n${result}`,
            toolOutput: result,
            ...(data.meta === undefined ? {} : { toolMeta: data.meta }),
            toolError,
            eventType: event.type,
            time: event.time,
            callId,
            rootCallId: callId,
            running: false,
        };
    }
    if (event.type === 'compaction/summary') {
        return { key: `compaction-${event.seq}`, role: 'compaction', text: '', eventType: event.type, time: event.time, compactionSummary: typeof data.summary === 'string' ? data.summary : undefined, shadowedItemCount: typeof data.shadowedItemCount === 'number' ? data.shadowedItemCount : undefined, shadowedTokenCount: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : undefined };
    }
    if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
        const retryId = typeof data.retryId === 'string' ? data.retryId : String(event.seq);
        const retry = typeof data.retry === 'number' ? data.retry : undefined;
        return { key: `retry-${retryId}`, role: 'retry', text: typeof data.failure === 'string' ? data.failure : '', eventType: event.type, time: event.time, retry, retryDelayMs: typeof data.delayMs === 'number' ? data.delayMs : undefined, retryState: event.type === 'llm/retry-started' ? 'started' : 'scheduled' };
    }
    if (event.type === 'turn/error' || event.type === 'turn/max-tokens') {
        const message = typeof data.message === 'string' ? data.message : event.type === 'turn/max-tokens' ? '已达到输出上限' : '回合执行失败';
        return { key: `system-${event.seq}`, role: 'system', text: message, eventType: event.type, time: event.time };
    }
    const turnError = eventFailureMessage(event);
    if (turnError !== null) {
        return { key: `system-${event.seq}`, role: 'system', text: turnError, eventType: 'turn/error', time: event.time };
    }
    return null;
}

export function settleRunningMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => ({
        ...message,
        ...(message.running ? { running: false } : {}),
        ...(message.children ? { children: settleRunningMessages(message.children) } : {}),
    }));
}

export function applyEvent(messages: ChatMessage[], event: SessionEvent, origin?: Pick<HistoryEntry, 'host' | 'runtimeId'>): ChatMessage[] {
    const settled = event.type === 'turn/end' ? settleRunningMessages(messages) : messages;
    const rawNext = eventMessage(event);
    const host = origin?.host ?? origin?.runtimeId;
    const hostLabel = host === undefined || origin?.runtimeId === undefined || host === origin.runtimeId
        ? host
        : `${host} (${origin.runtimeId})`;
    const next = rawNext === null || hostLabel === undefined ? rawNext : { ...rawNext, host: hostLabel };
    if (next === null) {
        if (event.type === 'assistant/message') {
            const streamKey = assistantStreamKey(event);
            return settled.filter((message) => message.key !== streamKey);
        }
        return settled;
    }
    if (event.type === 'assistant/chunk') {
        const index = settled.findIndex((message) => message.key === next.key);
        if (index < 0) return [...settled, next];
        const copy = settled.slice();
        const previous = copy[index];
        const previousSegments = previous.segments ?? [{ kind: 'text' as const, text: previous.text }];
        const incoming = next.segments ?? [{ kind: 'text' as const, text: next.text }];
        const segments = previousSegments.slice();
        const last = segments[segments.length - 1];
        const first = incoming[0];
        if (last && first && last.kind === first.kind) {
            segments[segments.length - 1] = { kind: last.kind, text: last.text + first.text };
            segments.push(...incoming.slice(1));
        } else {
            segments.push(...incoming);
        }
        const host = next.host ?? previous.host;
        copy[index] = { ...previous, text: previous.text + next.text, segments, time: next.time, running: true, ...(host === undefined ? {} : { host }) };
        return copy;
    }
    if (event.type === 'assistant/message') {
        const streamKey = assistantStreamKey(event);
        const previous = settled.find((message) => message.key === next.key || message.key === streamKey);
        const host = next.host ?? previous?.host;
        const final = host === undefined ? next : { ...next, host };
        return [...settled.filter((message) => message.key !== streamKey && message.key !== next.key), final];
    }
    if (event.type === 'tool/result' && next.callId) {
        const index = settled.findIndex((message) => message.callId === next.callId);
        if (index >= 0) {
            const copy = settled.slice();
            const previous = copy[index];
            const host = next.host ?? previous.host;
            copy[index] = { ...next, toolName: previous.toolName, toolInput: previous.toolInput, ...(host === undefined ? {} : { host }) };
            return copy;
        }
    }
    const index = settled.findIndex((message) => message.key === next.key);
    if (index >= 0) {
        const copy = settled.slice();
        const host = next.host ?? copy[index].host;
        copy[index] = { ...next, ...(host === undefined ? {} : { host }) };
        return copy;
    }
    return [...messages, next];
}

export function flattenToolTree(messages: ChatMessage[]): ChatMessage[] {
    return messages.flatMap((message) => {
        const { children, ...flat } = message;
        return [flat, ...(children ? flattenToolTree(children) : [])];
    });
}

export function foldToolTree(messages: ChatMessage[]): ChatMessage[] {
    const children = new Map<string, ChatMessage[]>();
    const roots: ChatMessage[] = [];
    for (const message of messages) {
        if (message.parentCallId) {
            const list = children.get(message.parentCallId) ?? [];
            list.push(message);
            children.set(message.parentCallId, list);
        } else {
            roots.push(message);
        }
    }
    const attach = (message: ChatMessage): ChatMessage => {
        const nested = children.get(message.callId ?? message.subCallId ?? '');
        return nested?.length ? { ...message, children: nested.map(attach) } : message;
    };
    return roots.map(attach);
}

function settleHistoryMessage(message: ChatMessage): ChatMessage {
    return {
        ...message,
        running: false,
        ...(message.children ? { children: message.children.map(settleHistoryMessage) } : {}),
    };
}

export function fileInjectionsAfterUser(messages: ChatMessage[]): ChatMessage[] {
    const moved = new Map<number, ChatMessage[]>();
    const hidden = new Set<number>();
    let pending: { index: number; message: ChatMessage }[] = [];
    messages.forEach((message, index) => {
        if (message.role === 'context' && (message.contextFiles?.length ?? 0) > 0) {
            pending.push({ index, message });
            return;
        }
        if (message.role !== 'user' || pending.length === 0) return;
        for (const entry of pending) hidden.add(entry.index);
        moved.set(index, pending.map((entry) => entry.message));
        pending = [];
    });
    if (hidden.size === 0) return messages;
    const result: ChatMessage[] = [];
    messages.forEach((message, index) => {
        if (hidden.has(index)) return;
        result.push(message);
        const injected = moved.get(index);
        if (injected !== undefined) result.push(...injected);
    });
    return result;
}

export function eventsToMessages(entries: HistoryEntry[]): ChatMessage[] {
    const messages = foldToolTree(entries.reduce<ChatMessage[]>((items, entry) => applyEvent(items, entry.event, entry), [])).map(settleHistoryMessage);
    return fileInjectionsAfterUser(messages);
}

export function queueItems(value: unknown[]): QueueItem[] {
    return value.map((item) => {
        const row = asObject(item);
        const message = asObject(row.message);
        const text = contentText(message.content);
        return { id: String(row.id ?? ''), preview: text || '待发送消息', ...(text ? { text } : {}) };
    }).filter((item) => item.id !== '');
}

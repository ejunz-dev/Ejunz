import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconChevronDownOutline14 } from '../../../icons';
import type { ChatMessage } from '../../types';
import { ChatMessageView } from './ChatMessage';
import css from './ChatView.module.css';

interface ChatViewProps {
    messages: ChatMessage[];
    running: boolean;
    runningTurnStartTime: number | null;
    historyHasMore: boolean;
    loadingOlder: boolean;
    loadedMessages: number;
    totalMessages: number | null;
    historyPageSize: number;
    onLoadOlder: () => void;
    onOpenFile?: (path: string) => void;
    onOpenDetails?: (message: ChatMessage) => void;
}

interface ScrollAnchor {
    key: string;
    top: number;
}

const FOLLOW_THRESHOLD = 1;
const TURN_STATUS_LABELS = ['Deep diving...', 'Thinking...', 'Reasoning...', 'Working...', 'Exploring...'];
const TURN_STATUS_INTERVAL_MS = 15000;

function scrollPortOf(element: HTMLElement): HTMLElement {
    const host = element.closest('[data-conversation-scroll]');
    return host instanceof HTMLElement ? host : element;
}

function anchorOf(local: HTMLElement, scrollElement: HTMLElement): ScrollAnchor | null {
    const viewport = scrollElement.getBoundingClientRect();
    const row = [...local.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
        .find((item) => item.getBoundingClientRect().bottom > viewport.top);
    if (!row?.dataset.chatAnchorKey) return null;
    return {
        key: row.dataset.chatAnchorKey,
        top: row.getBoundingClientRect().top - viewport.top,
    };
}

function pinnedOf(scrollElement: HTMLElement): boolean {
    return scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <= FOLLOW_THRESHOLD;
}

function olderHistoryRange(loadedMessages: number, totalMessages: number | null, pageSize: number): string {
    if (totalMessages === null) return `再 ${pageSize} 条消息`;
    const end = Math.max(1, totalMessages - loadedMessages);
    const start = Math.max(1, end - pageSize + 1);
    return `${start}-${end}`;
}

function formatRunDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return minutes > 0 ? `${minutes}:${seconds}` : `${totalSeconds}s`;
}

function TurnStatus({ startTime }: { startTime: number | null }) {
    const [mountedAt] = useState(() => Date.now());
    const anchor = startTime ?? mountedAt;
    const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor));
    useEffect(() => {
        const update = () => setElapsedMs(Math.max(0, Date.now() - anchor));
        update();
        const timer = window.setInterval(update, 1000);
        return () => window.clearInterval(timer);
    }, [anchor]);
    const label = TURN_STATUS_LABELS[Math.floor(elapsedMs / TURN_STATUS_INTERVAL_MS) % TURN_STATUS_LABELS.length];
    return <div className={css.turnStatus} role="status" aria-live="polite">
        {label}
        {elapsedMs >= 15000 && <span className={css.turnStatusClock}>{formatRunDuration(elapsedMs)}</span>}
    </div>;
}

export function ChatView({ messages, running, runningTurnStartTime, historyHasMore, loadingOlder, loadedMessages, totalMessages, historyPageSize, onLoadOlder, onOpenFile, onOpenDetails }: ChatViewProps) {
    const olderRange = olderHistoryRange(loadedMessages, totalMessages, historyPageSize);
    const localRef = useRef<HTMLDivElement>(null);
    const anchorRef = useRef<ScrollAnchor | null>(null);
    const observedTopRef = useRef<number | null>(null);
    const lastTailKeyRef = useRef<string | null>(null);
    const atBottomRef = useRef(true);
    const [atBottom, setAtBottom] = useState(true);

    const followToBottom = useCallback((scrollElement: HTMLElement) => {
        scrollElement.scrollTop = scrollElement.scrollHeight;
        observedTopRef.current = scrollElement.scrollTop;
        atBottomRef.current = true;
        setAtBottom(true);
    }, []);

    const toBottom = useCallback(() => {
        const local = localRef.current;
        if (!local) return;
        anchorRef.current = null;
        followToBottom(scrollPortOf(local));
    }, [followToBottom]);

    useEffect(() => {
        const local = localRef.current;
        if (!local) return undefined;
        const scrollElement = scrollPortOf(local);
        const onScroll = () => {
            const top = scrollElement.scrollTop;
            const observedTop = observedTopRef.current;
            if (observedTop !== null && Math.abs(top - observedTop) <= 1) {
                observedTopRef.current = null;
            } else {
                const atBottom = pinnedOf(scrollElement);
                atBottomRef.current = atBottom;
                setAtBottom(atBottom);
            }
            if (!atBottomRef.current && loadingOlder) {
                const anchor = anchorOf(local, scrollElement);
                if (anchor) anchorRef.current = anchor;
            }
        };
        onScroll();
        scrollElement.addEventListener('scroll', onScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', onScroll);
    }, [loadingOlder]);

    useLayoutEffect(() => {
        const local = localRef.current;
        if (!local) return;
        const scrollElement = scrollPortOf(local);
        const anchor = anchorRef.current;
        if (anchor !== null) {
            if (loadingOlder) return;
            const row = [...local.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
                .find((item) => item.dataset.chatAnchorKey === anchor.key);
            if (row) {
                scrollElement.scrollTop += row.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top - anchor.top;
                observedTopRef.current = scrollElement.scrollTop;
            }
            anchorRef.current = null;
            return;
        }
        if (atBottomRef.current) followToBottom(scrollElement);
    }, [followToBottom, loadingOlder, messages]);

    useLayoutEffect(() => {
        const tail = messages.at(-1);
        const previousTailKey = lastTailKeyRef.current;
        lastTailKeyRef.current = tail?.key ?? null;
        if (!previousTailKey || !tail || tail.key === previousTailKey || tail.role !== 'user') return;
        const local = localRef.current;
        if (local) followToBottom(scrollPortOf(local));
    }, [followToBottom, messages]);

    useEffect(() => {
        const local = localRef.current;
        if (!local || typeof ResizeObserver === 'undefined') return undefined;
        const scrollElement = scrollPortOf(local);
        const column = local.querySelector<HTMLElement>('[data-chat-flow]');
        const composer = scrollElement.querySelector<HTMLElement>('[data-composer-seat]');
        const observer = new ResizeObserver(() => {
            if (atBottomRef.current) followToBottom(scrollElement);
        });
        if (column) observer.observe(column);
        if (composer) observer.observe(composer);
        return () => observer.disconnect();
    }, [followToBottom]);

    const loadOlder = () => {
        const local = localRef.current;
        if (!local || loadingOlder) return;
        anchorRef.current = anchorOf(local, scrollPortOf(local));
        onLoadOlder();
    };

    return <div className={css.root}>
        <div ref={localRef} className={css.scroll}>
            <div className={css.column} data-chat-flow="">
                {historyHasMore && <div className={css.older}><button type="button" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? `加载中…（${olderRange}）` : `加载历史消息（${olderRange}）`}</button></div>}
                {messages.length
                    ? messages.map((message) => <div key={message.key} className={css.flowItem} data-chat-anchor-key={message.key} data-chat-flow-key={message.key} data-chat-flow-kind={message.role}><ChatMessageView message={message} onOpenFile={onOpenFile} onOpenDetails={onOpenDetails} /></div>)
                    : <div className={css.hint}>发送消息开始对话</div>}
                {running && <TurnStatus startTime={runningTurnStartTime} />}
            </div>
            {!atBottom && <div className={css.toBottomSlot}>
                <button type="button" className={css.toBottom} aria-label="回到底部" onClick={toBottom}>
                    <IconChevronDownOutline14 />
                </button>
            </div>}
        </div>
    </div>;
}

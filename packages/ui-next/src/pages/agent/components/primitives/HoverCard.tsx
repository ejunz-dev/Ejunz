import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { writeClipboard } from './clipboard';
import { usePointerGrace } from './pointer-grace';
import css from './HoverCard.module.css';

export interface HoverCardProps {
    anchor: ReactNode;
    content: ReactNode;
    openDelayMs?: number;
    disabled?: boolean;
    copyText?: string;
    copyLabel?: string;
    copiedLabel?: string;
}

export function HoverCard({ anchor, content, openDelayMs = 500, disabled = false, copyText, copyLabel = '复制', copiedLabel = '复制成功' }: HoverCardProps) {
    const rootRef = useRef<HTMLSpanElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const copyHeightRef = useRef<number | null>(null);
    const copyEpochRef = useRef(0);
    const copyingRef = useRef(false);
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const [copied, setCopied] = useState(false);
    const clearCopied = useCallback(() => {
        if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
        copyHeightRef.current = null;
        setCopied(false);
    }, []);
    const close = useCallback(() => {
        copyEpochRef.current += 1;
        clearCopied();
        setOpen(false);
    }, [clearCopied]);
    const { arm: armClose, cancel: cancelClose } = usePointerGrace(close);
    const clearTimer = () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = null;
    };
    useEffect(() => {
        if (!disabled) return;
        clearTimer();
        cancelClose();
        close();
    }, [close, disabled, cancelClose]);
    useEffect(() => () => { clearTimer(); cancelClose(); }, [cancelClose]);
    useLayoutEffect(() => {
        if (!open) {
            setPos(null);
            return undefined;
        }
        const place = () => {
            const wrapper = rootRef.current;
            if (wrapper === null) return;
            const rect = wrapper.getBoundingClientRect();
            const height = cardRef.current?.offsetHeight ?? 0;
            const top = rect.top + height > window.innerHeight - 8 ? window.innerHeight - height - 8 : rect.top;
            setPos({ left: rect.right + 8, top });
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => {
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
        };
    }, [open]);
    useLayoutEffect(() => {
        if (!open || pos === null) return;
        const height = cardRef.current?.offsetHeight ?? 0;
        if (pos.top + height > window.innerHeight - 8) setPos({ left: pos.left, top: window.innerHeight - height - 8 });
    }, [open, pos]);
    const copy = async () => {
        if (copyText === undefined || copied || copyingRef.current) return;
        copyingRef.current = true;
        const epoch = copyEpochRef.current;
        const accepted = await writeClipboard(copyText);
        copyingRef.current = false;
        const card = cardRef.current;
        if (!accepted || epoch !== copyEpochRef.current || card === null) return;
        copyHeightRef.current = card.offsetHeight > 0 ? card.offsetHeight : null;
        setCopied(true);
        copyTimerRef.current = setTimeout(clearCopied, 1000);
    };
    const copyable = copyText !== undefined;
    const card = open && pos !== null ? <div ref={cardRef} className={`${css.card}${copyable ? ` ${css.copyable}` : ''}${copied ? ` ${css.feedback}` : ''}`} style={{ ...pos, minHeight: copied && copyHeightRef.current !== null ? copyHeightRef.current : undefined }} role={copyable ? 'button' : undefined} tabIndex={copyable ? 0 : undefined} aria-label={copyable ? `${copyLabel}: ${copyText}` : undefined} onClick={copyable ? () => { void copy(); } : undefined} onKeyDown={copyable ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void copy(); } } : undefined}>
        {copied ? <span className={css.copied}>{copiedLabel}</span> : content}
    </div> : null;
    return <span ref={rootRef} className={css.root} onPointerEnter={() => {
        if (disabled) return;
        cancelClose();
        if (open) return;
        clearTimer();
        timerRef.current = setTimeout(() => { setOpen(true); }, openDelayMs);
    }} onPointerLeave={() => {
        clearTimer();
        if (open) armClose();
    }}>
        {anchor}
        {card && createPortal(card, document.body)}
    </span>;
}

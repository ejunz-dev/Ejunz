import { useEffect, useRef, type ReactNode } from 'react';
import css from './ConversationRoot.module.css';

interface ConversationRootProps {
    blank: boolean;
    title: string;
    renaming: boolean;
    titleEditor: ReactNode;
    actions: ReactNode;
    view: 'chat' | 'trajectory';
    onViewChange: (view: 'chat' | 'trajectory') => void;
    chat: ReactNode;
    trajectory: ReactNode;
    composer: ReactNode;
    hideHeader?: boolean;
}

export function ConversationRoot({ blank, title, renaming, titleEditor, actions, view, onViewChange, chat, trajectory, composer, hideHeader = false }: ConversationRootProps) {
    const composerSeatRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const seat = composerSeatRef.current;
        const scroller = seat?.parentElement;
        if (!seat || !scroller || typeof ResizeObserver === 'undefined') return undefined;
        const updateHeight = () => scroller.style.setProperty('--ea-composer-height', `${seat.offsetHeight}px`);
        const observer = new ResizeObserver(updateHeight);
        observer.observe(seat);
        updateHeight();
        return () => observer.disconnect();
    }, []);

    return <div className={css.root} data-phase="active">
        <header className={`${css.header}${blank || hideHeader ? ` ${css.headerHidden}` : ''}`}>
            <div className={css.titleRow}>
                <div className={css.titleCluster}>
                    {renaming ? titleEditor : <button type="button" className={`${css.crumb} ${css.crumbCurrent}`}>{title}</button>}
                </div>
                <div className={css.headerActions}>{actions}</div>
            </div>
            {!blank && <div className={css.tabs} role="tablist">
                <button type="button" role="tab" aria-selected={view === 'chat'} className={`${css.tab}${view === 'chat' ? ` ${css.tabActive}` : ''}`} onClick={() => onViewChange('chat')}>对话</button>
                <button type="button" role="tab" aria-selected={view === 'trajectory'} className={`${css.tab}${view === 'trajectory' ? ` ${css.tabActive}` : ''}`} onClick={() => onViewChange('trajectory')}>轨迹</button>
            </div>}
        </header>
        <div className={css.scrollBody} data-conversation-scroll="">
            <div className={css.viewArea}>{view === 'chat' ? chat : trajectory}</div>
            <div ref={composerSeatRef} className={css.composerSeat} data-composer-seat="">{composer}</div>
        </div>
    </div>;
}

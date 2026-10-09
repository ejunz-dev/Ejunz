import type { ChatMessage } from '../../types';
import { MarkdownText, PlainText } from '../../primitives/markdown/MarkdownText';
import { ReasoningBlock } from './ReasoningBlock';
import { RetryRow } from './RetryRow';
import css from './MessageItem.module.css';
import assistantCss from './AssistantMarkdown.module.css';
import { CompactionRow } from './CompactionRow';
import { ContextInjectionRow } from './ContextInjectionRow';
import { FileInjectionRow } from './FileInjectionRow';
import { MessageActions } from './MessageActions';
import { ToolRow } from './ToolRow';
import { TurnStatusRow } from './TurnStatusRow';

export function ChatMessageView({ message, onOpenFile, onOpenDetails }: { message: ChatMessage; onOpenFile?: (path: string) => void; onOpenDetails?: (message: ChatMessage) => void }) {
    if (message.pluginGroup) {
        return <div className={css.pluginGroup}>
            <div className={css.pluginGroupHeader}>
                <span className={css.pluginGroupIcon} aria-hidden="true">◈</span>
                <span className={css.pluginGroupTitle}>{message.contextLabel}</span>
                <span className={css.pluginGroupBadge}>插件</span>
            </div>
            <div className={css.pluginGroupChildren}>
                {message.children?.map((child) => <ChatMessageView key={child.key} message={child} onOpenFile={onOpenFile} onOpenDetails={onOpenDetails} />)}
            </div>
        </div>;
    }
    if (message.role === 'user') {
        return <div className={`${css.userRow} eza-message-user`}><div className={`${css.userStack} eza-userStack`}><div className={css.userLine}><div className={`${css.bubble} eza-bubble`}><PlainText text={message.text} /></div>{message.sendStatus && <span className={`${css.sendStatus} ${message.sendStatus === 'sending' ? css.sendStatusSending : css.sendStatusSent}`} role="status" aria-label={message.sendStatus === 'sending' ? '发送中' : '已发送'} title={message.sendStatus === 'sending' ? '发送中' : '已发送'}>{message.sendStatus === 'sending' ? <span className={css.sendSpinner} /> : '✓'}</span>}</div></div><MessageActions text={message.text} time={message.time} clock="start" /></div>;
    }
    if (message.role === 'assistant') {
        const segments = message.segments ?? [{ kind: 'text' as const, text: message.text }];
        return <div className={`${assistantCss.root} eza-message-assistant`}><div className={assistantCss.body}>{segments.map((segment, index) => segment.kind === 'reasoning'
            ? <ReasoningBlock key={index} text={segment.text} running={message.running && index === segments.length - 1} />
            : <MarkdownText key={index} text={segment.text} />)}</div>{!message.running && <MessageActions text={message.text} time={message.time} clock="end" />}</div>;
    }
    if (message.role === 'tool') {
        return <ToolRow message={message} onOpenFile={onOpenFile} onOpenDetails={onOpenDetails} />;
    }
    if (message.role === 'retry') {
        return <RetryRow message={message} />;
    }
    if (message.role === 'compaction') {
        return <CompactionRow summary={message.compactionSummary} items={message.shadowedItemCount} tokens={message.shadowedTokenCount} />;
    }
    if (message.role === 'context') {
        if (message.contextFiles && message.contextFiles.length > 0) return <FileInjectionRow files={message.contextFiles} />;
        return <ContextInjectionRow label={message.contextRole === 'recall' ? '上下文召回' : '上下文注入'} source={message.contextLabel} summary={message.contextSummary} text={message.text} contextSource={message.contextSource} contextForm={message.contextForm} />;
    }
    if (message.eventType === 'turn/error' || message.eventType === 'turn/max-tokens') return <TurnStatusRow message={message} />;
    return <div className="eza-systemMessage">{message.text}</div>;
}

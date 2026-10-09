import type { AgentPluginView, ChatMessage } from '../../types';
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

function pluginForContextMessage(message: ChatMessage, plugins: readonly AgentPluginView[]): AgentPluginView | undefined {
    if (message.role !== 'context' || !message.contextSource || typeof message.contextSource !== 'object') return undefined;
    const source = message.contextSource as Record<string, unknown>;
    if (source.kind !== 'plugin' || typeof source.plugin !== 'string') return undefined;
    return plugins.find((plugin) => plugin.contextSources?.includes(source.plugin as string));
}

export function ChatMessageView({ message, plugins, onOpenFile, onOpenDetails }: { message: ChatMessage; plugins: readonly AgentPluginView[]; onOpenFile?: (path: string) => void; onOpenDetails?: (message: ChatMessage) => void }) {
    if (message.agentPluginStatus) {
        const { displayName, enabled } = message.agentPluginStatus;
        return <div className={css.pluginStatusRow} role="status">
            <span className={css.pluginStatusIcon} aria-hidden="true">◈</span>
            <span className={css.pluginStatusName}>{displayName}</span>
            <span className={enabled ? css.pluginStatusEnabled : css.pluginStatusDisabled}>{enabled ? '插件生效' : '插件已关闭'}</span>
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
        return <ToolRow message={message} plugins={plugins} onOpenFile={onOpenFile} onOpenDetails={onOpenDetails} />;
    }
    if (message.role === 'retry') {
        return <RetryRow message={message} />;
    }
    if (message.role === 'compaction') {
        return <CompactionRow summary={message.compactionSummary} items={message.shadowedItemCount} tokens={message.shadowedTokenCount} />;
    }
    if (message.role === 'context') {
        if (message.contextFiles && message.contextFiles.length > 0) return <FileInjectionRow files={message.contextFiles} />;
        const plugin = pluginForContextMessage(message, plugins);
        const label = message.contextRole === 'recall'
            ? '上下文召回'
            : plugin ? `${plugin.displayName} · 上下文注入` : '上下文注入';
        return <ContextInjectionRow label={label} source={message.contextLabel} summary={message.contextSummary} text={message.text} contextSource={message.contextSource} contextForm={message.contextForm} />;
    }
    if (message.eventType === 'turn/error' || message.eventType === 'turn/max-tokens') return <TurnStatusRow message={message} />;
    return <div className="eza-systemMessage">{message.text}</div>;
}

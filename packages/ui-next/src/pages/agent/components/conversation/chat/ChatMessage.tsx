import type { AgentAddonView, ChatMessage } from '../../types';
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
import { AddonMountRow } from './AddonMountRow';
import { TurnStatusRow } from './TurnStatusRow';

function addonForContextMessage(message: ChatMessage, addons: readonly AgentAddonView[]): AgentAddonView | undefined {
    if (message.role !== 'context' || !message.contextSource || typeof message.contextSource !== 'object') return undefined;
    const source = message.contextSource as Record<string, unknown>;
    if (source.kind === 'agent-addon' && typeof source.addonId === 'string') {
        return addons.find((addon) => addon.addonId === source.addonId);
    }
    if (source.kind !== 'plugin') return undefined;
    const sections = Array.isArray(source.sections) ? source.sections : [];
    const ownedSection = sections.find((value) => {
        if (!value || typeof value !== 'object') return false;
        const name = (value as Record<string, unknown>).name;
        return typeof name === 'string' && name.startsWith('agent-plugin:');
    });
    const sectionName = ownedSection && typeof ownedSection === 'object'
        ? (ownedSection as Record<string, unknown>).name
        : undefined;
    if (typeof sectionName === 'string') {
        const pluginId = sectionName.slice('agent-plugin:'.length);
        const addon = addons.find((item) => item.addonId === pluginId);
        if (addon) return addon;
    }
    if (typeof source.plugin !== 'string') return undefined;
    return addons.find((plugin) => plugin.contextSources?.includes(source.plugin as string));
}

export function ChatMessageView({ message, addons, onOpenFile, onOpenDetails }: { message: ChatMessage; addons: readonly AgentAddonView[]; onOpenFile?: (path: string) => void; onOpenDetails?: (message: ChatMessage) => void }) {
    if (message.role === 'addon' && message.addonMount) {
        const { addonId, enabled } = message.addonMount;
        const addon = addons.find((item) => item.addonId === addonId);
        const displayName = addon?.displayName ?? addonId;
        return <AddonMountRow
            label={`插件${enabled ? '挂载' : '卸载'} · ${displayName}`}
            description={addon?.description ?? message.text}
            enabled={enabled}
            tools={addon?.tools ?? []}
        />;
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
        return <ToolRow message={message} addons={addons} onOpenFile={onOpenFile} onOpenDetails={onOpenDetails} />;
    }
    if (message.role === 'retry') {
        return <RetryRow message={message} />;
    }
    if (message.role === 'compaction') {
        return <CompactionRow summary={message.compactionSummary} items={message.shadowedItemCount} tokens={message.shadowedTokenCount} />;
    }
    if (message.role === 'context') {
        if (message.contextFiles && message.contextFiles.length > 0) return <FileInjectionRow files={message.contextFiles} />;
        const addon = addonForContextMessage(message, addons);
        const isAddonMount = message.contextLabel === '插件状态' || message.contextLabel === 'Agent 插件状态';
        const label = message.contextRole === 'recall'
            ? '上下文召回'
            : addon ? `${addon.displayName} · ${isAddonMount ? '插件挂载' : '上下文注入'}` : isAddonMount ? '插件挂载' : '上下文注入';
        return <ContextInjectionRow label={label} source={isAddonMount ? undefined : message.contextLabel} summary={message.contextSummary} text={message.text} contextSource={message.contextSource} contextForm={message.contextForm} />;
    }
    if (message.eventType === 'turn/error' || message.eventType === 'turn/max-tokens') return <TurnStatusRow message={message} />;
    return <div className="eza-systemMessage">{message.text}</div>;
}

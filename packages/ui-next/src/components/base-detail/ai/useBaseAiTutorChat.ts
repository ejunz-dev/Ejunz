import { useCallback, useEffect, useRef, useState } from 'react';
import Notification from '@/components/notification';
import { i18n } from '@/i18n';
import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode } from '../types';
import { splitAiAssistantStream } from './chat_utils';
import { buildBaseAiTutorSystemPrompt, buildBaseTutorContext } from './prompt_tutor';

export type BaseAiTutorMessage = {
  role: 'user' | 'assistant' | 'tool_call';
  content: string;
  toolCalls?: Array<{
    id: string;
    function: { name: string; arguments: string };
    result?: { content: string };
  }>;
};

export interface UseBaseAiTutorChatOptions {
  nodes: BaseDetailNode[];
  edges: BaseDetailEdge[];
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  selectedNode: BaseDetailNode | null;
  selectedCard: BaseDetailCard | null;
  docTitle: string;
  docDescription?: string;
  docId?: string;
  domainId: string;
}

export function useBaseAiTutorChat(options: UseBaseAiTutorChatOptions) {
  const {
    nodes,
    edges,
    nodeCardsMap,
    selectedNode,
    selectedCard,
    docTitle,
    docDescription,
    docId,
    domainId,
  } = options;

  const [messages, setMessages] = useState<BaseAiTutorMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const chatWebSocketRef = useRef<{ close: () => void; send: (data: string) => void } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const nodeCardsMapRef = useRef(nodeCardsMap);
  const selectedNodeRef = useRef(selectedNode);
  const selectedCardRef = useRef(selectedCard);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  nodeCardsMapRef.current = nodeCardsMap;
  selectedNodeRef.current = selectedNode;
  selectedCardRef.current = selectedCard;

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => () => {
    chatWebSocketRef.current?.close();
    chatWebSocketRef.current = null;
  }, []);

  const sendMessage = useCallback(async (rawText: string) => {
    const userMessage = rawText.trim();
    if (!userMessage || isLoading) return false;

    setIsLoading(true);

    const historyBeforeNewMessage = messages
      .filter((msg): msg is BaseAiTutorMessage => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => ({
        role: msg.role,
        content: msg.content || (msg.role === 'assistant' ? 'Done' : ''),
      }));

    // The assistant reply is always the last message; tool-call entries are
    // inserted just before it. Targeting the trailing message avoids index
    // bookkeeping that React StrictMode would double-run inside the updater.
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }, { role: 'assistant', content: '' }]);
    scrollToBottom();

    const setLastAssistant = (content: string) => {
      setMessages((prev) => {
        const next = [...prev];
        if (next.length > 0) next[next.length - 1] = { role: 'assistant', content };
        return next;
      });
    };

    try {
      const { baseText, selectedNodeContext } = buildBaseTutorContext(
        nodesRef.current,
        edgesRef.current,
        nodeCardsMapRef.current,
        selectedNodeRef.current,
        selectedCardRef.current,
      );

      const systemPrompt = buildBaseAiTutorSystemPrompt({
        baseText,
        selectedNodeContext,
        docTitle,
        docDescription,
      });

      if (chatWebSocketRef.current) {
        chatWebSocketRef.current.close();
        chatWebSocketRef.current = null;
      }

      const { default: WebSocket } = await import('@/components/socket');
      const sock = new WebSocket(`/d/${encodeURIComponent(domainId)}/ai/chat-ws`, false, true);
      chatWebSocketRef.current = sock;

      let accumulatedContent = '';
      let streamFinished = false;

      sock.onmessage = (_event, data: string) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'content') {
            accumulatedContent += msg.content;
            const split = splitAiAssistantStream(accumulatedContent);
            let displayContent = split.visibleProse;
            if (!split.inFence) {
              displayContent = accumulatedContent.replace(/```\s*json\s*\r?\n[\s\S]*?\r?\n```/gi, '').trim();
            }
            setLastAssistant(displayContent || (split.inFence ? '' : i18n('Roadmap AI thinking')));
            scrollToBottom();
          } else if (msg.type === 'tool_call') {
            setMessages((prev) => {
              const next = [...prev];
              const toolMsg: BaseAiTutorMessage = {
                role: 'tool_call',
                content: '',
                toolCalls: (msg.toolCalls || []).map((tc: any) => ({
                  id: tc.id || '',
                  function: { name: tc.function?.name || 'unknown', arguments: tc.function?.arguments || '{}' },
                  result: tc.result || undefined,
                })),
              };
              if (next.length > 0) next.splice(next.length - 1, 0, toolMsg);
              else next.push(toolMsg);
              return next;
            });
            scrollToBottom();
          } else if (msg.type === 'done') {
            streamFinished = true;
            const finalContent = msg.content || accumulatedContent;
            const textContent = finalContent.replace(/```\s*json\s*\r?\n[\s\S]*?\r?\n```/gi, '').trim();
            setLastAssistant(textContent || i18n('Done'));
            scrollToBottom();
            chatWebSocketRef.current?.close();
            chatWebSocketRef.current = null;
            setIsLoading(false);
          } else if (msg.type === 'error') {
            streamFinished = true;
            const errorText = i18n('Roadmap AI chat error', msg.error || 'unknown error');
            setLastAssistant(errorText);
            Notification.error(errorText);
            chatWebSocketRef.current?.close();
            chatWebSocketRef.current = null;
            setIsLoading(false);
          }
        } catch (e) {
          console.error('Base AI tutor WS parse error:', e);
        }
      };

      sock.onclose = () => {
        chatWebSocketRef.current = null;
        if (!streamFinished) setIsLoading(false);
      };

      sock.onopen = () => {
        sock.send(JSON.stringify({
          message: userMessage,
          systemPrompt,
          history: historyBeforeNewMessage,
          docId: docId || '',
        }));
      };
      return true;
    } catch (error: any) {
      setLastAssistant(i18n('Roadmap AI chat error', error?.message || String(error)));
      Notification.error(i18n('Roadmap AI chat error', error?.message || String(error)));
      setIsLoading(false);
      return false;
    }
  }, [docDescription, docTitle, isLoading, messages, scrollToBottom, domainId, docId]);

  return {
    messages,
    isLoading,
    sendMessage,
    messagesEndRef,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import Notification from 'vj/components/notification';
import { i18n } from 'vj/utils';
import type { EditorCard } from '../../editor_workspace/card_problems_panel';
import { splitAiAssistantStream } from './chat_utils';
import { buildRoadmapAiTutorSystemPrompt, buildRoadmapTutorContext } from './prompt_tutor';

export type RoadmapAiTutorMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export interface UseRoadmapAiTutorChatOptions {
  nodes: Node[];
  edges: Edge[];
  selectedNode: Node | null;
  docTitle: string;
  branch: string;
  docDescription?: string;
}

export function useRoadmapAiTutorChat(options: UseRoadmapAiTutorChatOptions) {
  const {
    nodes,
    edges,
    selectedNode,
    docTitle,
    branch,
    docDescription,
  } = options;

  const [messages, setMessages] = useState<RoadmapAiTutorMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const chatWebSocketRef = useRef<{ close: () => void; send: (data: string) => void } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const selectedNodeRef = useRef(selectedNode);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  selectedNodeRef.current = selectedNode;

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
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => ({
        role: msg.role,
        content: msg.content || (msg.role === 'assistant' ? 'Done' : ''),
      }));

    let assistantMessageIndex = 0;
    setMessages((prev) => {
      const next: RoadmapAiTutorMessage[] = [...prev, { role: 'user', content: userMessage }];
      assistantMessageIndex = next.length;
      next.push({ role: 'assistant', content: '' });
      return next;
    });
    scrollToBottom();

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      const nodeCardsMap = ((window as any).UiContext?.nodeCardsMap || {}) as Record<string, EditorCard[]>;
      const { roadmapText, selectedNodeContext } = buildRoadmapTutorContext(
        nodesRef.current,
        edgesRef.current,
        nodeCardsMap,
        selectedNodeRef.current,
      );
      const systemPrompt = buildRoadmapAiTutorSystemPrompt({
        roadmapText,
        selectedNodeContext,
        docTitle,
        branch,
        docDescription,
      });

      if (chatWebSocketRef.current) {
        chatWebSocketRef.current.close();
        chatWebSocketRef.current = null;
      }

      const { default: WebSocket } = await import('../../socket');
      const wsPrefix = (window as any).UiContext?.wsPrefix || '';
      const sock = new WebSocket(`${wsPrefix}/d/${domainId}/ai/chat-ws`, false, true);
      chatWebSocketRef.current = sock;

      let accumulatedContent = '';
      let streamFinished = false;

      sock.onmessage = (_, data: string) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'content') {
            accumulatedContent += msg.content;
            const split = splitAiAssistantStream(accumulatedContent);
            let displayContent = split.visibleProse;
            if (!split.inFence) {
              displayContent = accumulatedContent.replace(/```\s*json\s*\r?\n[\s\S]*?\r?\n```/gi, '').trim();
            }
            setMessages((prev) => {
              const next = [...prev];
              if (next[assistantMessageIndex]) {
                next[assistantMessageIndex] = {
                  role: 'assistant',
                  content: displayContent || (split.inFence ? '' : i18n('Roadmap AI thinking')),
                };
              }
              return next;
            });
            scrollToBottom();
          } else if (msg.type === 'done') {
            streamFinished = true;
            const finalContent = msg.content || accumulatedContent;
            const textContent = finalContent.replace(/```\s*json\s*\r?\n[\s\S]*?\r?\n```/gi, '').trim();
            setMessages((prev) => {
              const next = [...prev];
              if (next[assistantMessageIndex]) {
                next[assistantMessageIndex] = {
                  role: 'assistant',
                  content: textContent || i18n('Done'),
                };
              }
              return next;
            });
            scrollToBottom();
            chatWebSocketRef.current?.close();
            chatWebSocketRef.current = null;
            setIsLoading(false);
          } else if (msg.type === 'error') {
            streamFinished = true;
            setMessages((prev) => {
              const next = [...prev];
              if (next[assistantMessageIndex]) {
                next[assistantMessageIndex] = {
                  role: 'assistant',
                  content: i18n('Roadmap AI chat error', msg.error || 'unknown error'),
                };
              }
              return next;
            });
            Notification.error(i18n('Roadmap AI chat error', msg.error || 'unknown error'));
            chatWebSocketRef.current?.close();
            chatWebSocketRef.current = null;
            setIsLoading(false);
          }
        } catch (e) {
          console.error('Roadmap AI tutor WS parse error:', e);
        }
      };

      sock.onclose = () => {
        chatWebSocketRef.current = null;
        if (!streamFinished) setIsLoading(false);
      };

      sock.onopen = () => {
        sock.send(JSON.stringify({
          message: `${systemPrompt}\n\nUser question:\n${userMessage}`,
          history: historyBeforeNewMessage,
        }));
      };
      return true;
    } catch (error: any) {
      setMessages((prev) => {
        const next = [...prev];
        if (next[assistantMessageIndex]) {
          next[assistantMessageIndex] = {
            role: 'assistant',
            content: i18n('Roadmap AI chat error', error?.message || String(error)),
          };
        }
        return next;
      });
      Notification.error(i18n('Roadmap AI chat error', error?.message || String(error)));
      setIsLoading(false);
      return false;
    }
  }, [branch, docDescription, docTitle, isLoading, messages, scrollToBottom]);

  return {
    messages,
    isLoading,
    sendMessage,
    messagesEndRef,
  };
}

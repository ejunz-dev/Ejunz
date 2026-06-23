import { useCallback, useEffect, useRef, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import Notification from 'vj/components/notification';
import { i18n } from 'vj/utils';
import type { EditorCard } from '../../editor_workspace/card_problems_panel';
import {
  extractAiOperationTypesPartial,
  extractParsedOperationsFromPartialFence,
  friendlyRoadmapAiOperationLabel,
  parseOperationPayload,
  splitAiAssistantStream,
  summarizeRoadmapAiOperation,
} from './chat_utils';
import { executeRoadmapAiOperations } from './execute_operations';
import {
  buildRoadmapAiSystemPrompt,
  buildSelectedRoadmapNodeContext,
  convertRoadmapToText,
} from './prompt';

export type RoadmapAiChatMessage = {
  role: 'user' | 'assistant' | 'operation';
  content: string;
  operations?: unknown[];
  isExpanded?: boolean;
  streamOps?: { lines: string[]; receiving: boolean; charCount: number } | null;
};

type ExecuteRoadmapAiOpsFn = (
  operations: unknown[],
  execOpts?: { quiet?: boolean },
) => Promise<{ success: boolean; errors: string[] }>;

export interface UseRoadmapAiChatOptions {
  nodes: Node[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  setSelectedNodeId: (id: string | null) => void;
  markProblemsDirty: (cardId: string) => void;
  setCardsReloadEpoch: React.Dispatch<React.SetStateAction<number>>;
  selectedNode: Node | null;
  docTitle: string;
  branch: string;
  terminalInput: string;
  setTerminalInput: (value: string) => void;
  newNodeId: () => string;
  newEdgeId: (source: string, target: string) => string;
}

export function useRoadmapAiChat(options: UseRoadmapAiChatOptions) {
  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    setSelectedNodeId,
    markProblemsDirty,
    setCardsReloadEpoch,
    selectedNode,
    docTitle,
    branch,
    terminalInput,
    setTerminalInput,
    newNodeId,
    newEdgeId,
  } = options;

  const [chatMessages, setChatMessages] = useState<RoadmapAiChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const chatWebSocketRef = useRef<{ close: () => void; send: (data: string) => void } | null>(null);
  const executeOpsRef = useRef<ExecuteRoadmapAiOpsFn | null>(null);
  const aiOperationClientNodeIdsRef = useRef(new Map<string, string>());
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  const scrollToBottomIfNeeded = useCallback(() => {
    requestAnimationFrame(() => {
      chatMessagesEndRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
    });
  }, []);

  useEffect(() => {
    scrollToBottomIfNeeded();
  }, [chatMessages, scrollToBottomIfNeeded]);

  const executeRoadmapAiOps = useCallback<ExecuteRoadmapAiOpsFn>(async (operations, execOpts) => {
    return executeRoadmapAiOperations(operations, {
      nodes: nodesRef.current,
      edges: edgesRef.current,
      setNodes,
      setEdges,
      setSelectedNodeId,
      markProblemsDirty,
      setCardsReloadEpoch,
      newNodeId,
      newEdgeId,
      aiCreatedNodeIdsRef: aiOperationClientNodeIdsRef,
    }, execOpts);
  }, [markProblemsDirty, newEdgeId, newNodeId, setCardsReloadEpoch, setEdges, setNodes, setSelectedNodeId]);

  useEffect(() => {
    executeOpsRef.current = executeRoadmapAiOps;
  }, [executeRoadmapAiOps]);

  useEffect(() => () => {
    chatWebSocketRef.current?.close();
    chatWebSocketRef.current = null;
  }, []);

  const handleSend = useCallback(async () => {
    const userMessage = terminalInput.trim();
    if (!userMessage || isChatLoading) return;

    setTerminalInput('');
    setIsChatLoading(true);
    aiOperationClientNodeIdsRef.current.clear();

    const historyBeforeNewMessage = chatMessages
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => ({
        role: msg.role,
        content: msg.content || (msg.role === 'assistant' ? 'Done' : ''),
      }));

    let assistantMessageIndex = 0;
    setChatMessages((prev) => {
      const next: RoadmapAiChatMessage[] = [
        ...prev,
        { role: 'user', content: userMessage },
      ];
      assistantMessageIndex = next.length;
      next.push({ role: 'assistant', content: '' });
      return next;
    });
    scrollToBottomIfNeeded();

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      const nodeCardsMap = ((window as any).UiContext?.nodeCardsMap || {}) as Record<string, EditorCard[]>;
      const roadmapText = convertRoadmapToText(nodesRef.current, edgesRef.current, nodeCardsMap);
      const selectedNodeContext = buildSelectedRoadmapNodeContext(selectedNode, nodeCardsMap);
      const systemPrompt = buildRoadmapAiSystemPrompt({
        roadmapText,
        selectedNodeContext,
        docTitle,
        branch,
      });

      if (chatWebSocketRef.current) {
        chatWebSocketRef.current.close();
        chatWebSocketRef.current = null;
      }

      const { default: WebSocket } = await import('../../socket');
      const wsPrefix = (window as any).UiContext?.wsPrefix || '';
      const wsUrl = `/d/${domainId}/ai/chat-ws`;
      const sock = new WebSocket(wsPrefix + wsUrl, false, true);
      chatWebSocketRef.current = sock;

      let accumulatedContent = '';
      let streamFinished = false;
      let streamedOpsExecuted = 0;
      let streamExecChain: Promise<unknown> = Promise.resolve();

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
            const opLines = split.inFence
              ? extractAiOperationTypesPartial(split.fenceBody).map((type) => friendlyRoadmapAiOperationLabel(type))
              : [];

            setChatMessages((prev) => {
              const next = [...prev];
              if (next[assistantMessageIndex]) {
                next[assistantMessageIndex] = {
                  role: 'assistant',
                  content: displayContent || (split.inFence ? '' : i18n('Roadmap AI thinking')),
                  streamOps: split.inFence
                    ? { lines: opLines, receiving: true, charCount: split.fenceBody.length }
                    : null,
                };
              }
              return next;
            });

            if (split.inFence && executeOpsRef.current) {
              const parsedSoFar = extractParsedOperationsFromPartialFence(split.fenceBody);
              const fn = executeOpsRef.current;
              while (streamedOpsExecuted < parsedSoFar.length) {
                const op = parsedSoFar[streamedOpsExecuted];
                streamedOpsExecuted += 1;
                streamExecChain = streamExecChain.then(() => fn([op], { quiet: true }));
              }
            }
            scrollToBottomIfNeeded();
          } else if (msg.type === 'done') {
            streamFinished = true;
            const finalContent = msg.content || accumulatedContent;
            const jsonMatch = finalContent.match(/```\s*json\s*\r?\n([\s\S]*?)\r?\n```/i);
            const textContent = finalContent.replace(/```\s*json\s*\r?\n[\s\S]*?\r?\n```/gi, '').trim();

            setChatMessages((prev) => {
              const next = [...prev];
              if (next[assistantMessageIndex]) {
                next[assistantMessageIndex] = {
                  role: 'assistant',
                  content: textContent || i18n('Done'),
                  streamOps: null,
                };
              }
              return next;
            });
            scrollToBottomIfNeeded();

            let opsChainFinishesLoading = false;
            if (jsonMatch) {
              try {
                const payload = parseOperationPayload(jsonMatch[1]);
                if (payload?.operations && Array.isArray(payload.operations)) {
                  const allOps = payload.operations;
                  setChatMessages((prev) => [
                    ...prev,
                    {
                      role: 'operation',
                      content: i18n('Roadmap AI applying operations', allOps.length),
                      operations: allOps,
                      isExpanded: false,
                    },
                  ]);

                  if (executeOpsRef.current) {
                    opsChainFinishesLoading = true;
                    const fn = executeOpsRef.current;
                    streamExecChain = streamExecChain.then(async () => {
                      const remaining = allOps.slice(streamedOpsExecuted);
                      if (!remaining.length) return { success: true, errors: [] as string[] };
                      const result = await fn(remaining, { quiet: true });
                      if (result.success) streamedOpsExecuted = allOps.length;
                      return result;
                    });
                    streamExecChain
                      .then((result: any) => {
                        if (!result?.success) {
                          const errorText = (result?.errors || []).join('\n');
                          setChatMessages((prev) => [
                            ...prev,
                            {
                              role: 'assistant',
                              content: i18n('Roadmap AI operations failed', errorText),
                            },
                          ]);
                          scrollToBottomIfNeeded();
                          return;
                        }
                        if (allOps.length) {
                          Notification.success(i18n('Roadmap AI operations applied'));
                        }
                      })
                      .catch((err) => {
                        const errorMsg = err?.message || String(err);
                        Notification.error(i18n('Roadmap AI execute error', errorMsg));
                      })
                      .finally(() => {
                        chatWebSocketRef.current?.close();
                        chatWebSocketRef.current = null;
                        setIsChatLoading(false);
                      });
                  }
                }
              } catch (e: any) {
                Notification.error(i18n('Roadmap AI parse error', e?.message || String(e)));
              }
            }

            if (!opsChainFinishesLoading) {
              chatWebSocketRef.current?.close();
              chatWebSocketRef.current = null;
              setIsChatLoading(false);
            }
          } else if (msg.type === 'error') {
            streamFinished = true;
            setChatMessages((prev) => {
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
            setIsChatLoading(false);
          }
        } catch (e) {
          console.error('Roadmap AI WS parse error:', e);
        }
      };

      sock.onclose = () => {
        chatWebSocketRef.current = null;
        if (!streamFinished) setIsChatLoading(false);
      };

      sock.onopen = () => {
        sock.send(JSON.stringify({
          message: `${systemPrompt}\n\nUser request:\n${userMessage}`,
          history: historyBeforeNewMessage,
        }));
      };
    } catch (error: any) {
      setChatMessages((prev) => {
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
      setIsChatLoading(false);
    }
  }, [
    branch,
    chatMessages,
    docTitle,
    isChatLoading,
    scrollToBottomIfNeeded,
    selectedNode,
    setTerminalInput,
    terminalInput,
  ]);

  return {
    chatMessages,
    setChatMessages,
    isChatLoading,
    handleSend,
    chatMessagesEndRef,
    scrollToBottomIfNeeded,
    summarizeRoadmapAiOperation,
  };
}

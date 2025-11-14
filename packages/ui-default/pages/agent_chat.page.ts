import { NamedPage } from 'vj/misc/Page';

let sessionWebSocket: any = null;
let sessionConnected = false;
let sessionConnectPromise: Promise<void> | null = null;

const page = new NamedPage('agent_chat', async () => {
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
  const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
  const mcpStatus = document.getElementById('mcpStatus');

  if (!chatMessages || !chatInput || !sendButton || !mcpStatus) return;
  
  const urlMatch = window.location.pathname.match(/\/agent\/([^\/]+)\/chat/);
  if (!urlMatch) {
    console.error('[AgentChat] Invalid URL format:', window.location.pathname);
    return;
  }

  const aid = urlMatch[1];
  
  const UiContext = (window as any).UiContext;
  const domainId = UiContext?.domainId;
  
  if (!domainId) {
    console.error('[AgentChat] Domain ID not found in context');
    return;
  }

  const wsPrefix = UiContext?.ws_prefix || '/';
  
  const connectToSession = async (): Promise<void> => {
    if (sessionConnected && sessionWebSocket) {
      console.log('[AgentChat] Session already connected');
      return;
    }
    
    if (sessionConnectPromise) {
      return sessionConnectPromise;
    }
    
    sessionConnectPromise = new Promise<void>((resolve, reject) => {
      const wsUrl = `agent-chat-session?domainId=${domainId}&aid=${aid}`;
      console.log('[AgentChat] Connecting to session WebSocket:', wsUrl);
      
      import('../components/socket').then(({ default: WebSocket }) => {
        const sock = new WebSocket(wsPrefix + wsUrl, false, true);
        sessionWebSocket = sock;
        sessionConnected = false;
        
        sock.onopen = () => {
          console.log('[AgentChat] Session WebSocket connected');
          sessionConnected = true;
          resolve();
        };
        
    sock.onmessage = (_, data: string) => {
      try {
        const msg = JSON.parse(data);
        console.log('[AgentChat] Session message received:', msg);
        
        if (msg.type === 'session_connected') {
          console.log('[AgentChat] Session connected:', msg);
        } else if (msg.type === 'record_update') {
          console.log('[AgentChat] Record update received:', {
            rid: msg.rid,
            recordStatus: msg.record?.status,
            agentMessagesCount: msg.record?.agentMessages?.length || 0,
            lastMessageRole: msg.record?.agentMessages?.[msg.record?.agentMessages?.length - 1]?.role,
            lastMessageContentLength: msg.record?.agentMessages?.[msg.record?.agentMessages?.length - 1]?.content?.length || 0,
          });
          handleRecordUpdate(msg);
        } else if (msg.type === 'error') {
          console.error('[AgentChat] Session error:', msg.error);
        }
      } catch (error: any) {
        console.error('[AgentChat] Error processing session message:', error);
      }
    };
        
        sock.onclose = () => {
          console.log('[AgentChat] Session WebSocket closed');
          sessionWebSocket = null;
          sessionConnected = false;
          sessionConnectPromise = null;
        };
      }).catch((error) => {
        sessionConnectPromise = null;
        reject(error);
      });
    });
    
    return sessionConnectPromise;
  };
  
  let currentRecordId: string | null = null;
  
  const handleRecordUpdate = (msg: any) => {
    if (!msg.rid) {
      console.warn('[AgentChat] Invalid record update message: missing rid', msg);
      return;
    }
    
    const record = msg.record || {};
    const rid = msg.rid;
    
    if (Object.keys(record).length === 0 && msg.agentMessagesCount > 0) {
      console.warn('[AgentChat] Record object is empty but agentMessagesCount > 0, data may be lost in transmission', {
        rid,
        agentMessagesCount: msg.agentMessagesCount,
      });
    }
    
    if (currentRecordId !== rid) {
      console.log('[AgentChat] New record detected:', rid);
      currentRecordId = rid;
    }
    
    if (record.agentMessages && Array.isArray(record.agentMessages)) {
      const newMessagesCount = record.agentMessages.length;
      const existingMessages = Array.from(chatMessages.children).filter(
        (el: any) => el.classList.contains('chat-message') && 
        (el.classList.contains('user') || el.classList.contains('assistant') || el.classList.contains('tool'))
      );
      
      console.log('[AgentChat] Processing messages:', {
        rid,
        currentRecordId,
        newMessagesCount,
        existingMessagesCount: existingMessages.length,
        lastMessageRole: record.agentMessages[newMessagesCount - 1]?.role,
        lastMessageContent: record.agentMessages[newMessagesCount - 1]?.content?.substring(0, 50),
        existingMessageRoles: existingMessages.map((el: any) => {
          if (el.classList.contains('user')) return 'user';
          if (el.classList.contains('assistant')) return 'assistant';
          if (el.classList.contains('tool')) return 'tool';
          return 'unknown';
        }),
      });

      if (currentRecordId !== rid) {
        console.log('[AgentChat] Different record, resetting message tracking');
        // 不重置，继续处理
      }

      const displayedNonUserCount = existingMessages.filter(
        (el: any) => !el.classList.contains('user')
      ).length;
      
      // 统计 record 中的非用户消息数量
      const recordNonUserMessages = record.agentMessages.filter((m: any) => m.role !== 'user');
      const recordNonUserCount = recordNonUserMessages.length;
      
      console.log('[AgentChat] Non-user message counts:', {
        displayed: displayedNonUserCount,
        inRecord: recordNonUserCount,
        needAdd: recordNonUserCount > displayedNonUserCount,
      });
      
      if (recordNonUserCount > displayedNonUserCount) {
        let addedCount = 0;
        const targetAddCount = recordNonUserCount - displayedNonUserCount;
        
        for (let i = 0; i < newMessagesCount && addedCount < targetAddCount; i++) {
          const msgData = record.agentMessages[i];
          
          if (msgData.role === 'user') {
            continue;
          }
          
          let alreadyDisplayed = false;
          
          if (msgData.role === 'assistant') {
            const content = msgData.content || '';
            const toolCalls = msgData.tool_calls;
            
            const lastAssistant = Array.from(chatMessages.children)
              .reverse()
              .find((el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant'));
            
            if (lastAssistant) {
              if (toolCalls && toolCalls.length > 0) {
                const toolCallName = lastAssistant.querySelector('.tool-call-item code')?.textContent;
                if (toolCallName === toolCalls[0]?.function?.name) {
                  alreadyDisplayed = true;
                }
              } else {
                const existingContent = lastAssistant.textContent?.trim() || '';
                if (content.trim() && 
                    (existingContent === content.trim() || existingContent.startsWith(content.trim()))) {
                  alreadyDisplayed = true;
                }
              }
            }
          } else if (msgData.role === 'tool') {
            const toolName = msgData.toolName || '';
            const content = typeof msgData.content === 'string' 
              ? msgData.content 
              : JSON.stringify(msgData.content, null, 2);
            
            const lastTool = Array.from(chatMessages.children)
              .reverse()
              .find((el: any) => el.classList.contains('chat-message') && el.classList.contains('tool'));
            
            if (lastTool) {
              const toolHeader = lastTool.querySelector('.tool-header');
              const toolContent = lastTool.querySelector('pre')?.textContent?.trim();
              if (toolHeader?.textContent === `Tool: ${toolName}` && 
                  toolContent === content.trim()) {
                alreadyDisplayed = true;
              }
            }
          }
          
          if (!alreadyDisplayed) {
            if (msgData.role === 'assistant') {
              const content = msgData.content || '';
              const toolCalls = msgData.tool_calls;
              console.log('[AgentChat] Adding assistant message:', { 
                index: i,
                contentLength: content.length, 
                hasToolCalls: !!toolCalls 
              });
              addMessage('assistant', content, undefined, toolCalls);
              chatHistory.push({
                role: 'assistant',
                content,
                tool_calls: toolCalls,
                timestamp: msgData.timestamp ? new Date(msgData.timestamp) : new Date(),
              });
              addedCount++;
            } else if (msgData.role === 'tool') {
              const content = typeof msgData.content === 'string' 
                ? msgData.content 
                : JSON.stringify(msgData.content, null, 2);
              console.log('[AgentChat] Adding tool message:', { 
                index: i,
                toolName: msgData.toolName, 
                contentLength: content.length 
              });
              addMessage('tool', content, msgData.toolName);
              chatHistory.push({
                role: 'tool',
                content,
                toolName: msgData.toolName,
                timestamp: msgData.timestamp ? new Date(msgData.timestamp) : new Date(),
              });
              addedCount++;
            }
          }
        }
      }
      
      if (newMessagesCount > 0 && newMessagesCount <= existingMessages.length) {
        const lastMsg = record.agentMessages[newMessagesCount - 1];
        
        if (lastMsg && lastMsg.role === 'assistant') {
          const content = lastMsg.content || '';
          const toolCalls = lastMsg.tool_calls;
          
          console.log('[AgentChat] Updating last assistant message:', { contentLength: content.length, hasToolCalls: !!toolCalls });
          
          let lastAssistantMessage: Element | null = null;
          for (let i = existingMessages.length - 1; i >= 0; i--) {
            const msg = existingMessages[i];
            if (msg.classList.contains('assistant')) {
              lastAssistantMessage = msg;
              break;
            }
          }
          
          if (lastAssistantMessage) {
            if (toolCalls && toolCalls.length > 0) {
              updateLastMessage(content, toolCalls);
            } else {
              let contentDiv = lastAssistantMessage.querySelector('.message-content');
              if (!contentDiv) {
                if (lastAssistantMessage.querySelector('.tool-call-header')) {
                  contentDiv = document.createElement('div');
                  contentDiv.className = 'message-content';
                  lastAssistantMessage.appendChild(contentDiv);
                } else {
                  contentDiv = lastAssistantMessage;
                }
              }
              contentDiv.textContent = content;
            }
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
          
          const lastHistoryMsg = chatHistory.filter(m => m.role === 'assistant').pop();
          if (lastHistoryMsg) {
            lastHistoryMsg.content = content;
            if (toolCalls) {
              lastHistoryMsg.tool_calls = toolCalls;
            }
          }
        }
      }
    }
    
    if (record.status !== undefined) {
      if (isTerminalTaskStatus(record.status)) {
        console.log('[AgentChat] Task completed, status:', record.status);
        setLoading(false);
        currentRecordId = null;
      }
    }
  };
  
  await connectToSession();

  const mcpStatusUrl = mcpStatus.getAttribute('data-status-url') || '';
  const UiCtx = (window as any).UiContext || {};
  const STATUS = UiCtx.STATUS || (window as any).STATUS || (window as any).model?.builtin?.STATUS || {};
  const ACTIVE_TASK_STATUSES = new Set(
    [
      STATUS.STATUS_TASK_WAITING,
      STATUS.STATUS_TASK_FETCHED,
      STATUS.STATUS_TASK_PROCESSING,
      STATUS.STATUS_TASK_PENDING,
    ].filter((value) => typeof value === 'number'),
  );
  const isTerminalTaskStatus = (status?: number) => {
    if (typeof status !== 'number') return false;
    return !ACTIVE_TASK_STATUSES.has(status);
  };

  let chatHistory: Array<{ role: string; content: string; timestamp?: Date; toolName?: string; tool_calls?: any[] }> = [];

  async function checkMcpStatus() {
    if (!mcpStatusUrl) return;
    try {
      const response = await fetch(mcpStatusUrl, { 
        method: 'GET'
      });
      const data = await response.json();
      if (data.connected) {
        mcpStatus.textContent = `MCP: Connected (${data.toolCount} tools)`;
        mcpStatus.className = 'mcp-status connected';
      } else {
        mcpStatus.textContent = 'MCP: Disconnected';
        mcpStatus.className = 'mcp-status disconnected';
      }
    } catch (e) {
      mcpStatus.textContent = 'MCP: Disconnected';
      mcpStatus.className = 'mcp-status disconnected';
    }
  }

  checkMcpStatus();

  function addMessage(role: string, content: string, toolName?: string, toolCalls?: any[]) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;
    
    if (role === 'tool') {
      const toolHeader = document.createElement('div');
      toolHeader.className = 'tool-header';
      toolHeader.textContent = `Tool: ${toolName || 'Unknown'}`;
      messageDiv.appendChild(toolHeader);
      
      const toolContent = document.createElement('pre');
      toolContent.textContent = content;
      messageDiv.appendChild(toolContent);
    } else if (toolCalls && toolCalls.length > 0) {
      const toolCallHeader = document.createElement('div');
      toolCallHeader.className = 'tool-call-header';
      toolCallHeader.textContent = 'Tool Call:';
      messageDiv.appendChild(toolCallHeader);
      
      toolCalls.forEach((toolCall: any) => {
        const toolCallDiv = document.createElement('div');
        toolCallDiv.className = 'tool-call-item';
        const toolNameSpan = document.createElement('code');
        toolNameSpan.textContent = toolCall.function?.name || 'unknown';
        toolCallDiv.appendChild(toolNameSpan);
        
        if (toolCall.function?.arguments) {
          const argsPre = document.createElement('pre');
          argsPre.textContent = typeof toolCall.function.arguments === 'string' 
            ? toolCall.function.arguments 
            : JSON.stringify(toolCall.function.arguments, null, 2);
          toolCallDiv.appendChild(argsPre);
        }
        messageDiv.appendChild(toolCallDiv);
      });
      
      if (content) {
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.textContent = content;
        messageDiv.appendChild(contentDiv);
      }
    } else {
    messageDiv.textContent = content;
    }
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    chatHistory.push({
      role,
      content,
      timestamp: new Date(),
      toolName,
      tool_calls: toolCalls,
    });
  }

  function updateLastMessage(content: string, toolCalls?: any[]) {
    const lastMessage = chatMessages.lastElementChild;
    if (!lastMessage || !lastMessage.classList.contains('chat-message')) return;
    
    if (toolCalls && toolCalls.length > 0) {
      const existingToolCalls = lastMessage.querySelectorAll('.tool-call-item');
      if (existingToolCalls.length === 0) {
        const toolCallHeader = document.createElement('div');
        toolCallHeader.className = 'tool-call-header';
        toolCallHeader.textContent = 'Tool Call:';
        lastMessage.appendChild(toolCallHeader);
      }
      
      toolCalls.forEach((toolCall: any) => {
        const toolCallDiv = document.createElement('div');
        toolCallDiv.className = 'tool-call-item';
        const toolNameSpan = document.createElement('code');
        toolNameSpan.textContent = toolCall.function?.name || 'unknown';
        toolCallDiv.appendChild(toolNameSpan);
        
        if (toolCall.function?.arguments) {
          const argsPre = document.createElement('pre');
          argsPre.textContent = typeof toolCall.function.arguments === 'string' 
            ? toolCall.function.arguments 
            : JSON.stringify(toolCall.function.arguments, null, 2);
          toolCallDiv.appendChild(argsPre);
        }
        lastMessage.appendChild(toolCallDiv);
      });
      
      if (content) {
        let contentDiv = lastMessage.querySelector('.message-content');
        if (!contentDiv) {
          contentDiv = document.createElement('div');
          contentDiv.className = 'message-content';
          lastMessage.appendChild(contentDiv);
        }
        contentDiv.textContent = content;
      }
    } else {
      lastMessage.textContent = content;
    }
    
    if (chatHistory.length > 0) {
      const lastHistory = chatHistory[chatHistory.length - 1];
      lastHistory.content = content;
      if (toolCalls) {
        lastHistory.tool_calls = toolCalls;
      }
    }
    
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  const originalButtonText = sendButton.textContent || 'Send';

  function setLoading(loading: boolean) {
    sendButton.disabled = loading;
    if (loading && !sendButton.querySelector('.loading')) {
      const loader = document.createElement('span');
      loader.className = 'loading';
      sendButton.innerHTML = '';
      const textSpan = document.createElement('span');
      textSpan.textContent = 'Sending... ';
      sendButton.appendChild(textSpan);
      sendButton.appendChild(loader);
    } else if (!loading) {
      sendButton.textContent = originalButtonText;
    }
  }

  async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message) return;

    addMessage('user', message);
    
    chatInput.value = '';
    setLoading(true);

    try {
      const urlMatch = window.location.pathname.match(/\/agent\/([^\/]+)\/chat/);
      if (!urlMatch) {
        addMessage('error', 'Invalid URL format: ' + window.location.pathname);
        setLoading(false);
        return;
      }

      const aid = urlMatch[1];
      
      const UiContext = (window as any).UiContext;
      const domainId = UiContext?.domainId;
      
      if (!domainId) {
        addMessage('error', 'Domain ID not found in context');
        setLoading(false);
        return;
      }
      
      const wsPrefix = UiContext?.ws_prefix || '/';

      const postUrl = `/d/${domainId}/agent/${aid}/chat`;
      console.log('[AgentChat] Creating task via POST:', { message, postUrl });
      
      const historyForBackend = chatHistory.slice(0, -1).map(msg => ({
        role: msg.role,
        content: msg.content,
        tool_calls: msg.tool_calls,
      }));

      const response = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          history: historyForBackend,
          createTaskRecord: true,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        addMessage('error', 'Send failed: ' + (errorData.error || 'Unknown error'));
              setLoading(false);
        return;
      }

      const responseData = await response.json();
      console.log('[AgentChat] POST response:', responseData);
      const taskRecordId = responseData.taskRecordId;
      
      if (!taskRecordId) {
        console.error('[AgentChat] Task created but record ID missing', responseData);
        addMessage('error', 'Task created but record ID missing: ' + JSON.stringify(responseData));
        setLoading(false);
        return;
      }

      console.log('[AgentChat] Task created, subscribing to record via session:', taskRecordId);

      // 确保 session 已连接
      try {
        await connectToSession();
        
        // 再次检查连接状态
        if (!sessionConnected || !sessionWebSocket) {
          throw new Error('Session connection failed');
        }
        
        // 通过 session 订阅新的 record
        sessionWebSocket.send(JSON.stringify({
          type: 'subscribe_record',
          rid: taskRecordId,
        }));
        console.log('[AgentChat] Subscribed to record via session:', taskRecordId);
      } catch (error: any) {
        console.error('[AgentChat] Failed to connect to session or subscribe:', error);
        addMessage('error', 'Failed to connect to session: ' + (error.message || String(error)));
        setLoading(false);
      }

    } catch (error: any) {
      console.error('[AgentChat] Error:', error);
      addMessage('error', 'Send failed: ' + error.message);
      setLoading(false);
    }
  }

  sendButton.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
});

export default page;

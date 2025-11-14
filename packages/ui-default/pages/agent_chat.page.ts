import { NamedPage } from 'vj/misc/Page';

let sessionWebSocket: any = null;
let sessionConnected = false;
let sessionConnectPromise: Promise<void> | null = null;
let currentSessionId: string | null = null;

const page = new NamedPage('agent_chat', async () => {
  const UiContext = (window as any).UiContext;
  const domainId = UiContext?.domainId;
  const mode = UiContext?.mode || 'list';
  const sessionId = UiContext?.sessionId || '';
  const aid = UiContext?.aid;
  
  if (!domainId || !aid) {
    console.error('[AgentChat] Missing domainId or aid');
    return;
  }

  const wsPrefix = UiContext?.ws_prefix || '/';
  const urlMatch = window.location.pathname.match(/\/agent\/([^\/]+)\/chat/);
  const urlAid = urlMatch ? urlMatch[1] : aid;

  // 共享的 connectToSession, sendMessage 等函数定义（需要在列表模式之前定义）
  const connectToSession = async (): Promise<void> => {
    if (sessionConnected && sessionWebSocket) {
      console.log('[AgentChat] Session already connected');
      return;
    }
    
    if (sessionConnectPromise) {
      return sessionConnectPromise;
    }
    
    sessionConnectPromise = new Promise<void>((resolve, reject) => {
      const wsUrl = `agent-chat-session?domainId=${domainId}&aid=${urlAid}`;
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
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    if (!msg.rid) {
      console.warn('[AgentChat] Invalid record update message: missing rid', msg);
      return;
    }
    
    const record = msg.record || {};
    const rid = msg.rid;
    
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
      
      const displayedNonUserCount = existingMessages.filter(
        (el: any) => !el.classList.contains('user')
      ).length;
      
      const recordNonUserMessages = record.agentMessages.filter((m: any) => m.role !== 'user');
      const recordNonUserCount = recordNonUserMessages.length;
      
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
              addMessage('assistant', content, undefined, toolCalls);
              addedCount++;
            } else if (msgData.role === 'tool') {
              const content = typeof msgData.content === 'string' 
                ? msgData.content 
                : JSON.stringify(msgData.content, null, 2);
              addMessage('tool', content, msgData.toolName);
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
        }
      }
    }
    
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
    
    if (record.status !== undefined) {
      if (isTerminalTaskStatus(record.status)) {
        console.log('[AgentChat] Task completed, status:', record.status);
        setLoading(false);
        currentRecordId = null;
      }
    }
  };
  
  function addMessage(role: string, content: string, toolName?: string, toolCalls?: any[]) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
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
  }

  function updateLastMessage(content: string, toolCalls?: any[]) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
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
    
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  const originalButtonText = 'Send';

  function setLoading(loading: boolean) {
    const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
    if (!sendButton) return;
    
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
    const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
    const chatMessages = document.getElementById('chatMessages');
    
    if (!chatInput || !chatMessages) return;
    
    const message = chatInput.value.trim();
    if (!message) return;

    addMessage('user', message);
    
    chatInput.value = '';
    setLoading(true);

    try {
      const postUrl = `/d/${domainId}/agent/${urlAid}/chat`;
      console.log('[AgentChat] Creating task via POST:', { message, postUrl, sessionId: currentSessionId });
      
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          history: [],
          createTaskRecord: true,
          // 如果 currentSessionId 为 null，不传 sessionId，让后端创建新 session
          ...(currentSessionId ? { sessionId: currentSessionId } : {}),
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
      const newSessionId = responseData.sessionId;
      
      if (!taskRecordId) {
        console.error('[AgentChat] Task created but record ID missing', responseData);
        addMessage('error', 'Task created but record ID missing: ' + JSON.stringify(responseData));
        setLoading(false);
        return;
      }

      // 如果返回了新的 sessionId（第一次发送消息时创建），无刷新切换到该 session 的 URL
      if (newSessionId && newSessionId !== currentSessionId) {
        currentSessionId = newSessionId;
        const newUrl = `/d/${domainId}/agent/${urlAid}/chat?sid=${newSessionId}`;
        // 使用 pushState 更新 URL，不刷新页面（类似 DeepSeek 的行为）
        window.history.pushState({ mode: 'chat', sessionId: newSessionId }, '', newUrl);
        // 更新 UiContext 中的 sessionId
        if (UiContext) {
          UiContext.sessionId = newSessionId;
        }
        console.log('[AgentChat] Session created and URL updated:', newSessionId);
      }

      console.log('[AgentChat] Task created, subscribing to record via session:', taskRecordId);

      // 确保 session 已连接
      try {
        await connectToSession();
        
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

  // 列表模式
  if (mode === 'list') {
    const sessionListMode = document.getElementById('sessionListMode');
    const newChatBtn = document.getElementById('newChatBtn');
    const sessionItems = document.querySelectorAll('.session-item');
    const chatMode = document.getElementById('chatMode');
    
    if (!sessionListMode) return;
    
    // 隐藏聊天模式（如果存在）
    if (chatMode) chatMode.style.display = 'none';
    
    // 新建会话按钮：切换到聊天模式（纯前端行为，不改变 URL）
    if (newChatBtn) {
      newChatBtn.addEventListener('click', () => {
        // 切换到聊天模式（URL 不变，纯前端切换）
        sessionListMode.style.display = 'none';
        const chatMode = document.getElementById('chatMode');
        if (chatMode) {
          chatMode.style.display = 'block';
          // 重置 sessionId，表示这是一个新会话
          currentSessionId = null;
          // 清空聊天消息
          const chatMessages = document.getElementById('chatMessages');
          if (chatMessages) {
            chatMessages.innerHTML = '';
          }
          // 初始化聊天模式（延迟执行，确保 DOM 已更新）
          setTimeout(() => {
            initChatModeForList();
          }, 100);
        } else {
          // 如果聊天模式不存在，跳转到新建聊天页面
          window.location.href = `/d/${domainId}/agent/${urlAid}/chat?new=true`;
        }
        // 不更新 URL，保持当前 URL 不变
      });
    }
    
    // 点击 session 项：跳转到对应的 session URL
    sessionItems.forEach(item => {
      item.addEventListener('click', () => {
        const sid = item.getAttribute('data-session-id');
        if (sid) {
          window.location.href = `/d/${domainId}/agent/${urlAid}/chat?sid=${sid}`;
        }
      });
    });
    
    return;
  }
  
  // 初始化聊天模式的函数（在列表模式下切换到聊天模式时调用）
  function initChatModeForList() {
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
    const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
    
    if (!chatMessages || !chatInput || !sendButton) {
      console.error('[AgentChat] Chat mode elements not found');
      return;
    }
    
    // 连接 session WebSocket
    connectToSession().then(() => {
      console.log('[AgentChat] Chat mode initialized from list mode');
    });
    
    // 设置发送按钮事件（使用一次性事件，避免重复绑定）
    const sendHandler = () => {
      sendMessage();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };
    
    sendButton.addEventListener('click', sendHandler);
    chatInput.addEventListener('keydown', keyHandler);
  }

  // 聊天模式
  const chatMode = document.getElementById('chatMode');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
  const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
  const mcpStatus = document.getElementById('mcpStatus');
  
  if (!chatMode || !chatMessages || !chatInput || !sendButton) return;
  
  // 显示聊天模式
  chatMode.style.display = 'block';
  currentSessionId = sessionId || null;
  
  // 加载历史记录（如果有）
  const recordHistory = UiContext?.recordHistory || [];
  if (recordHistory && Array.isArray(recordHistory) && recordHistory.length > 0) {
    recordHistory.forEach((msg: any) => {
      if (msg.role === 'user' || msg.role === 'assistant') {
        addMessage(msg.role, msg.content, undefined, msg.tool_calls);
      }
    });
  }

  // 使用共享的 connectToSession 函数（已在列表模式下定义）
  await connectToSession();

  if (mcpStatus) {
    const mcpStatusUrl = mcpStatus.getAttribute('data-status-url') || '';
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
  }

  // 使用共享的 sendMessage 函数（已在列表模式下定义）

  sendButton.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
});

export default page;

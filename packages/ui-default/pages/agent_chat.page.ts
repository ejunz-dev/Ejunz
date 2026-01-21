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

  // Shared function definitions for connectToSession, sendMessage, etc. (must be defined before list mode)
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
  
  // Show/hide loading state
  function setLoadingState(loading: boolean, message?: string) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    let loadingIndicator = document.getElementById('sessionLoadingIndicator');
    if (loading) {
      if (!loadingIndicator) {
        loadingIndicator = document.createElement('div');
        loadingIndicator.id = 'sessionLoadingIndicator';
        loadingIndicator.style.cssText = 'text-align: center; padding: 20px; color: #666;';
        loadingIndicator.innerHTML = `
          <div style="display: inline-block;">
            <span class="loading" style="margin-right: 8px;"></span>
            <span>${message || '加载中...'}</span>
          </div>
        `;
        chatMessages.appendChild(loadingIndicator);
      } else {
        if (message) {
          const textSpan = loadingIndicator.querySelector('span:last-child');
          if (textSpan) textSpan.textContent = message;
        }
        loadingIndicator.style.display = 'block';
      }
    } else {
      if (loadingIndicator) {
        loadingIndicator.style.display = 'none';
      }
    }
  }
  
  // Update session list highlight state (immediate update, no API wait)
  function updateSessionHighlight(sessionId: string | null) {
    const sessionListSidebar = document.getElementById('sessionListSidebar');
    if (!sessionListSidebar) return;
    
    const sessionItems = sessionListSidebar.querySelectorAll('.session-item-sidebar');
    sessionItems.forEach(item => {
      const sid = item.getAttribute('data-session-id');
      const isActive = sid === sessionId;
      const element = item as HTMLElement;
      
      // Only set border highlight, don't change background color
      if (isActive) {
        element.style.setProperty('border-color', '#007bff', 'important');
        element.style.setProperty('border-width', '2px', 'important');
      } else {
        element.style.setProperty('border-color', '#ddd', 'important');
        element.style.setProperty('border-width', '1px', 'important');
      }
    });
  }
  
  // Switch to specified session (no page refresh)
  async function switchToSession(sessionId: string) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    // If already the current session, do nothing
    if (currentSessionId === sessionId) {
      return;
    }
    
    // Immediately update highlight state (before loading, instant feedback)
    updateSessionHighlight(sessionId);
    
    // Save previous sessionId (for error recovery)
    const previousSessionId = currentSessionId;
    // Update currentSessionId (update early to avoid duplicate clicks)
    currentSessionId = sessionId;
    
    try {
      // Show loading state
      setLoadingState(true, '正在加载会话历史...');
      
      // Clear current chat messages
      chatMessages.innerHTML = '';
      setLoadingState(true, '正在加载会话历史...');
      
      // Fetch history records for this session
      const response = await fetch(`/d/${domainId}/agent/${urlAid}/chat/session/${sessionId}/history`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });
      
      if (!response.ok) {
        console.error('[AgentChat] Failed to load session history:', response.status);
        setLoadingState(false);
        // If failed, fall back to page navigation
        window.location.href = `/d/${domainId}/agent/${urlAid}/chat?sid=${sessionId}`;
        return;
      }
      
      const data = await response.json();
      const recordHistory = data.recordHistory || [];
      
      // Update URL (no page refresh)
      const newUrl = `/d/${domainId}/agent/${urlAid}/chat?sid=${sessionId}`;
      window.history.pushState({ mode: 'chat', sessionId: sessionId }, '', newUrl);
      
      // Update sessionId in UiContext
      if (UiContext) {
        UiContext.sessionId = sessionId;
      }
      
      // Hide loading state
      setLoadingState(false);
      
      // Load history records
      if (recordHistory && Array.isArray(recordHistory) && recordHistory.length > 0) {
        recordHistory.forEach((msg: any) => {
          if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool') {
            addMessage(msg.role, msg.content, msg.toolName, msg.tool_calls);
          }
        });
        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
      } else {
        // If no history records, show message
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'text-align: center; padding: 20px; color: #999;';
        emptyMsg.textContent = '暂无消息';
        chatMessages.appendChild(emptyMsg);
      }
      
      // Update left sidebar session list (maintain highlight state)
      await updateSessionListSidebar();
      // Ensure highlight state is correct (updateSessionListSidebar regenerates HTML)
      updateSessionHighlight(sessionId);
      
      // Reconnect WebSocket (if needed)
      if (sessionWebSocket) {
        sessionWebSocket.close();
        sessionConnected = false;
      }
      await connectToSession();
      
      console.log('[AgentChat] Switched to session:', sessionId);
    } catch (error: any) {
      console.error('[AgentChat] Error switching session:', error);
      setLoadingState(false);
      // If error occurred, restore previous highlight state
      currentSessionId = previousSessionId;
      updateSessionHighlight(previousSessionId);
      // If error occurred, fall back to page navigation
      window.location.href = `/d/${domainId}/agent/${urlAid}/chat?sid=${sessionId}`;
    }
  }
  
  // Function to update session list sidebar (must be defined before sendMessage)
  async function updateSessionListSidebar() {
    const sessionListSidebar = document.getElementById('sessionListSidebar');
    if (!sessionListSidebar) return;
    
    try {
      // Fetch latest session list (JSON API)
      const response = await fetch(`/d/${domainId}/agent/${urlAid}/chat/sessions`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });
      
      if (!response.ok) {
        console.error('[AgentChat] Failed to fetch sessions:', response.status);
        return;
      }
      
      const data = await response.json();
      const sessions = data.sessions || [];
      
      if (sessions.length === 0) {
        sessionListSidebar.innerHTML = '<div class="typo"><p class="text-gray" style="font-size: 0.9em;">No sessions yet.</p></div>';
        return;
      }
      
      // Build session list HTML
      let html = '<div class="session-list">';
      for (const session of sessions) {
        const sessionId = session._id;
        const isActive = sessionId === currentSessionId;
        const title = session.title || `Session ${sessionId.substring(0, 8)}`;
        const recordCount = (session.recordIds || []).length;
        
        let lastMsgPreview = '';
        if (session.lastRecord && session.lastRecord.agentMessages) {
          const lastMsg = session.lastRecord.agentMessages[session.lastRecord.agentMessages.length - 1];
          if (lastMsg && lastMsg.content) {
            const content = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
            lastMsgPreview = content.length > 60 ? content.substring(0, 60) + '...' : content;
          }
        }
        
        const updatedAt = session.updatedAt || session._id;
        const updatedAtStr = new Date(updatedAt).toLocaleString('zh-CN', { 
          month: 'short', 
          day: 'numeric', 
          hour: '2-digit', 
          minute: '2-digit' 
        });
        
        html += `
          <div class="session-item-sidebar" data-session-id="${sessionId}" 
               style="border: 1px solid #ddd; border-radius: 4px; padding: 12px; margin-bottom: 8px; cursor: pointer; ${isActive ? 'border-color: #007bff; border-width: 2px;' : ''}">
            <div style="flex: 1;">
              <h4 style="margin: 0 0 5px 0; font-size: 0.95em; font-weight: 600;">${title}</h4>
              ${lastMsgPreview ? `<p style="margin: 5px 0; color: #666; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${lastMsgPreview}</p>` : ''}
              <div style="font-size: 0.8em; color: #999; margin-top: 5px;">
                <span>${recordCount} records</span>
                <span style="margin-left: 8px;">${updatedAtStr}</span>
              </div>
            </div>
          </div>
        `;
      }
      html += '</div>';
      
      sessionListSidebar.innerHTML = html;
      
      // Rebind click events (no refresh switching)
      const sessionItems = sessionListSidebar.querySelectorAll('.session-item-sidebar');
      sessionItems.forEach(item => {
        const sid = item.getAttribute('data-session-id');
        if (sid) {
          item.addEventListener('click', async () => {
            await switchToSession(sid);
          });
        }
      });
    } catch (error: any) {
      console.error('[AgentChat] Error updating session list:', error);
    }
  }
  
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
          // If currentSessionId is null, don't pass sessionId, let backend create new session
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

      // If new sessionId is returned (auto-created on first message), update URL and sidebar
      if (newSessionId && newSessionId !== currentSessionId) {
        currentSessionId = newSessionId;
        const newUrl = `/d/${domainId}/agent/${urlAid}/chat?sid=${newSessionId}`;
        // Use pushState to update URL without page refresh (similar to DeepSeek behavior)
        window.history.pushState({ mode: 'chat', sessionId: newSessionId }, '', newUrl);
        // Update sessionId in UiContext
        if (UiContext) {
          UiContext.sessionId = newSessionId;
        }
        console.log('[AgentChat] Session created and URL updated:', newSessionId);
        
        // Update left sidebar session list
        await updateSessionListSidebar();
      }

      console.log('[AgentChat] Task created, subscribing to record via session:', taskRecordId);

      // Ensure session is connected
      try {
        await connectToSession();
        
        if (!sessionConnected || !sessionWebSocket) {
          throw new Error('Session connection failed');
        }
        
        // Subscribe to new record via session
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

  // List mode
  if (mode === 'list') {
    const sessionListMode = document.getElementById('sessionListMode');
    const newChatBtn = document.getElementById('newChatBtn');
    const sessionItems = document.querySelectorAll('.session-item');
    const chatMode = document.getElementById('chatMode');
    
    if (!sessionListMode) return;
    
    // Hide chat mode (if exists)
    if (chatMode) chatMode.style.display = 'none';
    
    // New chat button: switch to chat mode (pure frontend behavior, don't change URL)
    if (newChatBtn) {
      newChatBtn.addEventListener('click', () => {
        // Switch to chat mode (URL unchanged, pure frontend switch)
        sessionListMode.style.display = 'none';
        const chatMode = document.getElementById('chatMode');
        if (chatMode) {
          chatMode.style.display = 'block';
          // Reset sessionId, indicating this is a new session
          currentSessionId = null;
          // Clear chat messages
          const chatMessages = document.getElementById('chatMessages');
          if (chatMessages) {
            chatMessages.innerHTML = '';
          }
          // Initialize chat mode (delayed execution to ensure DOM is updated)
          setTimeout(() => {
            initChatModeForList();
          }, 100);
        } else {
          // If chat mode doesn't exist, navigate to new chat page
          window.location.href = `/d/${domainId}/agent/${urlAid}/chat?new=true`;
        }
        // Don't update URL, keep current URL unchanged
      });
    }
    
    // Click session item: navigate to corresponding session URL
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
  
  // Function to initialize chat mode (called when switching to chat mode from list mode)
  function initChatModeForList() {
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
    const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
    
    if (!chatMessages || !chatInput || !sendButton) {
      console.error('[AgentChat] Chat mode elements not found');
      return;
    }
    
    // Connect to session WebSocket
    connectToSession().then(() => {
      console.log('[AgentChat] Chat mode initialized from list mode');
    });
    
    // Set send button event (use one-time event to avoid duplicate binding)
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

  // Chat mode
  const chatMode = document.getElementById('chatMode');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
  const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
  
  if (!chatMode || !chatMessages || !chatInput || !sendButton) return;
  
  // Show chat mode
  chatMode.style.display = 'block';
  currentSessionId = sessionId || null;

  // Left sidebar plus button: clear chat box and create new session
  const newChatBtnSidebar = document.getElementById('newChatBtnSidebar');
  if (newChatBtnSidebar) {
    newChatBtnSidebar.addEventListener('click', () => {
      // Clear chat messages
      chatMessages.innerHTML = '';
      // Reset sessionId, indicating this is a new session
      currentSessionId = null;
      // Update URL, remove sid parameter
      const newUrl = `/d/${domainId}/agent/${urlAid}/chat`;
      window.history.pushState({ mode: 'chat', sessionId: null }, '', newUrl);
      // Update sessionId in UiContext
      if (UiContext) {
        UiContext.sessionId = '';
      }
      // Update left sidebar session list (remove current session highlight)
      updateSessionListSidebar();
      console.log('[AgentChat] Chat cleared, ready for new session');
    });
  }

  // Load history records (if any)
  const recordHistory = UiContext?.recordHistory || [];
  if (recordHistory && Array.isArray(recordHistory) && recordHistory.length > 0) {
    recordHistory.forEach((msg: any) => {
      if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool') {
        addMessage(msg.role, msg.content, msg.toolName, msg.tool_calls);
      }
    });
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Use shared connectToSession function (already defined in list mode)
  await connectToSession();

  // Bind click events for initially rendered session items (if in template)
  const initialSessionItems = document.querySelectorAll('.session-item-sidebar');
  initialSessionItems.forEach(item => {
    const sid = item.getAttribute('data-session-id');
    if (sid) {
      item.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await switchToSession(sid);
      });
    }
  });

  // Handle browser back/forward buttons
  window.addEventListener('popstate', async (event) => {
    const urlParams = new URLSearchParams(window.location.search);
    const sid = urlParams.get('sid');
    if (sid && sid !== currentSessionId) {
      await switchToSession(sid);
    } else if (!sid && currentSessionId) {
      // If no sid in URL, clear chat box
      currentSessionId = null;
      chatMessages.innerHTML = '';
      if (UiContext) {
        UiContext.sessionId = '';
      }
      await updateSessionListSidebar();
    }
  });

  // Use shared sendMessage function (already defined in list mode)

  sendButton.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
});

export default page;

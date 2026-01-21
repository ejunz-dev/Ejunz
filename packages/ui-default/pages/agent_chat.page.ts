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
      return;
    }
    
    if (sessionConnectPromise) {
      return sessionConnectPromise;
    }
    
    sessionConnectPromise = new Promise<void>((resolve, reject) => {
      const wsUrl = `agent-chat-session?domainId=${domainId}&aid=${urlAid}`;
      
      import('../components/socket').then(({ default: WebSocket }) => {
        const sock = new WebSocket(wsPrefix + wsUrl, false, true);
        sessionWebSocket = sock;
        sessionConnected = false;
        
        sock.onopen = () => {
          sessionConnected = true;
          resolve();
        };
        
        sock.onmessage = (_, data: string) => {
          try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'session_connected') {
            } else if (msg.type === 'message_start') {
              handleMessageStart(msg);
            } else if (msg.type === 'message_complete') {
              handleMessageComplete(msg);
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
  
  // Track message lifecycle: messages that have started and completed
  const activebubbleIds = new Set<string>(); // Messages currently being streamed
  const completedbubbleIds = new Set<string>(); // Messages that have completed
  
  // Handle message start event
  function handleMessageStart(msg: any) {
    const { rid, bubbleId } = msg;
    if (bubbleId) {
      activebubbleIds.add(bubbleId);
      completedbubbleIds.delete(bubbleId); // Remove from completed if restarted
    }
  }
  
  // Handle message complete event
  function handleMessageComplete(msg: any) {
    const { rid, bubbleId } = msg;
    if (bubbleId) {
      activebubbleIds.delete(bubbleId);
      completedbubbleIds.add(bubbleId);
      console.log('[AgentChat] Message completed:', { rid, bubbleId, completedCount: completedbubbleIds.size });
    }
  }
  
  // Render markdown content to HTML
  async function renderMarkdown(text: string, inline: boolean = false): Promise<string> {
    try {
      const response = await fetch('/markdown', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text || '',
          inline: inline,
        }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to render markdown');
      }
      
      return await response.text();
    } catch (error: any) {
      console.error('[AgentChat] Error rendering markdown:', error);
      // Fallback to plain text with escaped HTML
      return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }
  
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
        // Render all messages sequentially to ensure proper order
        for (const msg of recordHistory) {
          if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool') {
            await addMessage(msg.role, msg.content, msg.toolName, msg.tool_calls, msg.bubbleId);
          }
        }
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
  
  // Helper function to check if task is in terminal status
  const getTaskStatusInfo = () => {
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
    return { STATUS, ACTIVE_TASK_STATUSES, isTerminalTaskStatus };
  };
  
  const handleRecordUpdate = async (msg: any) => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    if (!msg.rid) {
      console.warn('[AgentChat] Invalid record update message: missing rid', msg);
      return;
    }
    
    const record = msg.record || {};
    const rid = msg.rid;
    
    if (currentRecordId !== rid) {
      currentRecordId = rid;
    }
    
    // Check if task is streaming (before processing messages)
    const { isTerminalTaskStatus } = getTaskStatusInfo();
    const isStreaming = record.status !== undefined && !isTerminalTaskStatus(record.status);
    const isCompleted = record.status !== undefined && isTerminalTaskStatus(record.status);
    
    if (record.agentMessages && Array.isArray(record.agentMessages)) {
      const newMessagesCount = record.agentMessages.length;
      
      // If task is completed, only update existing messages, never create new ones
      if (isCompleted) {
      }
      
      // Use bubbleId-based tracking to prevent duplicates
      // Each message element gets a data-message-id attribute
      const getbubbleId = (el: Element): string | null => {
        return el.getAttribute('data-message-id');
      };
      
      const setbubbleId = (el: Element, bubbleId: string) => {
        el.setAttribute('data-message-id', bubbleId);
      };
      
      // Count all message-related elements (chat-message, tool-call-container, tool-result-container)
      const existingMessages = Array.from(chatMessages.children).filter(
        (el: any) => 
          (el.classList.contains('chat-message') && 
           (el.classList.contains('user') || el.classList.contains('assistant'))) ||
          el.classList.contains('tool-call-container') ||
          el.classList.contains('tool-result-container')
      );
      
      // Build a map of displayed message IDs
      // Start with global set to include messages added before record updates
      const displayedbubbleIds = new Set<string>(displayedbubbleIdsGlobal);
      existingMessages.forEach((el: Element) => {
        const bubbleId = getbubbleId(el);
        if (bubbleId) {
          displayedbubbleIds.add(bubbleId);
          displayedbubbleIdsGlobal.add(bubbleId);
        }
      });
      
      // Process messages: add new ones or update existing ones
      (async () => {
        for (let i = 0; i < newMessagesCount; i++) {
          const msgData = record.agentMessages[i];
          let bubbleId = msgData.bubbleId;
          const hadbubbleId = !!bubbleId; // Track if bubbleId was originally present
          
          if (!bubbleId && msgData.role === 'assistant' && msgData.content) {
            const content = (msgData.content || '').trim();
            if (content) {
              // Check all assistant messages in DOM for content match
              const allAssistantMessages = Array.from(chatMessages.children).filter(
                (el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant')
              );
              
              for (const existingMsg of allAssistantMessages) {
                const existingId = getbubbleId(existingMsg);
                if (existingId) {
                  continue;
                }
                
                const messageBubble = existingMsg.querySelector('.message-bubble');
                if (messageBubble) {
                  const contentDiv = messageBubble.querySelector('.message-content');
                  if (contentDiv) {
                    const existingContent = contentDiv.textContent?.trim() || '';
                    if (existingContent === content) {
                      bubbleId = existingId || generatebubbleId();
                      setbubbleId(existingMsg, bubbleId);
                      displayedbubbleIds.add(bubbleId);
                      displayedbubbleIdsGlobal.add(bubbleId);
                      break;
                    }
                  }
                }
              }
            }
          }
          
          if (bubbleId && msgData.role === 'assistant') {
            const allAssistantMessages = Array.from(chatMessages.children).filter(
              (el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant')
            );
            
            let preCreatedMsg: Element | null = null;
            for (let j = allAssistantMessages.length - 1; j >= 0; j--) {
              const existingMsg = allAssistantMessages[j];
              const existingId = getbubbleId(existingMsg);
              if (existingId && existingId.startsWith('temp-')) {
                preCreatedMsg = existingMsg;
                break;
              }
            }
            
            if (preCreatedMsg) {
              setbubbleId(preCreatedMsg, bubbleId);
              displayedbubbleIds.add(bubbleId);
              displayedbubbleIdsGlobal.add(bubbleId);
            } else {
              displayedbubbleIds.add(bubbleId);
              displayedbubbleIdsGlobal.add(bubbleId);
            }
          } else if (!bubbleId && msgData.role === 'assistant') {
            const allAssistantMessages = Array.from(chatMessages.children).filter(
              (el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant')
            );
            
            let preCreatedMsg: Element | null = null;
            for (let j = allAssistantMessages.length - 1; j >= 0; j--) {
              const existingMsg = allAssistantMessages[j];
              const existingId = getbubbleId(existingMsg);
              if (existingId && existingId.startsWith('temp-')) {
                preCreatedMsg = existingMsg;
                break;
              }
            }
            
            if (preCreatedMsg) {
              bubbleId = generatebubbleId();
              setbubbleId(preCreatedMsg, bubbleId);
              displayedbubbleIds.add(bubbleId);
              displayedbubbleIdsGlobal.add(bubbleId);
              console.error('[AgentChat] Backend did not provide bubbleId for assistant message, generated fallback:', bubbleId);
            } else {
              bubbleId = generatebubbleId();
              console.error('[AgentChat] Backend did not provide bubbleId and no pre-created message found, generated fallback:', bubbleId);
            }
          } else if (!bubbleId) {
            bubbleId = generatebubbleId();
          }
          
          if (msgData.role === 'user') {
            // For user messages, always check if already displayed first
            // This prevents duplicate adds during streaming updates
            if (displayedbubbleIds.has(bubbleId)) {
              // User message already displayed, skip
              continue;
            }
            
            // Find user message by bubbleId in DOM
            let userMessage = Array.from(chatMessages.children).find(
              (el: any) => el.classList.contains('chat-message') && 
                          el.classList.contains('user') &&
                          getbubbleId(el) === bubbleId
            );
            
            if (userMessage) {
              // Message exists in DOM, mark as displayed
              displayedbubbleIds.add(bubbleId);
              displayedbubbleIdsGlobal.add(bubbleId);
            } else {
              // Message not in DOM, but check if content matches any existing user message
              // This handles cases where bubbleId wasn't set properly
              const content = msgData.content || '';
              const existingUserMessages = Array.from(chatMessages.children).filter(
                (el: any) => el.classList.contains('chat-message') && el.classList.contains('user')
              );
              
              // Check if any existing user message matches this content and doesn't have a bubbleId
              const matchingMessage = existingUserMessages.find((el: any) => {
                const existingId = getbubbleId(el);
                if (existingId) return false; // Skip messages that already have an ID
                const messageBubble = el.querySelector('.message-bubble');
                const existingContent = messageBubble?.textContent?.trim() || '';
                return existingContent === content.trim();
              });
              
              if (matchingMessage) {
                // Found matching message without ID, set the bubbleId
                setbubbleId(matchingMessage, bubbleId);
                displayedbubbleIds.add(bubbleId);
                displayedbubbleIdsGlobal.add(bubbleId);
              } else if (content) {
                // No matching message found, create new one (shouldn't happen normally)
                console.warn('[AgentChat] Creating new user message from record update:', bubbleId);
                await addMessage('user', content, undefined, undefined, bubbleId);
                displayedbubbleIds.add(bubbleId);
                displayedbubbleIdsGlobal.add(bubbleId);
              }
            }
            continue;
          }
          
          // For assistant messages, always try to update existing message first (for streaming)
            if (msgData.role === 'assistant') {
              const content = msgData.content || '';
              const toolCalls = msgData.tool_calls;
            
            // CRITICAL: If task is completed, only update existing messages, never create new ones
            // This prevents duplicates when multiple record_update events arrive after completion
            if (isCompleted && !displayedbubbleIds.has(bubbleId)) {
              // Task is completed and message not in displayedbubbleIds, check DOM first
              const existingInDOM = Array.from(chatMessages.children).find(
                (el: any) => getbubbleId(el) === bubbleId && 
                            el.classList.contains('chat-message') && 
                            el.classList.contains('assistant')
              );
              if (!existingInDOM) {
                // Message not in DOM and task is completed, skip to prevent duplicates
                continue;
              }
            }
            
            // Use event-based lifecycle tracking
            if (completedbubbleIds.has(bubbleId)) {
              continue;
            }
            
            // CRITICAL: If bubbleId was generated (missing from backend), check for existing message by content FIRST
            // This prevents creating duplicate messages when backend doesn't send bubbleId
            const originalbubbleId = msgData.bubbleId; // The bubbleId from backend (may be undefined)
            const isGeneratedId = !originalbubbleId && bubbleId; // bubbleId was generated by frontend
            
            if (isGeneratedId && content && content.trim()) {
              // bubbleId was generated, meaning backend didn't provide one
              // Check if there's already a message with this content in DOM
              const allAssistantMessages = Array.from(chatMessages.children).filter(
                (el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant')
              );
              
              for (const existingMsg of allAssistantMessages) {
                const existingId = getbubbleId(existingMsg);
                // Skip if already has a different bubbleId
                if (existingId && existingId !== bubbleId) {
                  continue;
                }
                
                // Check content match
                const messageBubble = existingMsg.querySelector('.message-bubble');
                if (messageBubble) {
                  const contentDiv = messageBubble.querySelector('.message-content');
                  if (contentDiv) {
                    const existingContent = contentDiv.textContent?.trim() || '';
                    const newContent = content.trim();
                    
                    if (existingContent && newContent && existingContent === newContent) {
                      // Found exact match! Use the existing message instead of creating new
                      if (!existingId) {
                        // Set the generated bubbleId on existing message
                        setbubbleId(existingMsg, bubbleId);
                        displayedbubbleIds.add(bubbleId);
                        displayedbubbleIdsGlobal.add(bubbleId);
                        if (!isStreaming) {
                          completedbubbleIds.add(bubbleId);
                        } else {
                          activebubbleIds.add(bubbleId);
                        }
                      } else {
                        // Already has bubbleId, just mark as displayed
                        displayedbubbleIds.add(bubbleId);
                        displayedbubbleIdsGlobal.add(bubbleId);
                      }
                      // Update content if needed (for markdown rendering)
                      if (!isStreaming && contentDiv.textContent && !contentDiv.innerHTML.includes('<')) {
                        renderMarkdown(content, false).then(renderedHtml => {
                          contentDiv.innerHTML = renderedHtml;
                        });
                      }
                      continue; // Skip to next message in outer loop (don't create new)
                    }
                  }
                }
              }
            }
            
            // If message is completed, allow one final update if task is also completed
            // This ensures final content is rendered correctly even after completion
            if (completedbubbleIds.has(bubbleId)) {
              // If task is completed, allow one final content update to ensure completeness
              if (isCompleted) {
                // Find existing message and update content one last time
                const existingMsg = Array.from(chatMessages.children).find(
                  (el: any) => getbubbleId(el) === bubbleId && 
                              el.classList.contains('chat-message') && 
                              el.classList.contains('assistant')
                );
                if (existingMsg) {
                  const messageBubble = existingMsg.querySelector('.message-bubble');
                  if (messageBubble) {
                    const contentDiv = messageBubble.querySelector('.message-content');
                    if (contentDiv && content) {
                      // Only update if content is different (to avoid unnecessary updates)
                      const currentContent = contentDiv.textContent?.trim() || '';
                      if (currentContent !== content.trim()) {
                        // Final update: render markdown for completed message
                        try {
                          const response = await fetch('/system/markdown', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ content }),
                          });
                          if (response.ok) {
                            const data = await response.json();
                            contentDiv.innerHTML = data.html || content;
                          } else {
                            contentDiv.textContent = content;
                          }
                        } catch (e) {
                          contentDiv.textContent = content;
                        }
                      }
                    }
                  }
                }
              }
              // Skip further processing for completed messages
              continue;
            }
            
            // If message is not active and not in displayedbubbleIds, it might be a new message
            // But if it's not streaming and we haven't seen it start, be cautious
            if (!isStreaming && !activebubbleIds.has(bubbleId) && !displayedbubbleIds.has(bubbleId)) {
              // This could be a late update, check if content matches existing message
              const allAssistantMessages = Array.from(chatMessages.children).filter(
                (el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant')
              );
              
              let foundMatching = false;
              for (const existingMsg of allAssistantMessages) {
                const existingId = getbubbleId(existingMsg);
                if (existingId === bubbleId) {
                  foundMatching = true;
              break;
            }
                // Check by content if no bubbleId
                if (!existingId && content) {
                  const messageBubble = existingMsg.querySelector('.message-bubble');
                  if (messageBubble) {
                    const contentDiv = messageBubble.querySelector('.message-content');
                    if (contentDiv) {
                      const existingContent = contentDiv.textContent?.trim() || '';
                      if (existingContent === content.trim()) {
                        // Found matching message, set bubbleId and mark as completed
                        setbubbleId(existingMsg, bubbleId);
                        displayedbubbleIds.add(bubbleId);
                        displayedbubbleIdsGlobal.add(bubbleId);
                        completedbubbleIds.add(bubbleId);
                        foundMatching = true;
                        break;
                      }
                    }
                  }
                }
              }
              
              if (foundMatching) {
                continue;
              }
            }
            
            // First, try to find by bubbleId
            let assistantMsg = Array.from(chatMessages.children).find(
              (el: any) => getbubbleId(el) === bubbleId && 
                          el.classList.contains('chat-message') && 
                          el.classList.contains('assistant')
            );
            
            // If not found by bubbleId, check tool-call-container
            if (!assistantMsg) {
              const toolCallContainer = Array.from(chatMessages.children).find(
                (el: any) => getbubbleId(el) === bubbleId && el.classList.contains('tool-call-container')
              );
              if (toolCallContainer) {
                const allChildren = Array.from(chatMessages.children);
                const containerIndex = allChildren.indexOf(toolCallContainer);
                assistantMsg = allChildren
                  .slice(containerIndex + 1)
                  .find((el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant'));
              }
            }
            
            // If still not found and streaming, find the last assistant message (for streaming updates)
            if (!assistantMsg && isStreaming) {
              const allChildren = Array.from(chatMessages.children);
              for (let j = allChildren.length - 1; j >= 0; j--) {
                const el = allChildren[j];
                if (el.classList.contains('chat-message') && el.classList.contains('assistant')) {
                  assistantMsg = el;
                  // Set bubbleId on the found message if it doesn't have one
                  if (!getbubbleId(assistantMsg)) {
                    setbubbleId(assistantMsg, bubbleId);
                    displayedbubbleIds.add(bubbleId);
                    displayedbubbleIdsGlobal.add(bubbleId);
                  }
                  break;
                }
              }
            }
            
            // If found existing message, update it
            if (assistantMsg && assistantMsg.classList.contains('assistant')) {
              // Update existing assistant message (streaming or final)
              const messageBubble = assistantMsg.querySelector('.message-bubble');
              if (messageBubble) {
                let contentDiv = messageBubble.querySelector('.message-content');
              if (!contentDiv) {
                  contentDiv = document.createElement('div');
                  contentDiv.className = 'message-content';
                  messageBubble.appendChild(contentDiv);
                }
                
                if (isStreaming) {
                  contentDiv.textContent = content;
                } else {
                  const renderedHtml = await renderMarkdown(content, false);
                  contentDiv.innerHTML = renderedHtml;
                }
                chatMessages.scrollTop = chatMessages.scrollHeight;
              }
              
              // Ensure bubbleId is set and tracked
              if (!displayedbubbleIds.has(bubbleId)) {
                displayedbubbleIds.add(bubbleId);
                displayedbubbleIdsGlobal.add(bubbleId);
              }
              continue;
            } else if (toolCalls && toolCalls.length > 0) {
              // Handle tool calls - check if we need to create message first
              // But skip if already displayed and not streaming
              if (!isStreaming && displayedbubbleIds.has(bubbleId)) {
                continue;
              }
              
              if (!assistantMsg) {
                // Create assistant message first if it doesn't exist
                displayedbubbleIds.add(bubbleId);
                displayedbubbleIdsGlobal.add(bubbleId);
                await addMessage('assistant', content || '', undefined, toolCalls, bubbleId);
              } else {
                updateLastMessage(content, toolCalls, isStreaming);
              }
              if (!displayedbubbleIds.has(bubbleId)) {
                displayedbubbleIds.add(bubbleId);
                displayedbubbleIdsGlobal.add(bubbleId);
              }
              continue;
            }
            
            // If no existing message found, create a new one
            
            // Check 1: Already in displayedbubbleIds
            if (displayedbubbleIds.has(bubbleId)) {
              continue;
            }
            
            // Check 1.5: If task is completed, NEVER create new messages
            // This is the most critical check to prevent duplicates after completion
            if (isCompleted) {
              // Double-check DOM one more time
              const finalCheckInDOM = Array.from(chatMessages.children).find(
                (el: any) => {
                  const elId = getbubbleId(el);
                  if (elId === bubbleId) return true;
                  // Also check by content if no bubbleId match
                  if (!elId && content && content.trim()) {
                    const messageBubble = el.querySelector('.message-bubble');
                    if (messageBubble) {
                      const contentDiv = messageBubble.querySelector('.message-content');
                      if (contentDiv) {
                        const existingContent = contentDiv.textContent?.trim() || '';
                        return existingContent === content.trim();
                      }
                    }
                  }
                  return false;
                }
              );
              if (!finalCheckInDOM) {
                continue;
              } else {
                // Found in DOM, update it instead of creating new
                setbubbleId(finalCheckInDOM as Element, bubbleId);
                displayedbubbleIds.add(bubbleId);
                displayedbubbleIdsGlobal.add(bubbleId);
                completedbubbleIds.add(bubbleId);
                // Update content if needed
                const messageBubble = (finalCheckInDOM as any).querySelector('.message-bubble');
                if (messageBubble) {
                  const contentDiv = messageBubble.querySelector('.message-content');
                  if (contentDiv && content) {
                    if (!isStreaming) {
                      // Render markdown for completed message
                      try {
                        const response = await fetch('/system/markdown', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ content }),
                        });
                        if (response.ok) {
                          const data = await response.json();
                          contentDiv.innerHTML = data.html || content;
                        } else {
              contentDiv.textContent = content;
            }
                      } catch (e) {
                        contentDiv.textContent = content;
                      }
                    } else {
                      contentDiv.textContent = content;
                    }
                  }
                }
                continue;
              }
            }
            
            // Check 2: Check DOM for any assistant message with same or similar content
            if (content && content.trim()) {
              const allAssistantMessages = Array.from(chatMessages.children).filter(
                (el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant')
              );
              
              for (const existingMsg of allAssistantMessages) {
                const existingId = getbubbleId(existingMsg);
                
                // Skip if already has a different bubbleId (different message)
                if (existingId && existingId !== bubbleId) {
                  continue;
                }
                
                // Check content match
                const messageBubble = existingMsg.querySelector('.message-bubble');
                if (messageBubble) {
                  const contentDiv = messageBubble.querySelector('.message-content');
                  if (contentDiv) {
                    // Get text content (works for both raw text and rendered HTML)
                    const existingContent = contentDiv.textContent?.trim() || '';
                    const newContent = content.trim();
                    
                    if (existingContent && newContent) {
                      // Exact match
                      if (existingContent === newContent) {
                        // Found matching message, set bubbleId and update
                        setbubbleId(existingMsg, bubbleId);
                        displayedbubbleIds.add(bubbleId);
                        displayedbubbleIdsGlobal.add(bubbleId);
                        if (!isStreaming) {
                          completedbubbleIds.add(bubbleId);
                        } else {
                          activebubbleIds.add(bubbleId);
                        }
                        // Update content if needed
                        if (isStreaming) {
                          contentDiv.textContent = content;
                        } else if (contentDiv.textContent && !contentDiv.innerHTML.includes('<')) {
                          renderMarkdown(content, false).then(renderedHtml => {
                            contentDiv.innerHTML = renderedHtml;
                          });
                        }
                        continue; // Skip to next message in outer loop
                      }
                      
                      // Substantial overlap check (one contains the other with 80%+ similarity)
                      const longer = existingContent.length > newContent.length ? existingContent : newContent;
                      const shorter = existingContent.length > newContent.length ? newContent : existingContent;
                      if (longer.includes(shorter) && shorter.length / longer.length > 0.8) {
                        // Update the existing message instead of creating new
                        setbubbleId(existingMsg, bubbleId);
                        displayedbubbleIds.add(bubbleId);
                        displayedbubbleIdsGlobal.add(bubbleId);
                        if (!isStreaming) {
                          completedbubbleIds.add(bubbleId);
                        } else {
                          activebubbleIds.add(bubbleId);
                        }
                        // Update content
                        if (isStreaming) {
                          contentDiv.textContent = content;
                        } else {
                          const renderedHtml = await renderMarkdown(content, false);
                          contentDiv.innerHTML = renderedHtml;
                        }
                        continue; // Skip to next message in outer loop
                      }
                    }
                  }
                }
              }
            }
            
            // Check 3: If completed, don't create
            if (completedbubbleIds.has(bubbleId)) {
              continue;
            }
            
            // Check 4: If not streaming and not active, be very cautious - check for messages without IDs
            if (!isStreaming && !activebubbleIds.has(bubbleId)) {
              const messagesWithoutId = Array.from(chatMessages.children).filter(
                (el: any) => el.classList.contains('chat-message') && 
                            el.classList.contains('assistant') &&
                            !getbubbleId(el)
              );
              
              if (messagesWithoutId.length > 0) {
                // There are messages without IDs, don't create new one to avoid duplicates
                continue;
              }
            }
            
            // This handles the first message in a stream or when bubbleId doesn't match
            // Only create during streaming or if truly new
            displayedbubbleIds.add(bubbleId);
            displayedbubbleIdsGlobal.add(bubbleId);
            if (isStreaming) {
              activebubbleIds.add(bubbleId);
            }
            await addMessage('assistant', content, undefined, toolCalls, bubbleId);
            continue;
          }
          
          // For tool messages (tool results)
          if (msgData.role === 'tool') {
            const toolCallId = msgData.tool_call_id;
            const toolName = msgData.toolName || 'Unknown Tool';
            
            // Try to find the corresponding tool call item by tool_call_id
            let toolCallItem: Element | null = null;
            if (toolCallId) {
              toolCallItem = Array.from(chatMessages.querySelectorAll('.tool-call-item')).find(
                (el: any) => el.getAttribute('data-tool-call-id') === toolCallId
              ) as Element | null;
            }
            
            if (toolCallItem) {
              // Update tool call status to success
              toolCallItem.setAttribute('data-tool-status', 'success');
              const statusBadge = toolCallItem.querySelector('.tool-status-badge') as HTMLElement;
              if (statusBadge) {
                statusBadge.textContent = '执行成功';
                statusBadge.style.cssText = 'padding: 2px 8px; border-radius: 12px; background: #4caf50; color: white; font-size: 11px;';
              }
              
              // Add tool result to the tool call item (in details section)
              const toolCallDetails = toolCallItem.querySelector('.tool-call-details') as HTMLElement;
              if (toolCallDetails) {
                // Check if result already exists
                let resultDiv = toolCallDetails.querySelector('.tool-call-result') as HTMLElement;
                if (!resultDiv) {
                  resultDiv = document.createElement('div');
                  resultDiv.className = 'tool-call-result';
                  resultDiv.style.cssText = 'margin-top: 8px;';
                  
                  const resultLabel = document.createElement('div');
                  resultLabel.textContent = '结果:';
                  resultLabel.style.cssText = 'font-size: 11px; color: #666; margin-bottom: 4px;';
                  resultDiv.appendChild(resultLabel);
                  
                  const resultPre = document.createElement('pre');
                  resultPre.style.cssText = 'margin: 0; padding: 8px; background: #e7f3ff; border: 1px solid #b3d9ff; border-radius: 4px; font-size: 12px; overflow-x: auto; max-height: 300px; overflow-y: auto;';
                  resultDiv.appendChild(resultPre);
                  
                  toolCallDetails.appendChild(resultDiv);
                }
                
                const resultPre = resultDiv.querySelector('pre') as HTMLElement;
                if (resultPre) {
                  const toolContent = typeof msgData.content === 'string' 
                    ? msgData.content 
                    : JSON.stringify(msgData.content, null, 2);
                  resultPre.textContent = toolContent;
                }
                
                // Auto-expand if collapsed
                if (toolCallDetails.style.display === 'none') {
                  toolCallDetails.style.display = 'block';
                  const toggleIcon = toolCallItem.querySelector('.tool-call-toggle-icon') as HTMLElement;
                  if (toggleIcon) {
                    toggleIcon.textContent = '▲';
                  }
                }
              }
              
              // Mark as displayed
              if (bubbleId) {
                displayedbubbleIds.add(bubbleId);
                displayedbubbleIdsGlobal.add(bubbleId);
              }
            } else {
              // Tool call item not found, create standalone tool result (fallback)
              if (displayedbubbleIds.has(bubbleId)) {
                continue;
              }
              
              const toolContent = typeof msgData.content === 'string' 
                ? msgData.content 
                : JSON.stringify(msgData.content, null, 2);
              displayedbubbleIds.add(bubbleId);
              displayedbubbleIdsGlobal.add(bubbleId);
              await addMessage('tool', toolContent, toolName, undefined, bubbleId);
            }
            continue;
          }
        }
      })();
      
    }
    
    // Check task status and handle completion
    if (record.status !== undefined) {
      if (isTerminalTaskStatus(record.status)) {
        setLoading(false);
        currentRecordId = null;
        
        // When task is complete, render markdown for the last assistant message
        const lastAssistantMessage = Array.from(chatMessages.children)
          .reverse()
          .find((el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant'));
        
        if (lastAssistantMessage) {
          const messageBubble = lastAssistantMessage.querySelector('.message-bubble');
          if (messageBubble) {
            const contentDiv = messageBubble.querySelector('.message-content');
            if (contentDiv) {
              // Check if content is still raw text (not yet rendered as markdown)
              const rawContent = contentDiv.textContent || '';
              // Only re-render if content exists and looks like it might be markdown
              if (rawContent && (rawContent.includes('**') || rawContent.includes('#') || rawContent.includes('`') || rawContent.includes('\n'))) {
                renderMarkdown(rawContent, false).then(renderedHtml => {
                  contentDiv.innerHTML = renderedHtml;
                  chatMessages.scrollTop = chatMessages.scrollHeight;
                });
              }
            }
          }
        }
      }
    }
  };
  
  async function addMessage(role: string, content: string, toolName?: string, toolCalls?: any[], bubbleId?: string) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    // Generate bubbleId if not provided
    if (!bubbleId) {
      bubbleId = generatebubbleId();
    }
    
    // Tool result messages - separate container
    if (role === 'tool') {
      // Set bubbleId for tool messages to prevent duplicates
      if (bubbleId) {
        // Check if tool message already exists
        const existingToolMessages = Array.from(chatMessages.children).filter(
          (el: any) => el.classList.contains('tool-result-container')
        );
        
        // Try to find by checking if any tool message has the same content
        for (const existingTool of existingToolMessages) {
          const toolBubble = existingTool.querySelector('.tool-result-bubble');
          if (toolBubble) {
            const toolContent = toolBubble.querySelector('.tool-content pre');
            if (toolContent && toolContent.textContent?.trim() === content.trim()) {
              // Found matching tool message, set bubbleId and skip
              existingTool.setAttribute('data-message-id', bubbleId);
              return;
            }
          }
        }
      }
      
      const toolContainer = document.createElement('div');
      toolContainer.className = 'tool-result-container';
      if (bubbleId) {
        toolContainer.setAttribute('data-message-id', bubbleId);
      }
      
      const toolBubble = document.createElement('div');
      toolBubble.className = 'tool-result-bubble';
      
      const toolHeader = document.createElement('div');
      toolHeader.className = 'tool-header';
      toolHeader.textContent = toolName || 'Unknown Tool';
      toolBubble.appendChild(toolHeader);
      
      const toolContent = document.createElement('div');
      toolContent.className = 'tool-content';
      const contentPre = document.createElement('pre');
      contentPre.textContent = content;
      toolContent.appendChild(contentPre);
      toolBubble.appendChild(toolContent);
      
      toolContainer.appendChild(toolBubble);
      chatMessages.appendChild(toolContainer);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return;
    }
    
    // Tool calls - separate container before message
    if (toolCalls && toolCalls.length > 0) {
      const toolCallContainer = document.createElement('div');
      toolCallContainer.className = 'tool-call-container';
      // Set bubbleId as data attribute for deduplication (tool calls belong to assistant message)
      if (bubbleId) {
        toolCallContainer.setAttribute('data-message-id', bubbleId);
      }
      
      const toolCallBubble = document.createElement('div');
      toolCallBubble.className = 'tool-call-bubble';
      
      const toolCallHeader = document.createElement('div');
      toolCallHeader.className = 'tool-call-header';
      toolCallHeader.textContent = 'Tool Call';
      toolCallBubble.appendChild(toolCallHeader);
      
      toolCalls.forEach((toolCall: any) => {
        const toolCallId = toolCall.id || generatebubbleId();
        const toolName = toolCall.function?.name || 'unknown';
        // Generate unique bubbleId for each tool call
        const toolCallbubbleId = `${bubbleId || generatebubbleId()}_tool_${toolCallId}`;
        
        const toolCallDiv = document.createElement('div');
        toolCallDiv.className = 'tool-call-item';
        toolCallDiv.setAttribute('data-tool-call-id', toolCallId);
        toolCallDiv.setAttribute('data-message-id', toolCallbubbleId);
        toolCallDiv.setAttribute('data-tool-status', 'running'); // pending, running, success, error
        
        // Header with tool name and status
        const toolCallHeader = document.createElement('div');
        toolCallHeader.className = 'tool-call-item-header';
        toolCallHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none;';
        
        const toolNameCode = document.createElement('code');
        toolNameCode.textContent = toolName;
        toolNameCode.style.cssText = 'font-size: 13px; font-weight: 600;';
        
        const statusContainer = document.createElement('div');
        statusContainer.className = 'tool-call-status';
        statusContainer.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 12px;';
        
        const statusBadge = document.createElement('span');
        statusBadge.className = 'tool-status-badge';
        statusBadge.textContent = '执行中';
        statusBadge.style.cssText = 'padding: 2px 8px; border-radius: 12px; background: #ff9800; color: white; font-size: 11px;';
        statusContainer.appendChild(statusBadge);
        
        const toggleIcon = document.createElement('span');
        toggleIcon.className = 'tool-call-toggle-icon';
        toggleIcon.textContent = '▼';
        toggleIcon.style.cssText = 'font-size: 10px; transition: transform 0.2s;';
        statusContainer.appendChild(toggleIcon);
        
        toolCallHeader.appendChild(toolNameCode);
        toolCallHeader.appendChild(statusContainer);
        toolCallDiv.appendChild(toolCallHeader);
        
        // Collapsible details section - DEFAULT COLLAPSED
        const toolCallDetails = document.createElement('div');
        toolCallDetails.className = 'tool-call-details';
        toolCallDetails.style.cssText = 'display: none; margin-top: 8px;'; // Default collapsed
        
        if (toolCall.function?.arguments) {
          const argsLabel = document.createElement('div');
          argsLabel.textContent = '参数:';
          argsLabel.style.cssText = 'font-size: 11px; color: #666; margin-bottom: 4px;';
          toolCallDetails.appendChild(argsLabel);
          
          const argsPre = document.createElement('pre');
          argsPre.style.cssText = 'margin: 0; padding: 8px; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 4px; font-size: 12px; overflow-x: auto;';
          argsPre.textContent = typeof toolCall.function.arguments === 'string' 
            ? toolCall.function.arguments 
            : JSON.stringify(toolCall.function.arguments, null, 2);
          toolCallDetails.appendChild(argsPre);
        }
        
        toolCallDiv.appendChild(toolCallDetails);
        
        // Toggle collapse/expand
        toolCallHeader.addEventListener('click', () => {
          const isCollapsed = toolCallDetails.style.display === 'none';
          toolCallDetails.style.display = isCollapsed ? 'block' : 'none';
          toggleIcon.textContent = isCollapsed ? '▲' : '▼';
        });
        
        toolCallBubble.appendChild(toolCallDiv);
      });
      
      toolCallContainer.appendChild(toolCallBubble);
      chatMessages.appendChild(toolCallContainer);
    }
    
    // Regular message bubble (user or assistant)
    if (content || (!toolCalls || toolCalls.length === 0)) {
      const messageDiv = document.createElement('div');
      messageDiv.className = `chat-message ${role}`;
      if (bubbleId) {
        messageDiv.setAttribute('data-message-id', bubbleId);
      }
      
      const messageBubble = document.createElement('div');
      messageBubble.className = 'message-bubble';
      
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
      
      // Render markdown for assistant messages, plain text for user messages
      // For assistant messages, always create content div (even if empty, for streaming)
      if (role === 'assistant') {
        if (content) {
          const renderedHtml = await renderMarkdown(content, false);
          contentDiv.innerHTML = renderedHtml;
        }
        // If no content, leave empty (will be filled during streaming)
      } else if (content) {
        contentDiv.textContent = content;
    }
    
      messageBubble.appendChild(contentDiv);
      messageDiv.appendChild(messageBubble);
    chatMessages.appendChild(messageDiv);
    }
    
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function updateLastMessage(content: string, toolCalls?: any[], isStreaming: boolean = false) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    // Find the last assistant message bubble (not tool call container)
    let lastAssistantMessage: Element | null = null;
    const children = Array.from(chatMessages.children);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child.classList.contains('chat-message') && child.classList.contains('assistant')) {
        lastAssistantMessage = child;
        break;
      }
    }
    
    if (!lastAssistantMessage) return;
    
    const messageBubble = lastAssistantMessage.querySelector('.message-bubble');
    if (!messageBubble) return;
    
    // Handle tool calls - add tool call container before message if needed
    if (toolCalls && toolCalls.length > 0) {
      // Check if tool call container already exists
      let toolCallContainer = chatMessages.querySelector('.tool-call-container:last-of-type');
      if (!toolCallContainer || toolCallContainer.nextElementSibling !== lastAssistantMessage) {
        // Create new tool call container
        toolCallContainer = document.createElement('div');
        toolCallContainer.className = 'tool-call-container';
        
        const toolCallBubble = document.createElement('div');
        toolCallBubble.className = 'tool-call-bubble';
        
        const toolCallHeader = document.createElement('div');
        toolCallHeader.className = 'tool-call-header';
        toolCallHeader.textContent = 'Tool Call';
        toolCallBubble.appendChild(toolCallHeader);
        
        toolCallContainer.appendChild(toolCallBubble);
        chatMessages.insertBefore(toolCallContainer, lastAssistantMessage);
      }
      
      const toolCallBubble = toolCallContainer.querySelector('.tool-call-bubble');
      if (toolCallBubble) {
        // Clear existing tool call items
        const existingItems = toolCallBubble.querySelectorAll('.tool-call-item');
        existingItems.forEach(item => item.remove());
        
        // Add new tool calls
      toolCalls.forEach((toolCall: any) => {
          const toolCallId = toolCall.id || generatebubbleId();
          const toolName = toolCall.function?.name || 'unknown';
          // Generate unique bubbleId for each tool call
          const toolCallbubbleId = `${generatebubbleId()}_tool_${toolCallId}`;
          
        const toolCallDiv = document.createElement('div');
        toolCallDiv.className = 'tool-call-item';
          toolCallDiv.setAttribute('data-tool-call-id', toolCallId);
          toolCallDiv.setAttribute('data-message-id', toolCallbubbleId);
          toolCallDiv.setAttribute('data-tool-status', 'running'); // pending, running, success, error
          
          // Header with tool name and status
          const toolCallHeader = document.createElement('div');
          toolCallHeader.className = 'tool-call-item-header';
          toolCallHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none;';
          
          const toolNameCode = document.createElement('code');
          toolNameCode.textContent = toolName;
          toolNameCode.style.cssText = 'font-size: 13px; font-weight: 600;';
          
          const statusContainer = document.createElement('div');
          statusContainer.className = 'tool-call-status';
          statusContainer.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 12px;';
          
          const statusBadge = document.createElement('span');
          statusBadge.className = 'tool-status-badge';
          statusBadge.textContent = '执行中';
          statusBadge.style.cssText = 'padding: 2px 8px; border-radius: 12px; background: #ff9800; color: white; font-size: 11px;';
          statusContainer.appendChild(statusBadge);
          
          const toggleIcon = document.createElement('span');
          toggleIcon.className = 'tool-call-toggle-icon';
          toggleIcon.textContent = '▼';
          toggleIcon.style.cssText = 'font-size: 10px; transition: transform 0.2s;';
          statusContainer.appendChild(toggleIcon);
          
          toolCallHeader.appendChild(toolNameCode);
          toolCallHeader.appendChild(statusContainer);
          toolCallDiv.appendChild(toolCallHeader);
          
          // Collapsible details section
          const toolCallDetails = document.createElement('div');
          toolCallDetails.className = 'tool-call-details';
          toolCallDetails.style.cssText = 'display: none; margin-top: 8px;';
        
        if (toolCall.function?.arguments) {
            const argsLabel = document.createElement('div');
            argsLabel.textContent = '参数:';
            argsLabel.style.cssText = 'font-size: 11px; color: #666; margin-bottom: 4px;';
            toolCallDetails.appendChild(argsLabel);
            
          const argsPre = document.createElement('pre');
            argsPre.style.cssText = 'margin: 0; padding: 8px; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 4px; font-size: 12px; overflow-x: auto;';
          argsPre.textContent = typeof toolCall.function.arguments === 'string' 
            ? toolCall.function.arguments 
            : JSON.stringify(toolCall.function.arguments, null, 2);
            toolCallDetails.appendChild(argsPre);
          }
          
          toolCallDiv.appendChild(toolCallDetails);
          
          // Toggle collapse/expand
          toolCallHeader.addEventListener('click', () => {
            const isCollapsed = toolCallDetails.style.display === 'none';
            toolCallDetails.style.display = isCollapsed ? 'block' : 'none';
            toggleIcon.textContent = isCollapsed ? '▲' : '▼';
          });
          
          toolCallBubble.appendChild(toolCallDiv);
        });
      }
    }
    
    // Update message content
    if (content !== undefined) {
      let contentDiv = messageBubble.querySelector('.message-content');
        if (!contentDiv) {
          contentDiv = document.createElement('div');
          contentDiv.className = 'message-content';
        messageBubble.appendChild(contentDiv);
        }
      
      // During streaming, show raw text (don't render markdown to avoid flickering)
      // Markdown will be rendered when streaming is complete
      if (isStreaming) {
        contentDiv.textContent = content;
    } else {
        // Streaming complete, render markdown
        const renderedHtml = await renderMarkdown(content, false);
        contentDiv.innerHTML = renderedHtml;
      }
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

  // Generate unique message ID
  function generatebubbleId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback for older browsers
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Track displayed message IDs globally to prevent duplicates across updates
  const displayedbubbleIdsGlobal = new Set<string>();

  async function sendMessage() {
    const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
    const chatMessages = document.getElementById('chatMessages');
    
    if (!chatInput || !chatMessages) return;
    
    const message = chatInput.value.trim();
    if (!message) return;

    // Generate bubbleId for user message (frontend still generates user bubbleId)
    const userbubbleId = generatebubbleId();
    displayedbubbleIdsGlobal.add(userbubbleId);
    await addMessage('user', message, undefined, undefined, userbubbleId);
    
    const tempAssistantbubbleId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await addMessage('assistant', '', undefined, undefined, tempAssistantbubbleId);
    
    chatInput.value = '';
    setLoading(true);

    try {
      const postUrl = `/d/${domainId}/agent/${urlAid}/chat`;
      
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          bubbleId: userbubbleId,
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
        
        // Update left sidebar session list
        await updateSessionListSidebar();
      }


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
    });
  }

  // Load history records (if any)
  const recordHistory = UiContext?.recordHistory || [];
  if (recordHistory && Array.isArray(recordHistory) && recordHistory.length > 0) {
    // Render all messages sequentially to ensure proper order
    for (const msg of recordHistory) {
      if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool') {
        await addMessage(msg.role, msg.content, msg.toolName, msg.tool_calls);
      }
    }
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

import { NamedPage } from 'vj/misc/Page';

const page = new NamedPage('agent_chat', async () => {
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
  const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
  const mcpStatus = document.getElementById('mcpStatus');

  if (!chatMessages || !chatInput || !sendButton || !mcpStatus) return;

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

  // 消息历史记录（用于上下文传递）
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
    
    // 保存到历史记录
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
      // 更新工具调用消息
      const existingToolCalls = lastMessage.querySelectorAll('.tool-call-item');
      if (existingToolCalls.length === 0) {
        // 如果还没有工具调用，添加
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
      // 更新普通消息内容（流式更新）
      lastMessage.textContent = content;
    }
    
    // 更新历史记录中的最后一条消息
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

    // 添加用户消息到界面
    addMessage('user', message);
    
    chatInput.value = '';
    setLoading(true);

    try {
      // 从 URL 中提取 aid（路由格式：/agent/:aid/chat）
      const urlMatch = window.location.pathname.match(/\/agent\/([^\/]+)\/chat/);
      if (!urlMatch) {
        addMessage('error', 'Invalid URL format: ' + window.location.pathname);
        setLoading(false);
        return;
      }

      const aid = urlMatch[1];
      
      // 从 UiContext 获取 domainId（模板中已设置）
      const UiContext = (window as any).UiContext;
      const domainId = UiContext?.domainId;
      
      if (!domainId) {
        addMessage('error', 'Domain ID not found in context');
        setLoading(false);
        return;
      }
      
      const wsPrefix = UiContext?.ws_prefix || '/';

      // 先通过 HTTP POST 创建任务记录
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
          createTaskRecord: historyForBackend.length === 0, // 只有第一条消息创建任务记录
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

      console.log('[AgentChat] Task created, connecting to record WebSocket:', taskRecordId);

      // 连接到 task-record-detail-conn 来接收流式更新
      const wsUrl = `task-record-detail-conn?domainId=${domainId}&rid=${taskRecordId}`;
      console.log('[AgentChat] Connecting to WebSocket:', wsUrl);

      // 动态导入 WebSocket
      const { default: WebSocket } = await import('../components/socket');
      const sock = new WebSocket(wsPrefix + wsUrl, false, true);

      // 用于累积当前 assistant 消息的内容
      let currentAssistantContent = '';
      let currentToolCalls: any[] = [];
      let lastMessageIndex = -1; // 跟踪最后一条 assistant 消息的索引

      sock.onmessage = (_, data: string) => {
        try {
          const msg = JSON.parse(data);
          console.log('[AgentChat] WebSocket message received:', msg);

          // 处理 record 格式的消息（来自 task-record-detail-conn）
          if (msg.record) {
            const record = msg.record;
            
            // 更新 agentMessages
            if (record.agentMessages && Array.isArray(record.agentMessages)) {
              const newMessagesCount = record.agentMessages.length;
              const existingMessages = Array.from(chatMessages.children).filter(
                (el: any) => el.classList.contains('chat-message')
              );
              
              // 如果消息数量增加，添加新消息
              if (newMessagesCount > existingMessages.length) {
                // 添加新消息（从现有消息之后开始）
                for (let i = existingMessages.length; i < newMessagesCount; i++) {
                  const msgData = record.agentMessages[i];
                  
                  if (msgData.role === 'user') {
                    // 用户消息：检查是否已经显示（避免重复）
                    const lastUserMsg = chatHistory.filter(m => m.role === 'user').pop();
                    if (!lastUserMsg || lastUserMsg.content !== msgData.content) {
                      // 如果历史记录中没有这条用户消息，添加它（但不在界面上重复显示）
                      // 因为用户消息在发送时已经显示了
                      chatHistory.push({
                        role: 'user',
                        content: msgData.content,
                        timestamp: msgData.timestamp ? new Date(msgData.timestamp) : new Date(),
                      });
                    }
                  } else if (msgData.role === 'assistant') {
                    // Assistant 消息
                    const content = msgData.content || '';
                    const toolCalls = msgData.tool_calls;
                    addMessage('assistant', content, undefined, toolCalls);
                    lastMessageIndex = chatHistory.length - 1;
                    currentAssistantContent = content;
                  } else if (msgData.role === 'tool') {
                    // Tool 消息
                    const content = typeof msgData.content === 'string' 
                      ? msgData.content 
                      : JSON.stringify(msgData.content, null, 2);
                    addMessage('tool', content, msgData.toolName);
                  }
                }
              } else if (newMessagesCount === existingMessages.length && newMessagesCount > 0) {
                const lastMsg = record.agentMessages[newMessagesCount - 1];
                
                if (lastMsg && lastMsg.role === 'assistant') {
                  const content = lastMsg.content || '';
                  const toolCalls = lastMsg.tool_calls;
                  
                  const lastMessage = chatMessages.lastElementChild;
                  if (lastMessage && lastMessage.classList.contains('chat-message') && 
                      lastMessage.classList.contains('assistant')) {
                    if (toolCalls && toolCalls.length > 0) {
                      // 有工具调用，更新工具调用显示
                      updateLastMessage(content, toolCalls);
                    } else {
                      const contentDiv = lastMessage.querySelector('.message-content') || lastMessage;
                      if (contentDiv) {
                        contentDiv.textContent = content;
            } else {
                        lastMessage.textContent = content;
                      }
                    }
            chatMessages.scrollTop = chatMessages.scrollHeight;
                  }
                  
                  // 更新历史记录
                  if (lastMessageIndex >= 0 && chatHistory[lastMessageIndex]) {
                    chatHistory[lastMessageIndex].content = content;
                    if (toolCalls) {
                      chatHistory[lastMessageIndex].tool_calls = toolCalls;
                    }
                  }
                  
                  currentAssistantContent = content;
                }
              }
              
              if (record.status !== undefined) {
                if (isTerminalTaskStatus(record.status)) {
                  console.log('[AgentChat] Task completed, status:', record.status);
                  setLoading(false);
                  try {
                    sock.close();
                  } catch (e) {
                    // ignore
                  }
                }
              }
            }

            return;
          }

          if (msg.type === 'error') {
            addMessage('error', msg.error || 'Unknown error');
            setLoading(false);
            sock.close();
            return;
          }

          if (msg.type === 'done' || msg.type === 'complete') {
            console.log('[AgentChat] Message processing completed');
            setLoading(false);
          }
        } catch (error: any) {
          console.error('[AgentChat] Error processing WebSocket message:', error);
          addMessage('error', 'Error processing message: ' + error.message);
          setLoading(false);
        }
      };

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

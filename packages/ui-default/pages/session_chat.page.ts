import { NamedPage } from 'vj/misc/Page';

let sessionWebSocket: any = null;
let sessionConnected = false;
let currentSessionId: string | null = null;

const page = new NamedPage('session_chat', async () => {
  const UiContext = (window as any).UiContext;
  const domainId = UiContext?.domainId;
  const socketUrl = UiContext?.socketUrl;
  const sids = UiContext?.sids || [];
  
  if (!domainId) {
    console.error('[SessionChat] Missing domainId');
    return;
  }

  const wsPrefix = UiContext?.ws_prefix || '/';
  
  // 从URL中提取sessionId
  const urlMatch = window.location.pathname.match(/\/session\/([^\/]+)\/chat/);
  const sessionId = urlMatch ? urlMatch[1] : null;
  currentSessionId = sessionId;
  
  if (!sessionId) {
    console.error('[SessionChat] Missing sessionId');
    return;
  }

  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
  const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
  
  if (!chatMessages || !chatInput || !sendButton) {
    console.error('[SessionChat] Missing required DOM elements');
    return;
  }

  // 加载历史消息（参考agent_chat的实现）
  async function loadHistory() {
    try {
      const response = await fetch(`/d/${domainId}/session/${sessionId}`);
      if (!response.ok) {
        console.error('[SessionChat] Failed to load session:', response.statusText);
        return;
      }
      
      const data = await response.json();
      const records = data.records || [];
      
      // 从records中提取所有消息（按record创建时间排序，然后按消息timestamp排序）
      const allMessages: any[] = [];
      for (const record of records) {
        const recordTime = record._id ? new Date(record._id.getTimestamp()).getTime() : 0;
        if (record.agentMessages && Array.isArray(record.agentMessages)) {
          for (const msg of record.agentMessages) {
            if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool') {
              // 使用消息的timestamp，如果没有则使用record的创建时间
              const msgTime = msg.timestamp ? new Date(msg.timestamp).getTime() : recordTime;
              allMessages.push({
                ...msg,
                recordId: record._id,
                _sortTime: msgTime,
              });
            }
          }
        }
      }
      
      // 按时间排序（确保消息按正确顺序显示）
      allMessages.sort((a, b) => {
        const timeA = a._sortTime || 0;
        const timeB = b._sortTime || 0;
        if (timeA !== timeB) {
          return timeA - timeB;
        }
        // 如果时间相同，按role排序：user -> assistant -> tool
        const roleOrder = { user: 0, assistant: 1, tool: 2 };
        return (roleOrder[a.role as keyof typeof roleOrder] || 99) - (roleOrder[b.role as keyof typeof roleOrder] || 99);
      });
      
      // 显示历史消息
      chatMessages.innerHTML = '';
      displayedbubbleIds.clear(); // 清空已显示消息的ID集合
      bubbleIdMap.clear(); // 清空消息ID映射
      
      for (let i = 0; i < allMessages.length; i++) {
        const msg = allMessages[i];
        const recordId = msg.recordId ? msg.recordId.toString() : '';
        const msgId = getbubbleId(msg, i, recordId);
        if (!displayedbubbleIds.has(msgId)) {
          const msgElement = addMessage(msg.role, msg.content, msg.toolName, msg.tool_calls, msgId, recordId);
          displayedbubbleIds.add(msgId);
          bubbleIdMap.set(msgId, msgElement);
        }
      }
      
      scrollToBottom();
      console.log('[SessionChat] History loaded:', allMessages.length, 'messages');
    } catch (error: any) {
      console.error('[SessionChat] Error loading history:', error);
    }
  }


  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // 连接WebSocket以接收实时更新
  async function connectWebSocket() {
    if (sessionConnected && sessionWebSocket) {
      return;
    }
    
    if (!socketUrl) {
      console.warn('[SessionChat] No socketUrl, skipping WebSocket connection');
      return;
    }
    
    try {
      const { default: WebSocket } = await import('../components/socket');
      const sock = new WebSocket(wsPrefix + socketUrl, false, true);
      sessionWebSocket = sock;
      sessionConnected = false;
      
      sock.onopen = () => {
        console.log('[SessionChat] WebSocket connected');
        sessionConnected = true;
      };
      
      sock.onmessage = (_, data: string) => {
        try {
          const msg = JSON.parse(data);
          console.log('[SessionChat] WebSocket message:', msg);
          
          if (msg.type === 'record_update' && msg.rid) {
            handleRecordUpdate(msg);
          } else if (msg.type === 'error') {
            console.error('[SessionChat] WebSocket error:', msg.error);
          }
        } catch (error: any) {
          console.error('[SessionChat] Error processing WebSocket message:', error);
        }
      };
      
      sock.onclose = () => {
        console.log('[SessionChat] WebSocket closed');
        sessionWebSocket = null;
        sessionConnected = false;
        // 尝试重连
        setTimeout(() => {
          if (currentSessionId) {
            connectWebSocket();
          }
        }, 3000);
      };
    } catch (error: any) {
      console.error('[SessionChat] Error connecting WebSocket:', error);
    }
  }

  let currentRecordId: string | null = null;
  const displayedbubbleIds = new Set<string>(); // 跟踪已显示的消息，避免重复
  const bubbleIdMap = new Map<string, HTMLElement>(); // 消息ID到DOM元素的映射
  const pendingUserMessages = new Map<string, string>(); // 临时用户消息ID到recordId的映射
  
  // 生成消息的唯一ID（用于去重和跟踪）
  // 注意：不使用timestamp，因为流式传输时timestamp会不断更新，导致ID变化
  // 对于assistant消息，也不使用tool_calls，因为流式传输时可能先没有工具调用，后来才添加
  function getbubbleId(msg: any, index: number, recordId: string): string {
    // 对于tool消息，使用tool_call_id作为标识（tool消息的tool_call_id是稳定的）
    if (msg.role === 'tool' && msg.tool_call_id) {
      const toolName = msg.toolName || '';
      return `${recordId}_${index}_${msg.role}_${msg.tool_call_id}_${toolName}`;
    }
    
    // 对于其他消息（user或assistant），使用recordId、index和role
    // 这样即使assistant消息在流式传输中从无工具调用变为有工具调用，ID也保持一致
    return `${recordId}_${index}_${msg.role}`;
  }
  
  // 为工具调用项生成唯一ID
  function getToolCallItemId(recordId: string, toolCallId: string, toolName: string): string {
    return `${recordId}_toolcall_${toolCallId}_${toolName}`;
  }
  
  // 处理record更新（参考agent_chat的实现，但支持所有消息类型）
  function handleRecordUpdate(msg: any) {
    if (!msg.rid) {
      console.warn('[SessionChat] Invalid record update message: missing rid', msg);
      return;
    }
    
    const record = msg.record || {};
    const rid = msg.rid;
    
    if (currentRecordId !== rid) {
      console.log('[SessionChat] New record detected:', rid);
      currentRecordId = rid;
    }
    
    if (record.agentMessages && Array.isArray(record.agentMessages)) {
      const newMessagesCount = record.agentMessages.length;
      
      // 处理每条消息，使用消息ID来跟踪和更新
      for (let i = 0; i < newMessagesCount; i++) {
        const msgData = record.agentMessages[i];
        const msgId = getbubbleId(msgData, i, rid);
        
        // 检查消息是否已存在
        const existingElement = bubbleIdMap.get(msgId);
        
        if (existingElement) {
          // 消息已存在，更新内容（用于流式更新）
          if (msgData.role === 'assistant') {
            const content = msgData.content || '';
            const toolCalls = msgData.tool_calls;
            
            if (toolCalls && toolCalls.length > 0) {
              updateMessage(existingElement, content, toolCalls, rid);
            } else {
              // 对于没有工具调用的assistant消息，查找或创建内容容器
              let contentDiv = existingElement.querySelector('.message-content');
              if (!contentDiv) {
                // 如果消息元素本身有子元素（如tool-call-header），创建新的content div
                if (existingElement.querySelector('.tool-call-header') || existingElement.children.length > 0) {
                  contentDiv = document.createElement('div');
                  contentDiv.className = 'message-content';
                  existingElement.appendChild(contentDiv);
                } else {
                  // 否则直接更新消息元素本身
                  existingElement.textContent = content;
                  scrollToBottom();
                  continue; // 跳过后续处理
                }
              }
              if (contentDiv) {
                contentDiv.textContent = content;
              }
            }
            scrollToBottom();
          } else if (msgData.role === 'tool') {
            // 更新tool消息的内容
            const toolContent = existingElement.querySelector('pre');
            if (toolContent) {
              const content = typeof msgData.content === 'string' 
                ? msgData.content 
                : JSON.stringify(msgData.content, null, 2);
              toolContent.textContent = content;
              scrollToBottom();
            }
          }
        } else {
          // 新消息，添加到界面
          if (msgData.role === 'user') {
            // 检查是否有待处理的临时用户消息需要替换
            const tempMsgId = pendingUserMessages.get(rid);
            if (tempMsgId) {
              const tempElement = bubbleIdMap.get(tempMsgId);
              if (tempElement) {
                // 移除临时消息
                tempElement.remove();
                bubbleIdMap.delete(tempMsgId);
                displayedbubbleIds.delete(tempMsgId);
              }
              pendingUserMessages.delete(rid);
            }
            
            const msgElement = addMessage('user', msgData.content || '', undefined, undefined, msgId);
            displayedbubbleIds.add(msgId);
            bubbleIdMap.set(msgId, msgElement);
          } else if (msgData.role === 'assistant') {
            const content = msgData.content || '';
            const toolCalls = msgData.tool_calls;
            const msgElement = addMessage('assistant', content, undefined, toolCalls, msgId, rid);
            displayedbubbleIds.add(msgId);
            bubbleIdMap.set(msgId, msgElement);
          } else if (msgData.role === 'tool') {
            const content = typeof msgData.content === 'string' 
              ? msgData.content 
              : JSON.stringify(msgData.content, null, 2);
            const msgElement = addMessage('tool', content, msgData.toolName, undefined, msgId);
            displayedbubbleIds.add(msgId);
            bubbleIdMap.set(msgId, msgElement);
          }
        }
      }
    }
    
    // 检查任务状态
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
        console.log('[SessionChat] Task completed, status:', record.status);
        setLoading(false);
        currentRecordId = null;
      }
    }
  }
  
  function addMessage(role: string, content: string, toolName?: string, toolCalls?: any[], bubbleId?: string, recordId?: string): HTMLElement {
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;
    
    // 设置消息ID属性
    if (bubbleId) {
      messageDiv.setAttribute('data-message-id', bubbleId);
    }
    
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
        
        // 为每个工具调用项设置唯一ID
        if (recordId && toolCall.id) {
          const toolCallItemId = getToolCallItemId(recordId, toolCall.id, toolCall.function?.name || 'unknown');
          toolCallDiv.setAttribute('data-tool-call-id', toolCallItemId);
        }
        
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
    scrollToBottom();
    return messageDiv;
  }

  function updateMessage(messageElement: HTMLElement, content: string, toolCalls?: any[], recordId?: string) {
    if (!messageElement || !messageElement.classList.contains('chat-message')) return;
    
    if (toolCalls && toolCalls.length > 0) {
      const existingToolCalls = messageElement.querySelectorAll('.tool-call-item');
      if (existingToolCalls.length === 0) {
        const toolCallHeader = document.createElement('div');
        toolCallHeader.className = 'tool-call-header';
        toolCallHeader.textContent = 'Tool Call:';
        messageElement.appendChild(toolCallHeader);
      }
      
      toolCalls.forEach((toolCall: any) => {
        // 检查工具调用是否已存在（基于tool_call.id）
        const existingToolCall = Array.from(existingToolCalls).find((el: any) => {
          const existingId = el.getAttribute('data-tool-call-id');
          if (recordId && toolCall.id) {
            const expectedId = getToolCallItemId(recordId, toolCall.id, toolCall.function?.name || 'unknown');
            return existingId === expectedId;
          }
          return false;
        });
        
        if (existingToolCall) {
          // 工具调用已存在，更新参数
          const argsPre = existingToolCall.querySelector('pre');
          if (argsPre && toolCall.function?.arguments) {
            argsPre.textContent = typeof toolCall.function.arguments === 'string' 
              ? toolCall.function.arguments 
              : JSON.stringify(toolCall.function.arguments, null, 2);
          }
        } else {
          // 新工具调用，添加到界面
          const toolCallDiv = document.createElement('div');
          toolCallDiv.className = 'tool-call-item';
          
          // 为每个工具调用项设置唯一ID
          if (recordId && toolCall.id) {
            const toolCallItemId = getToolCallItemId(recordId, toolCall.id, toolCall.function?.name || 'unknown');
            toolCallDiv.setAttribute('data-tool-call-id', toolCallItemId);
          }
          
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
          messageElement.appendChild(toolCallDiv);
        }
      });
      
      if (content) {
        let contentDiv = messageElement.querySelector('.message-content');
        if (!contentDiv) {
          contentDiv = document.createElement('div');
          contentDiv.className = 'message-content';
          messageElement.appendChild(contentDiv);
        }
        contentDiv.textContent = content;
      }
    } else {
      messageElement.textContent = content;
    }
    
    scrollToBottom();
  }

  // 发送消息
  const originalButtonText = sendButton.textContent || 'Send';
  
  function setLoading(loading: boolean) {
    sendButton.disabled = loading;
    if (loading) {
      sendButton.innerHTML = '<span class="loading"></span> Sending...';
    } else {
      sendButton.textContent = originalButtonText;
    }
  }

  async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message) return;
    
    // 生成临时用户消息ID（在收到真实record更新前使用）
    const tempMsgId = `temp_user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const tempElement = addMessage('user', message, undefined, undefined, tempMsgId);
    displayedbubbleIds.add(tempMsgId);
    bubbleIdMap.set(tempMsgId, tempElement);
    
    chatInput.value = '';
    setLoading(true);
    
    try {
      const response = await fetch(`/d/${domainId}/session/${sessionId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        // 移除临时用户消息
        tempElement.remove();
        displayedbubbleIds.delete(tempMsgId);
        bubbleIdMap.delete(tempMsgId);
        addMessage('error', 'Send failed: ' + (errorData.error || 'Unknown error'));
        setLoading(false);
        return;
      }
      
      const responseData = await response.json();
      console.log('[SessionChat] Message sent:', responseData);
      const taskRecordId = responseData.taskRecordId;
      
      if (!taskRecordId) {
        console.error('[SessionChat] Task created but record ID missing', responseData);
        // 移除临时用户消息
        tempElement.remove();
        displayedbubbleIds.delete(tempMsgId);
        bubbleIdMap.delete(tempMsgId);
        addMessage('error', 'Task created but record ID missing: ' + JSON.stringify(responseData));
        setLoading(false);
        return;
      }
      
      // 记录临时消息ID，等待WebSocket返回真实record时替换
      pendingUserMessages.set(taskRecordId, tempMsgId);
      
      // 消息已发送，等待WebSocket更新（通过record_update消息）
      // setLoading会在任务完成时通过handleRecordUpdate设置为false
    } catch (error: any) {
      console.error('[SessionChat] Error sending message:', error);
      // 移除临时用户消息
      tempElement.remove();
      displayedbubbleIds.delete(tempMsgId);
      bubbleIdMap.delete(tempMsgId);
      addMessage('error', 'Send failed: ' + error.message);
      setLoading(false);
    }
  }

  // 绑定事件
  sendButton.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 初始化
  await loadHistory();
  await connectWebSocket();
});

export default page;


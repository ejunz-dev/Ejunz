import { NamedPage } from 'vj/misc/Page';

const page = new NamedPage('agent_chat', async () => {
  const [{ default: WebSocket }] = await Promise.all([
    import('../components/socket'),
  ]);

  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
  const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
  const mcpStatus = document.getElementById('mcpStatus');

  if (!chatMessages || !chatInput || !sendButton || !mcpStatus) return;

  const mcpStatusUrl = mcpStatus.getAttribute('data-status-url') || '';
  const chatContainer = document.getElementById('chatContainer');
  const wsUrlBase = chatContainer?.getAttribute('data-ws-url') || '';

  let history: any[] = [];
  let sock: import('../components/socket').default | null = null;

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

  function addMessage(role: string, content: string) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;
    messageDiv.textContent = content;
    chatMessages.appendChild(messageDiv);
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

  let currentTextMessage: HTMLElement | null = null;
  let accumulatedContent = '';
  let contentUpdateCount = 0;
  let toolCallMessages: Map<string, HTMLElement> = new Map();
  let toolCallResults: Record<string, any> = {};

  async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message) return;

    addMessage('user', message);
    chatInput.value = '';
    setLoading(true);

    currentTextMessage = null;
    accumulatedContent = '';
    contentUpdateCount = 0;
    toolCallMessages.clear();
    toolCallResults = {};

    try {
      if (sock) {
        sock.close();
      }
      
      let wsUrl = wsUrlBase.startsWith('/') ? wsUrlBase.slice(1) : wsUrlBase;
      sock = new WebSocket(UiContext.ws_prefix + wsUrl, false, true);

      sock.onopen = () => {
        console.log('WebSocket connection established');
        sock!.send(JSON.stringify({
          message: message,
          history: history
        }));
        console.log('Message sent');
      };

      sock.onmessage = (msg, data) => {
        try {
          const parsed = JSON.parse(data);
          
          if (parsed.type === 'connected') {
            console.log('Connection confirmed:', parsed.message);
            return;
          }
          
          if (parsed.type === 'content' && parsed.content) {
            contentUpdateCount++;
            accumulatedContent += parsed.content;
            
            if (!currentTextMessage) {
              currentTextMessage = document.createElement('div');
              currentTextMessage.className = 'chat-message assistant';
              chatMessages.appendChild(currentTextMessage);
            }
            
            currentTextMessage.textContent = accumulatedContent;
            chatMessages.scrollTop = chatMessages.scrollHeight;
            
            if (contentUpdateCount <= 10 || contentUpdateCount % 10 === 0) {
              console.log('[Stream] Update #' + contentUpdateCount, 'New content:', parsed.content, 'Total length:', accumulatedContent.length);
            }
          } else if (parsed.type === 'tool_call_start') {
            console.log('Tool call started:', parsed.tools);
            const toolNames = parsed.tools || ['unknown'];
            
            toolNames.forEach((toolName: string) => {
              if (toolCallMessages.has(toolName)) {
                return;
              }
              
              const toolMessage = document.createElement('div');
              toolMessage.className = 'chat-message assistant tool-call-message';
              toolMessage.id = `tool-message-${toolName}`;
              
              const toolStatus = document.createElement('div');
              toolStatus.className = 'tool-call-status calling';
              toolStatus.innerHTML = `
                <span class="loading"></span>
                <span>Calling tool: <strong>${toolName}</strong></span>
              `;
              
              toolMessage.appendChild(toolStatus);
              chatMessages.appendChild(toolMessage);
              
              toolCallMessages.set(toolName, toolMessage);
            });
            
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (parsed.type === 'tool_result') {
            console.log('Tool result received:', parsed.tool, parsed.result);
            if (parsed.tool) {
              const toolMessage = toolCallMessages.get(parsed.tool);
              
              if (toolMessage) {
                const toolStatus = toolMessage.querySelector('.tool-call-status');
                
                if (toolStatus) {
                  const isSuccess = parsed.result !== undefined && parsed.result !== null;
                  const hasError = parsed.result && typeof parsed.result === 'object' && parsed.result.error;
                  
                  if (hasError || !isSuccess) {
                    toolStatus.className = 'tool-call-status failed';
                    const errorMsg = hasError ? parsed.result.error : 'Tool call failed';
                    toolStatus.innerHTML = `
                      <span>✗ Tool call failed: <strong>${parsed.tool}</strong> - ${errorMsg}</span>
                    `;
                  } else {
                    toolStatus.className = 'tool-call-status completed';
                    
                    if (parsed.result !== undefined) {
                      toolCallResults[parsed.tool] = parsed.result;
                    }
                    
                    const resultDiv = document.createElement('div');
                    resultDiv.id = `tool-result-${parsed.tool}`;
                    resultDiv.className = 'tool-call-result';
                    resultDiv.textContent = typeof parsed.result === 'string' 
                      ? parsed.result 
                      : JSON.stringify(parsed.result, null, 2);
                    
                    const toggleBtn = document.createElement('span');
                    toggleBtn.className = 'tool-call-toggle';
                    toggleBtn.textContent = 'View result';
                    toggleBtn.onclick = () => {
                      if (resultDiv.classList.contains('expanded')) {
                        resultDiv.classList.remove('expanded');
                        toggleBtn.textContent = 'View result';
                      } else {
                        resultDiv.classList.add('expanded');
                        toggleBtn.textContent = 'Hide result';
                      }
                    };
                    
                    toolStatus.innerHTML = `
                      <span>✓ Tool call successful: <strong>${parsed.tool}</strong></span>
                    `;
                    toolStatus.appendChild(toggleBtn);
                    toolStatus.appendChild(resultDiv);
                  }
                }
                
                chatMessages.scrollTop = chatMessages.scrollHeight;
              }
            }
          } else if (parsed.type === 'tool_call_complete') {
            console.log('Tool call completed');
            
            toolCallMessages.forEach((toolMessage, toolName) => {
              const toolStatus = toolMessage.querySelector('.tool-call-status');
              if (toolStatus && toolStatus.classList.contains('calling')) {
                toolStatus.className = 'tool-call-status unknown';
                toolStatus.innerHTML = `
                  <span>? Tool call status unknown: <strong>${toolName}</strong></span>
                `;
              }
            });
            
            currentTextMessage = null;
            accumulatedContent = '';
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (parsed.type === 'done') {
            console.log('Received done signal, full message length:', parsed.message?.length || 0);
            if (parsed.history) {
              history = JSON.parse(parsed.history);
            }
            
            const finalContent = accumulatedContent || parsed.message || '';
            
            if (currentTextMessage && finalContent) {
              currentTextMessage.textContent = finalContent;
            } else if (finalContent && !currentTextMessage) {
              currentTextMessage = document.createElement('div');
              currentTextMessage.className = 'chat-message assistant';
              currentTextMessage.textContent = finalContent;
              chatMessages.appendChild(currentTextMessage);
            }
            
            toolCallMessages.clear();
            currentTextMessage = null;
            toolCallResults = {};
            chatMessages.scrollTop = chatMessages.scrollHeight;
            sock!.close();
            setLoading(false);
          } else if (parsed.type === 'error') {
            console.error('Error received:', parsed.error);
            toolCallMessages.forEach((toolMessage, toolName) => {
              const toolStatus = toolMessage.querySelector('.tool-call-status');
              if (toolStatus && toolStatus.classList.contains('calling')) {
                toolStatus.className = 'tool-call-status failed';
                toolStatus.innerHTML = `<span>✗ Tool call error: <strong>${toolName}</strong> - ${parsed.error}</span>`;
              }
            });
            addMessage('error', parsed.error);
            sock!.close();
            setLoading(false);
          }
        } catch (e) {
          console.error('Parse error:', e, 'Data:', data);
        }
      };

      sock.onclose = (code, reason) => {
        console.log('WebSocket connection closed', 'code:', code, 'reason:', reason);
        
        if (code >= 4000) {
          addMessage('error', `Connection closed: ${reason || 'Unknown reason'} (code: ${code})`);
          setLoading(false);
        } else if (code === 1000 || code === 1001) {
          console.log('Connection closed normally');
          setLoading(false);
        } else {
          if (sock) {
            sock.close();
          }
          addMessage('error', 'Connection disconnected');
          setLoading(false);
        }
      };
    } catch (error: any) {
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

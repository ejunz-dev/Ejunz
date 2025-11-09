import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

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

  // MCP Tools Sidebar WebSocket Connection
  const mcpStatusWsUrl = (document.querySelector('[data-mcp-status-ws-url]') as HTMLElement)?.getAttribute('data-mcp-status-ws-url') || '';
  let mcpStatusWs: import('../components/socket').default | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  
  // Collect assigned tool IDs from initial render (for filtering real-time updates)
  const assignedToolIds = new Set<string>();
  document.querySelectorAll('.mcp-tool-item').forEach(item => {
    const toolId = item.getAttribute('data-tool-id');
    if (toolId) {
      assignedToolIds.add(toolId);
    }
  });

  function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function connectMcpStatus() {
    if (mcpStatusWs) {
      return; // Already connected
    }

    if (!mcpStatusWsUrl) return;

    try {
      let wsUrl = mcpStatusWsUrl.startsWith('/') ? mcpStatusWsUrl.slice(1) : mcpStatusWsUrl;
      mcpStatusWs = new WebSocket(UiContext.ws_prefix + wsUrl, false, true);

      mcpStatusWs.onopen = () => {
        console.log('MCP Status WebSocket connected');
        mcpStatusWs!.send(JSON.stringify({ type: 'ping' }));
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
        reconnectTimer = setInterval(() => {
          if (mcpStatusWs) {
            mcpStatusWs.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30000);
      };

      mcpStatusWs.onmessage = (msg, data) => {
        try {
          const parsed = JSON.parse(data);
          handleMcpStatusMessage(parsed);
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      mcpStatusWs.onclose = () => {
        console.log('MCP Status WebSocket closed, reconnecting...');
        mcpStatusWs = null;
        setTimeout(connectMcpStatus, 3000);
      };
    } catch (e) {
      console.error('Failed to connect MCP Status WebSocket:', e);
      mcpStatusWs = null;
      setTimeout(connectMcpStatus, 3000);
    }
  }

  function handleMcpStatusMessage(data: any) {
    switch (data.type) {
      case 'init':
        if (data.servers) {
          updateServersList(data.servers);
        }
        break;
      case 'server/status':
        if (data.server) {
          updateServerStatus(data.server);
        }
        break;
      case 'tools/update':
        if (data.serverId && data.tools) {
          updateServerTools(data.serverId, data.tools);
        }
        break;
      case 'refresh':
        if (data.servers) {
          updateServersList(data.servers);
        }
        break;
      case 'pong':
        break;
    }
  }

  function updateServersList(servers: any[]) {
    const container = document.getElementById('mcp-servers-list');
    if (!container) return;

    // Save current expanded state
    const currentExpanded: Record<string, boolean> = {};
    document.querySelectorAll('.mcp-server-item').forEach(item => {
      const serverId = item.getAttribute('data-server-id');
      const toolsDiv = document.getElementById(`tools-${serverId}`);
      if (toolsDiv && toolsDiv.style.display !== 'none') {
        currentExpanded[serverId || ''] = true;
      }
    });

    // Filter: only show assigned tools
    const filteredServers = servers.map(server => {
      const assignedTools = (server.tools || []).filter((tool: any) => {
        const toolId = tool._id ? tool._id.toString() : String(tool._id);
        return assignedToolIds.has(toolId);
      });
      return {
        ...server,
        tools: assignedTools,
        toolsCount: assignedTools.length
      };
    }).filter(server => server.toolsCount > 0);

    // Re-render list
    container.innerHTML = filteredServers.map(server => {
      const isExpanded = currentExpanded[String(server.serverId)] || false;
      const statusClass = server.status === 'connected' ? 'status-online' : 'status-offline';
      const statusText = server.status === 'connected' ? i18n('Online') : i18n('Offline');
      const toggleIcon = isExpanded ? 'icon-chevron-down' : 'icon-chevron-right';
      const toolsDisplay = isExpanded ? '' : 'style="display: none;"';

      const toolsHtml = server.tools && server.tools.length > 0
        ? server.tools.map((tool: any) => `
          <div class="mcp-tool-item" data-tool-id="${tool._id}">
            <div class="mcp-tool-name">${escapeHtml(tool.name)}</div>
            <div class="mcp-tool-description">${escapeHtml(tool.description || '')}</div>
            ${tool.inputSchema ? `
            <details class="mcp-tool-schema">
              <summary>${i18n('View Parameters')}</summary>
              <pre>${escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</pre>
            </details>
            ` : ''}
          </div>
        `).join('')
        : `<div class="mcp-tool-empty">${i18n('No tools available')}</div>`;

      return `
        <div class="mcp-server-item" data-server-id="${server.serverId}">
          <div class="mcp-server-header" onclick="window.toggleServer && window.toggleServer('${String(server.serverId)}')">
            <span class="mcp-server-toggle icon ${toggleIcon}" id="toggle-${server.serverId}"></span>
            <span class="mcp-server-name">${escapeHtml(server.name)}</span>
            <span class="mcp-server-status" id="status-${server.serverId}" data-status="${server.status}">
              <span class="status-indicator ${statusClass}"></span>${statusText}
            </span>
          </div>
          <div class="mcp-server-tools" id="tools-${server.serverId}" ${toolsDisplay}>
            ${toolsHtml}
          </div>
        </div>
      `;
    }).join('');

    // Re-bind events
    (window as any).toggleServer = (window as any).toggleServer;
  }

  function updateServerStatus(server: any) {
    const statusEl = document.getElementById(`status-${server.serverId}`);
    if (!statusEl) return;

    const isOnline = server.status === 'connected';
    statusEl.setAttribute('data-status', server.status);
    statusEl.innerHTML = `
      <span class="status-indicator ${isOnline ? 'status-online' : 'status-offline'}"></span>
      ${isOnline ? i18n('Online') : i18n('Offline')}
    `;
  }

  function updateServerTools(serverId: number, tools: any[]) {
    const toolsDiv = document.getElementById(`tools-${serverId}`);
    if (!toolsDiv) return;

    // Filter: only show assigned tools
    const assignedTools = (tools || []).filter(tool => {
      const toolId = tool._id ? tool._id.toString() : String(tool._id);
      return assignedToolIds.has(toolId);
    });

    const isExpanded = toolsDiv.style.display !== 'none';
    const toolsHtml = assignedTools && assignedTools.length > 0
      ? assignedTools.map(tool => `
        <div class="mcp-tool-item" data-tool-id="${tool._id}">
          <div class="mcp-tool-name">${escapeHtml(tool.name)}</div>
          <div class="mcp-tool-description">${escapeHtml(tool.description || '')}</div>
          ${tool.inputSchema ? `
          <details class="mcp-tool-schema">
            <summary>${i18n('View Parameters')}</summary>
            <pre>${escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</pre>
          </details>
          ` : ''}
        </div>
      `).join('')
      : `<div class="mcp-tool-empty">${i18n('No tools available')}</div>`;

    toolsDiv.innerHTML = toolsHtml;
    if (!isExpanded) {
      toolsDiv.style.display = 'none';
    }
  }

  (window as any).toggleServer = function(serverId: string) {
    const toolsDiv = document.getElementById(`tools-${serverId}`);
    const toggleIcon = document.getElementById(`toggle-${serverId}`);
    if (!toolsDiv || !toggleIcon) return;

    const isExpanded = toolsDiv.style.display !== 'none';
    if (isExpanded) {
      toolsDiv.style.display = 'none';
      toggleIcon.className = 'mcp-server-toggle icon icon-chevron-right';
    } else {
      toolsDiv.style.display = 'block';
      toggleIcon.className = 'mcp-server-toggle icon icon-chevron-down';
    }
  };

  // Connect WebSocket after page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connectMcpStatus);
  } else {
    connectMcpStatus();
  }
});

export default page;

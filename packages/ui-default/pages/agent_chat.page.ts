import { NamedPage } from 'vj/misc/Page';

let sessionWebSocket: any = null;
let sessionConnected = false;
let sessionConnectPromise: Promise<void> | null = null;
let currentSessionId: string | null = null;

const page = new NamedPage('agent_chat', async () => {
  try {
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

  /** Returns true if tool result content indicates an error (e.g. { error: true } or { success: false }). */
  const isToolResultError = (content: string | object | undefined): boolean => {
    if (content == null) return false;
    let o: any = content;
    if (typeof content === 'string') {
      try {
        o = JSON.parse(content);
      } catch { return false; }
    }
    if (o && typeof o === 'object') {
      if (o.error === true) return true;
      if (o.success === false) return true;
    }
    return false;
  };

  const applyToolCallStatus = (toolCallItem: Element, content: string | object | undefined, statusBadge: HTMLElement | null) => {
    const isError = isToolResultError(content);
    toolCallItem.setAttribute('data-tool-status', isError ? 'error' : 'success');
    if (statusBadge) {
      statusBadge.textContent = isError ? '执行失败' : '执行成功';
      statusBadge.style.cssText = isError
        ? 'padding: 2px 8px; border-radius: 12px; background: #f44336; color: white; font-size: 11px;'
        : 'padding: 2px 8px; border-radius: 12px; background: #4caf50; color: white; font-size: 11px;';
    }
    const resultPre = toolCallItem.querySelector('.tool-call-result pre') as HTMLElement | null;
    if (resultPre) {
      resultPre.style.background = isError ? '#ffebee' : '#e7f3ff';
      resultPre.style.borderColor = isError ? '#f44336' : '#b3d9ff';
    }
  };

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
      
      let connectionTimeout: NodeJS.Timeout | null = null;
      let sessionConnectedReceived = false;
      let wsOpened = false;
      
      // Set timeout for receiving session_connected message (30 seconds after WebSocket opens)
      const setSessionTimeout = () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        connectionTimeout = setTimeout(() => {
          if (!sessionConnectedReceived) {
            console.error('[AgentChat] Timeout waiting for session_connected message');
            if (sessionWebSocket) {
              try {
                sessionWebSocket.close();
              } catch (e) {
                // ignore
              }
            }
            sessionWebSocket = null;
            sessionConnected = false;
            sessionConnectPromise = null;
            reject(new Error('Timeout waiting for session_connected message (30s)'));
          }
        }, 30000); // 30 seconds after WebSocket opens
      };
      
      import('../components/socket').then(({ default: WebSocket }) => {
        // Use longer connectionTimeout for agent chat session (30 seconds)
        const sock = new WebSocket(wsPrefix + wsUrl, false, true, {
          connectionTimeout: 30000, // 30 seconds to establish connection
          maxReconnectionDelay: 10000,
          maxRetries: 100,
        });
        sessionWebSocket = sock;
        sessionConnected = false;
        
        sock.onopen = () => {
          wsOpened = true;
          console.log('[AgentChat] WebSocket opened, waiting for session_connected...');
          // Start timeout after WebSocket opens (not before)
          setSessionTimeout();
        };
        
        sock.onmessage = (_, data: string) => {
          try {
            // Log raw message for debugging
            if (typeof data !== 'string') {
              console.warn('[AgentChat] WebSocket: received non-string data', {
                dataType: typeof data,
                dataLength: data?.length,
                dataPreview: typeof data === 'string' ? data.substring(0, 100) : String(data).substring(0, 100),
              });
              return;
            }
            
            let msg: any;
            try {
              msg = JSON.parse(data);
            } catch (parseError: any) {
              console.error('[AgentChat] WebSocket: JSON parse error', {
                error: parseError.message,
                dataPreview: data.substring(0, 200),
                dataLength: data.length,
              });
              return;
            }
            
            // Log all received messages for debugging
            console.log('[AgentChat] WebSocket: message received', {
              type: msg.type,
              rid: msg.rid,
              bubbleId: msg.bubbleId,
              timestamp: new Date().toISOString(),
            });
            
            if (msg.type === 'session_connected') {
              if (connectionTimeout) {
                clearTimeout(connectionTimeout);
                connectionTimeout = null;
              }
              sessionConnected = true;
              sessionConnectedReceived = true;
              console.log('[AgentChat] Session connected message received, connection ready');
              resolve();
            } else if (msg.type === 'message_start') {
              handleBubbleStart(msg);
            } else if (msg.type === 'message_complete') {
              console.log('[AgentChat] WebSocket: received message_complete', {
                rid: msg.rid,
                bubbleId: msg.bubbleId,
                timestamp: new Date().toISOString(),
              });
              handleBubbleComplete(msg);
            } else if (msg.type === 'bubble_stream') {
              console.log('[AgentChat] WebSocket: received bubble_stream', {
                rid: msg.rid,
                bubbleId: msg.bubbleId,
                contentLength: msg.content ? msg.content.length : 0,
                isNew: msg.isNew,
                timestamp: new Date().toISOString(),
              });
              handleBubbleStream(msg);
            } else if (msg.type === 'record_update') {
              console.log('[AgentChat] WebSocket: received record_update', {
                rid: msg.rid,
                timestamp: new Date().toISOString(),
                recordKeys: msg.record ? Object.keys(msg.record) : [],
              });
              handleRecordUpdate(msg);
            } else if (msg.type === 'error') {
              console.error('[AgentChat] Session error:', msg.error);
              // If we haven't received session_connected yet, this is a connection error
              if (!sessionConnectedReceived) {
                if (connectionTimeout) {
                  clearTimeout(connectionTimeout);
                  connectionTimeout = null;
                }
                sessionWebSocket = null;
                sessionConnected = false;
                sessionConnectPromise = null;
                reject(new Error('Session error: ' + (msg.error || 'Unknown error')));
              }
            }
          } catch (error: any) {
            console.error('[AgentChat] Error processing session message:', error);
          }
        };
        
        sock.onclose = (code?: number, reason?: string) => {
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          console.log('[AgentChat] WebSocket session closed:', code, reason);
          sessionWebSocket = null;
          sessionConnected = false;
          sessionConnectPromise = null;
          
          // If connection was closed before receiving session_connected, reject the promise
          // Code >= 4000 indicates an error (see socket component)
          if (!sessionConnectedReceived) {
            const errorMsg = code && code >= 4000 
              ? `WebSocket connection error: code=${code}, reason=${reason || 'unknown'}`
              : `WebSocket closed before session connected: code=${code}, reason=${reason || 'unknown'}`;
            reject(new Error(errorMsg));
          }
        };
      }).catch((error) => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        sessionConnectPromise = null;
        console.error('[AgentChat] Failed to import WebSocket:', error);
        reject(error);
      });
    });
    
    return sessionConnectPromise;
  };
  
  let currentRecordId: string | null = null;
  
  // Frontend bubble state (UI state, independent from backend)
  enum FrontendBubbleState {
    PENDING = 'pending',           // Created but not yet received from backend
    STREAMING = 'streaming',       // Currently receiving updates from backend
    PENDING_COMPLETE = 'pending_complete', // Received complete signal, waiting for timeout
    COMPLETED = 'completed',       // Truly completed after timeout
    ERROR = 'error',               // Error state
  }
  
  // Backend state (from server events)
  enum BackendBubbleState {
    UNKNOWN = 'unknown',           // Not yet received from backend
    STREAMING = 'streaming',       // Backend is streaming
    COMPLETED = 'completed',       // Backend has completed
    ERROR = 'error',               // Backend error
  }
  
  // State change event
  interface StateChangeEvent {
    eventId: string;               // Unique event ID
    bubbleId: string;              // Bubble ID
    timestamp: number;             // Event timestamp
    source: 'frontend' | 'backend' | 'system'; // Event source
    frontendState?: FrontendBubbleState; // Frontend state after event
    backendState?: BackendBubbleState;   // Backend state after event
    reason: string;                // Reason for state change
    data?: any;                    // Additional event data
  }
  
  interface BubbleStateInfo {
    // Frontend state (UI state)
    frontendState: FrontendBubbleState;
    frontendStateTime: number;     // When frontend state was set
    
    // Backend state (from server)
    backendState: BackendBubbleState;
    backendStateTime: number;      // When backend state was received
    
    // State synchronization
    lastContentUpdateTime: number; // Last time content was updated
    completeTimeout: NodeJS.Timeout | null; // Timeout for marking as completed
    inactiveTimeout?: NodeJS.Timeout; // Timeout for detecting inactivity during streaming
    createTime: number;            // When the bubble was created (frontend)
    backendCreateTime?: number;    // When backend created the bubble
    
    // Message data
    role?: 'user' | 'assistant' | 'tool';  // Message role
    content?: string;              // Message content
    bubbleId: string;              // Unique identifier
    toolCalls?: any[];             // Tool calls (for assistant messages)
    toolName?: string;             // Tool name (for tool messages)
    
    // Rendering state
    isRendered?: boolean;          // Whether markdown has been rendered
    renderedContentHash?: string;  // Hash of rendered content
    
    // DOM reference (optional, for quick access)
    domElement?: HTMLElement | null; // Reference to the message DOM element
    
    // Event history (complete history of all state changes)
    eventHistory: StateChangeEvent[]; // Complete event history
    updateCount: number;           // Number of times content was updated
  }
  
  // Get Chinese text for frontend bubble state
  function getStateText(state: FrontendBubbleState): string {
    switch (state) {
      case FrontendBubbleState.PENDING:
        return '等待中';
      case FrontendBubbleState.STREAMING:
        return '流传输中';
      case FrontendBubbleState.PENDING_COMPLETE:
        return '归档中';
      case FrontendBubbleState.COMPLETED:
        return '已完成';
      case FrontendBubbleState.ERROR:
        return '错误';
      default:
        return '';
    }
  }
  
  // Generate unique event ID
  function generateEventId(): string {
    return `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  // Emit state change event
  function emitStateChangeEvent(
    bubbleId: string,
    source: 'frontend' | 'backend' | 'system',
    frontendState?: FrontendBubbleState,
    backendState?: BackendBubbleState,
    reason: string = 'state_change',
    data?: any
  ): StateChangeEvent {
    const event: StateChangeEvent = {
      eventId: generateEventId(),
      bubbleId,
      timestamp: Date.now(),
      source,
      frontendState,
      backendState,
      reason,
      data,
    };
    
    // Add to bubble's event history
    const stateInfo = bubbleStates.get(bubbleId);
    if (stateInfo) {
      stateInfo.eventHistory.push(event);
    }
    
    console.log('[AgentChat] State change event:', event);
    return event;
  }
  
  // Helper function to get bubbleId from element
  function getbubbleIdFromElement(el: Element | null): string | null {
    if (!el) return null;
    return el.getAttribute('data-message-id');
  }
  
  // Update status display for a bubble (uses frontend state)
  function updateStatusDisplay(bubbleId: string, state: FrontendBubbleState) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    // Find message element by bubbleId
    const messageEl = Array.from(chatMessages.children).find(
      (el: any) => {
        const elBubbleId = getbubbleIdFromElement(el);
        return elBubbleId === bubbleId && el.classList.contains('chat-message');
      }
    ) as HTMLElement | undefined;
    
    if (!messageEl) return;
    
    // Find or create status display element
    let statusDiv = messageEl.querySelector('.message-status') as HTMLElement | null;
    if (!statusDiv) {
      statusDiv = document.createElement('div');
      statusDiv.className = 'message-status';
      const messageBubble = messageEl.querySelector('.message-bubble');
      if (messageBubble && messageBubble.parentNode) {
        messageBubble.parentNode.insertBefore(statusDiv, messageBubble);
      }
    }
    
    // Update status text and class
    const stateText = getStateText(state);
    statusDiv.textContent = stateText;
    statusDiv.className = `message-status message-status-${state}`;
    
    // Show status for assistant messages
    if (messageEl.classList.contains('assistant')) {
      // Always show status, including "已完成" state
      statusDiv.style.display = 'block';
    } else {
      statusDiv.style.display = 'none';
    }
  }
  
  // Handle bubble start event (from backend)
  function handleBubbleStart(msg: any) {
    const { rid, bubbleId } = msg;
    if (bubbleId) {
      // Backend event: bubble started streaming
      updateBackendState(bubbleId, BackendBubbleState.STREAMING, 'backend_bubble_start', { rid });
      // Sync frontend state if needed
      syncFrontendStateFromBackend(bubbleId);
    }
  }
  
  // Handle bubble complete event (from backend)
  function handleBubbleComplete(msg: any) {
    const { rid, bubbleId } = msg;
    if (bubbleId) {
      // Backend event: bubble completed
      updateBackendState(bubbleId, BackendBubbleState.COMPLETED, 'backend_bubble_complete', { rid });
      
      // CRITICAL: When backend completes, check if we can immediately mark as completed
      // This prevents subsequent record_update events from triggering unnecessary processing
      const stateInfo = bubbleStates.get(bubbleId);
      if (stateInfo) {
        const timeSinceLastUpdate = Date.now() - stateInfo.lastContentUpdateTime;
        // If no recent update (500ms), immediately mark as completed
        // Otherwise, sync will set it to pending_complete and wait for timeout
        if (timeSinceLastUpdate >= UPDATE_THRESHOLD_MS) {
          updateFrontendState(bubbleId, FrontendBubbleState.COMPLETED, 'backend_completed_immediate');
        } else {
          // Recent update, sync will handle it (pending_complete -> timeout -> completed)
          syncFrontendStateFromBackend(bubbleId);
        }
      } else {
        // No state info yet, sync will create it
        syncFrontendStateFromBackend(bubbleId);
      }
    }
  }
  
  const bubbleStates = new Map<string, BubbleStateInfo>(); // bubbleId -> state info
  const COMPLETE_TIMEOUT_MS = 2000; // Wait 2 seconds after complete signal or last update before truly completing
  const INACTIVE_TIMEOUT_MS = 3000; // If no update for 3 seconds during streaming, enter pending_complete
  const UPDATE_THRESHOLD_MS = 500;  // If no update for 500ms, consider it stable
  
  // Track last processed record state to skip duplicate record_update events
  const lastRecordState = new Map<string, { contentHash: string; messageCount: number; status: number; lastUpdateTime: number }>(); // rid -> state
  
  // Track message lifecycle: messages that have started and completed (for backward compatibility)
  const activebubbleIds = new Set<string>(); // Messages currently being streamed
  const completedbubbleIds = new Set<string>(); // Messages that have completed
  const renderedMarkdownIds = new Map<string, string>(); // bubbleId -> last rendered content hash (to prevent duplicate rendering)
  
  // Get frontend bubble state
  function getFrontendBubbleState(bubbleId: string): FrontendBubbleState {
    const stateInfo = bubbleStates.get(bubbleId);
    return stateInfo?.frontendState || FrontendBubbleState.PENDING;
  }
  
  // Get backend bubble state
  function getBackendBubbleState(bubbleId: string): BackendBubbleState {
    const stateInfo = bubbleStates.get(bubbleId);
    return stateInfo?.backendState || BackendBubbleState.UNKNOWN;
  }
  
  // Update frontend state (UI state, independent from backend)
  function updateFrontendState(
    bubbleId: string,
    newState: FrontendBubbleState,
    reason: string = 'frontend_state_change',
    data?: any
  ) {
    const now = Date.now();
    let stateInfo = bubbleStates.get(bubbleId);
    
    if (!stateInfo) {
      // Create new state info
      stateInfo = {
        frontendState: newState,
        frontendStateTime: now,
        backendState: BackendBubbleState.UNKNOWN,
        backendStateTime: 0,
        lastContentUpdateTime: now,
        completeTimeout: null,
        inactiveTimeout: undefined,
        createTime: now,
        bubbleId: bubbleId,
        eventHistory: [],
        updateCount: 0,
      };
      bubbleStates.set(bubbleId, stateInfo);
    }
    
    const oldFrontendState = stateInfo.frontendState;
    
    // Only update if state changed
    if (oldFrontendState !== newState) {
      stateInfo.frontendState = newState;
      stateInfo.frontendStateTime = now;
      
      // Emit state change event (this saves to eventHistory)
      const event = emitStateChangeEvent(bubbleId, 'frontend', newState, undefined, reason, data);
      
      // Log state change for debugging
      console.log('[AgentChat] Frontend state changed:', {
        bubbleId,
        oldState: oldFrontendState,
        newState: newState,
        reason: reason,
        eventId: event.eventId,
        timestamp: event.timestamp,
      });
      
      // Update status display
      updateStatusDisplay(bubbleId, newState);
      
      // Handle state-specific logic
      if (newState === FrontendBubbleState.STREAMING) {
        activebubbleIds.add(bubbleId);
        completedbubbleIds.delete(bubbleId);
        // Update DOM classes for streaming state
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
          const messageEl = Array.from(chatMessages.children).find(
            (el: any) => {
              const elBubbleId = getbubbleIdFromElement(el);
              return elBubbleId === bubbleId && el.classList.contains('chat-message');
            }
          ) as HTMLElement | undefined;
          if (messageEl) {
            messageEl.classList.add('streaming');
            messageEl.classList.remove('completed');
          }
        }
      } else if (newState === FrontendBubbleState.COMPLETED) {
      completedbubbleIds.add(bubbleId);
        activebubbleIds.delete(bubbleId);
        
        // CRITICAL: Update DOM classes when completed to remove streaming state
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
          const messageEl = Array.from(chatMessages.children).find(
            (el: any) => {
              const elBubbleId = getbubbleIdFromElement(el);
              return elBubbleId === bubbleId && el.classList.contains('chat-message');
            }
          ) as HTMLElement | undefined;
          if (messageEl) {
            messageEl.classList.remove('streaming');
            messageEl.classList.add('completed');
          }
        }
        
        // Log completion for debugging
        console.log('[AgentChat] Bubble completed:', {
          bubbleId,
          eventHistory: stateInfo.eventHistory.length,
          totalEvents: stateInfo.eventHistory,
        });
      }
    } else {
      // Even if state didn't change, ensure status display is updated
      updateStatusDisplay(bubbleId, newState);
    }
  }
  
  // Update backend state (from server events)
  function updateBackendState(
    bubbleId: string,
    newState: BackendBubbleState,
    reason: string = 'backend_state_change',
    data?: any
  ) {
    const now = Date.now();
    let stateInfo = bubbleStates.get(bubbleId);
    
    if (!stateInfo) {
      // Create new state info if doesn't exist
      stateInfo = {
        frontendState: FrontendBubbleState.PENDING,
        frontendStateTime: now,
        backendState: newState,
        backendStateTime: now,
        lastContentUpdateTime: now,
        completeTimeout: null,
        inactiveTimeout: undefined,
        createTime: now,
        bubbleId: bubbleId,
        eventHistory: [],
        updateCount: 0,
      };
      bubbleStates.set(bubbleId, stateInfo);
    }
    
    const oldBackendState = stateInfo.backendState;
    
    // Only update if state changed
    if (oldBackendState !== newState) {
      stateInfo.backendState = newState;
      stateInfo.backendStateTime = now;
      
      // Record backend create time if this is the first backend event
      if (oldBackendState === BackendBubbleState.UNKNOWN && newState !== BackendBubbleState.UNKNOWN) {
        stateInfo.backendCreateTime = now;
      }
      
      // Emit state change event
      emitStateChangeEvent(bubbleId, 'backend', undefined, newState, reason, data);
      
      // Sync frontend state based on backend state
      syncFrontendStateFromBackend(bubbleId);
    }
  }
  
  // Sync frontend state from backend state (event-driven synchronization)
  function syncFrontendStateFromBackend(bubbleId: string) {
    const stateInfo = bubbleStates.get(bubbleId);
    if (!stateInfo) {
      console.warn('[AgentChat] syncFrontendStateFromBackend: stateInfo not found', { bubbleId });
      return;
    }
    
    const backendState = stateInfo.backendState;
    const frontendState = stateInfo.frontendState;
    
    console.log('[AgentChat] syncFrontendStateFromBackend: called', {
      bubbleId,
      backendState,
      frontendState,
      lastContentUpdateTime: stateInfo.lastContentUpdateTime,
      timeSinceLastUpdate: Date.now() - stateInfo.lastContentUpdateTime,
    });
    
    // State synchronization rules:
    // - If backend is STREAMING and frontend is PENDING, move to STREAMING
    // - If backend is COMPLETED and frontend is STREAMING, move to PENDING_COMPLETE (then timeout to COMPLETED)
    // - If backend is COMPLETED and frontend is PENDING_COMPLETE, start timeout to COMPLETED
    // - If backend is ERROR, move frontend to ERROR
    
    if (backendState === BackendBubbleState.STREAMING) {
      if (frontendState === FrontendBubbleState.PENDING) {
        updateFrontendState(bubbleId, FrontendBubbleState.STREAMING, 'backend_started_streaming');
        // Set up inactive timeout
        setupInactiveTimeout(bubbleId);
      } else if (frontendState === FrontendBubbleState.PENDING_COMPLETE) {
        // Backend resumed streaming, go back to streaming
        updateFrontendState(bubbleId, FrontendBubbleState.STREAMING, 'backend_resumed_streaming');
        setupInactiveTimeout(bubbleId);
      }
    } else if (backendState === BackendBubbleState.COMPLETED) {
      // Backend is completed, update frontend state accordingly
      if (frontendState === FrontendBubbleState.PENDING) {
        // Frontend was waiting, backend is already completed - mark as completed immediately
        updateFrontendState(bubbleId, FrontendBubbleState.COMPLETED, 'backend_completed_immediate');
      } else if (frontendState === FrontendBubbleState.STREAMING) {
        // Frontend was streaming, backend completed - check if we should wait or immediately complete
        const timeSinceLastUpdate = Date.now() - stateInfo.lastContentUpdateTime;
        if (timeSinceLastUpdate >= UPDATE_THRESHOLD_MS) {
          // No recent update, immediately mark as completed
          updateFrontendState(bubbleId, FrontendBubbleState.COMPLETED, 'backend_completed_immediate');
        } else {
          // Recent update, wait for timeout to ensure no more content arrives
          updateFrontendState(bubbleId, FrontendBubbleState.PENDING_COMPLETE, 'backend_completed');
          setupCompleteTimeout(bubbleId);
        }
      } else if (frontendState === FrontendBubbleState.PENDING_COMPLETE) {
        // Already in pending_complete, check if we can immediately complete
        const timeSinceLastUpdate = Date.now() - stateInfo.lastContentUpdateTime;
        if (timeSinceLastUpdate >= UPDATE_THRESHOLD_MS) {
          // No recent update, immediately mark as completed
          updateFrontendState(bubbleId, FrontendBubbleState.COMPLETED, 'backend_completed_immediate');
        } else {
          // Recent update, ensure timeout is set (don't reset if already set)
          if (!stateInfo.completeTimeout) {
            setupCompleteTimeout(bubbleId);
          }
        }
      }
      // If frontend is already COMPLETED, no need to update
    } else if (backendState === BackendBubbleState.ERROR) {
      updateFrontendState(bubbleId, FrontendBubbleState.ERROR, 'backend_error');
    }
  }
  
  // Setup inactive timeout (when streaming, if no update for INACTIVE_TIMEOUT_MS, enter pending_complete)
  function setupInactiveTimeout(bubbleId: string) {
    const stateInfo = bubbleStates.get(bubbleId);
    if (!stateInfo) {
      console.warn('[AgentChat] setupInactiveTimeout: stateInfo not found', { bubbleId });
      return;
    }
    
    // Clear existing inactive timeout
    if (stateInfo.inactiveTimeout) {
      clearTimeout(stateInfo.inactiveTimeout);
      stateInfo.inactiveTimeout = undefined;
      console.log('[AgentChat] setupInactiveTimeout: cleared existing timeout', { bubbleId });
    }
    
    console.log('[AgentChat] setupInactiveTimeout: setting timeout', {
      bubbleId,
      INACTIVE_TIMEOUT_MS,
      frontendState: stateInfo.frontendState,
      backendState: stateInfo.backendState,
      lastContentUpdateTime: stateInfo.lastContentUpdateTime,
      timeSinceLastUpdate: Date.now() - stateInfo.lastContentUpdateTime,
    });
    
    // Only set timeout if currently streaming
    stateInfo.inactiveTimeout = setTimeout(() => {
      const currentStateInfo = bubbleStates.get(bubbleId);
      if (!currentStateInfo) {
        console.warn('[AgentChat] setupInactiveTimeout: timeout fired but stateInfo not found', { bubbleId });
        return;
      }
      
      const timeSinceLastUpdate = Date.now() - currentStateInfo.lastContentUpdateTime;
      const lastState = lastRecordState.get(currentRecordId || '');
      const timeSinceLastRecordUpdate = (lastState && 'lastUpdateTime' in lastState && lastState.lastUpdateTime) ? Date.now() - lastState.lastUpdateTime : Infinity;
      
      console.log('[AgentChat] setupInactiveTimeout: timeout fired', {
        bubbleId,
        frontendState: currentStateInfo.frontendState,
        backendState: currentStateInfo.backendState,
        timeSinceLastUpdate,
        timeSinceLastRecordUpdate,
        INACTIVE_TIMEOUT_MS,
        shouldTimeout: timeSinceLastUpdate >= INACTIVE_TIMEOUT_MS && timeSinceLastRecordUpdate >= INACTIVE_TIMEOUT_MS,
      });
      
      // Only transition if still streaming and backend is still streaming
      // CRITICAL: Also check if we've received any record_update events recently
      // If backend is still sending updates (even if content unchanged), don't timeout
      if (currentStateInfo.frontendState === FrontendBubbleState.STREAMING &&
          currentStateInfo.backendState === BackendBubbleState.STREAMING) {
        // Only enter pending_complete if no update for INACTIVE_TIMEOUT_MS
        // AND no recent record_update events (check if lastRecordState was updated recently)
        if (timeSinceLastUpdate >= INACTIVE_TIMEOUT_MS && timeSinceLastRecordUpdate >= INACTIVE_TIMEOUT_MS) {
          console.log('[AgentChat] setupInactiveTimeout: entering PENDING_COMPLETE due to inactivity', {
            bubbleId,
            timeSinceLastUpdate,
            timeSinceLastRecordUpdate,
          });
          updateFrontendState(bubbleId, FrontendBubbleState.PENDING_COMPLETE, 'inactive_timeout');
          // If backend is completed, setup complete timeout
          const latestStateInfo = bubbleStates.get(bubbleId);
          if (latestStateInfo && latestStateInfo.backendState === BackendBubbleState.COMPLETED) {
            setupCompleteTimeout(bubbleId);
          }
        } else {
          // Still receiving updates, reset timeout
          console.log('[AgentChat] setupInactiveTimeout: still receiving updates, resetting timeout', {
            bubbleId,
            timeSinceLastUpdate,
            timeSinceLastRecordUpdate,
          });
          setupInactiveTimeout(bubbleId);
        }
      } else {
        console.log('[AgentChat] setupInactiveTimeout: state changed, not entering PENDING_COMPLETE', {
          bubbleId,
          frontendState: currentStateInfo.frontendState,
          backendState: currentStateInfo.backendState,
        });
      }
    }, INACTIVE_TIMEOUT_MS);
  }
  
  // Setup complete timeout (when pending_complete, wait COMPLETE_TIMEOUT_MS before truly completing)
  function setupCompleteTimeout(bubbleId: string) {
    const stateInfo = bubbleStates.get(bubbleId);
    if (!stateInfo) {
      console.warn('[AgentChat] setupCompleteTimeout: stateInfo not found', { bubbleId });
      return;
    }
    
    // Clear existing timeout
    if (stateInfo.completeTimeout) {
      clearTimeout(stateInfo.completeTimeout);
      stateInfo.completeTimeout = null;
      console.log('[AgentChat] setupCompleteTimeout: cleared existing timeout', { bubbleId });
    }
    
    // Calculate remaining time based on last content update
    const timeSinceLastUpdate = Date.now() - stateInfo.lastContentUpdateTime;
    const remainingTime = Math.max(0, COMPLETE_TIMEOUT_MS - timeSinceLastUpdate);
    
    console.log('[AgentChat] setupCompleteTimeout: setting timeout', {
      bubbleId,
      timeSinceLastUpdate,
      remainingTime,
      COMPLETE_TIMEOUT_MS,
      frontendState: stateInfo.frontendState,
      backendState: stateInfo.backendState,
    });
    
    // Set complete timeout
    stateInfo.completeTimeout = setTimeout(() => {
      const currentStateInfo = bubbleStates.get(bubbleId);
      console.log('[AgentChat] setupCompleteTimeout: timeout fired', {
        bubbleId,
        currentStateInfo: currentStateInfo ? {
          frontendState: currentStateInfo.frontendState,
          backendState: currentStateInfo.backendState,
        } : null,
      });
      
      if (currentStateInfo && currentStateInfo.frontendState === FrontendBubbleState.PENDING_COMPLETE) {
        // Final check: ensure backend is still completed and no recent updates
        if (currentStateInfo.backendState === BackendBubbleState.COMPLETED) {
          console.log('[AgentChat] setupCompleteTimeout: marking as COMPLETED', { bubbleId });
          updateFrontendState(bubbleId, FrontendBubbleState.COMPLETED, 'complete_timeout');
        } else {
          console.warn('[AgentChat] setupCompleteTimeout: backend not COMPLETED, not marking as completed', {
            bubbleId,
            backendState: currentStateInfo.backendState,
          });
        }
      } else {
        console.log('[AgentChat] setupCompleteTimeout: frontend state changed, not marking as completed', {
          bubbleId,
          frontendState: currentStateInfo?.frontendState,
        });
      }
    }, remainingTime);
  }
  
  // Mark bubble content update (reset timeouts)
  function markBubbleContentUpdate(bubbleId: string) {
    const stateInfo = bubbleStates.get(bubbleId);
    if (!stateInfo) return;
    
    const now = Date.now();
    stateInfo.lastContentUpdateTime = now;
    stateInfo.updateCount++;
    
    // CRITICAL: If backend is already COMPLETED and frontend is PENDING_COMPLETE,
    // don't call syncFrontendStateFromBackend as it will reset the complete timeout.
    // The timeout should continue running to eventually mark as COMPLETED.
    if (stateInfo.backendState === BackendBubbleState.COMPLETED && 
        stateInfo.frontendState === FrontendBubbleState.PENDING_COMPLETE) {
      // Backend is completed and frontend is waiting for timeout, don't reset it
      // Just emit the event and return
      emitStateChangeEvent(bubbleId, 'system', undefined, undefined, 'content_updated', {
        updateCount: stateInfo.updateCount,
        timeSinceLastUpdate: now - stateInfo.lastContentUpdateTime,
      });
      return;
    }
    
    // Sync frontend state from backend state first (in case backend state was just updated)
    syncFrontendStateFromBackend(bubbleId);
    
    // Get updated state info after sync
    const updatedStateInfo = bubbleStates.get(bubbleId);
    if (!updatedStateInfo) return;
    
    // If in pending_complete or completed state, go back to streaming (new content arrived)
    if (updatedStateInfo.frontendState === FrontendBubbleState.PENDING_COMPLETE || 
        updatedStateInfo.frontendState === FrontendBubbleState.COMPLETED) {
      // Only go back to streaming if backend is still streaming
      if (updatedStateInfo.backendState === BackendBubbleState.STREAMING) {
        updateFrontendState(bubbleId, FrontendBubbleState.STREAMING, 'new_content_arrived');
        setupInactiveTimeout(bubbleId);
      }
      // If backend is COMPLETED, don't reset timeout - let it continue to completion
    } else if (updatedStateInfo.frontendState === FrontendBubbleState.STREAMING) {
      // Reset inactive timeout when receiving updates during streaming
      setupInactiveTimeout(bubbleId);
    } else if (updatedStateInfo.frontendState === FrontendBubbleState.PENDING) {
      // If still in PENDING state but backend is STREAMING, sync to STREAMING
      if (updatedStateInfo.backendState === BackendBubbleState.STREAMING) {
        updateFrontendState(bubbleId, FrontendBubbleState.STREAMING, 'content_update_during_streaming');
        setupInactiveTimeout(bubbleId);
      }
    }
    
    // Emit content update event
    emitStateChangeEvent(bubbleId, 'system', undefined, undefined, 'content_updated', {
      updateCount: updatedStateInfo.updateCount,
      timeSinceLastUpdate: now - updatedStateInfo.lastContentUpdateTime,
    });
  }
    
  
  // Group messages: merge tool calls with results, separate before/after messages
  function groupMessages(messages: any[]): Array<{
    type: 'user' | 'assistant_before' | 'tool_call_result' | 'assistant_after';
    data: any;
    bubbleId: string;
    toolCallId?: string;
    toolResult?: any;
  }> {
    const processedMessages: Array<{
      type: 'user' | 'assistant_before' | 'tool_call_result' | 'assistant_after';
      data: any;
      bubbleId: string;
      toolCallId?: string;
      toolResult?: any;
    }> = [];
    
    for (let i = 0; i < messages.length; i++) {
      const msgData = messages[i];
      let bubbleId = msgData.bubbleId || generatebubbleId();
      
      if (msgData.role === 'user') {
        processedMessages.push({
          type: 'user',
          data: msgData,
          bubbleId,
        });
      } else if (msgData.role === 'assistant') {
        const content = msgData.content || '';
        const toolCalls = msgData.tool_calls;
        
        // If has tool_calls, check for corresponding tool result
        if (toolCalls && toolCalls.length > 0) {
          // Look ahead for tool result
          let toolResult: any = null;
          let toolResultIndex = -1;
          for (let j = i + 1; j < messages.length; j++) {
            const nextMsg = messages[j];
            if (nextMsg.role === 'tool' && nextMsg.tool_call_id === toolCalls[0].id) {
              toolResult = nextMsg;
              toolResultIndex = j;
              break;
            }
          }
          
          // Content before tool call (if any)
          if (content && content.trim()) {
            processedMessages.push({
              type: 'assistant_before',
              data: { ...msgData, content, tool_calls: undefined },
              bubbleId: bubbleId + '_before',
            });
          }
          
          // Tool call + result as one record
          processedMessages.push({
            type: 'tool_call_result',
            data: { ...msgData, content: '', tool_calls: toolCalls },
            bubbleId: bubbleId + '_tool',
            toolCallId: toolCalls[0].id,
            toolResult: toolResult,
          });
          
          // Skip the tool result message in the main loop
          if (toolResultIndex > i) {
            i = toolResultIndex; // Skip tool result in main loop
          }
          
          // Check for content after tool call (next assistant message without tool_calls)
          if (toolResultIndex >= 0 && toolResultIndex + 1 < messages.length) {
            const nextMsg = messages[toolResultIndex + 1];
            if (nextMsg.role === 'assistant' && !nextMsg.tool_calls && nextMsg.content) {
              processedMessages.push({
                type: 'assistant_after',
                data: nextMsg,
                bubbleId: nextMsg.bubbleId || generatebubbleId(),
              });
              i = toolResultIndex + 1; // Skip this message in main loop
            }
          }
        } else {
          // Assistant message without tool_calls
          processedMessages.push({
            type: 'assistant_after',
            data: msgData,
            bubbleId,
          });
        }
      } else if (msgData.role === 'tool') {
        // Tool messages are handled in the assistant message processing above
        // Skip them here to avoid duplicates
        continue;
      }
    }
    
    return processedMessages;
  }

  // Simple hash function for content
  function contentHash(content: string): string {
    // Simple hash based on content length and first/last chars
    if (!content) return '';
    return `${content.length}-${content.substring(0, 20)}-${content.substring(Math.max(0, content.length - 20))}`;
  }
  
  // Check if markdown should be rendered (avoid duplicate rendering)
  function shouldRenderMarkdown(bubbleId: string, content: string, contentDiv: HTMLElement | null): boolean {
    if (!content || !content.trim()) return false;
    
    // If content div already has HTML (rendered), check if content changed
    if (contentDiv && contentDiv.innerHTML && contentDiv.innerHTML.includes('<')) {
      const lastRenderedHash = renderedMarkdownIds.get(bubbleId);
      const currentHash = contentHash(content);
      
      // If content hasn't changed, don't re-render
      if (lastRenderedHash === currentHash) {
        return false;
      }
    }
    
    // If content div is empty or only has plain text, should render
    if (!contentDiv || !contentDiv.innerHTML || !contentDiv.innerHTML.includes('<')) {
      return true;
    }
    
    return false;
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
  
  // Render markdown and track it to prevent duplicates
  async function renderMarkdownWithTracking(bubbleId: string, content: string, contentDiv: HTMLElement | null): Promise<void> {
    if (!shouldRenderMarkdown(bubbleId, content, contentDiv)) {
      return; // Skip if already rendered or shouldn't render
    }
    
    // CRITICAL: Never overwrite non-empty bubble with empty - prevents 最后一句话时上面气泡被清空
    const existingText = contentDiv?.textContent?.trim() || (contentDiv?.innerHTML ? contentDiv.innerHTML.replace(/<[^>]*>/g, '').trim() : '');
    if ((!content || !content.trim()) && existingText) {
      return;
    }
    
    const contentHashValue = contentHash(content);
    const lastHash = renderedMarkdownIds.get(bubbleId);
    
    // If content hasn't changed, don't re-render
    if (lastHash === contentHashValue && contentDiv && contentDiv.innerHTML && contentDiv.innerHTML.includes('<')) {
      return;
    }
    
    try {
      const renderedHtml = await renderMarkdown(content, false);
      if (contentDiv) {
        const newHtmlTrimmed = (renderedHtml || '').replace(/<[^>]*>/g, '').trim();
        if (!newHtmlTrimmed && existingText) {
          return; // Don't overwrite non-empty with empty rendered result
        }
        contentDiv.innerHTML = renderedHtml;
        // Track that we rendered this content
        renderedMarkdownIds.set(bubbleId, contentHashValue);
      }
    } catch (error: any) {
      console.error('[AgentChat] Error rendering markdown with tracking:', error);
      if (contentDiv && (content.trim() || !existingText)) {
        contentDiv.textContent = content;
      }
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
        // Group messages: merge tool calls with results, separate before/after messages
        const groupedMessages = groupMessages(recordHistory);
        
        // Render all messages sequentially to ensure proper order
        for (const processedMsg of groupedMessages) {
          if (processedMsg.type === 'user') {
            await addMessage('user', processedMsg.data.content, undefined, undefined, processedMsg.bubbleId, true);
          } else if (processedMsg.type === 'assistant_before' || processedMsg.type === 'assistant_after') {
            await addMessage('assistant', processedMsg.data.content, undefined, undefined, processedMsg.bubbleId, true);
          } else if (processedMsg.type === 'tool_call_result') {
            // Add tool call container
            await addMessage('assistant', '', undefined, processedMsg.data.tool_calls, processedMsg.bubbleId, true);
            
            // Add tool result if available
            if (processedMsg.toolResult && processedMsg.toolCallId) {
              const toolCallItem = Array.from(chatMessages.querySelectorAll('.tool-call-item')).find(
                (el: any) => el.getAttribute('data-tool-call-id') === processedMsg.toolCallId
              ) as Element | null;
              
              if (toolCallItem) {
                const statusBadge = toolCallItem.querySelector('.tool-status-badge') as HTMLElement | null;
                applyToolCallStatus(toolCallItem, processedMsg.toolResult.content, statusBadge);
                
                const toolCallDetails = toolCallItem.querySelector('.tool-call-details') as HTMLElement;
                if (toolCallDetails) {
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
                    const toolContent = typeof processedMsg.toolResult.content === 'string'
                      ? processedMsg.toolResult.content
                      : JSON.stringify(processedMsg.toolResult.content, null, 2);
                    resultPre.textContent = toolContent;
                    applyToolCallStatus(toolCallItem, processedMsg.toolResult.content, toolCallItem.querySelector('.tool-status-badge') as HTMLElement | null);
                  }
                }
              }
            }
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
  
  // Handle bubble stream events (streaming content, not updating Record)
  const handleBubbleStream = async (msg: any) => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    const { rid, bubbleId, content, isNew } = msg;
    if (!rid || !bubbleId || content === undefined) {
      console.warn('[AgentChat] Invalid bubble_stream message:', msg);
      return;
    }
    
    try {
      // Helper function to get bubbleId from element
      const getbubbleId = (el: Element): string | null => {
        return el.getAttribute('data-message-id');
      };
      
      // Helper function to set bubbleId on element
      const setbubbleId = (el: Element, bubbleId: string) => {
        el.setAttribute('data-message-id', bubbleId);
      };
      
      // Find the message element by bubbleId (should already exist, created by sendMessage)
      let messageElement = Array.from(chatMessages.children).find(
        (el: any) => getbubbleId(el) === bubbleId && el.classList.contains('chat-message')
      ) as HTMLElement | null;
      
      if (!messageElement) {
        // Message not found - this shouldn't happen if backend uses the frontend-provided bubbleId
        // But handle it gracefully: check if already tracked to prevent duplicate creation
        if (displayedbubbleIdsGlobal.has(bubbleId)) {
          console.warn('[AgentChat] BubbleId tracked but message not found in DOM:', { bubbleId });
          return;
        }
        
        // Create message as fallback (shouldn't happen in normal flow)
        displayedbubbleIdsGlobal.add(bubbleId);
        await addMessage('assistant', '', undefined, undefined, bubbleId, false);
        updateFrontendState(bubbleId, FrontendBubbleState.STREAMING);
        updateBackendState(bubbleId, BackendBubbleState.STREAMING);
        messageElement = Array.from(chatMessages.children).find(
          (el: any) => getbubbleId(el) === bubbleId && el.classList.contains('chat-message')
        ) as HTMLElement | null;
        console.warn('[AgentChat] Created fallback message element (should not happen):', { bubbleId });
      }
      
      // Update content (plain text, no markdown rendering during streaming)
      const messageBubble = messageElement.querySelector('.message-bubble');
      if (messageBubble) {
        let contentDiv = messageBubble.querySelector('.message-content') as HTMLElement | null;
        if (!contentDiv) {
          // Create contentDiv if it doesn't exist (shouldn't happen, but handle edge case)
          contentDiv = document.createElement('div');
          contentDiv.className = 'message-content';
          messageBubble.appendChild(contentDiv);
          console.log('[AgentChat] handleBubbleStream: created contentDiv', { bubbleId });
        }
        
        // Get current content before update
        const currentContent = contentDiv.textContent || '';
        const currentLength = currentContent.length;
        
        // Update text content directly (no markdown rendering during streaming)
        if (contentDiv) {
          contentDiv.textContent = content;
          // Mark as streaming (add class for styling)
          messageElement.classList.add('streaming');
          messageElement.classList.remove('completed');
          
          // Log content update details
          const newLength = content ? content.length : 0;
          const contentIncreased = newLength > currentLength;
          const contentDecreased = newLength < currentLength;
          const contentSame = newLength === currentLength;
          
          console.log('[AgentChat] handleBubbleStream: content updated', {
            bubbleId,
            currentLength,
            newLength,
            contentIncreased,
            contentDecreased,
            contentSame,
            diff: newLength - currentLength,
            currentPreview: currentContent.substring(Math.max(0, currentLength - 20)),
            newPreview: content ? content.substring(Math.max(0, newLength - 20)) : '',
          });
          
          if (contentDecreased) {
            console.warn('[AgentChat] handleBubbleStream: WARNING - content decreased!', {
              bubbleId,
              currentLength,
              newLength,
              currentContent: currentContent.substring(0, 100),
              newContent: content ? content.substring(0, 100) : '',
            });
          }
        }
      } else {
        console.warn('[AgentChat] handleBubbleStream: Message bubble not found', { bubbleId });
      }
      
      // Mark content update (reset timeouts)
      const stateBeforeUpdate = getFrontendBubbleState(bubbleId);
      const backendStateBeforeUpdate = getBackendBubbleState(bubbleId);
      markBubbleContentUpdate(bubbleId);
      const stateAfterUpdate = getFrontendBubbleState(bubbleId);
      const backendStateAfterUpdate = getBackendBubbleState(bubbleId);
      
      console.log('[AgentChat] handleBubbleStream: state after update', {
        bubbleId,
        frontendStateBefore: stateBeforeUpdate,
        frontendStateAfter: stateAfterUpdate,
        backendStateBefore: backendStateBeforeUpdate,
        backendStateAfter: backendStateAfterUpdate,
        contentLength: content ? content.length : 0,
      });
    } catch (error: any) {
      console.error('[AgentChat] Error handling bubble stream:', error);
    }
  };
  
  const handleRecordUpdate = async (msg: any) => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) {
      console.warn('[AgentChat] handleRecordUpdate: chatMessages not found');
      return;
    }
    
    if (!msg.rid) {
      console.warn('[AgentChat] handleRecordUpdate: Invalid record update message: missing rid', msg);
      return;
    }
    
    console.log('[AgentChat] handleRecordUpdate: received', {
      rid: msg.rid,
      timestamp: new Date().toISOString(),
      recordKeys: msg.record ? Object.keys(msg.record) : [],
      agentMessagesCount: msg.record?.agentMessages?.length || 0,
    });
    
    const record = msg.record || {};
    const rid = msg.rid;
    
    if (currentRecordId !== rid) {
      console.log('[AgentChat] handleRecordUpdate: currentRecordId changed', {
        oldRecordId: currentRecordId,
        newRecordId: rid,
      });
      currentRecordId = rid;
    }
    
    // EARLY EXIT: Check if this record_update is a duplicate (same content hash and message count)
    if (record.agentMessages && Array.isArray(record.agentMessages)) {
      const messageCount = record.agentMessages.length;
      const status = record.status;
      
      // Calculate a simple hash of all message content hashes
      const allContentHashes = record.agentMessages
        .map((m: any) => m.contentHash || (m.content ? contentHash(m.content) : ''))
        .filter((h: string) => h)
        .join('|');
      const recordContentHash = allContentHashes ? contentHash(allContentHashes) : '';
      
      const lastState = lastRecordState.get(rid);
      if (lastState && 
          lastState.contentHash === recordContentHash && 
          lastState.messageCount === messageCount &&
          lastState.status === status) {
        // Record content unchanged, skip processing to prevent duplicate markdown rendering
        console.log('[AgentChat] Skipping duplicate record_update:', { rid, contentHash: recordContentHash, messageCount });
        return;
      }
      
      // Update last processed state (including timestamp to track when we last received an update)
      lastRecordState.set(rid, { contentHash: recordContentHash, messageCount, status, lastUpdateTime: Date.now() });
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
      // For streaming, don't group messages yet (tool calls and results may not be complete)
      // For completed tasks, group messages to merge tool calls with results
      const processedMessages = isStreaming 
        ? (() => {
            const messages = record.agentMessages;
            const result: any[] = [];
            for (let i = 0; i < messages.length; i++) {
              const msg = messages[i];
              const baseBubbleId = msg.bubbleId || generatebubbleId();
              const isToolCallResult = msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0;
              if (msg.role === 'tool') {
                continue;
              }
              let toolResult: any = undefined;
              if (isToolCallResult && msg.tool_calls && msg.tool_calls[0]) {
                const toolCallId = msg.tool_calls[0].id;
                for (let j = i + 1; j < messages.length; j++) {
                  if (messages[j].role === 'tool' && (messages[j] as any).tool_call_id === toolCallId) {
                    toolResult = messages[j];
                    break;
                  }
                }
              }
              result.push({
                type: msg.role === 'user' ? 'user' as const :
                      isToolCallResult ? 'tool_call_result' as const : 'assistant_after' as const,
                data: msg,
                bubbleId: isToolCallResult ? baseBubbleId + '_tool' : baseBubbleId,
                toolCallId: msg.tool_calls?.[0]?.id,
                toolResult,
                bubbleState: msg.bubbleState || (isStreaming ? 'streaming' : 'completed'),
                contentHash: msg.contentHash,
              });
            }
            return result;
          })()
        : groupMessages(record.agentMessages).map((processedMsg: any) => ({
            ...processedMsg,
            // For completed messages, mark as completed
            bubbleState: 'completed',
            contentHash: processedMsg.data.contentHash,
          }));
      
      // Second pass: process grouped messages
      (async () => {
        for (const processedMsg of processedMessages) {
          const msgData = processedMsg.data;
          let bubbleId = processedMsg.bubbleId;
          const hadbubbleId = !!msgData.bubbleId; // Track if bubbleId was originally present
          
          // CRITICAL: Check message state and content hash from record to avoid duplicate processing
          // Calculate content hash for this message
          const messageContent = msgData.content || '';
          const calculatedContentHash = messageContent ? contentHash(messageContent) : '';
          const messageState = processedMsg.bubbleState; // 'streaming' | 'completed' | undefined (from backend)
          const messageContentHash = processedMsg.contentHash || calculatedContentHash; // Use provided hash or calculate
          
          // If message is marked as completed and we've already rendered this content, skip
          if (messageState === 'completed' && bubbleId && messageContentHash) {
            const lastRenderedHash = renderedMarkdownIds.get(bubbleId);
            if (lastRenderedHash === messageContentHash) {
              // Content already rendered with same hash, skip this message completely
              console.log('[AgentChat] Skipping completed message with unchanged content:', { bubbleId, contentHash: messageContentHash });
              continue;
            }
          }
          
          // If task is completed and message state is completed, check content before processing
          if (isCompleted && messageState === 'completed' && bubbleId) {
            const existingMsg = Array.from(chatMessages.children).find(
              (el: any) => getbubbleId(el) === bubbleId && 
                          el.classList.contains('chat-message') && 
                          el.classList.contains('assistant')
            );
            if (existingMsg) {
              const messageBubble = existingMsg.querySelector('.message-bubble');
              if (messageBubble) {
                const contentDiv = messageBubble.querySelector('.message-content');
                if (contentDiv) {
                  const currentContent = contentDiv.textContent?.trim() || '';
                  const newContent = messageContent.trim();
                  const currentHash = currentContent ? contentHash(currentContent) : '';
                  
                  // If content hash matches, skip completely
                  if (currentHash === messageContentHash && messageContentHash) {
                    console.log('[AgentChat] Skipping message with matching content hash:', { bubbleId, contentHash: messageContentHash });
                    continue;
                  }
                }
              }
            }
          }
          
          // For streaming assistant messages without bubbleId, try to find message without bubbleId
          if (isStreaming && msgData.role === 'assistant' && !msgData.bubbleId) {
            const allAssistantMessages = Array.from(chatMessages.children).filter(
              (el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant')
            );
            
            // Find message without bubbleId (shouldn't happen if backend uses frontend-provided bubbleId)
            for (let j = allAssistantMessages.length - 1; j >= 0; j--) {
              const existingMsg = allAssistantMessages[j];
              const existingId = getbubbleId(existingMsg);
              if (!existingId) {
                // Found message without bubbleId, generate and set one
                bubbleId = generatebubbleId();
                setbubbleId(existingMsg, bubbleId);
                break;
              }
            }
          }
          
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
            
            // Backend should provide bubbleId, but if not, just mark as displayed
              displayedbubbleIds.add(bubbleId);
              displayedbubbleIdsGlobal.add(bubbleId);
          } else if (!bubbleId && msgData.role === 'assistant') {
            // 后端应该提供 bubbleId（使用前端发送的 assistantBubbleId）
            // 如果没有提供，查找最后一个没有 bubbleId 的 assistant 消息
            const allAssistantMessages = Array.from(chatMessages.children).filter(
              (el: any) => el.classList.contains('chat-message') && el.classList.contains('assistant')
            );
            
            // 从后往前找第一个没有 bubbleId 的消息
            for (let j = allAssistantMessages.length - 1; j >= 0; j--) {
              const existingMsg = allAssistantMessages[j];
              const existingId = getbubbleId(existingMsg);
              if (!existingId) {
                // 找到没有 bubbleId 的消息，生成新的并设置
                bubbleId = generatebubbleId();
                setbubbleId(existingMsg, bubbleId);
                displayedbubbleIds.add(bubbleId);
                displayedbubbleIdsGlobal.add(bubbleId);
                break;
              }
            }
            
            // 如果没找到，生成新的 bubbleId（不应该发生，但处理边界情况）
            if (!bubbleId) {
              bubbleId = generatebubbleId();
            }
          } else if (!bubbleId) {
            bubbleId = generatebubbleId();
          }
          
          // Handle different message types
          if (processedMsg.type === 'user') {
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
          
          // Handle tool_call_result type (merged tool call + result)
          if (processedMsg.type === 'tool_call_result') {
            const toolCalls = msgData.tool_calls;
            const toolResult = processedMsg.toolResult;
            const precedingAssistantBubbleId = msgData.bubbleId;
            if (precedingAssistantBubbleId) {
              const precedingAssistant = Array.from(chatMessages.children).find(
                (el: any) => getbubbleId(el) === precedingAssistantBubbleId &&
                            el.classList.contains('chat-message') && el.classList.contains('assistant')
              ) as HTMLElement | null;
              if (precedingAssistant) {
                const contentDiv = precedingAssistant.querySelector('.message-content') as HTMLElement | null;
                if (contentDiv && msgData.content != null) {
                  const newVal = typeof msgData.content === 'string' ? msgData.content : JSON.stringify(msgData.content || '');
                  const currentVal = contentDiv.textContent?.trim() || (contentDiv.innerHTML ? contentDiv.innerHTML.replace(/<[^>]*>/g, '').trim() : '');
                  // CRITICAL: tool_call_result has content:'' in groupMessages - never overwrite non-empty 上方气泡 with empty (fixes 最后一句话时上面气泡被清空)
                  if (newVal.trim() || !currentVal) {
                    contentDiv.textContent = newVal;
                  }
                }
                precedingAssistant.classList.remove('streaming');
                precedingAssistant.classList.add('completed');
                updateFrontendState(precedingAssistantBubbleId, FrontendBubbleState.COMPLETED, 'tool_call_before', {});
              }
            }
            if (displayedbubbleIds.has(bubbleId)) {
              // Update tool result if available
              if (toolResult && processedMsg.toolCallId) {
                const toolCallItem = Array.from(chatMessages.querySelectorAll('.tool-call-item')).find(
                  (el: any) => el.getAttribute('data-tool-call-id') === processedMsg.toolCallId
                ) as Element | null;
                
                if (toolCallItem) {
                  const content = toolResult.content;
                  applyToolCallStatus(toolCallItem, content, toolCallItem.querySelector('.tool-status-badge') as HTMLElement | null);
                  const toolCallDetails = toolCallItem.querySelector('.tool-call-details') as HTMLElement;
                  if (toolCallDetails) {
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
                      const toolContent = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2);
                      resultPre.textContent = toolContent;
                    }
                  }
                }
              }
              continue;
            }
            
            // Create tool call + result container
            // Mark as tracked BEFORE creating to prevent race condition
            displayedbubbleIds.add(bubbleId);
            displayedbubbleIdsGlobal.add(bubbleId);
            
            const finalCheckInDOMForTool = Array.from(chatMessages.children).find(
              (el: any) => getbubbleId(el) === bubbleId && el.classList.contains('tool-call-container')
            );
            if (!finalCheckInDOMForTool) {
              await addMessage('assistant', '', undefined, toolCalls, bubbleId);
            } else {
              console.log('[AgentChat] Tool call container already exists, skipping creation:', { bubbleId });
            }
            
            // If tool result is available, add it immediately
            if (toolResult && processedMsg.toolCallId) {
              const toolCallItem = Array.from(chatMessages.querySelectorAll('.tool-call-item')).find(
                (el: any) => el.getAttribute('data-tool-call-id') === processedMsg.toolCallId
              ) as Element | null;
              if (toolCallItem) {
                applyToolCallStatus(toolCallItem, toolResult.content, toolCallItem.querySelector('.tool-status-badge') as HTMLElement | null);
                const toolCallDetails = toolCallItem.querySelector('.tool-call-details') as HTMLElement;
                if (toolCallDetails) {
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
                    const toolContent = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2);
                    resultPre.textContent = toolContent;
                    applyToolCallStatus(toolCallItem, toolResult.content, toolCallItem.querySelector('.tool-status-badge') as HTMLElement | null);
                  }
                }
              }
            }
            continue;
          }
          
          // Handle assistant_before and assistant_after types (regular assistant messages)
          if (processedMsg.type === 'assistant_before' || processedMsg.type === 'assistant_after') {
            // Treat as regular assistant message
            msgData.role = 'assistant';
          }
          
          // Continue with existing assistant message handling logic
            if (msgData.role === 'assistant') {
            // For assistant messages, always try to update existing message first (for streaming)
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
            
            // Use event-based lifecycle tracking with timeout
            // CRITICAL: If bubble is already completed, skip all processing to prevent duplicate markdown rendering
            const msgStateCheck = getFrontendBubbleState(bubbleId);
            const backendStateCheck = getBackendBubbleState(bubbleId);
            if (msgStateCheck === FrontendBubbleState.COMPLETED) {
              // Frontend is completed, skip all processing
              continue;
            }
            
            // CRITICAL: If backend is completed and task is completed, skip if content hasn't changed
            // This prevents duplicate processing of repeated record_update events after completion
            if (isCompleted && backendStateCheck === BackendBubbleState.COMPLETED) {
              // Check if content actually changed
              const existingMsg = Array.from(chatMessages.children).find(
                (el: any) => getbubbleId(el) === bubbleId && 
                            el.classList.contains('chat-message') && 
                            el.classList.contains('assistant')
              );
              if (existingMsg) {
                const messageBubble = existingMsg.querySelector('.message-bubble');
                if (messageBubble) {
                  const contentDiv = messageBubble.querySelector('.message-content');
                  if (contentDiv) {
                    const currentContent = contentDiv.textContent?.trim() || '';
                    const newContent = content?.trim() || '';
                    // If content hasn't changed, skip this update completely
                    if (currentContent === newContent) {
                      continue;
                    }
                  }
                }
              }
            }
            
            // CRITICAL: Update backend state based on message state from record
            // This ensures frontend state syncs correctly when backend completes
            const currentBackendState = getBackendBubbleState(bubbleId);
            
            // 如果任务已完成，无论 messageState 是什么，都应该标记为 COMPLETED
            if (isCompleted) {
              // Task is completed, mark backend state as COMPLETED
              if (currentBackendState !== BackendBubbleState.COMPLETED) {
                updateBackendState(bubbleId, BackendBubbleState.COMPLETED, 'record_update_completed', {
                  content: content,
                  messageState: messageState,
                  isCompleted: isCompleted,
                });
                // Sync frontend state immediately to transition from STREAMING/PENDING to PENDING_COMPLETE/COMPLETED
                syncFrontendStateFromBackend(bubbleId);
              }
            } else if (messageState === 'completed') {
              // Message is explicitly marked as completed (even if task is not completed yet)
              if (currentBackendState !== BackendBubbleState.COMPLETED) {
                updateBackendState(bubbleId, BackendBubbleState.COMPLETED, 'record_update_completed', {
                  content: content,
                  messageState: messageState,
                  isCompleted: isCompleted,
                });
                syncFrontendStateFromBackend(bubbleId);
              }
            } else if (messageState === 'streaming' || (isStreaming && messageState !== 'completed')) {
              // Message is streaming, update backend state to STREAMING
              // This handles the case where record_update arrives before message_start event
              if (currentBackendState === BackendBubbleState.UNKNOWN || currentBackendState === BackendBubbleState.COMPLETED) {
                // Only update if unknown, or if we're receiving streaming content after completion (shouldn't happen, but handle it)
                if (currentBackendState === BackendBubbleState.UNKNOWN) {
                  updateBackendState(bubbleId, BackendBubbleState.STREAMING, 'record_update_streaming', {
                    content: content,
                    isStreaming: isStreaming,
                    messageState: messageState,
                  });
                }
              }
            }
            
            // Mark bubble as receiving content update (reset pending_complete if needed, reset inactive timeout)
            // CRITICAL: Only mark update if content actually changed or we're streaming
            // This prevents unnecessary processing of duplicate record_update events
            if (content && content.trim()) {
              // Check if content actually changed before marking as update
              const existingMsg = Array.from(chatMessages.children).find(
                (el: any) => getbubbleId(el) === bubbleId && 
                            el.classList.contains('chat-message') && 
                            el.classList.contains('assistant')
              );
              
              let contentChanged = true;
              if (existingMsg && isCompleted) {
                // If task is completed, check if content changed to avoid duplicate processing
                const messageBubble = existingMsg.querySelector('.message-bubble');
                if (messageBubble) {
                  const contentDiv = messageBubble.querySelector('.message-content');
                  if (contentDiv) {
                    const currentContent = contentDiv.textContent?.trim() || '';
                    const newContent = content.trim();
                    contentChanged = currentContent !== newContent;
                  }
                }
              }
              
              // Only mark as update if content changed or we're still streaming
              if (contentChanged || isStreaming) {
                markBubbleContentUpdate(bubbleId);
              }
            } else if (isStreaming) {
              // Even if content is empty, mark as update during streaming to reset inactive timeout
              markBubbleContentUpdate(bubbleId);
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
            
            // If bubble is in pending_complete or completed state, check if we should still update
            const pendingState = getFrontendBubbleState(bubbleId);
            if (pendingState === FrontendBubbleState.PENDING_COMPLETE || pendingState === FrontendBubbleState.COMPLETED) {
              // Always allow updates if content has changed, even if bubble is in pending_complete or completed
              // This ensures we don't miss any final content updates
              if (content && content.trim()) {
                const existingMsg = Array.from(chatMessages.children).find(
                  (el: any) => getbubbleId(el) === bubbleId && 
                              el.classList.contains('chat-message') && 
                              el.classList.contains('assistant')
                );
                if (existingMsg) {
                  const messageBubble = existingMsg.querySelector('.message-bubble');
                  if (messageBubble) {
                    const contentDiv = messageBubble.querySelector('.message-content');
                    if (contentDiv) {
                      const currentContent = contentDiv.textContent?.trim() || '';
                      const newContent = content.trim();
                      
                      // If content has changed, update it and reset state
                      if (currentContent !== newContent) {
                        // Mark content update (this will handle state synchronization)
                        markBubbleContentUpdate(bubbleId);
                        
                        // Update content
                        if (isStreaming || pendingState === FrontendBubbleState.PENDING_COMPLETE) {
                          contentDiv.textContent = newContent;
                          } else {
                          // Render markdown for truly completed bubbles (with tracking to prevent duplicates)
                          if (contentDiv && contentDiv instanceof HTMLElement) {
                            renderMarkdownWithTracking(bubbleId, content, contentDiv);
                          }
                        }
                        
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                      }
                    }
                  }
                }
              }
              // Continue processing to allow further updates
              // Don't skip - we want to allow updates even for completed bubbles
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
            // Priority: 1) temp- message, 2) last assistant message without bubbleId, 3) last assistant message
            if (!assistantMsg && isStreaming) {
              const allChildren = Array.from(chatMessages.children);
              
              // First, try to find temp- message
              for (let j = allChildren.length - 1; j >= 0; j--) {
                const el = allChildren[j];
                if (el.classList.contains('chat-message') && el.classList.contains('assistant')) {
                  const elId = getbubbleId(el);
                  if (elId && elId.startsWith('temp-')) {
                    assistantMsg = el;
                    // Update temp- message with actual bubbleId
                    setbubbleId(assistantMsg, bubbleId);
                    displayedbubbleIds.add(bubbleId);
                    displayedbubbleIdsGlobal.add(bubbleId);
                    activebubbleIds.add(bubbleId);
                    break;
                  }
                }
              }
              
              // If temp- message not found, find last assistant message without bubbleId
              if (!assistantMsg) {
                for (let j = allChildren.length - 1; j >= 0; j--) {
                  const el = allChildren[j];
                  if (el.classList.contains('chat-message') && el.classList.contains('assistant')) {
                    const elId = getbubbleId(el);
                    if (!elId) {
                      assistantMsg = el;
                      setbubbleId(assistantMsg, bubbleId);
                      displayedbubbleIds.add(bubbleId);
                      displayedbubbleIdsGlobal.add(bubbleId);
                      activebubbleIds.add(bubbleId);
                      break;
                    }
                  }
                }
              }
              
              // Last resort: find any last assistant message
              if (!assistantMsg) {
              for (let j = allChildren.length - 1; j >= 0; j--) {
                const el = allChildren[j];
                if (el.classList.contains('chat-message') && el.classList.contains('assistant')) {
                  assistantMsg = el;
                  // Set bubbleId on the found message if it doesn't have one
                  if (!getbubbleId(assistantMsg)) {
                    setbubbleId(assistantMsg, bubbleId);
                    displayedbubbleIds.add(bubbleId);
                    displayedbubbleIdsGlobal.add(bubbleId);
                      activebubbleIds.add(bubbleId);
                  }
                  break;
                  }
                }
              }
            }
            
            // If found existing message, update it
            if (assistantMsg && assistantMsg.classList.contains('assistant')) {
              // CRITICAL: Before updating, check if we should skip this update completely
              // If task is completed, backend is completed, and content hasn't changed, skip all processing
              const currentMsgState = getFrontendBubbleState(bubbleId);
              const currentBackendState = getBackendBubbleState(bubbleId);
              
              if (isCompleted && currentBackendState === BackendBubbleState.COMPLETED) {
                const messageBubble = assistantMsg.querySelector('.message-bubble');
                if (messageBubble) {
                  const contentDiv = messageBubble.querySelector('.message-content');
                  if (contentDiv) {
                    const currentContent = contentDiv.textContent?.trim() || '';
                    const newContent = content?.trim() || '';
                    // If content hasn't changed, skip completely to prevent duplicate markdown rendering
                    if (currentContent === newContent) {
                      continue;
                    }
                  }
                }
              }
              
              // Update existing assistant message (streaming or final)
              const messageBubble = assistantMsg.querySelector('.message-bubble');
              if (messageBubble) {
                let contentDiv = messageBubble.querySelector('.message-content');
              if (!contentDiv) {
                  contentDiv = document.createElement('div');
                  contentDiv.className = 'message-content';
                  messageBubble.appendChild(contentDiv);
                }
                
                // Get current content to check if it changed
                const currentContent = contentDiv.textContent?.trim() || '';
                const newContent = content?.trim() || '';
                const contentChanged = currentContent !== newContent;
                
                // Check bubble state to determine update behavior
                const isPendingComplete = currentMsgState === FrontendBubbleState.PENDING_COMPLETE;
                const isCompletedState = currentMsgState === FrontendBubbleState.COMPLETED;
                
                // During streaming, do not overwrite content; handleBubbleStream updates incrementally
                // For pending_complete or completed, update content if changed
                // CRITICAL: Never overwrite non-empty bubble content with empty - prevents "清空全部气泡" from malformed record_update
                if (isStreaming) {
                  markBubbleContentUpdate(bubbleId);
                } else if (isPendingComplete) {
                  if (contentChanged) {
                    const newVal = content || '';
                    if (newVal.trim() || !currentContent.trim()) {
                      contentDiv.textContent = newVal;
                    }
                    markBubbleContentUpdate(bubbleId);
                  }
                } else if (content && isCompletedState) {
                  // Task and bubble are completed, only update if content actually changed
                  // CRITICAL: This prevents duplicate markdown rendering from repeated record_update events
                  if (contentChanged) {
                    if (contentDiv && contentDiv instanceof HTMLElement) {
                      await renderMarkdownWithTracking(bubbleId, content, contentDiv);
                    }
                    // Mark as receiving update only if content changed
                    markBubbleContentUpdate(bubbleId);
                  }
                  // CRITICAL: Always update DOM classes when completed to remove streaming state
                  assistantMsg.classList.remove('streaming');
                  assistantMsg.classList.add('completed');
                  // If content unchanged, skip completely (already checked above)
                } else if (content) {
                  // Fallback: if we have content but state is unclear, update if changed
                  if (contentChanged && contentDiv && contentDiv instanceof HTMLElement) {
                    await renderMarkdownWithTracking(bubbleId, content, contentDiv);
                    markBubbleContentUpdate(bubbleId);
                  }
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
                // Mark as tracked BEFORE creating to prevent race condition
                displayedbubbleIds.add(bubbleId);
                displayedbubbleIdsGlobal.add(bubbleId);
                
                // CRITICAL: Double-check DOM one more time (handleBubbleStream might have created it)
                const finalCheckInDOM = Array.from(chatMessages.children).find(
                  (el: any) => getbubbleId(el) === bubbleId && 
                              el.classList.contains('chat-message') && 
                              el.classList.contains('assistant')
                );
                if (finalCheckInDOM) {
                  // Message was created by handleBubbleStream, use it instead
                  console.log('[AgentChat] Message created by handleBubbleStream, using existing:', { bubbleId });
                  assistantMsg = finalCheckInDOM as HTMLElement;
                  updateLastMessage(content, toolCalls, isStreaming);
                } else {
                const contentToSet = isStreaming ? '' : (content || '');
                await addMessage('assistant', contentToSet, undefined, toolCalls, bubbleId);
                }
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
            
            // Check 1.2: If message exists in DOM (created by bubble_stream), skip creating new one
            // This prevents duplicate bubbles when both bubble_stream and record_update events arrive
            // Note: The update logic above (lines 1991-2070) should handle updating existing messages
            // This check is just to prevent duplicate creation
            const existingInDOMForCreation = Array.from(chatMessages.children).find(
              (el: any) => getbubbleId(el) === bubbleId && 
                          el.classList.contains('chat-message') && 
                          el.classList.contains('assistant')
            );
            if (existingInDOMForCreation) {
              // Message already exists (likely created by bubble_stream), just mark as displayed
              // The update logic above should have already handled content updates
              displayedbubbleIds.add(bubbleId);
              displayedbubbleIdsGlobal.add(bubbleId);
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
                          const currentVal = contentDiv.textContent?.trim() || '';
                          if (content.trim() || !currentVal) {
                            contentDiv.textContent = content;
                          }
                        }
                      } catch (e) {
                        const currentVal = contentDiv.textContent?.trim() || '';
                        if (content.trim() || !currentVal) {
                          contentDiv.textContent = content;
                        }
                      }
                    } else {
                      const currentVal = contentDiv.textContent?.trim() || '';
                      if (content.trim() || !currentVal) {
                        contentDiv.textContent = content;
                      }
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
                        if (!isStreaming && contentDiv && contentDiv instanceof HTMLElement) {
                          await renderMarkdownWithTracking(bubbleId, content, contentDiv);
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
                        if (!isStreaming) {
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
            
            // Check 3: If truly completed, don't create
            const finalStateCheck = getFrontendBubbleState(bubbleId);
            if (finalStateCheck === FrontendBubbleState.COMPLETED) {
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
            // For streaming, always create if not found (even if content is empty initially)
            if (isStreaming || content || (!toolCalls || toolCalls.length === 0)) {
              // Mark as tracked BEFORE creating to prevent race condition with handleBubbleStream
            displayedbubbleIds.add(bubbleId);
            displayedbubbleIdsGlobal.add(bubbleId);
            if (isStreaming) {
              activebubbleIds.add(bubbleId);
            }
              
              // CRITICAL: Double-check DOM one more time (handleBubbleStream might have created it just now)
              const finalCheckInDOM = Array.from(chatMessages.children).find(
                (el: any) => getbubbleId(el) === bubbleId && 
                            el.classList.contains('chat-message') && 
                            el.classList.contains('assistant')
              );
              if (finalCheckInDOM) {
                // Message was created by handleBubbleStream between checks, skip creation
                console.log('[AgentChat] Message created by handleBubbleStream between checks, skipping creation:', { bubbleId });
            continue;
          }
          
              const contentToSet = isStreaming ? '' : content;
              await addMessage('assistant', contentToSet, undefined, toolCalls, bubbleId);
            }
                continue;
              }
              
          // Tool messages are now handled in tool_call_result type above
          // Skip standalone tool messages to avoid duplicates
          if (msgData.role === 'tool') {
            continue;
          }
        }
        if (isStreaming && record.agentMessages && record.agentMessages.length > 0) {
          for (let i = 0; i < record.agentMessages.length - 1; i++) {
            const msg = record.agentMessages[i];
            if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) continue;
            const nextMsg = record.agentMessages[i + 1];
            if (nextMsg.role !== 'tool') continue;
            const baseBubbleId = msg.bubbleId || generatebubbleId();
            const toolBubbleId = baseBubbleId + '_tool';
            const hasToolContainer = Array.from(chatMessages.children).some(
              (el: any) => getbubbleId(el) === toolBubbleId && el.classList.contains('tool-call-container')
            );
            if (!hasToolContainer) {
              const toolCalls = msg.tool_calls;
              const toolResult = nextMsg;
              const toolCallId = toolCalls[0]?.id;
              displayedbubbleIdsGlobal.add(toolBubbleId);
              await addMessage('assistant', '', undefined, toolCalls, toolBubbleId);
              const toolCallItem = Array.from(chatMessages.querySelectorAll('.tool-call-item')).find(
                (el: any) => el.getAttribute('data-tool-call-id') === toolCallId
              ) as Element | null;
              if (toolCallItem && toolResult) {
                applyToolCallStatus(toolCallItem, toolResult.content, toolCallItem.querySelector('.tool-status-badge') as HTMLElement | null);
                const toolCallDetails = toolCallItem.querySelector('.tool-call-details') as HTMLElement;
                if (toolCallDetails) {
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
                    const toolContent = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2);
                    resultPre.textContent = toolContent;
                    applyToolCallStatus(toolCallItem, toolResult.content, toolCallItem.querySelector('.tool-status-badge') as HTMLElement | null);
                  }
                }
              }
              chatMessages.scrollTop = chatMessages.scrollHeight;
            }
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
              // Use tracking to prevent duplicate rendering
              if (rawContent && (rawContent.includes('**') || rawContent.includes('#') || rawContent.includes('`') || rawContent.includes('\n'))) {
                // Find bubbleId from the message element
                const messageEl = contentDiv.closest('.chat-message');
                const bubbleId = messageEl ? getbubbleIdFromElement(messageEl) : null;
                if (bubbleId && contentDiv && contentDiv instanceof HTMLElement) {
                  renderMarkdownWithTracking(bubbleId, rawContent, contentDiv).then(() => {
                  chatMessages.scrollTop = chatMessages.scrollHeight;
                });
                }
              }
            }
          }
        }
      }
    }
  };
  
  async function addMessage(role: string, content: string, toolName?: string, toolCalls?: any[], bubbleId?: string, isHistorical?: boolean) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    
    // Generate bubbleId if not provided
    if (!bubbleId) {
      bubbleId = generatebubbleId();
    }
    
    // Initialize bubble state (frontend state only, backend state will be updated via events)
    // CRITICAL: For historical messages loaded from backend, they should be marked as COMPLETED
    // Historical messages are those loaded from backend history, not new streaming messages
    const isHistoricalMessage = isHistorical === true || (isHistorical === undefined && content && content.trim());
    
    if (role === 'assistant' && bubbleId) {
      // For historical messages, mark as completed immediately
      // For new messages, start as PENDING (waiting for backend to start streaming)
      const initialState = isHistoricalMessage ? FrontendBubbleState.COMPLETED : FrontendBubbleState.PENDING;
      const reason = isHistoricalMessage ? 'historical_message_loaded' : 'frontend_bubble_created';
      
      updateFrontendState(bubbleId, initialState, reason, {
        role: role as 'assistant',
        content: content,
        toolCalls: toolCalls,
      });
      
      // If historical message, also mark backend as completed
      if (isHistoricalMessage) {
        updateBackendState(bubbleId, BackendBubbleState.COMPLETED, 'historical_message_loaded');
      }
      
      // Update message data
      const stateInfo = bubbleStates.get(bubbleId);
      if (stateInfo) {
        stateInfo.role = role as 'assistant';
        stateInfo.content = content;
        stateInfo.toolCalls = toolCalls;
      }
    } else if (role === 'user' && bubbleId) {
      // User messages are immediately completed (no backend streaming)
      updateFrontendState(bubbleId, FrontendBubbleState.COMPLETED, 'user_bubble_created', {
        role: 'user',
        content: content,
      });
      // Update message data
      const stateInfo = bubbleStates.get(bubbleId);
      if (stateInfo) {
        stateInfo.role = 'user';
        stateInfo.content = content;
      }
    } else if (role === 'tool' && bubbleId) {
      // Tool messages are immediately completed (no backend streaming)
      updateFrontendState(bubbleId, FrontendBubbleState.COMPLETED, 'tool_bubble_created', {
        role: 'tool',
        content: content,
        toolName: toolName,
      });
      // Update message data
      const stateInfo = bubbleStates.get(bubbleId);
      if (stateInfo) {
        stateInfo.role = 'tool';
        stateInfo.content = content;
        stateInfo.toolName = toolName;
      }
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
      
      // Create status display for assistant messages (before message bubble)
      if (role === 'assistant' && bubbleId) {
        const statusDiv = document.createElement('div');
        statusDiv.className = 'message-status message-status-streaming';
        const state = getFrontendBubbleState(bubbleId);
        statusDiv.textContent = getStateText(state);
        // Initially show status (will be hidden when completed)
        statusDiv.style.display = 'block';
        messageDiv.appendChild(statusDiv);
      }
      
      const messageBubble = document.createElement('div');
      messageBubble.className = 'message-bubble';
      
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
      
      // Render markdown for assistant messages, plain text for user messages
      // For assistant messages, always create content div (even if empty, for streaming)
      if (role === 'assistant') {
        if (content && bubbleId) {
          await renderMarkdownWithTracking(bubbleId, content, contentDiv);
        }
        // If no content, leave empty (will be filled during streaming)
      } else if (content) {
        contentDiv.textContent = content;
    }
    
      messageBubble.appendChild(contentDiv);
      messageDiv.appendChild(messageBubble);
    chatMessages.appendChild(messageDiv);
    
    // Update DOM reference in state
    if (bubbleId) {
      const stateInfo = bubbleStates.get(bubbleId);
      if (stateInfo) {
        stateInfo.domElement = messageDiv instanceof HTMLElement ? messageDiv : null;
      }
    }
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
    
    // Update message content (during streaming, do not overwrite; handleBubbleStream updates incrementally)
    if (content !== undefined && !isStreaming) {
      let contentDiv = messageBubble.querySelector('.message-content');
        if (!contentDiv) {
          contentDiv = document.createElement('div');
          contentDiv.className = 'message-content';
        messageBubble.appendChild(contentDiv);
        }
      const messageEl = contentDiv.closest('.chat-message');
        const bubbleId = messageEl ? getbubbleIdFromElement(messageEl) : null;
        if (bubbleId && contentDiv instanceof HTMLElement) {
          await renderMarkdownWithTracking(bubbleId, content, contentDiv);
        } else {
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

    // Generate bubbleId for user message
    const userbubbleId = generatebubbleId();
    displayedbubbleIdsGlobal.add(userbubbleId);
    await addMessage('user', message, undefined, undefined, userbubbleId);
    
    // Generate real bubbleId for assistant message (frontend generates, backend will use it)
    const assistantBubbleId = generatebubbleId();
    displayedbubbleIdsGlobal.add(assistantBubbleId);
    await addMessage('assistant', '', undefined, undefined, assistantBubbleId);
    
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
          assistantbubbleId: assistantBubbleId, // Send assistant bubbleId to backend (lowercase to match backend)
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
    // Group messages: merge tool calls with results, separate before/after messages
    const groupedMessages = groupMessages(recordHistory);
    
    // Render all messages sequentially to ensure proper order
    for (const processedMsg of groupedMessages) {
      if (processedMsg.type === 'user') {
        await addMessage('user', processedMsg.data.content, undefined, undefined, processedMsg.bubbleId);
      } else if (processedMsg.type === 'assistant_before' || processedMsg.type === 'assistant_after') {
        await addMessage('assistant', processedMsg.data.content, undefined, undefined, processedMsg.bubbleId);
      } else if (processedMsg.type === 'tool_call_result') {
        // Add tool call container
        await addMessage('assistant', '', undefined, processedMsg.data.tool_calls, processedMsg.bubbleId);
        
        // Add tool result if available
        if (processedMsg.toolResult && processedMsg.toolCallId) {
          const toolCallItem = Array.from(chatMessages.querySelectorAll('.tool-call-item')).find(
            (el: any) => el.getAttribute('data-tool-call-id') === processedMsg.toolCallId
          ) as Element | null;
          
          if (toolCallItem) {
            applyToolCallStatus(toolCallItem, processedMsg.toolResult.content, toolCallItem.querySelector('.tool-status-badge') as HTMLElement | null);
            const toolCallDetails = toolCallItem.querySelector('.tool-call-details') as HTMLElement;
            if (toolCallDetails) {
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
                const toolContent = typeof processedMsg.toolResult.content === 'string' ? processedMsg.toolResult.content : JSON.stringify(processedMsg.toolResult.content, null, 2);
                resultPre.textContent = toolContent;
                applyToolCallStatus(toolCallItem, processedMsg.toolResult.content, toolCallItem.querySelector('.tool-status-badge') as HTMLElement | null);
              }
            }
          }
        }
      }
    }
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Use shared connectToSession function (already defined in list mode)
  try {
  await connectToSession();
  } catch (error: any) {
    console.error('[AgentChat] Failed to connect to session during initialization:', error);
    // Don't block page loading if connection fails
  }

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
  } catch (error: any) {
    console.error('[AgentChat] Error in page initialization:', error);
    console.error('[AgentChat] Error stack:', error.stack);
    // Don't throw, let the page continue loading even if there's an error
  }
});

export default page;

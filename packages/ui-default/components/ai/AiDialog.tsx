import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { flushSync } from 'react-dom';
import $ from 'jquery';
import { api } from 'vj/utils';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface AiDialogProps {
  onClose: () => void;
}

export default function AiDialog({ onClose }: AiDialogProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingQueueRef = useRef<string>('');
  const typingTimerRef = useRef<number | null>(null);
  const isTypingRef = useRef<boolean>(false);

  const UiContext = (window as any).UiContext;
  const domainId = UiContext?.domainId;

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
    
    return () => {
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
    };
  }, []);

  // 打字机效果：逐字显示内容
  const processTypingQueue = (messageIndex: number) => {
    if (!isTypingRef.current || typingQueueRef.current.length === 0) {
      isTypingRef.current = false;
      return;
    }

    const char = typingQueueRef.current[0];
    typingQueueRef.current = typingQueueRef.current.slice(1);

    setMessages(prev => {
      const newMessages = [...prev];
      if (newMessages[messageIndex]) {
        newMessages[messageIndex] = {
          ...newMessages[messageIndex],
          content: newMessages[messageIndex].content + char,
        };
      }
      return newMessages;
    });

    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'instant' });
    }

    const delay = /[\u4e00-\u9fa5，。！？；：]/.test(char) ? 30 : 20;
    typingTimerRef.current = window.setTimeout(() => {
      processTypingQueue(messageIndex);
    }, delay);
  };

  const addToTypingQueue = (content: string, messageIndex: number) => {
    typingQueueRef.current += content;
    
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      processTypingQueue(messageIndex);
    }
  };

  const handleSend = async () => {
    if (!inputValue.trim() || isLoading) {
      return;
    }

    const userMessage: Message = {
      role: 'user',
      content: inputValue.trim(),
    };

    // 先添加用户消息和临时的assistant消息
    let assistantMessageIndex: number;
    setMessages(prev => {
      const newMessages = [...prev, userMessage];
      // 添加一个临时的assistant消息用于流式更新
      assistantMessageIndex = newMessages.length; // assistant消息的索引
      newMessages.push({ role: 'assistant', content: '' });
      return newMessages;
    });
    setInputValue('');
    setIsLoading(true);
    
    typingQueueRef.current = '';
    isTypingRef.current = false;
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }

    try {
      const history = messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      const response = await fetch(`/d/${domainId}/ai/chat?stream=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: userMessage.content,
          history,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: '请求失败' }));
        throw new Error(errorData.error || '请求失败');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedContent = '';

      if (!reader) {
        throw new Error('无法读取响应流');
      }

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        if (value) {
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded;
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          
          if (!line.startsWith('data: ')) {
            continue;
          }
          
          try {
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            
            const data = JSON.parse(jsonStr);
            
            if (data.type === 'content') {
              accumulatedContent += data.content;
              addToTypingQueue(data.content, assistantMessageIndex);
            } else if (data.type === 'done') {
              
              const checkAndFinalize = () => {
                if (typingQueueRef.current.length === 0) {
                  setMessages(prev => {
                    const newMessages = [...prev];
                    if (newMessages[assistantMessageIndex]) {
                      const finalContent = data.content || accumulatedContent;
                      const currentContent = newMessages[assistantMessageIndex].content;
                      if (currentContent !== finalContent) {
                        const missing = finalContent.slice(currentContent.length);
                        if (missing) {
                          newMessages[assistantMessageIndex] = {
                            role: 'assistant',
                            content: finalContent,
                          };
                        }
                      }
                    }
                    return newMessages;
                  });
                  
                  isTypingRef.current = false;
                  if (typingTimerRef.current) {
                    clearTimeout(typingTimerRef.current);
                    typingTimerRef.current = null;
                  }
                } else {
                  setTimeout(checkAndFinalize, 100);
                }
              };
              
              if (typingQueueRef.current.length === 0) {
                checkAndFinalize();
              } else {
                setTimeout(checkAndFinalize, 100);
              }
              
              break;
            } else if (data.type === 'error') {
              throw new Error(data.error || '请求失败');
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    } catch (error: any) {
      setMessages(prev => {
        const newMessages = [...prev];
        if (newMessages[assistantMessageIndex]) {
          newMessages[assistantMessageIndex] = {
            role: 'assistant',
            content: `错误: ${error.message || '未知错误'}`,
          };
        }
        return newMessages;
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return ReactDOM.createPortal(
    <div className="ai-dialog-overlay" onClick={onClose}>
      <div className="ai-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ai-dialog__header">
          <h3>AI助手</h3>
          <button className="ai-dialog__close" onClick={onClose}>
            <span className="icon icon-close"></span>
          </button>
        </div>
        <div className="ai-dialog__messages">
          {messages.length === 0 && (
            <div className="ai-dialog__empty">
              <p>你好！我是AI助手，有什么可以帮助你的吗？</p>
            </div>
          )}
          {messages.map((msg, index) => (
            <div key={index} className={`ai-dialog__message ai-dialog__message--${msg.role}`}>
              <div className="ai-dialog__message-content">
                {msg.content.split('\n').map((line, i) => (
                  <React.Fragment key={i}>
                    {line}
                    {i < msg.content.split('\n').length - 1 && <br />}
                  </React.Fragment>
                ))}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="ai-dialog__message ai-dialog__message--assistant">
              <div className="ai-dialog__message-content">
                <span className="ai-dialog__typing">正在思考...</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <div className="ai-dialog__input">
          <textarea
            ref={inputRef}
            className="ai-dialog__textarea"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="输入消息... (Shift+Enter换行，Enter发送)"
            rows={3}
            disabled={isLoading}
          />
          <button
            className="ai-dialog__send"
            onClick={handleSend}
            disabled={!inputValue.trim() || isLoading}
          >
            发送
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}


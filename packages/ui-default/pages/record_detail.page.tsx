import $ from 'jquery';
import React from 'react';
import { InfoDialog } from 'vj/components/dialog';
import { NamedPage } from 'vj/misc/Page';
import { tpl, withTransitionCallback } from 'vj/utils';

export default new NamedPage('record_detail,task_record_detail', async () => {
  $(document).on('click', '.compiler-text', () => {
    withTransitionCallback(() => {
      $('.collapsed').removeClass('collapsed');
    });
  });
  $(document).on('click', '.subtask-case', function () {
    const text = $(this).find('.message').text();
    const data = $(this).find('.message').html();
    if (!text?.trim() || (!text.includes('\n') && text.length < 20)) return;
    new InfoDialog({
      $body: tpl(<pre dangerouslySetInnerHTML={{ __html: data }} />),
    }).open();
  });
  
  // 初始化时更新所有行的时间
  const updateInitialTimes = () => {
    const $tbody = $('#agent-messages-tbody');
    if ($tbody.length) {
      const rows = $tbody.find('tr.subtask-case');
      rows.each((index, row) => {
        const $row = $(row);
        const timestampAttr = $row.attr('data-timestamp');
        if (!timestampAttr) return;
        
        let currentTime = 0;
        try {
          if (timestampAttr.includes('T') || timestampAttr.includes('-')) {
            // ISO 字符串格式
            currentTime = new Date(timestampAttr).getTime();
          } else {
            // 时间戳数字
            currentTime = parseInt(timestampAttr, 10);
          }
        } catch (e) {
          return;
        }
        
        if (isNaN(currentTime) || currentTime <= 0) return;
        
        // 查找上一条消息的时间戳
        let prevTime = 0;
        if (index > 0) {
          const $prevRow = rows.eq(index - 1);
          const prevTimestampAttr = $prevRow.attr('data-timestamp');
          if (prevTimestampAttr) {
            try {
              if (prevTimestampAttr.includes('T') || prevTimestampAttr.includes('-')) {
                prevTime = new Date(prevTimestampAttr).getTime();
              } else {
                prevTime = parseInt(prevTimestampAttr, 10);
              }
            } catch (e) {
              // ignore
            }
          }
        }
        
        const timeDiff = prevTime > 0 ? currentTime - prevTime : 0;
        const $timeSpan = $row.find('.time-cost');
        $timeSpan.text(timeDiff > 0 ? `${Math.round(timeDiff)}ms` : '-');
      });
    }
  };
  
  // 页面加载完成后更新初始时间
  updateInitialTimes();

  if (!UiContext.socketUrl) return;
  const [{ default: WebSocket }, { DiffDOM }] = await Promise.all([
    import('../components/socket'),
    import('diff-dom'),
  ]);

  const sock = new WebSocket(UiContext.ws_prefix + UiContext.socketUrl, false, true);
  const dd = new DiffDOM();
  sock.onmessage = (_, data) => {
    const msg = JSON.parse(data);
    
    // 检查是否是 agent task record 的消息格式
    if (msg.record) {
      // Agent task record 格式：实时更新聊天历史
      const record = msg.record;
      
      // 更新状态显示
      if (record.status !== undefined) {
        // 获取全局 STATUS 常量（从 window 或 model.builtin）
        const STATUS = (window as any).STATUS || (window as any).model?.builtin?.STATUS || {};
        const STATUS_TEXTS = (window as any).STATUS_TEXTS || (window as any).model?.builtin?.STATUS_TEXTS || {};
        const STATUS_CODES = (window as any).STATUS_CODES || (window as any).model?.builtin?.STATUS_CODES || {};
        
        // 更新页面顶部的状态横幅 (#status)
        const $statusSection = $('#status');
        if ($statusSection.length) {
          const statusText = STATUS_TEXTS[record.status] || `Status ${record.status}`;
          const statusCode = STATUS_CODES[record.status] || 'unknown';
          const score = record.score !== undefined ? record.score : null;
          
          // 更新 data-status 属性
          $statusSection.attr('data-status', record.status);
          
          // 更新状态横幅标题
          const $statusTitle = $statusSection.find('.section__title');
          if ($statusTitle.length) {
            // 更新图标
            const $icon = $statusTitle.find('.icon');
            if ($icon.length) {
              $icon.removeClass().addClass(`icon record-status--icon ${statusCode}`);
            } else {
              $statusTitle.prepend($('<span>').addClass(`icon record-status--icon ${statusCode}`));
            }
            
            // 更新分数
            if (score !== null && score !== undefined) {
              const $scoreSpan = $statusTitle.find('span[style*="color"]');
              if ($scoreSpan.length) {
                $scoreSpan.text(score);
                // 更新颜色
                const getScoreColor = (window as any).utils?.status?.getScoreColor || 
                                     (window as any).model?.utils?.status?.getScoreColor ||
                                     ((s: number) => s >= 100 ? '#4caf50' : s >= 60 ? '#ff9800' : '#f44336');
                $scoreSpan.css('color', getScoreColor(score));
              } else {
                const scoreColor = (window as any).utils?.status?.getScoreColor?.(score) || 
                                  (score >= 100 ? '#4caf50' : score >= 60 ? '#ff9800' : '#f44336');
                $statusTitle.append($('<span>').css('color', scoreColor).text(score));
              }
            }
            
            // 更新状态文本
            const $statusText = $statusTitle.find('.record-status--text');
            if ($statusText.length) {
              $statusText.removeClass().addClass(`record-status--text ${statusCode}`).text(statusText);
            } else {
              $statusTitle.append($('<span>').addClass(`record-status--text ${statusCode}`).text(statusText));
            }
          }
        }
        
        // 更新侧边栏的状态徽章
        const $statusBadge = $('.section__body .badge');
        if ($statusBadge.length) {
          const statusText = STATUS_TEXTS[record.status] || `Status ${record.status}`;
          const statusCode = STATUS_CODES[record.status] || 'unknown';
          
          // 根据状态代码设置样式类
          let badgeClass = 'badge';
          if (statusCode === 'pass' || statusCode === 'delivered') {
            badgeClass = 'badge--success';
          } else if (statusCode === 'progress' || statusCode === 'processing') {
            badgeClass = 'badge--info';
          } else if (statusCode === 'fail' || statusCode === 'error') {
            badgeClass = 'badge--error';
          } else if (statusCode === 'waiting' || statusCode === 'pending') {
            badgeClass = 'badge--warning';
          }
          
          $statusBadge.text(statusText).removeClass().addClass(badgeClass);
        }
      }

      // 更新聊天历史（实时流式更新，subtask 格式）
      if (record.agentMessages && Array.isArray(record.agentMessages)) {
        const $tbody = $('#agent-messages-tbody');
        if ($tbody.length) {
          const existingRows = $tbody.find('tr.subtask-case');
          const newMessagesCount = record.agentMessages.length;
          
          // 计算每条消息的耗时（相对于上一条消息）
          const calculateTimeDiff = (currentMsg: any, prevMsg: any): number => {
            if (!currentMsg?.timestamp || !prevMsg?.timestamp) return 0;
            const currentTime = new Date(currentMsg.timestamp).getTime();
            const prevTime = new Date(prevMsg.timestamp).getTime();
            return Math.max(0, currentTime - prevTime);
          };
          
          // 渲染单条消息为表格行
          const renderMessageRow = (msg: any, index: number, prevMsg: any) => {
            const msgIndex = index + 1;
            const timeDiff = calculateTimeDiff(msg, prevMsg);
            
            // 获取时间戳（支持 Date 对象或时间戳字符串/数字）
            let timestamp = '';
            if (msg.timestamp) {
              if (msg.timestamp instanceof Date) {
                timestamp = msg.timestamp.getTime().toString();
              } else if (typeof msg.timestamp === 'string' || typeof msg.timestamp === 'number') {
                timestamp = new Date(msg.timestamp).getTime().toString();
              }
            }
            
            const $row = $('<tr>').addClass('subtask-case')
              .attr('data-msg-index', index)
              .attr('data-role', msg.role)
              .attr('data-timestamp', timestamp);
            
            // 编号列
            const $caseTd = $('<td>').addClass('col--case record-status--border')
              .text(`#${msgIndex}`);
            $row.append($caseTd);
            
            // 状态和内容列
            const $statusTd = $('<td>').addClass('col--status');
            
            let statusIcon = 'progress';
            let statusText = '';
            if (msg.role === 'user') {
              statusIcon = 'pass';
              statusText = 'User';
            } else if (msg.role === 'assistant') {
              statusIcon = 'progress';
              statusText = 'Assistant';
            } else if (msg.role === 'tool') {
              statusIcon = 'progress';
              statusText = `Tool: ${msg.toolName || 'Unknown'}`;
            }
            
            $statusTd.append($('<span>').addClass(`icon record-status--icon ${statusIcon}`));
            $statusTd.append($('<span>').addClass(`record-status--text ${statusIcon}`).text(statusText));

            // 消息内容
            const $messageSpan = $('<span>').addClass('message')
              .css({
                display: 'block',
                marginTop: '5px',
              whiteSpace: 'pre-wrap',
              wordWrap: 'break-word',
            });
            
            if (msg.role === 'tool') {
              const content = typeof msg.content === 'string' 
                ? msg.content 
                : JSON.stringify(msg.content, null, 2);
              $messageSpan.append($('<pre>').css({
                background: '#fff',
                padding: '8px',
                borderRadius: '3px',
                overflowX: 'auto',
                margin: '0',
              }).append($('<code>').text(content)));
            } else if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
              const $toolCallDiv = $('<div>').css({
                background: '#fff',
                padding: '8px',
                borderRadius: '3px',
                margin: '0',
              }).html('<strong>Tool Call:</strong>');
              
              msg.tool_calls.forEach((toolCall: any) => {
                const $callDiv = $('<div>').css('marginTop', '5px');
                $callDiv.append($('<code>').text(toolCall.function?.name || 'unknown'));
                $callDiv.append($('<pre>').css({
                  marginTop: '5px',
                  background: '#f5f5f5',
                  padding: '5px',
                  borderRadius: '3px',
                  margin: '0',
                }).text(toolCall.function?.arguments || ''));
                $toolCallDiv.append($callDiv);
              });
              
              $messageSpan.append($toolCallDiv);
              
              if (msg.content) {
                $messageSpan.append($('<div>').css('marginTop', '8px').text(msg.content));
              }
            } else if (msg.content) {
              // 使用 markdown 渲染（如果需要）
              $messageSpan.text(msg.content);
            }
            
            $statusTd.append($messageSpan);
            $row.append($statusTd);
            
            // 耗时列
            const $timeTd = $('<td>').addClass('col--time');
            const $timeSpan = $('<span>').addClass('time-cost')
              .text(timeDiff > 0 ? `${Math.round(timeDiff)}ms` : '-');
            $timeTd.append($timeSpan);
            $row.append($timeTd);
            
            return $row;
          };
          
          // 更新所有行的时间（包括初始加载时）
          const updateAllTimes = () => {
            const rows = $tbody.find('tr.subtask-case');
            rows.each((index, row) => {
              const $row = $(row);
              const currentTimestamp = $row.attr('data-timestamp');
              if (!currentTimestamp) return;
              
              const currentTime = parseInt(currentTimestamp, 10);
              if (isNaN(currentTime)) return;
              
              // 查找上一条消息的时间戳
              let prevTime = 0;
              if (index > 0) {
                const $prevRow = rows.eq(index - 1);
                const prevTimestamp = $prevRow.attr('data-timestamp');
                if (prevTimestamp) {
                  prevTime = parseInt(prevTimestamp, 10);
                }
              }
              
              const timeDiff = prevTime > 0 ? currentTime - prevTime : 0;
              const $timeSpan = $row.find('.time-cost');
              $timeSpan.text(timeDiff > 0 ? `${Math.round(timeDiff)}ms` : '-');
            });
          };
          
          // 如果新消息数量大于现有消息，需要添加新行或更新现有行
          if (newMessagesCount > existingRows.length) {
            // 添加新消息行
            for (let i = existingRows.length; i < newMessagesCount; i++) {
              const msg = record.agentMessages[i];
              const prevMsg = i > 0 ? record.agentMessages[i - 1] : null;
              const $row = renderMessageRow(msg, i, prevMsg);
              $tbody.append($row);
            }
            // 更新所有行的时间（因为新行可能影响后续行的时间计算）
            updateAllTimes();
          }
          
          // 更新最后一条消息（流式更新）
          if (newMessagesCount > 0 && newMessagesCount === existingRows.length) {
            const lastIndex = newMessagesCount - 1;
            const lastMsg = record.agentMessages[lastIndex];
            const $lastRow = existingRows.eq(lastIndex);
            
            if (lastMsg && $lastRow.length && lastMsg.role !== 'user') {
              // 只更新非用户消息（用户消息不会流式更新）
              const prevMsg = lastIndex > 0 ? record.agentMessages[lastIndex - 1] : null;
              const timeDiff = calculateTimeDiff(lastMsg, prevMsg);
              
              // 更新时间戳属性
              let timestamp = '';
              if (lastMsg.timestamp) {
                if (lastMsg.timestamp instanceof Date) {
                  timestamp = lastMsg.timestamp.getTime().toString();
                } else if (typeof lastMsg.timestamp === 'string' || typeof lastMsg.timestamp === 'number') {
                  timestamp = new Date(lastMsg.timestamp).getTime().toString();
            }
              }
              if (timestamp) {
                $lastRow.attr('data-timestamp', timestamp);
              }
              
              // 更新状态列的内容
              const $statusTd = $lastRow.find('.col--status');
              const $messageSpan = $statusTd.find('.message');
              
              if ($messageSpan.length) {
                if (lastMsg.role === 'tool') {
                  const content = typeof lastMsg.content === 'string' 
                    ? lastMsg.content 
                    : JSON.stringify(lastMsg.content, null, 2);
                  $messageSpan.html($('<pre>').css({
                    background: '#fff',
                    padding: '8px',
                    borderRadius: '3px',
                    overflowX: 'auto',
                    margin: '0',
                  }).append($('<code>').text(content)).prop('outerHTML'));
                } else if (lastMsg.tool_calls && Array.isArray(lastMsg.tool_calls)) {
                  const $toolCallDiv = $('<div>').css({
                    background: '#fff',
                    padding: '8px',
                    borderRadius: '3px',
                    margin: '0',
                  }).html('<strong>Tool Call:</strong>');
                  
                  lastMsg.tool_calls.forEach((toolCall: any) => {
                    const $callDiv = $('<div>').css('marginTop', '5px');
                    $callDiv.append($('<code>').text(toolCall.function?.name || 'unknown'));
                    $callDiv.append($('<pre>').css({
                      marginTop: '5px',
                      background: '#f5f5f5',
                      padding: '5px',
                      borderRadius: '3px',
                      margin: '0',
                    }).text(toolCall.function?.arguments || ''));
                    $toolCallDiv.append($callDiv);
          });
          
                  let html = $toolCallDiv.prop('outerHTML');
                  if (lastMsg.content) {
                    html += `<div style="margin-top: 8px;">${lastMsg.content}</div>`;
                  }
                  $messageSpan.html(html);
                } else if (lastMsg.content) {
                  $messageSpan.text(lastMsg.content);
                }
              }
              
              // 更新时间
              const $timeSpan = $lastRow.find('.time-cost');
              $timeSpan.text(timeDiff > 0 ? `${Math.round(timeDiff)}ms` : '-');
            }
          } else if (newMessagesCount > existingRows.length || existingRows.length === 0) {
            // 完全重新渲染（初始加载或消息数量变化）
            $tbody.empty();
            record.agentMessages.forEach((msg: any, index: number) => {
              const prevMsg = index > 0 ? record.agentMessages[index - 1] : null;
              const $row = renderMessageRow(msg, index, prevMsg);
              $tbody.append($row);
            });
            updateAllTimes();
          }
        }
      }

      // 更新进度条
      if (record.progress !== undefined) {
        const $progressBar = $('.progress-bar__fill');
        const $progressText = $('.progress-bar__text');
        if ($progressBar.length) {
          $progressBar.css('width', `${record.progress}%`);
        }
        if ($progressText.length) {
          $progressText.text(`${record.progress}%`);
        }
      }

      // 更新工具调用计数
      if (record.agentToolCallCount !== undefined) {
        const $toolCallsDd = $('.section__body dt').filter((_, el) => $(el).text().trim() === 'Tool Calls').next('dd');
        if ($toolCallsDd.length) {
          let text = record.agentToolCallCount.toString();
          if (record.agentTotalToolCalls) {
            text += ` / ${record.agentTotalToolCalls}`;
          }
          $toolCallsDd.text(text);
        }
      }
      
      return; // Agent task record 处理完成，不继续处理普通记录的逻辑
    }
    
    // 普通 record 格式：更新 status_html 和 summary_html
    if (typeof msg.status === 'number' && window.parent) window.parent.postMessage({ status: msg.status });
    withTransitionCallback(() => {
      if (msg.status_html) {
      const newStatus = $(msg.status_html);
      const oldStatus = $('#status');
        if (oldStatus.length && newStatus.length) {
      oldStatus.trigger('vjContentRemove');
      dd.apply(oldStatus[0], dd.diff(oldStatus[0], newStatus[0]));
      $('#status').trigger('vjContentNew');
        }
      }
      if (msg.summary_html) {
      const newSummary = $(msg.summary_html);
      const oldSummary = $('#summary');
        if (oldSummary.length && newSummary.length) {
      oldSummary.trigger('vjContentRemove');
      dd.apply(oldSummary[0], dd.diff(oldSummary[0], newSummary[0]));
      $('#summary').trigger('vjContentNew');
        }
      }
    });
  };
});
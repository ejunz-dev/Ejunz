import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { request } from 'vj/utils';
import DomDialog from 'vj/components/dialog/DomDialog';

const page = new NamedPage('edge_main', async () => {
  let globalSock: any = null;
  let pingInterval: NodeJS.Timeout | null = null;

  const cleanupOldConnection = () => {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    if (globalSock) {
      try {
        if (globalSock.sock) {
          globalSock.sock.onopen = null;
          globalSock.sock.onclose = null;
          globalSock.sock.onmessage = null;
          globalSock.sock.onerror = null;
          globalSock.sock.close();
          globalSock.sock = null;
        }
        globalSock.close();
      } catch (e) {
        // ignore
      }
      globalSock = null;
    }
  };
  
  cleanupOldConnection();
  
  if (UiContext.socketUrl) {
    const [{ default: WebSocket }, { DiffDOM }] = await Promise.all([
      import('../components/socket'),
      import('diff-dom'),
    ]);

    const wsUrl = UiContext.ws_prefix + UiContext.socketUrl;
    const sock = new WebSocket(wsUrl, false, true);
    globalSock = sock;
    const dd = new DiffDOM();

    sock.onopen = () => {
      // 连接成功后发送ping保持连接
      if (pingInterval) {
        clearInterval(pingInterval);
      }
      pingInterval = setInterval(() => {
        if (globalSock && globalSock.sock) {
          try {
            globalSock.sock.send(JSON.stringify({ type: 'ping' }));
          } catch (e) {
            // ignore
          }
        }
      }, 30000); // 每30秒发送一次ping
    };
    
    sock.onclose = () => {
      if (globalSock === sock) {
        globalSock = null;
      }
    };
    
    sock.onmessage = (_, data) => {
      try {
        const msg = JSON.parse(data);
        
        // 参考 record 的实现，使用 HTML 更新
        if (msg.html) {
          const $newTr = $(msg.html);
          if (!$newTr.length) return;
          const edgeId = $newTr.attr('data-edge-id');
          if (!edgeId) return;
          
          const $oldTr = $(`.edge_main__table tr[data-edge-id="${edgeId}"]`);
          if ($oldTr.length) {
            // 更新现有行
            $oldTr.trigger('vjContentRemove');
            dd.apply($oldTr[0], dd.diff($oldTr[0], $newTr[0]));
            $oldTr.trigger('vjContentNew');
          } else {
            // 添加新行
            $('.edge_main__table tbody').prepend($newTr);
            $newTr.trigger('vjContentNew');
          }
        } else if (msg.type === 'pong') {
          // ping响应
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };
    
    const cleanup = () => {
      if (globalSock === sock) {
        try {
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          if (globalSock.sock) {
            globalSock.sock.onopen = null;
            globalSock.sock.onclose = null;
            globalSock.sock.onmessage = null;
            globalSock.sock.onerror = null;
            globalSock.sock.close();
            globalSock.sock = null;
          }
          globalSock.close();
        } catch (e) {
          // ignore
        }
        globalSock = null;
      }
    };
    
    $(window).on('beforeunload', cleanup);
    $(window).on('pagehide', cleanup);
  }

  // 生成token按钮 - 打开 dialog
  $('#generate-token-btn').on('click', () => {
        const tokenDialog = DomDialog.getOrConstruct($('#token-dialog'), {
          cancelByClickingBack: true,
          cancelByEsc: true,
        }) as any;
        
    // 重置 dialog 状态
    $('#token-display').val('');
    $('#ws-endpoint-display').val('');
    $('#mqtt-tcp-url-display').val('');
    $('#mqtt-ws-url-display').val('');
    $('#mqtt-auth-display').val('');
    $('#edge-type-select').val('provider');
    
    // 隐藏所有信息容器
    $('#ws-endpoint-container').hide();
    $('#mqtt-info-container').hide();
    $('#mqtt-ws-container').hide();
    $('#mqtt-auth-container').hide();
    $('#copy-mqtt-btn-container').hide();
    $('#node-link-container').hide();
    
    tokenDialog.show();
  });

  // Dialog 内的确认生成按钮
  $('#generate-token-confirm-btn').on('click', async () => {
    try {
      const edgeType = $('#edge-type-select').val() as string || 'provider';
      const response = await request.post('/edge/generate-token', { type: edgeType });
      if (response.success && response.token) {
        $('#token-display').val(response.token);
        
        // 根据类型显示不同的信息
        if (response.type === 'node' && response.mqtt) {
          // Node 类型：显示 MQTT 信息
          $('#ws-endpoint-container').show();
          $('#ws-endpoint-display').val(response.wsEndpoint || '');
          
          $('#mqtt-info-container').show();
          $('#mqtt-tcp-url-display').val(response.mqtt.tcpUrl || '');
          
          $('#mqtt-ws-container').show();
          $('#mqtt-ws-url-display').val(response.mqtt.wsUrl || '');
          
          $('#mqtt-auth-container').show();
          $('#mqtt-auth-display').val(`${response.mqtt.username} / ${response.mqtt.password}`);
          
          $('#copy-mqtt-btn-container').show();
          
          // Node 类型：显示提示信息（node 将在连接时创建）
          if (response.note) {
            $('#node-link-container').show();
            $('#node-link').text(response.note).attr('href', '#').css('cursor', 'default').off('click').on('click', (e) => {
              e.preventDefault();
            });
          } else {
            $('#node-link-container').hide();
          }
        } else if (response.type === 'client') {
          // Client 类型：只显示 WebSocket
          $('#ws-endpoint-container').show();
          $('#ws-endpoint-display').val(response.wsEndpoint || '');
          
          $('#mqtt-info-container').hide();
          $('#mqtt-ws-container').hide();
          $('#mqtt-auth-container').hide();
          $('#copy-mqtt-btn-container').hide();
          
          // Client 类型：显示提示信息（client 将在连接时创建）
          if (response.note) {
            $('#node-link-container').show();
            $('#node-link').text(response.note).attr('href', '#').css('cursor', 'default').off('click').on('click', (e) => {
              e.preventDefault();
            });
          } else {
            $('#node-link-container').hide();
          }
        } else {
          // Provider 类型：只显示 WebSocket
          $('#ws-endpoint-container').show();
          $('#ws-endpoint-display').val(response.wsEndpoint || '');
          
          $('#mqtt-info-container').hide();
          $('#mqtt-ws-container').hide();
          $('#mqtt-auth-container').hide();
          $('#copy-mqtt-btn-container').hide();
          $('#node-link-container').hide();
        }
        
        Notification.success('接入点已生成');
      }
    } catch (error: any) {
      Notification.error('生成接入点失败: ' + (error.message || '未知错误'));
    }
  });

  // 复制token按钮
  $('#copy-token-btn').on('click', () => {
    const token = $('#token-display').val() as string;
    if (token) {
      navigator.clipboard.writeText(token).then(() => {
        Notification.success('Token 已复制到剪贴板');
      }).catch(() => {
        // 降级方案
        const textarea = document.createElement('textarea');
        textarea.value = token;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        Notification.success('Token 已复制到剪贴板');
      });
    }
  });

  // 复制接入点URL按钮
  $('#copy-endpoint-btn').on('click', () => {
    const endpoint = $('#ws-endpoint-display').val() as string;
    if (endpoint) {
      navigator.clipboard.writeText(endpoint).then(() => {
        Notification.success('接入点 URL 已复制到剪贴板');
      }).catch(() => {
        // 降级方案
        const textarea = document.createElement('textarea');
        textarea.value = endpoint;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        Notification.success('接入点 URL 已复制到剪贴板');
      });
    }
  });

  // 复制 MQTT 配置按钮
  $('#copy-mqtt-btn').on('click', () => {
    const tcpUrl = $('#mqtt-tcp-url-display').val() as string;
    const wsUrl = $('#mqtt-ws-url-display').val() as string;
    const auth = $('#mqtt-auth-display').val() as string;
    
    const mqttConfig = `MQTT TCP: ${tcpUrl}
MQTT WebSocket: ${wsUrl}
用户名/密码: ${auth}`;
    
    navigator.clipboard.writeText(mqttConfig).then(() => {
      Notification.success('MQTT 配置已复制到剪贴板');
    }).catch(() => {
      // 降级方案
      const textarea = document.createElement('textarea');
      textarea.value = mqttConfig;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      Notification.success('MQTT 配置已复制到剪贴板');
    });
  });

  // 关闭dialog
  $('[name="token-dialog__close"]').on('click', () => {
    const tokenDialog = DomDialog.getOrConstruct($('#token-dialog'), {
      cancelByClickingBack: true,
      cancelByEsc: true,
    }) as any;
    tokenDialog.hide();
  });

});

export default page;


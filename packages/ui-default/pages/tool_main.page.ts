import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';

const page = new NamedPage('tool_main', async () => {
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
    const [{ default: WebSocket }] = await Promise.all([
      import('../components/socket'),
    ]);

    const wsUrl = UiContext.ws_prefix + UiContext.socketUrl;
    const sock = new WebSocket(wsUrl, false, true);
    globalSock = sock;

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
        
        if (msg.type === 'init') {
          // 初始化数据
          if (msg.tools && Array.isArray(msg.tools)) {
            updateToolsTable(msg.tools);
          }
        } else if (msg.type === 'tools/update') {
          // 更新某个edge的工具
          updateServerTools(msg.token, msg.tools);
        } else if (msg.type === 'server/status') {
          // 更新edge状态
          updateServerStatus(msg.token, msg.tools);
        } else if (msg.type === 'refresh') {
          // 刷新所有工具
          if (msg.tools && Array.isArray(msg.tools)) {
            updateToolsTable(msg.tools);
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

  // 更新工具状态
  function updateToolStatus(toolId: number, edgeToken: string, tool: any) {
    const $row = $(`.tool_main__table tr[data-tool-id="${toolId}"][data-edge-token="${edgeToken}"]`);
    if ($row.length) {
      // 更新状态
      const $statusCell = $row.find('.col--status .tool-status');
      $statusCell.removeClass('tool-status-working tool-status-online tool-status-offline');
      $statusCell.addClass(`tool-status-${tool.edgeStatus}`);
      
      let statusText = '';
      if (tool.edgeStatus === 'working') {
        statusText = '工作中';
      } else if (tool.edgeStatus === 'online') {
        statusText = '在线';
      } else {
        statusText = '离线';
      }
      $statusCell.text(statusText);
    }
  }

  // 更新edge工具
  function updateServerTools(token: string, tools: any[]) {
    // 移除该edge的旧工具
    $(`.tool_main__table tr[data-edge-token="${token}"]`).remove();
    
    // 添加新工具
    const $tbody = $('.tool_main__table tbody');
    tools.forEach(tool => {
      addToolToTable(tool);
    });
  }

  // 更新edge状态
  function updateServerStatus(token: string, tools: any[]) {
    tools.forEach(tool => {
      updateToolStatus(tool.toolId, token, tool);
    });
  }

  // 添加工具到表格
  function addToolToTable(tool: any) {
    const $tbody = $('.tool_main__table tbody');
    if ($tbody.length === 0) {
      // 如果没有表格，需要重新加载页面
      location.reload();
      return;
    }
    
    // 检查是否已存在
    const $existing = $(`.tool_main__table tr[data-tool-id="${tool.toolId}"][data-edge-token="${tool.edgeToken}"]`);
    if ($existing.length > 0) {
      updateToolStatus(tool.toolId, tool.edgeToken, tool);
      return;
    }
    
    // 创建新行
    let statusText = '';
    if (tool.edgeStatus === 'working') {
      statusText = '工作中';
    } else if (tool.edgeStatus === 'online') {
      statusText = '在线';
    } else {
      statusText = '离线';
    }
    const domainId = UiContext.domain._id;
    const edgeUrl = `/d/${domainId}/edge/list`;
    
    const $newRow = $(`
      <tr data-tool-id="${tool.toolId}" data-edge-token="${tool.edgeToken}">
        <td class="col--server"><a href="${edgeUrl}">${tool.edgeName}</a></td>
        <td class="col--name"><code>${tool.name}</code></td>
        <td class="col--description">${tool.description || ''}</td>
        <td class="col--status"><span class="tool-status tool-status-${tool.edgeStatus}">${statusText}</span></td>
      </tr>
    `);
    
    $tbody.append($newRow);
    $newRow.trigger('vjContentNew');
  }

  // 更新整个表格
  function updateToolsTable(tools: any[]) {
    const $tbody = $('.tool_main__table tbody');
    if ($tbody.length === 0) {
      // 如果没有表格，需要重新加载页面
      location.reload();
      return;
    }
    
    // 清空现有行
    $tbody.empty();
    
    // 添加所有工具
    tools.forEach(tool => {
      addToolToTable(tool);
    });
  }
});

export default page;


import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

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
      }, 30000);
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
          if (msg.tools && Array.isArray(msg.tools)) {
            const $rows = $('.tool_main__table tbody tr');
            if ($rows.length === 0) {
              updateToolsTable(msg.tools);
            }
          }
        } else if (msg.type === 'tools/update') {
          updateServerTools(msg.token, msg.tools);
        } else if (msg.type === 'server/status') {
          updateServerStatus(msg.token, msg.tools);
        } else if (msg.type === 'refresh') {
          if (msg.tools && Array.isArray(msg.tools)) {
            updateToolsTable(msg.tools);
          }
        } else if (msg.type === 'pong') {
          // no-op
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

  function updateToolStatus(tid: number, edgeToken: string, tool: any) {
    const $row = $(`.tool_main__table tr[data-tool-id="${tid}"][data-edge-token="${edgeToken}"]`);
    if ($row.length) {
      const $statusCell = $row.find('.col--status .tool-status');
      $statusCell.removeClass('tool-status-working tool-status-online tool-status-offline');
      $statusCell.addClass(`tool-status-${tool.edgeStatus}`);
      let statusText = '';
      if (tool.edgeStatus === 'working') {
        statusText = i18n('Working');
      } else if (tool.edgeStatus === 'online') {
        statusText = i18n('Online');
      } else {
        statusText = i18n('Offline');
      }
      $statusCell.text(statusText);
    }
  }

  function updateServerTools(token: string, tools: any[]) {
    $(`.tool_main__table tr[data-edge-token="${token}"]`).remove();
    tools.forEach(tool => {
      addToolToTable(tool);
    });
  }

  function updateServerStatus(token: string, tools: any[]) {
    tools.forEach(tool => {
      updateToolStatus(tool.tid, token, tool);
    });
  }

  function addToolToTable(tool: any) {
    let $tbody = $('.tool_main__table tbody');
    if ($tbody.length === 0) {
      const $sectionBody = $('.section__body');
      if ($sectionBody.length === 0) {
        location.reload();
        return;
      }
      $sectionBody.find('.typo').remove();
      const $table = $(`
        <table class="data-table tool_main__table">
          <colgroup>
            <col class="col--status">
            <col class="col--server">
            <col class="col--name">
            <col class="col--description">
          </colgroup>
          <thead>
            <tr>
              <th class="col--status">${i18n('Status')}</th>
              <th class="col--server">${i18n('Server')}</th>
              <th class="col--name">${i18n('Tool Name')}</th>
              <th class="col--description">${i18n('Description')}</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      `);
      $sectionBody.append($table);
      $tbody = $table.find('tbody');
    }
    const toolId = tool.tid ?? tool.toolKey;
    const $existing = $(`.tool_main__table tr[data-tool-id="${toolId}"][data-edge-token="${tool.edgeToken}"]`);
    if ($existing.length > 0) {
      if (tool.tid != null) updateToolStatus(tool.tid, tool.edgeToken, tool);
      return;
    }
    let statusText = '';
    if (tool.edgeStatus === 'working') {
      statusText = i18n('Working');
    } else if (tool.edgeStatus === 'online') {
      statusText = i18n('Online');
    } else {
      statusText = i18n('Offline');
    }
    const domainId = UiContext.domain._id;
    const edgeUrl = `/d/${domainId}/edge/${tool.eid}`;
    const toolUrl = tool.toolKey
      ? `/d/${domainId}/tool/system/${tool.toolKey}`
      : `/d/${domainId}/tool/${tool.tid}`;
    const serverLabel = tool.edgeName || String(tool.eid);
    const isSystem = tool.edgeName === 'system';
    const serverCell = isSystem
      ? `<code>${serverLabel}</code>`
      : `<a href="${edgeUrl}"><code>${serverLabel}</code></a>`;
    const rowClass = isSystem ? 'tool_main__row--market' : '';
    const $newRow = $(`
      <tr data-tool-id="${toolId}" data-edge-token="${tool.edgeToken}"${rowClass ? ` class="${rowClass}"` : ''}>
        <td class="col--status"><span class="tool-status tool-status-${tool.edgeStatus}">${statusText}</span></td>
        <td class="col--server">${serverCell}</td>
        <td class="col--name"><a href="${toolUrl}"><code>${tool.name}</code></a></td>
        <td class="col--description">${tool.description || ''}</td>
      </tr>
    `);
    
    $tbody.append($newRow);
    $newRow.trigger('vjContentNew');
  }

  function updateToolsTable(tools: any[]) {
    let $tbody = $('.tool_main__table tbody');
    if ($tbody.length === 0) {
      const $sectionBody = $('.section__body');
      if ($sectionBody.length === 0) {
        location.reload();
        return;
      }
      $sectionBody.find('.typo').remove();
      const $table = $(`
        <table class="data-table tool_main__table">
          <colgroup>
            <col class="col--status">
            <col class="col--server">
            <col class="col--name">
            <col class="col--description">
          </colgroup>
          <thead>
            <tr>
              <th class="col--status">${i18n('Status')}</th>
              <th class="col--server">${i18n('Server')}</th>
              <th class="col--name">${i18n('Tool Name')}</th>
              <th class="col--description">${i18n('Description')}</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      `);
      $sectionBody.append($table);
      $tbody = $table.find('tbody');
    }
    $tbody.empty();
    tools.forEach(tool => {
      addToolToTable(tool);
    });
  }
});

export default page;


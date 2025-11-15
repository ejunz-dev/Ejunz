import $ from 'jquery';
import Notification from 'vj/components/notification';
import DomDialog from 'vj/components/dialog/DomDialog';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

let globalSock: any = null;

const page = new NamedPage('edge_main', async () => {
  const cleanupOldConnection = () => {
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
        if (globalSock.interval) {
          clearInterval(globalSock.interval);
          globalSock.interval = null;
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
      // 连接建立后，后端会自动发送初始状态
    };
    
    sock.onclose = () => {
      if (globalSock === sock) {
        globalSock = null;
      }
    };
    
    sock.onmessage = (_, data) => {
      try {
        const msg = JSON.parse(data);
        if (!msg.html) return;
        const $newTr = $(msg.html);
        if (!$newTr.length) return;
        const itemType = $newTr.attr('data-type');
        const itemId = $newTr.attr('data-id');
        const $oldTr = $(`.record_main__table tr[data-type="${itemType}"][data-id="${itemId}"]`);
        if ($oldTr.length) {
          $oldTr.trigger('vjContentRemove');
          dd.apply($oldTr[0], dd.diff($oldTr[0], $newTr[0]));
          $oldTr.trigger('vjContentNew');
        } else {
          // 新项目，添加到表格顶部
          $('.record_main__table tbody').prepend($newTr);
          $newTr.trigger('vjContentNew');
        }
      } catch (e) {
        // ignore
      }
    };
    
    const cleanup = () => {
      if (globalSock === sock) {
        try {
          if (globalSock.sock) {
            globalSock.sock.onopen = null;
            globalSock.sock.onclose = null;
            globalSock.sock.onmessage = null;
            globalSock.sock.onerror = null;
            globalSock.sock.close();
            globalSock.sock = null;
          }
          if (globalSock.interval) {
            clearInterval(globalSock.interval);
            globalSock.interval = null;
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

  // Token 生成弹窗
  const tokenDialog = DomDialog.getOrConstruct($('.dialog--edge-token'), {
    cancelByClickingBack: true,
    cancelByEsc: true,
  }) as any;

  $('[name="edge-generate-token-btn"]').on('click', () => {
    tokenDialog.show();
  });

  $('[name="dialog--edge-token__close"]').on('click', () => {
    tokenDialog.hide();
  });

  $('#edge-token-form').on('submit', async (ev) => {
    ev.preventDefault();
    const type = $('[name="type"]').val() as string;
    if (!type) {
      Notification.error(i18n('Please select access point type'));
      return;
    }

    try {
      const response = await $.ajax({
        url: `/d/${UiContext.domainId}/edge/generate-token`,
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ type }),
      });

      if (response.token) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        let wsPath = '';
        let endpoint = '';
        
        if (type === 'provider') {
          wsPath = `/d/${UiContext.domainId}/mcp/ws`;
          endpoint = `${protocol}//${host}${wsPath}?token=${response.token}`;
        } else if (type === 'node') {
          wsPath = `/d/${UiContext.domainId}/node/ws`;
          endpoint = `${protocol}//${host}${wsPath}?token=${response.token}`;
        } else if (type === 'client') {
          wsPath = `/d/${UiContext.domainId}/client/ws`;
          endpoint = `${protocol}//${host}${wsPath}?token=${response.token}`;
        }

        // 显示 token 信息
        const tokenInfo = `
          <div class="edge-token-result" style="margin-top: 20px; padding: 15px; background: #f5f5f5; border-radius: 4px;">
            <p><strong>${i18n('Token')}:</strong> <code style="word-break: break-all;">${response.token}</code></p>
            ${endpoint ? `<p><strong>${i18n('WebSocket URL')}:</strong></p>
            <div style="margin: 10px 0;">
              <code style="word-break: break-all; display: block; padding: 10px; background: #fff; border: 1px solid #ddd; border-radius: 4px;">${endpoint}</code>
              <button class="button small edge-copy-token-btn" style="margin-top: 10px;" data-token="${response.token}" data-endpoint="${endpoint}">${i18n('Copy')}</button>
            </div>` : ''}
            <p style="margin-top: 10px; color: #666; font-size: 0.9em;">${i18n('Token will be deleted if not used within 30 minutes')}</p>
          </div>
        `;
        
        $('.dialog--edge-token__main').append(tokenInfo);
        Notification.success(i18n('Token generated successfully'));
        
        // 复制功能
        $('.edge-copy-token-btn').on('click', function() {
          const text = $(this).attr('data-endpoint') || $(this).attr('data-token') || '';
          navigator.clipboard.writeText(text).then(() => {
            Notification.success(i18n('Copied to clipboard'));
          }).catch(() => {
            Notification.error(i18n('Failed to copy'));
          });
        });
      }
    } catch (error: any) {
      Notification.error(i18n('Failed to generate token: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
    }
  });
});

export default page;


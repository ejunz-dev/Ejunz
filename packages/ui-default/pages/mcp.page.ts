import $ from 'jquery';
import _ from 'lodash';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import {
  i18n, pjax, request, tpl,
} from 'vj/utils';

let globalSock: any = null;

function getSelectedMids() {
  const mids: string[] = [];
  $('[data-checkbox-group="mcp"]:checked').each(function () {
    const mid = $(this).closest('tr').attr('data-mid');
    if (mid) mids.push(mid);
  });
  return mids;
}

function getCurrentMids() {
  const domMids = Array.from($('.mcp-list-table tbody tr[data-mid]')).map((tr) => $(tr).attr('data-mid')).filter(Boolean);
  const mids = domMids.length ? domMids : (UiContext.mcpMids || []);
  return mids.map((mid) => Number(mid)).filter((mid) => Number.isFinite(mid) && mid > 0);
}

function currentSocketUrl() {
  if (!UiContext.socketUrl) return '';
  const [path, query = ''] = UiContext.socketUrl.split('?');
  const params = new URLSearchParams(query);
  const q = new URLSearchParams(window.location.search).get('q') || '';
  if (q) params.set('q', q);
  else params.delete('q');
  return `${path}?${params.toString()}`;
}

function closeMcpSocket() {
  if (!globalSock) return;
  try {
    globalSock.onopen = null;
    globalSock.onclose = null;
    globalSock.onmessage = null;
    globalSock.onerror = null;
    globalSock.close();
  } catch {
    // ignore socket cleanup errors
  }
  globalSock = null;
}

async function setupMcpSocket() {
  closeMcpSocket();
  const socketUrl = currentSocketUrl();
  if (!socketUrl) return;

  const [{ default: WebSocketCtor }, { DiffDOM }] = await Promise.all([
    import('../components/socket'),
    import('diff-dom'),
  ]);

  const sock = new WebSocketCtor(UiContext.ws_prefix + socketUrl, false, true);
  globalSock = sock;
  const dd = new DiffDOM();

  sock.onopen = () => {
    const mids = getCurrentMids();
    if (mids.length) sock.send(JSON.stringify({ mids }));
  };

  sock.onclose = () => {
    if (globalSock === sock) globalSock = null;
  };

  sock.onmessage = (_, data) => {
    try {
      const msg = JSON.parse(data);
      const $tbody = $('.mcp-list-table tbody');
      if (!$tbody.length) return;

      if (msg.remove && msg.mid) {
        $tbody.find(`tr[data-mid="${msg.mid}"]`).trigger('vjContentRemove').remove();
        return;
      }

      if (!msg.html) return;
      const $newTr = $(msg.html);
      if (!$newTr.length) return;
      const mid = $newTr.attr('data-mid');
      if (!mid) return;

      const $oldTr = $tbody.find(`tr[data-mid="${mid}"]`);
      if ($oldTr.length) {
        $oldTr.trigger('vjContentRemove');
        dd.apply($oldTr[0], dd.diff($oldTr[0], $newTr[0]));
        $oldTr.trigger('vjContentNew');
        if (!msg.initial) $tbody.prepend($oldTr);
      } else {
        const params = new URLSearchParams(window.location.search);
        if (+params.get('page')! > 1 || params.get('nopush')) return;
        $tbody.prepend($newTr);
        $newTr.trigger('vjContentNew');
      }

      const pageSize = Number(UiContext.mcpPageSize) || 20;
      const $allRows = $tbody.find('tr');
      if ($allRows.length > pageSize) $allRows.slice(pageSize).trigger('vjContentRemove').remove();
    } catch {
      // ignore malformed live update payloads
    }
  };
}

function loadQuery() {
  const q = $('[name="q"]').val()?.toString() || '';
  const url = new URL(window.location.href);
  if (!q) url.searchParams.delete('q');
  else url.searchParams.set('q', q);
  url.searchParams.delete('page');
  return pjax.request({ url: url.toString() }).then(() => setupMcpSocket());
}

const page = new NamedPage('mcp_main', async () => {
  const $body = $('body');
  $body.addClass('display-mode');
  $('.section.display-mode').removeClass('display-mode');

  await setupMcpSocket();

  $(document).on('click', '[name="leave-edit-mode"]', () => {
    $body.removeClass('edit-mode').addClass('display-mode');
  });

  $(document).on('click', '[name="enter-edit-mode"]', () => {
    $body.removeClass('display-mode').addClass('edit-mode');
  });

  $(document).on('click', '[name="delete_selected_mcps"]', async () => {
    const mids = getSelectedMids();
    if (mids.length === 0) {
      Notification.error(i18n('Please select at least one MCP to delete.'));
      return;
    }
    const action = await new ConfirmDialog({
      $body: tpl`
        <div class="typo">
          <p>${i18n('Confirm deleting {0} selected MCP endpoint(s)? Their tokens will be invalidated immediately.').replace('{0}', mids.length.toString())}</p>
        </div>`,
    }).open();
    if (action !== 'yes') return;
    try {
      await request.post('', {
        operation: 'delete_selected',
        mids,
      });
      Notification.success(i18n('Selected MCP endpoint(s) have been deleted.'));
      await pjax.request({ push: false });
      await setupMcpSocket();
    } catch (error: any) {
      Notification.error(error.message);
    }
  });

  $('#searchForm').on('submit', (ev) => {
    ev.preventDefault();
    loadQuery();
  });

  $('#searchForm').find('input').on('input', _.debounce(loadQuery, 500));

  $(document).on('click', 'a.pager__item', (ev) => {
    ev.preventDefault();
    pjax.request(ev.currentTarget.getAttribute('href')).then(async () => {
      window.scrollTo(0, 0);
      await setupMcpSocket();
    });
  });

  const cleanup = () => closeMcpSocket();
  $(window).on('beforeunload', cleanup);
  $(window).on('pagehide', cleanup);
});

export default page;

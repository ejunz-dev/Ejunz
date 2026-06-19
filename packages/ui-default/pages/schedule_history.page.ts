import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';

let globalSock: any = null;

function cleanupOldConnection() {
  if (globalSock) {
    try {
      globalSock.onopen = null;
      globalSock.onclose = null;
      globalSock.onmessage = null;
      globalSock.onerror = null;
      globalSock.close();
    } catch {
      // ignore
    }
    globalSock = null;
  }
}

const page = new NamedPage('schedule_history', async () => {
  cleanupOldConnection();

  if (UiContext.socketUrl) {
    const [{ default: WebSocketCtor }, { DiffDOM }] = await Promise.all([
      import('../components/socket'),
      import('diff-dom'),
    ]);

    const wsUrl = UiContext.ws_prefix + UiContext.socketUrl;
    const sock = new WebSocketCtor(wsUrl, false, true);
    globalSock = sock;
    const dd = new DiffDOM();

    sock.onopen = () => {
      const runIds = (UiContext.scheduleRunIds && UiContext.scheduleRunIds.length)
        ? UiContext.scheduleRunIds
        : Array.from($('.schedule_history__table tbody tr[data-run-id]')).map((tr) =>
          $(tr).attr('data-run-id')).filter(Boolean);
      if (runIds.length) sock.send(JSON.stringify({ runIds }));
    };

    sock.onclose = () => {
      if (globalSock === sock) globalSock = null;
    };

    sock.onmessage = (_, data) => {
      try {
        const msg = JSON.parse(data);
        const $tbody = $('.schedule_history__table tbody');
        if (!$tbody.length) return;
        const id = String(msg.id || '');
        if (msg.type === 'remove' && id) {
          const $oldTr = $tbody.find(`tr[data-run-id="${id}"]`);
          if ($oldTr.length) {
            $oldTr.trigger('vjContentRemove');
            $oldTr.remove();
            if (!$tbody.find('tr[data-run-id]').length) {
              $tbody.append('<tr class="schedule_history__empty"><td colspan="8" class="empty">No scheduled task history.</td></tr>');
            }
          }
          return;
        }
        if (!msg.html) return;
        const $newTr = $(msg.html);
        if (!$newTr.length) return;
        const rid = $newTr.attr('data-run-id');
        if (!rid) return;
        const $oldTr = $tbody.find(`tr[data-run-id="${rid}"]`);
        if ($oldTr.length) {
          $oldTr.trigger('vjContentRemove');
          dd.apply($oldTr[0], dd.diff($oldTr[0], $newTr[0]));
          $oldTr.trigger('vjContentNew');
        } else {
          if (+new URLSearchParams(window.location.search).get('page')! > 1
            || new URLSearchParams(window.location.search).get('nopush')) {
            return;
          }
          $tbody.find('.schedule_history__empty').remove();
          $tbody.prepend($newTr);
          const $allRows = $tbody.find('tr[data-run-id]');
          if ($allRows.length > 20) {
            $allRows.eq($allRows.length - 1).remove();
          }
          $newTr.trigger('vjContentNew');
        }
      } catch {
        // ignore malformed live update
      }
    };

    const cleanup = () => cleanupOldConnection();
    $(window).on('beforeunload', cleanup);
    $(window).on('pagehide', cleanup);
  }
});

export default page;

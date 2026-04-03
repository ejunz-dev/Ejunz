import $ from 'jquery';
import UserSelectAutoComplete from 'vj/components/autocomplete/UserSelectAutoComplete';
import { NamedPage } from 'vj/misc/Page';
import 'vj/components/room/room.page.styl';

let globalSock: any = null;

const page = new NamedPage('record_main', async () => {
  const cleanupOldConnection = () => {
    if (globalSock) {
      try {
        globalSock.onopen = null;
        globalSock.onclose = null;
        globalSock.onmessage = null;
        globalSock.onerror = null;
        globalSock.close();
      } catch {
      }
      globalSock = null;
    }
  };

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
      const rids = (UiContext.recordRids && UiContext.recordRids.length)
        ? UiContext.recordRids
        : Array.from($('.record_main__table tbody tr[data-rid]')).map((tr) =>
            $(tr).attr('data-rid')).filter(Boolean);
      if (rids.length) {
        sock.send(JSON.stringify({ rids }));
      }
    };

    sock.onclose = () => {
      if (globalSock === sock) globalSock = null;
    };

    sock.onmessage = (_, data) => {
      try {
        const msg = JSON.parse(data);
        if (!msg.html) return;
        const $newTr = $(msg.html);
        if (!$newTr.length) return;
        const rid = $newTr.attr('data-rid');
        if (!rid) return;
        const $tbody = $('.record_main__table tbody');
        const $oldTr = $tbody.find(`tr[data-rid="${rid}"]`);
        if ($oldTr.length) {
          $oldTr.trigger('vjContentRemove');
          dd.apply($oldTr[0], dd.diff($oldTr[0], $newTr[0]));
          $oldTr.trigger('vjContentNew');
        } else {
          if (+new URLSearchParams(window.location.search).get('page')! > 1
            || new URLSearchParams(window.location.search).get('nopush')) {
            return;
          }
          $tbody.prepend($newTr);
          const $allRows = $tbody.find('tr');
          if ($allRows.length > 20) {
            $allRows.eq($allRows.length - 1).remove();
          }
          $newTr.trigger('vjContentNew');
        }
      } catch {
      }
    };

    const cleanup = () => {
      cleanupOldConnection();
    };

    $(window).on('beforeunload', cleanup);
    $(window).on('pagehide', cleanup);
  }

  UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
    clearDefaultValue: false,
  });
});

export default page;

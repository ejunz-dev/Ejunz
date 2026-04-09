import $ from 'jquery';
import UserSelectAutoComplete from 'vj/components/autocomplete/UserSelectAutoComplete';
import { NamedPage } from 'vj/misc/Page';
import 'vj/components/session_row/session_row.page.styl';

let globalSock: any = null;

const page = new NamedPage('session_domain', async () => {
  const cleanupOldConnection = () => {
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
      const sids = (UiContext.sessionSids && UiContext.sessionSids.length)
        ? UiContext.sessionSids
        : Array.from($('.session_domain__table tbody tr[data-sid]')).map((tr) =>
            $(tr).attr('data-sid')).filter(Boolean);
      if (sids.length) {
        sock.send(JSON.stringify({ sids }));
        return;
      }
      const uids = (UiContext.sessionUids && UiContext.sessionUids.length)
        ? UiContext.sessionUids
        : Array.from($('.session_domain__table tbody tr[data-uid]')).map((tr) =>
            $(tr).attr('data-uid')).filter(Boolean);
      if (uids.length) {
        sock.send(JSON.stringify({ uids }));
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
        const sid = $newTr.attr('data-sid');
        const uid = $newTr.attr('data-uid');
        const $tbody = $('.session_domain__table tbody');
        const $oldTr = sid
          ? $tbody.find(`tr[data-sid="${sid}"]`)
          : (uid ? $tbody.find(`tr[data-uid="${uid}"]`) : $());
        if (!$oldTr.length && !sid && !uid) return;
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
        // ignore
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

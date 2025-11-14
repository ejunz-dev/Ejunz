import $ from 'jquery';
import UserSelectAutoComplete from 'vj/components/autocomplete/UserSelectAutoComplete';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getAvailableLangs, request, tpl } from 'vj/utils';

let globalSock: any = null;

const page = new NamedPage(['record_main', 'task_record_main'], async () => {
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
      if (UiContext.rids && UiContext.rids.length) {
        sock.send(JSON.stringify({ rids: UiContext.rids }));
      }
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
        const rid = $newTr.attr('data-rid');
        const $oldTr = $(`.record_main__table tr[data-rid="${rid}"]`);
        if ($oldTr.length) {
          $oldTr.trigger('vjContentRemove');
          dd.apply($oldTr[0], dd.diff($oldTr[0], $newTr[0]));
          $oldTr.trigger('vjContentNew');
        } else {
          if (+new URLSearchParams(window.location.search).get('page') > 1
            || new URLSearchParams(window.location.search).get('nopush')) {
            return;
          }
          $('.record_main__table tbody').prepend($newTr);
          $('.record_main__table tbody tr:last').remove();
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
  UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
    clearDefaultValue: false,
  });
  const langs = UiContext.domain.langs?.split(',').map((i) => i.trim()).filter((i) => i);
  const availableLangs = getAvailableLangs(langs?.length ? langs : undefined);
  Object.keys(availableLangs).map(
    (i) => ($('select[name="lang"]').append(tpl`<option value="${i}" key="${i}">${availableLangs[i].display}</option>`)));
  const lang = new URL(window.location.href).searchParams.get('lang');
  if (lang) $('select[name="lang"]').val(lang);

  for (const operation of ['rerun', 'cancel']) {
    $(document).on('click', `[name="operation"][value="${operation}"]`, (ev) => {
      ev.preventDefault();
      const action = $(ev.target).closest('form').attr('action');
      request.post(action, { operation }).catch((e) => Notification.error(e));
    });
  }
});

export default page;
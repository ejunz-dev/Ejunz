import $ from 'jquery';
import UserSelectAutoComplete from 'vj/components/autocomplete/UserSelectAutoComplete';
import { NamedPage } from 'vj/misc/Page';
import 'vj/components/session/session.page.styl';

let globalSock: any = null;

const page = new NamedPage('session_domain', async () => {
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
      const sids = (UiContext.sids && UiContext.sids.length) 
        ? UiContext.sids 
        : Array.from($('.session_domain__table tbody tr[data-sid]')).map((tr) => 
            $(tr).attr('data-sid')
          ).filter(Boolean);
      if (sids.length) {
        sock.send(JSON.stringify({ sids }));
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
        const sid = $newTr.attr('data-sid');
        if (!sid) return;
        const $tbody = $('.session_domain__table tbody');
        const $oldTr = $tbody.find(`tr[data-sid="${sid}"]`);
        if ($oldTr.length) {
          $oldTr.trigger('vjContentRemove');
          dd.apply($oldTr[0], dd.diff($oldTr[0], $newTr[0]));
          $oldTr.trigger('vjContentNew');
        } else {
          if (+new URLSearchParams(window.location.search).get('page') > 1
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
});

export default page;


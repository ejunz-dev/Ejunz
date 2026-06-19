import $ from 'jquery';
import { ActionDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import {
  i18n, request, tpl,
} from 'vj/utils';

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

function rowForButton(button: HTMLElement) {
  return $(button).closest('tr[data-schedule-id]');
}

async function postScheduleAction(payload: Record<string, any>, successMessage: string) {
  await request.post(UiContext.scheduleActionUrl || '/schedule/action', payload);
  Notification.success(successMessage);
}

function bindScheduleActions() {
  $(document).off('click.scheduleMainActions');

  $(document).on('click.scheduleMainActions', '.schedule-pause-btn', async function onPause() {
    const scheduleId = String($(this).attr('data-schedule-id') || '');
    try {
      await postScheduleAction({ scheduleId, action: 'pause' }, i18n('Schedule paused'));
    } catch (error) {
      Notification.error(error.message);
    }
  });

  $(document).on('click.scheduleMainActions', '.schedule-resume-btn', async function onResume() {
    const scheduleId = String($(this).attr('data-schedule-id') || '');
    try {
      await postScheduleAction({ scheduleId, action: 'resume' }, i18n('Schedule resumed'));
    } catch (error) {
      Notification.error(error.message);
    }
  });

  $(document).on('click.scheduleMainActions', '.schedule-delete-btn', async function onDelete() {
    const scheduleId = String($(this).attr('data-schedule-id') || '');
    if (!confirm(i18n('Delete this schedule?'))) return;
    try {
      await postScheduleAction({ scheduleId, action: 'delete' }, i18n('Schedule deleted'));
    } catch (error) {
      Notification.error(error.message);
    }
  });

  $(document).on('click.scheduleMainActions', '.schedule-edit-btn', async function onEdit() {
    const $row = rowForButton(this);
    const scheduleId = String($row.attr('data-schedule-id') || '');
    const scheduleType = String($row.attr('data-schedule-type') || 'once');
    const $body = $(tpl`
      <div class="typo schedule-edit-dialog">
        <label>${i18n('Title')}
          <input class="textbox" name="title" type="text" value="${String($row.attr('data-title') || '')}" data-autofocus>
        </label>
        <label>${i18n('Agent')}
          <input class="textbox" name="agentId" type="text" value="${String($row.attr('data-agent-id') || '')}">
        </label>
        <label>${i18n('Message')}
          <textarea class="textbox" name="command" rows="3">${String($row.attr('data-command') || '')}</textarea>
        </label>
        <label>${i18n('Type')}
          <select name="scheduleType">
            <option value="once" ${scheduleType === 'once' ? 'selected' : ''}>once</option>
            <option value="interval" ${scheduleType === 'interval' ? 'selected' : ''}>interval</option>
          </select>
        </label>
        <div class="schedule-edit-once">
          <label>${i18n('Execute at')}
            <input class="textbox" name="executeAt" type="text" value="${String($row.attr('data-execute-at') || '')}" placeholder="2026-06-19T12:00:00.000Z">
          </label>
        </div>
        <div class="schedule-edit-interval">
          <label>${i18n('Interval count')}
            <input class="textbox" name="intervalCount" type="number" min="1" value="${String($row.attr('data-interval-count') || '1')}">
          </label>
          <label>${i18n('Interval unit')}
            <select name="intervalUnit">
              <option value="minute" ${String($row.attr('data-interval-unit') || 'day') === 'minute' ? 'selected' : ''}>minute</option>
              <option value="hour" ${String($row.attr('data-interval-unit') || 'day') === 'hour' ? 'selected' : ''}>hour</option>
              <option value="day" ${String($row.attr('data-interval-unit') || 'day') === 'day' ? 'selected' : ''}>day</option>
              <option value="week" ${String($row.attr('data-interval-unit') || 'day') === 'week' ? 'selected' : ''}>week</option>
              <option value="month" ${String($row.attr('data-interval-unit') || 'day') === 'month' ? 'selected' : ''}>month</option>
            </select>
          </label>
          <label>${i18n('Max runs')}
            <input class="textbox" name="maxRuns" type="number" min="1" value="${String($row.attr('data-max-runs') || '')}" placeholder="optional">
          </label>
          <label>${i18n('End at')}
            <input class="textbox" name="endAt" type="text" value="${String($row.attr('data-end-at') || '')}" placeholder="optional ISO datetime">
          </label>
        </div>
        <label>${i18n('Timezone')}
          <input class="textbox" name="timezone" type="text" value="${String($row.attr('data-timezone') || 'UTC')}">
        </label>
        <label>${i18n('Description')}
          <textarea class="textbox" name="description" rows="2">${String($row.attr('data-description') || '')}</textarea>
        </label>
      </div>
    `);
    const updateTypeVisibility = () => {
      const type = String($body.find('[name="scheduleType"]').val() || 'once');
      $body.find('.schedule-edit-once').toggle(type === 'once');
      $body.find('.schedule-edit-interval').toggle(type === 'interval');
    };
    $body.on('change', '[name="scheduleType"]', updateTypeVisibility);
    updateTypeVisibility();
    const dialog = new ActionDialog({
      $body,
      $action: [
        `<button class="rounded button" data-action="cancel">${i18n('Cancel')}</button>`,
        `<button class="primary rounded button" data-action="ok">${i18n('Save')}</button>`,
      ].join('\n'),
      width: '520px',
    });
    const action = await dialog.open();
    if (action !== 'ok') return;
    try {
      await postScheduleAction({
        scheduleId,
        action: 'update',
        title: dialog.$dom.find('[name="title"]').val(),
        agentId: dialog.$dom.find('[name="agentId"]').val(),
        command: dialog.$dom.find('[name="command"]').val(),
        scheduleType: dialog.$dom.find('[name="scheduleType"]').val(),
        executeAt: dialog.$dom.find('[name="executeAt"]').val(),
        intervalCount: dialog.$dom.find('[name="intervalCount"]').val(),
        intervalUnit: dialog.$dom.find('[name="intervalUnit"]').val(),
        maxRuns: dialog.$dom.find('[name="maxRuns"]').val(),
        endAt: dialog.$dom.find('[name="endAt"]').val(),
        timezone: dialog.$dom.find('[name="timezone"]').val(),
        description: dialog.$dom.find('[name="description"]').val(),
      }, i18n('Schedule updated'));
    } catch (error) {
      Notification.error(error.message);
    }
  });
}

const page = new NamedPage('schedule_main', async () => {
  cleanupOldConnection();
  bindScheduleActions();

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
      const scheduleIds = (UiContext.scheduleIds && UiContext.scheduleIds.length)
        ? UiContext.scheduleIds
        : Array.from($('.schedule_main__table tbody tr[data-schedule-id]')).map((tr) =>
          $(tr).attr('data-schedule-id')).filter(Boolean);
      if (scheduleIds.length) sock.send(JSON.stringify({ scheduleIds }));
    };

    sock.onclose = () => {
      if (globalSock === sock) globalSock = null;
    };

    sock.onmessage = (_, data) => {
      try {
        const msg = JSON.parse(data);
        const $tbody = $('.schedule_main__table tbody');
        if (!$tbody.length) return;
        const id = String(msg.id || '');
        if (msg.type === 'remove' && id) {
          const $oldTr = $tbody.find(`tr[data-schedule-id="${id}"]`);
          if ($oldTr.length) {
            $oldTr.trigger('vjContentRemove');
            $oldTr.remove();
            if (!$tbody.find('tr[data-schedule-id]').length) {
              $tbody.append('<tr class="schedule_main__empty"><td colspan="9" class="empty">No scheduled agent tasks.</td></tr>');
            }
          }
          return;
        }
        if (!msg.html) return;
        const $newTr = $(msg.html);
        if (!$newTr.length) return;
        const sid = $newTr.attr('data-schedule-id');
        if (!sid) return;
        const $oldTr = $tbody.find(`tr[data-schedule-id="${sid}"]`);
        if ($oldTr.length) {
          $oldTr.trigger('vjContentRemove');
          dd.apply($oldTr[0], dd.diff($oldTr[0], $newTr[0]));
          $oldTr.trigger('vjContentNew');
        } else {
          if (+new URLSearchParams(window.location.search).get('page')! > 1
            || new URLSearchParams(window.location.search).get('nopush')) {
            return;
          }
          $tbody.find('.schedule_main__empty').remove();
          $tbody.prepend($newTr);
          const $allRows = $tbody.find('tr[data-schedule-id]');
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

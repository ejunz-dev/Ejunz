import $ from 'jquery';
import { ActionDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import {
  i18n, pjax, request, tpl,
} from 'vj/utils';

let refreshTimer: ReturnType<typeof window.setInterval> | null = null;
let refreshInFlight = false;

async function refreshWorkerStatus() {
  if (refreshInFlight || document.hidden) return;
  refreshInFlight = true;
  try {
    await pjax.request({ push: false });
  } finally {
    refreshInFlight = false;
  }
}

function cleanupRefreshTimer() {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  $(document).off('visibilitychange.statusWorkerRefresh');
  $(window).off('beforeunload.statusWorkerRefresh pagehide.statusWorkerRefresh');
}

const page = new NamedPage('status', () => {
  cleanupRefreshTimer();
  refreshTimer = window.setInterval(() => {
    refreshWorkerStatus();
  }, 10000);
  $(document).on('visibilitychange.statusWorkerRefresh', () => {
    if (!document.hidden) refreshWorkerStatus();
  });
  $(window).on('beforeunload.statusWorkerRefresh pagehide.statusWorkerRefresh', cleanupRefreshTimer);

  $(document).on('click', '.worker-edit-btn', async function openWorkerEditDialog() {
    const $btn = $(this);
    const workerIds = String($btn.attr('data-worker-ids') || '');
    const workerId = String($btn.attr('data-worker-id') || '');
    const workerName = String($btn.attr('data-worker-name') || '');
    const workerStatus = String($btn.attr('data-worker-status') || '');
    const workerPaused = $btn.attr('data-worker-paused') === 'true';
    const workerOnline = $btn.attr('data-worker-online') === 'true';
    const $body = $(tpl`
      <div class="typo worker-edit-dialog">
        <label>${i18n('ID')}
          <input class="textbox" type="text" value="${workerId}" disabled>
        </label>
        <label>${i18n('Name')}
          <input class="textbox" name="workerName" type="text" value="${workerName}" autocomplete="off" data-autofocus>
        </label>
        <label>${i18n('Status')}
          <select name="paused" ${workerOnline ? '' : 'disabled'}>
            <option value="false" ${!workerPaused ? 'selected' : ''}>${i18n('Online')}</option>
            <option value="true" ${workerPaused ? 'selected' : ''}>${i18n('Paused')}</option>
          </select>
        </label>
        ${workerOnline ? '' : `<label><input type="checkbox" name="deleteWorker"> ${i18n('Delete offline worker')}</label>`}
        <p><small>${i18n('Current Status')}: ${workerStatus}</small></p>
      </div>
    `);
    const dialog = new ActionDialog({
      $body,
      $action: [
        `<button class="rounded button" data-action="cancel">${i18n('Cancel')}</button>`,
        `<button class="primary rounded button" data-action="ok">${i18n('Save')}</button>`,
      ].join('\n'),
      width: '420px',
    });
    const action = await dialog.open();
    if (action !== 'ok') return;
    const deleteWorker = dialog.$dom.find('[name="deleteWorker"]').prop('checked');
    try {
      await request.post('/status/worker/edit', {
        workerIds,
        workerName: dialog.$dom.find('[name="workerName"]').val(),
        paused: workerOnline ? dialog.$dom.find('[name="paused"]').val() : undefined,
        deleteWorker,
      });
      Notification.success(i18n('Worker updated'));
      await refreshWorkerStatus();
    } catch (error) {
      Notification.error(error.message);
    }
  });
});

export default page;

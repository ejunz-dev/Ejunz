import $ from 'jquery';
import { Dialog } from 'vj/components/dialog/index';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

const page = new NamedPage('base_branches', () => {
  $(document).on('click', '[name="open_create_branch"]', async () => {
    const $body = $('<div class="typo"></div>');
    $body.append($('#create-branch-dialog').html());
    const cancelBtn = `<button class="rounded button" data-action="cancel">${i18n('Cancel')}</button>`;
    const createBtn = `<button class="primary rounded button" data-action="ok">${i18n('Create new branch')}</button>`;
    const dialog = new Dialog({
      $body,
      $action: `${cancelBtn}\n${createBtn}`,
      width: '450px',
      cancelByClickingBack: true,
      cancelByEsc: true,
    });
    const action = await dialog.open();
    if (action !== 'ok') return;

    const branch = dialog.$dom.find('#new-branch-name').val()?.toString().trim();
    const sourceBranch = dialog.$dom.find('#source-branch').val()?.toString().trim() || 'main';
    if (!branch) {
      Notification.error(i18n('Branch name is required'));
      return;
    }
    try {
      await request.post('', {
        operation: 'create_branch',
        branch,
        sourceBranch,
      });
      Notification.success(i18n('Branch created successfully'));
      window.location.reload();
    } catch (error) {
      Notification.error(error.message);
    }
  });
});

export default page;

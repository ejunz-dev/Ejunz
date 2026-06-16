import $ from 'jquery';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request, tpl } from 'vj/utils';

const page = new NamedPage('plugin_domain', async () => {
  $('.plugin-delete-btn').on('click', async function deletePlugin() {
    const docId = String($(this).attr('data-doc-id') || '');
    if (!docId) return;
    const action = await new ConfirmDialog({
      $body: tpl.typoMsg(i18n('Confirm to delete this plugin? Agents using it will lose its slash commands.')),
    }).open();
    if (action !== 'yes') return;
    try {
      await request.post(`/plugins/${encodeURIComponent(docId)}/delete`, {});
      Notification.success(i18n('Plugin deleted'));
      window.location.reload();
    } catch (e: any) {
      Notification.error(e?.message || i18n('Delete failed'));
    }
  });
});

export default page;

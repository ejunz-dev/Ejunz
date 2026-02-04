import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

const page = new NamedPage('tool_market', async () => {
  const domainId = (window as any).UiContext?.domain?._id;
  if (!domainId) return;

  $(document).on('click', '.tool_market__add-btn', async (ev) => {
    const $btn = $(ev.currentTarget);
    const toolKey = $btn.attr('data-tool-key');
    if (!toolKey) return;
    $btn.prop('disabled', true).text(i18n('Adding...'));
    try {
      await request.post(`/d/${domainId}/tool/market/add`, { toolKey });
      Notification.success(i18n('Added to tool list.'));
      $btn.replaceWith(`<button type="button" class="rounded button tool_market__remove-btn" data-tool-key="${toolKey}">${i18n('Uninstall')}</button>`);
    } catch (e: any) {
      Notification.error(e?.message || i18n('Add failed.'));
      $btn.prop('disabled', false).text(i18n('Add'));
    }
  });

  $(document).on('click', '.tool_market__remove-btn', async (ev) => {
    const $btn = $(ev.currentTarget);
    const toolKey = $btn.attr('data-tool-key');
    if (!toolKey) return;
    $btn.prop('disabled', true).text(i18n('Uninstalling...'));
    try {
      await request.post(`/d/${domainId}/tool/market/remove`, { toolKey });
      Notification.success(i18n('Tool uninstalled.'));
      $btn.replaceWith(`<button type="button" class="primary button tool_market__add-btn" data-tool-key="${toolKey}">${i18n('Add')}</button>`);
    } catch (e: any) {
      Notification.error(e?.message || i18n('Uninstall failed.'));
      $btn.prop('disabled', false).text(i18n('Uninstall'));
    }
  });
});

export default page;

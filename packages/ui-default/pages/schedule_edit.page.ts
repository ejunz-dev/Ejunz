import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

const page = new NamedPage('schedule_edit', () => {
  const updateTypeVisibility = () => {
    const type = String($('[name="scheduleType"]').val() || 'once');
    $('.schedule-edit-once').toggle(type === 'once');
    $('.schedule-edit-interval').toggle(type === 'interval');
  };

  $(document).off('change.scheduleEdit click.scheduleEdit');
  $(document).on('change.scheduleEdit', '[name="scheduleType"]', updateTypeVisibility);
  $(document).on('click.scheduleEdit', '.schedule-edit-delete', () => window.confirm(i18n('Cancel this scheduled task?')));
  updateTypeVisibility();
});

export default page;

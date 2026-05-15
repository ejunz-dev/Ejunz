import $ from 'jquery';
import _ from 'lodash';
import { ConfirmDialog } from 'vj/components/dialog/index';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, pjax, request, tpl } from 'vj/utils';

function loadQuery() {
  const q = $('[name="q"]').val().toString();
  const url = new URL(window.location.href);
  if (!q) url.searchParams.delete('q');
  else url.searchParams.set('q', q);
  url.searchParams.delete('page');
  pjax.request({ url: url.toString() });
}

function getSelectedDocIds() {
  const ids = [];
  $('[data-checkbox-group="skill"]:checked').each(function () {
    const docId = $(this).closest('tr').attr('data-doc-id');
    if (docId) ids.push(docId);
  });
  return ids;
}

const page = new NamedPage('skill_domain', () => {
  const $body = $('body');
  $body.addClass('display-mode');
  $('.section.display-mode').removeClass('display-mode');

  $(document).on('click', '[name="leave-edit-mode"]', () => {
    $body.removeClass('edit-mode').addClass('display-mode');
  });
  $(document).on('click', '[name="enter-edit-mode"]', () => {
    $body.removeClass('display-mode').addClass('edit-mode');
  });

  $(document).on('click', '[name="delete_selected_skills"]', async () => {
    const docIds = getSelectedDocIds();
    if (docIds.length === 0) {
      Notification.error(i18n('Please select at least one skill library to delete.'));
      return;
    }
    const action = await new ConfirmDialog({
      $body: tpl`
        <div class="typo">
          <p>${i18n('Confirm deleting {0} selected skill library/libraries?').replace('{0}', docIds.length)}</p>
        </div>`,
    }).open();
    if (action !== 'yes') return;
    try {
      await request.post('', {
        operation: 'delete_selected',
        docIds,
      });
      Notification.success(i18n('Selected skill libraries have been deleted.'));
      await pjax.request({ push: false });
    } catch (error) {
      Notification.error(error.message);
    }
  });

  function inputChanged() {
    loadQuery();
  }
  $('#searchForm').on('submit', (ev) => {
    ev.preventDefault();
    inputChanged();
  });
  $('#searchForm').find('input').on('input', _.debounce(inputChanged, 500));

  $(document).on('click', 'a.pager__item', (ev) => {
    ev.preventDefault();
    pjax.request(ev.currentTarget.getAttribute('href')).then(() => window.scrollTo(0, 0));
  });
});

export default page;

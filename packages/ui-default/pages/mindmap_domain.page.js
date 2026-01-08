import parser, { SearchParserResult } from '@ejunz/utils/lib/search';
import $ from 'jquery';
import _ from 'lodash';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { delay, i18n, pjax, request, tpl } from 'vj/utils';

const parserOptions = {
  keywords: ['category'],
  offsets: true,
  alwaysArray: true,
  tokenize: true,
};

function loadQuery() {
  const q = $('[name="q"]').val().toString();
  const url = new URL(window.location.href);
  if (!q) {
    url.searchParams.delete('q');
  } else {
    url.searchParams.set('q', q);
  }
  url.searchParams.delete('page');
  pjax.request({ url: url.toString() });
}

function inputChanged() {
  loadQuery();
}

function ensureAndGetSelectedDocIds() {
  const docIds = _.map(
    $('tbody [data-checkbox-group="mindmap"]:checked'),
    (ch) => $(ch).closest('tr').attr('data-doc-id'),
  );
  if (docIds.length === 0) {
    Notification.error(i18n('Please select at least one mindmap to perform this operation.'));
    return null;
  }
  return docIds;
}

async function handleDelete() {
  const docIds = ensureAndGetSelectedDocIds();
  if (docIds === null) return;
  
  const action = await new ConfirmDialog({
    $body: tpl.typoMsg(i18n('Confirm to delete the selected mindmaps?')),
  }).open();
  if (action !== 'yes') return;
  
  try {
    const domainId = window.UiContext?.domainId || 'system';
    for (const docId of docIds) {
      try {
        await request.post(`/d/${domainId}/mindmap/${docId}/edit`, {
          operation: 'delete',
        });
      } catch (error) {
        console.error(`Failed to delete mindmap ${docId}:`, error);
      }
    }
    Notification.success(i18n('Selected mindmaps have been deleted.'));
    await delay(2000);
    loadQuery();
  } catch (error) {
    Notification.error(error.message || i18n('Failed to delete mindmaps.'));
  }
}

const page = new NamedPage('mindmap_domain', () => {
  const $body = $('body');
  $body.addClass('display-mode');
  $('.section.display-mode').removeClass('display-mode');

  $(document).on('click', '[name="leave-edit-mode"]', () => {
    $body.removeClass('edit-mode').addClass('display-mode');
  });
  $(document).on('click', '[name="enter-edit-mode"]', () => {
    $body.removeClass('display-mode').addClass('edit-mode');
  });
  $(document).on('click', '[name="delete_selected_mindmaps"]', handleDelete);

  $('#search').on('click', (ev) => {
    ev.preventDefault();
    inputChanged();
  });

  $('#searchForm').on('submit', (ev) => {
    ev.preventDefault();
    inputChanged();
  });

  $('#searchForm').find('input').on('input', _.debounce(inputChanged, 500));

  // 分页
  $(document).on('click', 'a.pager__item', (ev) => {
    ev.preventDefault();
    pjax.request(ev.currentTarget.getAttribute('href')).then(() => window.scrollTo(0, 0));
  });
});

export default page;


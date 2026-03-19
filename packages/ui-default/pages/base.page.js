import $ from 'jquery';
import _ from 'lodash';
import { NamedPage } from 'vj/misc/Page';
import { pjax } from 'vj/utils';

function loadQuery() {
  const q = $('[name="q"]').val().toString();
  const url = new URL(window.location.href);
  if (!q) url.searchParams.delete('q');
  else url.searchParams.set('q', q);
  url.searchParams.delete('page');
  pjax.request({ url: url.toString() });
}

const page = new NamedPage('base_domain', () => {
  const $body = $('body');
  $body.addClass('display-mode');
  $('.section.display-mode').removeClass('display-mode');

  $(document).on('click', '[name="leave-edit-mode"]', () => {
    $body.removeClass('edit-mode').addClass('display-mode');
  });
  $(document).on('click', '[name="enter-edit-mode"]', () => {
    $body.removeClass('display-mode').addClass('edit-mode');
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

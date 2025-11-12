import $ from 'jquery';
import _ from 'lodash';
import { AutoloadPage } from 'vj/misc/Page';
import { pjax } from 'vj/utils';

export default new AutoloadPage('base_domain', async () => {
  // 搜索功能
  function loadQuery() {
    const q = $('[name="q"]').val().toString();
    const url = new URL(window.location.href);
    if (!q) url.searchParams.delete('q');
    else url.searchParams.set('q', q);
    pjax.request({ url: url.toString() });
  }

  function inputChanged() {
    loadQuery();
  }

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

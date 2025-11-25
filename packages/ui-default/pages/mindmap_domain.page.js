import parser, { SearchParserResult } from '@ejunz/utils/lib/search';
import $ from 'jquery';
import _ from 'lodash';
import { NamedPage } from 'vj/misc/Page';
import { pjax } from 'vj/utils';

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

const page = new NamedPage(['mindmap_domain'], () => {
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


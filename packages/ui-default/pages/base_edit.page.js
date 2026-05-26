import $ from 'jquery';
import Dropdown from 'vj/components/dropdown/Dropdown';
import { NamedPage } from 'vj/misc/Page';

function appendTag(name) {
  const tag = String(name || '').trim();
  if (!tag) return;
  const $input = $('[name="tag"]');
  if (!$input.length) return;
  const parts = String($input.val() || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.includes(tag)) return;
  parts.push(tag);
  $input.val(`${parts.join(', ')}, `);
}

function buildCategorySidebar() {
  const $container = $('[data-widget-cf-container]');
  if (!$container.length) return;
  $container.attr('class', 'widget--category-filter widget--category-filter--sidebar');
  for (const category of $container.children('li').get()) {
    const $category = $(category)
      .attr('class', 'widget--category-filter__category column');
    const $categoryTag = $category
      .find('.section__title a')
      .remove()
      .attr('class', 'widget--category-filter__tag')
      .removeAttr('href');
    const categoryText = $categoryTag.text();
    const $drop = $category
      .children('.chip-list')
      .remove()
      .attr('class', 'widget--category-filter__drop');
    $category.empty().append($categoryTag);
    if ($drop.length > 0) {
      $drop
        .children('li')
        .attr('class', 'widget--category-filter__subcategory')
        .find('a')
        .attr('class', 'widget--category-filter__tag')
        .removeAttr('href')
        .attr('data-category', categoryText);
      Dropdown.getOrConstruct($categoryTag, {
        target: $drop[0],
        position: 'left center',
      });
    }
  }
}

const page = new NamedPage(['base_create', 'base_edit'], () => {
  buildCategorySidebar();
  // Dropdown moves subcategory nodes outside the sidebar; do not scope to .section--problem-sidebar-tags
  $(document).on('click', '.widget--category-filter__tag', (ev) => {
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey) return;
    ev.preventDefault();
    appendTag($(ev.currentTarget).text());
  });
});

export default page;

import parser from '@ejunz/utils/lib/search';
import $ from 'jquery';
import _ from 'lodash';
import { ConfirmDialog } from 'vj/components/dialog/index';
import Dropdown from 'vj/components/dropdown/Dropdown';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, pjax, request, tpl } from 'vj/utils';

const selections = { category: {} };
const selectedTags = { category: [] };

function setDomSelected($dom, selected, icon?) {
  if (selected) {
    $dom.addClass('selected');
    if (icon) $dom.append(icon);
  } else {
    $dom.removeClass('selected');
    if (icon) $dom.find('span').remove();
  }
}

const parserOptions = {
  keywords: ['category'],
  offsets: true,
  alwaysArray: true,
  tokenize: true,
};

function writeSelectionToInput() {
  const currentValue = $('[name="q"]').val() as string;
  const parsedCurrentValue = parser.parse(currentValue, parserOptions);
  const q = parser.stringify({
    ...parsedCurrentValue,
    category: selectedTags.category,
    text: parsedCurrentValue.text,
  }, parserOptions);
  $('[name="q"]').val(q);
}

function updateSelection() {
  selectedTags.category = _.uniq(selectedTags.category);
  for (const selection in selections.category) {
    const item = selections.category[selection];
    const shouldSelect = selectedTags.category.includes(selection);
    const isSelected = (item.$tag || item.$legacy).hasClass('selected');
    let childSelected = false;
    for (const subcategory in item.children) {
      const childShouldSelect = selectedTags.category.includes(subcategory);
      const childIsSelected = item.children[subcategory].$tag.hasClass('selected');
      childSelected ||= childShouldSelect;
      if (childIsSelected !== childShouldSelect) setDomSelected(item.children[subcategory].$tag, childShouldSelect);
    }
    if (item.$legacy) setDomSelected(item.$legacy, (shouldSelect || childSelected));
    if (isSelected !== shouldSelect) {
      if (item.$tag) setDomSelected(item.$tag, shouldSelect, '<span class="icon icon-close"></span>');
    }
  }
}

function loadQuery() {
  const q = $('[name="q"]').val().toString();
  const url = new URL(window.location.href);
  if (!q) url.searchParams.delete('q');
  else url.searchParams.set('q', q);
  url.searchParams.delete('page');
  pjax.request({ url: url.toString() });
}

function handleListTagClick(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const tag = $(ev.currentTarget).text().trim();
  if (!tag) return;
  selectedTags.category = [tag];
  updateSelection();
  writeSelectionToInput();
  loadQuery();
}

function handleTagSelected(ev) {
  if (ev.shiftKey || ev.metaKey || ev.ctrlKey) return;
  let [type, selection] = ['category', $(ev.currentTarget).text()];
  if ($(ev.currentTarget).attr('data-selection')) [type, selection] = $(ev.currentTarget).attr('data-selection').split(':');
  const category = $(ev.currentTarget).attr('data-category');
  const treeItem = category ? selections[type][category].children[selection] : selections[type][selection];
  const shouldSelect = !(treeItem.$tag || treeItem.$legacy).hasClass('selected');
  if (shouldSelect) {
    selectedTags[type].push(selection);
  } else {
    selectedTags[type] = _.without(selectedTags[type], selection, ...(category ? [] : Object.keys(treeItem.children)));
  }
  updateSelection();
  writeSelectionToInput();
  loadQuery();
  ev.preventDefault();
}

function buildLegacyCategoryFilter() {
  const $container = $('[data-widget-cf-container]');
  if (!$container.length) return;
  $container.attr('class', 'widget--category-filter row small-up-3 medium-up-2');
  for (const category of $container.children('li').get()) {
    const $category = $(category)
      .attr('class', 'widget--category-filter__category column');
    const $categoryTag = $category
      .find('.section__title a')
      .remove()
      .attr('class', 'widget--category-filter__tag');
    const categoryText = $categoryTag.text();
    const $drop = $category
      .children('.chip-list')
      .remove()
      .attr('class', 'widget--category-filter__drop');
    if (selections.category[categoryText]) {
      selections.category[categoryText].$legacy = $categoryTag;
    } else {
      selections.category[categoryText] = {
        $legacy: $categoryTag,
        $tag: null,
        children: {},
      };
    }
    $category.empty().append($categoryTag);
    if ($drop.length > 0) {
      const $subCategoryTags = $drop
        .children('li')
        .attr('class', 'widget--category-filter__subcategory')
        .find('a')
        .attr('class', 'widget--category-filter__tag')
        .attr('data-category', categoryText);
      for (const subCategoryTag of $subCategoryTags.get()) {
        const $tag = $(subCategoryTag);
        selections.category[categoryText].children[$tag.text()] = { $tag };
      }
      Dropdown.getOrConstruct($categoryTag, {
        target: $drop[0],
        position: 'left center',
      });
    }
  }
  $(document).on('click', '.widget--category-filter__tag', (ev) => handleTagSelected(ev));
}

function parseCategorySelection() {
  const parsed = parser.parse($('[name="q"]').val() as string || '', parserOptions);
  selectedTags.category = _.uniq(parsed.category || []);
}

function getSelectedDocIds() {
  const ids = [];
  $('[data-checkbox-group="roadmap"]:checked').each(function () {
    const docId = $(this).closest('tr').attr('data-doc-id');
    if (docId) ids.push(docId);
  });
  return ids;
}

const page = new NamedPage('roadmap_main', () => {
  const $body = $('body');
  $body.addClass('display-mode');
  $('.section.display-mode').removeClass('display-mode');

  buildLegacyCategoryFilter();
  parseCategorySelection();
  updateSelection();

  $(document).on('click', '.roadmap-list-table .problem__tag-link', (ev) => handleListTagClick(ev));

  $(document).on('click', '[name="leave-edit-mode"]', () => {
    $body.removeClass('edit-mode').addClass('display-mode');
  });
  $(document).on('click', '[name="enter-edit-mode"]', () => {
    $body.removeClass('display-mode').addClass('edit-mode');
  });

  $(document).on('click', '[name="delete_selected_roadmaps"]', async () => {
    const docIds = getSelectedDocIds();
    if (docIds.length === 0) {
      Notification.error(i18n('Please select at least one roadmap to delete.'));
      return;
    }
    const action = await new ConfirmDialog({
      $body: tpl`
        <div class="typo">
          <p>${i18n('Confirm deleting {0} selected roadmap(s)?').replace('{0}', docIds.length)}</p>
        </div>`,
    }).open();
    if (action !== 'yes') return;
    try {
      await request.post('', {
        operation: 'delete_selected',
        docIds,
      });
      Notification.success(i18n('Selected roadmaps have been deleted.'));
      await pjax.request({ push: false });
    } catch (error) {
      Notification.error(error.message);
    }
  });

  function inputChanged() {
    parseCategorySelection();
    updateSelection();
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

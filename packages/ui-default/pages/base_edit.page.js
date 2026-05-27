import $ from 'jquery';
import Dropdown from 'vj/components/dropdown/Dropdown';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

export const BASE_EDIT_RETURN_URL_KEY = 'baseEditReturnUrl';
export const BASE_CREATE_PREFILL_KEY = 'baseCreatePrefill';

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

function resolveReturnUrl() {
  const ctx = window.UiContext;
  const fromContext = String(ctx?.returnUrl || '').trim();
  if (fromContext.startsWith('/') && !fromContext.startsWith('//')) return fromContext;

  const stored = sessionStorage.getItem(BASE_EDIT_RETURN_URL_KEY);
  sessionStorage.removeItem(BASE_EDIT_RETURN_URL_KEY);
  if (stored && stored.startsWith('/') && !stored.startsWith('//')) {
    if (ctx) ctx.returnUrl = stored;
    return stored;
  }
  return '';
}

function applyBaseCreatePrefill() {
  const raw = sessionStorage.getItem(BASE_CREATE_PREFILL_KEY);
  if (!raw) return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(BASE_CREATE_PREFILL_KEY);
    return;
  }
  const title = String(data?.title || '').trim();
  if (title) $('[name="title"]').val(title);
  if (data?.migrate) {
    const $intro = $('.base-form-page__intro');
    if ($intro.length) {
      $intro.text(i18n('Separate as new base create hint'));
    }
    setupBaseCreateMigrateSubmit(data);
  }
}

function setupBaseCreateMigrateSubmit(prefill) {
  const $form = $('#base-form');
  if (!$form.length || !prefill?.migrate) return;

  $form.on('submit.baseCreateMigrate', async (ev) => {
    ev.preventDefault();
    const title = String($form.find('[name="title"]').val() || '').trim();
    if (!title) {
      Notification.error(i18n('Separate as new base title required'));
      return;
    }
    const bid = String($form.find('[name="bid"]').val() || '').trim();
    const { docId, branch, nodeId } = prefill.migrate;
    const domainId = window.UiContext?.domainId || 'system';
    const $submit = $('.base-form-page__actions .button.primary');
    $submit.prop('disabled', true);
    try {
      const res = await request.post(`/d/${domainId}/base/migrate-node-to-new`, {
        docId,
        branch: branch || 'main',
        nodeId,
        title,
        bid,
      });
      sessionStorage.removeItem(BASE_CREATE_PREFILL_KEY);
      if (!res?.success) {
        Notification.error(res?.message || i18n('Separate as new base failed'));
        return;
      }
      Notification.success(i18n('Separate as new base success'));
      const openSeg = res.bid ? String(res.bid) : String(res.newDocId);
      window.location.href = `/d/${domainId}/base/${encodeURIComponent(openSeg)}/outline/branch/${encodeURIComponent(branch || 'main')}`;
    } catch (err) {
      Notification.error(err?.message || i18n('Separate as new base failed'));
    } finally {
      $submit.prop('disabled', false);
    }
  });

  $('.base-form-page__actions .button').not('.primary').on('click.baseCreateMigrate', () => {
    sessionStorage.removeItem(BASE_CREATE_PREFILL_KEY);
  });
}

function applyReturnUrl() {
  const returnUrl = resolveReturnUrl();
  const $cancel = $('[data-base-edit-cancel]');
  $cancel.on('click', () => {
    if (returnUrl) window.location.href = returnUrl;
    else window.history.go(-1);
  });

  if (!returnUrl) return;

  const $form = $('#base-form').length ? $('#base-form') : $('form[method="post"]').first();
  if (!$form.length) return;
  if (!$form.find('[name="returnUrl"]').length) {
    $('<input>', { type: 'hidden', name: 'returnUrl', value: returnUrl }).prependTo($form);
  }
  $('[data-base-edit-compact-hide]').remove();
}

const page = new NamedPage(['base_create', 'base_edit', 'base_card_edit'], () => {
  applyReturnUrl();
  applyBaseCreatePrefill();
  buildCategorySidebar();
  // Dropdown moves subcategory nodes outside the sidebar; do not scope to .section--problem-sidebar-tags
  $(document).on('click', '.widget--category-filter__tag', (ev) => {
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey) return;
    ev.preventDefault();
    appendTag($(ev.currentTarget).text());
  });
});

export default page;

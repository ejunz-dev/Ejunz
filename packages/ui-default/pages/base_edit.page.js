import $ from 'jquery';
import Dropdown from 'vj/components/dropdown/Dropdown';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request, domainApiPath, domainScopedPath } from 'vj/utils';

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
    const slug = String($form.find('[name="slug"]').val() || '').trim();
    if (!slug) {
      Notification.error(i18n('Slug is required'));
      return;
    }
    const bid = String($form.find('[name="bid"]').val() || '').trim();
    const { docId, nodeId } = prefill.migrate;
    const domainId = window.UiContext?.domainId || 'system';
    const $submit = $('.base-form-page__actions .button.primary');
    $submit.prop('disabled', true);
    try {
      const res = await request.post(domainApiPath('/base/migrate-node-to-new', domainId), {
        docId,
        nodeId,
        title,
        slug,
        bid,
      });
      sessionStorage.removeItem(BASE_CREATE_PREFILL_KEY);
      if (!res?.success) {
        Notification.error(res?.message || i18n('Separate as new base failed'));
        return;
      }
      Notification.success(i18n('Separate as new base success'));
      const openSeg = res.slug ? String(res.slug) : (res.bid ? String(res.bid) : String(res.newDocId));
      window.location.href = domainScopedPath(`/base/${encodeURIComponent(openSeg)}`, domainId);
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

/** Slug real-time validation — GitHub-style: shows message without auto-correcting input. */
function setupSlugValidation() {
  const $slug = $('[name="slug"]');
  if (!$slug.length) return;
  const $help = $slug.closest('.form__item').find('.help-text');
  const $docId = $('[name="docId"]');
  const domainId = window.UiContext?.domainId || 'system';

  $slug.next('.slug-status').remove();
  const $status = $('<div class="slug-status" style="margin-top:4px;font-size:13px;line-height:1.4;"></div>');
  $slug.after($status);

  let timer = null;

  const validate = async () => {
    const val = String($slug.val() || '').trim();
    if (!val) {
      $status.empty();
      if ($help.length) $help.css('color', '');
      return;
    }
    $status.html('<span style="color:#586069;">' + i18n('Checking availability…') + '</span>');
    const body = { slug: val };
    const docId = $docId.length ? Number($docId.val()) : 0;
    if (docId) body.docId = docId;
    try {
      const res = await request.post(domainApiPath('/base/slug-check', domainId), body);
      if (res.available) {
        $status.html('<span style="color:green;font-weight:600;">' + i18n('{0} is available', val) + '</span>');
        if ($help.length) $help.css('color', '');
      } else if (res.suggestion && res.suggestion !== val) {
        // GitHub-style: show what will be created, no error text
        $status.html(
          '<span style="color:#0366d6;">' + i18n('Your new repository will be created as {0}.', '<strong>' + res.suggestion + '</strong>') + '</span>'
        );
        if ($help.length) $help.css('color', '#0366d6');
      } else if (res.errorKey) {
        const errMsg = res.errorSlug ? i18n(res.errorKey, res.errorSlug) : i18n(res.errorKey);
        $status.html('<span style="color:#d73a49;">' + errMsg + '</span>');
        if ($help.length) $help.css('color', '#d73a49');
      } else {
        $status.html('<span style="color:#d73a49;">' + i18n('Slug is not available') + '</span>');
        if ($help.length) $help.css('color', '#d73a49');
      }
    } catch {
      $status.html('<span style="color:orange;">' + i18n('Unable to validate slug') + '</span>');
    }
  };

  $slug.on('input', () => {
    clearTimeout(timer);
    if (!$slug.val().trim()) {
      $status.empty();
      if ($help.length) $help.css('color', '');
      return;
    }
    timer = setTimeout(validate, 300);
  });

  // Do NOT auto-correct on blur, just re-validate to ensure message is current
  $slug.on('blur', () => {
    clearTimeout(timer);
    // Still show the message but never change input value
    if ($slug.val().trim()) {
      timer = setTimeout(validate, 50);
    }
  });

  // Validate on page load (edit page with pre-filled slug)
  setTimeout(validate, 100);
}

const page = new NamedPage(['base_create', 'base_edit', 'base_card_edit'], () => {
  applyReturnUrl();
  applyBaseCreatePrefill();
  buildCategorySidebar();
  setupSlugValidation();
  // Dropdown moves subcategory nodes outside the sidebar; do not scope to .section--problem-sidebar-tags
  $(document).on('click', '.widget--category-filter__tag', (ev) => {
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey) return;
    ev.preventDefault();
    appendTag($(ev.currentTarget).text());
  });
});

export default page;

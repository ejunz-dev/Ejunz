import 'jquery.easing';

import $ from 'jquery';
import { ConfirmDialog } from 'vj/components/dialog';
import CommentBox from 'vj/components/hub/CommentBox';
import { AutoloadPage } from 'vj/misc/Page';
import {
  delay, i18n, request, slideDown, slideUp, tpl,
} from 'vj/utils';
import uploadFiles from 'vj/components/upload'; 
import Notification from 'vj/components/notification';
import initD3 from "vj/components/d3map/d3.sub.view";
import D3Main from "vj/components/d3map/d3.main.view";
import D3MainEdit from "vj/components/d3map/d3.main.edit";
import D3SubEdit from "vj/components/d3map/d3.sub.edit";

const $replyTemplate = $('.commentbox-container').eq(0).clone();

function createReplyContainer($parent) {
  const $container = $replyTemplate
    .clone()
    .hide()
    .prependTo($parent.find('.commentbox-reply-target').eq(0))
    .trigger('vjContentNew');
  return $container.find('.commentbox-placeholder');
}

async function showReplyContainer($parent) {
  const $container = $parent.find('.commentbox-container');
  // TODO: fix ugly hack. cannot get $container rect because it is invisible
  const rect = $container.parent()[0].getBoundingClientRect();
  const rectBody = document.body.getBoundingClientRect();
  if (rect.top < 100 || rect.top + 100 > window.innerHeight) {
    const targetScrollTop = rect.top - rectBody.top - window.innerHeight * 0.382;
    $('html, body').stop().animate({ scrollTop: targetScrollTop }, 400, 'easeOutCubic');
    await delay(300);
    // delay duration is set smaller than animation duration intentionally
  }
  $container.css('opacity', 0);
  await slideDown($container, 300);
  await $container.transition({ opacity: 1 }, { duration: 200 }).promise();
  $container.removeAttr('style');
}

async function destroyReplyContainer($parent) {
  const $container = $parent.find('.commentbox-container');
  $container.css('opacity', 1);
  await $container.transition({ opacity: 0 }, { duration: 200 }).promise();
  await slideUp($container, 300);
  $container.remove();
}

function onClickDummyBox(ev) {
  const $evTarget = $(ev.currentTarget);

  if (CommentBox.get($evTarget)) {
    CommentBox.get($evTarget).focus();
    return;
  }

  const $mediaBody = $evTarget.closest('.media__body');

  const opt = {
    form: JSON.parse($evTarget.attr('data-form')),
    mode: 'comment',
    onCancel: () => {
      $mediaBody.removeClass('is-editing');
    },
  };

  $mediaBody.addClass('is-editing');

  CommentBox
    .getOrConstruct($evTarget, opt)
    .appendTo($mediaBody.find('.commentbox-placeholder').eq(0))
    .focus();
}

async function onCommentClickReplyComment(ev, options: any = {}) {
  const $evTarget = $(ev.currentTarget);

  if (CommentBox.get($evTarget)) {
    // If comment box is already expanded,
    // we should insert "initialText"
    CommentBox
      .get($evTarget)
      .insertText(options.initialText || '')
      .focus();
    return;
  }

  const $mediaBody = $evTarget.closest('.media__body');

  const opt = {
    initialText: '',
    mode: 'reply',
    ...options,
    onCancel: async () => {
      await destroyReplyContainer($mediaBody);
    },
  };

  const cbox = CommentBox
    .getOrConstruct($evTarget, {
      form: JSON.parse($evTarget.attr('data-form')),
      ...opt,
    })
    .appendTo(createReplyContainer($mediaBody));
  await showReplyContainer($mediaBody);
  cbox.focus();
}

async function onCommentClickReplyReply(ev) {
  const $evTarget = $(ev.currentTarget);
  const $mediaBody = $evTarget.closest('.media__body');
  const uid = $mediaBody
    .find('.user-profile-name')
    .attr('href').split('/user/')[1];

  $evTarget
    .closest('.dczcomments__item')
    .find('[data-op="reply"][data-type="comment"]').eq(0)
    .trigger('click', { initialText: `@[](/user/${uid.trim()}) ` });
}

async function onCommentClickEdit(mode, ev) {
  const $evTarget = $(ev.currentTarget);

  if (CommentBox.get($evTarget)) {
    CommentBox.get($evTarget).focus();
    return;
  }

  const $mediaBody = $evTarget.closest('.media__body');

  const raw = await request.get(
    $mediaBody.find('.typo').eq(0).attr('data-raw-url'),
    {},
    { dataType: 'text' },
  );

  const opt = {
    initialText: raw,
    form: JSON.parse($evTarget.attr('data-form')),
    mode,
    onCancel: () => {
      $mediaBody.removeClass('is-editing');
    },
  };

  $mediaBody.addClass('is-editing');

  CommentBox
    .getOrConstruct($evTarget, opt)
    .appendTo($mediaBody.find('.commentbox-edit-target').eq(0))
    .focus();
}

function onCommentClickEditComment(ev) {
  return onCommentClickEdit('comment-update', ev);
}

function onCommentClickEditReply(ev) {
  return onCommentClickEdit('reply-update', ev);
}

async function onCommentClickDelete(type, ev) {
  const message = (type === 'comment')
    ? 'Confirm deleting this comment? Its replies will be deleted as well.'
    : 'Confirm deleting this reply?';
  const action = await new ConfirmDialog({
    $body: tpl.typoMsg(i18n(message)),
  }).open();
  if (action !== 'yes') return;

  const $evTarget = $(ev.currentTarget);
  const form = JSON.parse($evTarget.attr('data-form'));

  await request.post('', form);
  window.location.reload();
}

function onCommentClickDeleteComment(ev) {
  onCommentClickDelete('comment', ev);
}

function onCommentClickDeleteReply(ev) {
  onCommentClickDelete('reply', ev);
}


async function onCommentClickUploadReplyFile(ev, type, did, drid, drrid, files?) {
  if (!files) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.click();
    await new Promise((resolve) => { input.onchange = resolve; });
    files = input.files;
  }
  if (!files.length) {
    Notification.warn(i18n('No file selected.'));
    return;
  }
  
  const uploadUrl = `/hub/${did}/${drid}/${drrid}/file`;
  await uploadFiles(uploadUrl, files, { type, pjax: true });
}

async function submitD3FormData() {
  const action = await new ConfirmDialog({
    $body: tpl.typoMsg(i18n('Are you sure you want to submit this form?')),
  }).open();
  
  if (action !== 'yes') return;

  const coordinatesInput = (document.getElementById("node-coordinates") as HTMLInputElement).value;
  let formData;
  
  try {
    formData = JSON.parse(coordinatesInput);
  } catch (error) {
    Notification.error(i18n('Invalid form data.'));
    return;
  }

  try {
    console.log('Submitting data:', coordinatesInput);
    document.getElementById("form-data-display").textContent = coordinatesInput;
    document.getElementById("form-data-display").textContent = coordinatesInput;

    const response = await request.post('', coordinatesInput, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log('Form submission response:', response);
    Notification.success(i18n('Form submitted successfully.'));
  } catch (error) {
    console.error('Form submission error:', error);
    Notification.error(i18n('Failed to submit form.'));
  }
}


const commentsPage = new AutoloadPage('commentsPage', () => {
  $(document).ready(() => {
    if ($('#d3-main').length > 0) {
      D3Main();
    }
    if ($('#d3-main-edit').length > 0) {
      D3MainEdit();
    }
    if ($('#d3-sub').length > 0) {
      initD3();
    }
    if ($('#d3-sub-edit').length > 0) {
      D3SubEdit();
    }
  });
  $(document).on('click', '[name="dczcomments__dummy-box"]', onClickDummyBox);
  $(document).on('click', '[data-op="reply"][data-type="comment"]', onCommentClickReplyComment);
  $(document).on('click', '[data-op="reply"][data-type="reply"]', onCommentClickReplyReply);
  $(document).on('click', '[data-op="edit"][data-type="comment"]', onCommentClickEditComment);
  $(document).on('click', '[data-op="edit"][data-type="reply"]', onCommentClickEditReply);
  $(document).on('click', '[data-op="delete"][data-type="comment"]', onCommentClickDeleteComment);
  $(document).on('click', '[data-op="delete"][data-type="reply"]', onCommentClickDeleteReply);
  $(document).on('click', '[data-op="upload"][data-type="replyfile"]', function(ev) {
    const did = $(this).data('did');
    const drid = $(this).data('drid');
    const drrid = $(this).data('drrid');
    onCommentClickUploadReplyFile(ev, 'replyfile', did, drid, drrid);
  });
  $(document).on('submit', '#node-edit-form', function(ev) {
    ev.preventDefault();
    submitD3FormData();
  });

});

export default commentsPage;

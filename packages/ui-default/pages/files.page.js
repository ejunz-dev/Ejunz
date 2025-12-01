import $ from 'jquery';
import _ from 'lodash';
import Clipboard from 'clipboard';
import { ConfirmDialog } from 'vj/components/dialog/index';
import Notification from 'vj/components/notification';
import uploadFiles from 'vj/components/upload';
import { NamedPage } from 'vj/misc/Page';
import {
  i18n, pjax, request, tpl,
} from 'vj/utils';

function ensureAndGetSelectedFiles() {
  const files = _.map(
    $('.files tbody [data-checkbox-group="files"]:checked'),
    (ch) => $(ch).closest('tr').attr('data-filename'),
  );
  if (files.length === 0) {
    Notification.error(i18n('Please select at least one file to perform this operation.'));
    return null;
  }
  return files;
}

async function handleClickUpload(files) {
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
  await uploadFiles('', files, { pjax: true });
}

async function handleClickRemoveSelected() {
  const selectedFiles = ensureAndGetSelectedFiles();
  if (selectedFiles === null) return;
  const action = await new ConfirmDialog({
    $body: tpl`
      <div class="typo">
        <p>${i18n('Confirm to delete the selected files?')}</p>
      </div>`,
  }).open();
  if (action !== 'yes') return;
  try {
    await request.post('', {
      operation: 'delete_files',
      files: selectedFiles,
    });
    Notification.success(i18n('Selected files have been deleted.'));
    await pjax.request({ push: false });
  } catch (error) {
    Notification.error(error.message);
  }
}

/**
 * @param {JQuery.DragOverEvent<HTMLElement, undefined, HTMLElement, HTMLElement>} ev
 */
function handleDragOver(ev) {
  ev.preventDefault();
}

/**
 * @param {JQuery.DropEvent<HTMLElement, undefined, HTMLElement, HTMLElement>} ev
 */
function handleDrop(ev) {
  ev.preventDefault();
  if (!$('[name="upload_file"]').length) {
    Notification.error(i18n("You don't have permission to upload file."));
    return;
  }
  ev = ev.originalEvent;
  const files = [];
  if (ev.dataTransfer.items) {
    for (let i = 0; i < ev.dataTransfer.items.length; i++) {
      if (ev.dataTransfer.items[i].kind === 'file') {
        const file = ev.dataTransfer.items[i].getAsFile();
        files.push(file);
      }
    }
  } else {
    for (let i = 0; i < ev.dataTransfer.files.length; i++) {
      files.push(ev.dataTransfer.files[i]);
    }
  }
  handleClickUpload(files);
}

function updateSortIndicator($sortBtn, direction) {
  $('.sort-btn .sort-indicator').text('⇅').css('opacity', '0.5');
  
  const $indicator = $sortBtn.find('.sort-indicator');
  if (direction === 'asc') {
    $indicator.text('↑').css('opacity', '1');
  } else if (direction === 'desc') {
    $indicator.text('↓').css('opacity', '1');
  }
}

function handleClickSort(ev) {
  ev.preventDefault();
  const $sortBtn = $(ev.currentTarget);
  const sortType = $sortBtn.attr('data-sort');
  const $tbody = $('.files tbody');
  const $rows = $tbody.find('tr').toArray();
  
  const isCurrentSort = $sortBtn.hasClass('active');
  const isAscending = $sortBtn.hasClass('asc');
  
  $('.sort-btn').removeClass('active asc desc');
  
  // 设置新的排序状态
  let newDirection;
  if (isCurrentSort) {
    newDirection = isAscending ? 'desc' : 'asc';
  } else {
    newDirection = 'desc';
  }
  
  $sortBtn.addClass('active').addClass(newDirection);
  updateSortIndicator($sortBtn, newDirection);
  
  $rows.sort((a, b) => {
    let compareResult = 0;
    
    if (sortType === 'name') {
      const nameA = $(a).attr('data-filename') || '';
      const nameB = $(b).attr('data-filename') || '';
      compareResult = nameA.localeCompare(nameB);
    } else if (sortType === 'size') {
      const sizeA = parseInt($(a).attr('data-size') || '0', 10);
      const sizeB = parseInt($(b).attr('data-size') || '0', 10);
      compareResult = sizeA - sizeB;
    } else if (sortType === 'time') {
      const timeA = parseInt($(a).attr('data-last-modified') || '0', 10);
      const timeB = parseInt($(b).attr('data-last-modified') || '0', 10);
      compareResult = timeA - timeB;
    }
    
    return newDirection === 'asc' ? compareResult : -compareResult;
  });
  
  $tbody.empty().append($rows);
}

const page = new NamedPage(['home_files', 'mindmap_files', 'mindmap_files_mmid', 'mindmap_files_branch', 'mindmap_files_branch_mmid'], (pagename, loadPage) => {
  $('.files [data-copyfilelink]').each(function() {
    const $row = $(this).closest('tr');
    const filename = $row.attr('data-filename') || '';
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const baseLink = $(this).attr('data-copyfilelink') || '';
    
    let linkToCopy = baseLink;
    if (ext === 'pdf') {
      linkToCopy = baseLink.includes('?') 
        ? (baseLink.includes('noDisposition=1') ? baseLink : `${baseLink}&noDisposition=1`)
        : `${baseLink}?noDisposition=1`;
    } else {
      if (baseLink.includes('noDisposition=1')) {
        linkToCopy = baseLink.replace(/[?&]noDisposition=1/, '').replace(/\?$/, '');
      }
    }
    
    const clip = new Clipboard(this, { text: () => linkToCopy });
    clip.on('success', () => Notification.success(i18n('Link copied to clipboard!')));
    clip.on('error', () => Notification.error(i18n('Copy failed :(')));
  });
  
  $(document).on('click', '[name="upload_file"]', () => handleClickUpload());
  $(document).on('click', '[name="remove_selected"]', () => handleClickRemoveSelected());
  $(document).on('click', '.sort-btn', handleClickSort);
  $(document).on('dragover', '.files', (ev) => handleDragOver(ev));
  $(document).on('drop', '.files', (ev) => handleDrop(ev));
});

export default page;

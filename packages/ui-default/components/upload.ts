import { Dialog } from 'vj/components/dialog/index';
import Notification from 'vj/components/notification';
import {
  delay, i18n, pjax, request,
} from 'vj/utils';

function onBeforeUnload(e) {
  e.returnValue = '';
}

interface UploadOptions {
  type?: string;
  pjax?: boolean;
  sidebar?: boolean;
  singleFileUploadCallback?: (file: File) => any;
  filenameCallback?: (file: File) => string;
}

async function compressImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (e) => {
      const img = new Image();
      img.src = e.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        
        const maxSize = 2000;
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Compress image failed'));
            return;
          }
          const compressedFile = new File([blob], file.name, {
            type: 'image/jpeg',
            lastModified: Date.now(),
          });
          resolve(compressedFile);
        }, 'image/jpeg', 0.8);
      };
      img.onerror = () => reject(new Error('Load image failed'));
    };
    reader.onerror = () => reject(new Error('Read file failed'));
  });
}

export default async function uploadFiles(endpoint = '', files: File[] | FileList = [], options: UploadOptions = {}) {
  const dialog = new Dialog({
    $body: `
      <div class="file-label" style="text-align: center; margin-bottom: 5px; color: gray; font-size: small;"></div>
      <div class="bp5-progress-bar bp5-intent-primary bp5-no-stripes">
        <div class="file-progress bp5-progress-meter" style="width: 0"></div>
      </div>
      <div class="upload-label" style="text-align: center; margin: 5px 0; color: gray; font-size: small;"></div>
      <div class="bp5-progress-bar bp5-intent-primary bp5-no-stripes">
        <div class="upload-progress bp5-progress-meter" style="width: 0"></div>
      </div>`,
  });
  try {
    Notification.info(i18n('Uploading files...'));
    window.addEventListener('beforeunload', onBeforeUnload);
    dialog.open();
    const $uploadLabel = dialog.$dom.find('.dialog__body .upload-label');
    const $uploadProgress = dialog.$dom.find('.dialog__body .upload-progress');
    const $fileLabel = dialog.$dom.find('.dialog__body .file-label');
    const $fileProgress = dialog.$dom.find('.dialog__body .file-progress');
    
    const processedFiles: File[] = [];
    for (const i in files) {
      if (Number.isNaN(+i)) continue;
      const file = files[i];
      
      if (file.type.startsWith('image/') && file.size > 1024 * 1024) {
        try {
          $fileLabel.text(i18n('Compressing image...'));
          const compressedFile = await compressImage(file);
          processedFiles.push(compressedFile);
          Notification.info(i18n('Image compressed from {0}MB to {1}MB', 
            (file.size / (1024 * 1024)).toFixed(2),
            (compressedFile.size / (1024 * 1024)).toFixed(2)
          ));
        } catch (e) {
          console.error('Image compression failed:', e);
          processedFiles.push(file);
        }
      } else {
        processedFiles.push(file);
      }
    }

    for (const i in processedFiles) {
      if (Number.isNaN(+i)) continue;
      const file = processedFiles[i];
      const data = new FormData();
      data.append('filename', options.filenameCallback?.(file) || file.name);
      data.append('file', file);
      if (options.type) data.append('type', options.type);
      data.append('operation', 'upload_file');
      await request.postFile(endpoint, data, {
        xhr() {
          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener('loadstart', () => {
            $fileLabel.text(`[${+i + 1}/${processedFiles.length}] ${file.name}`);
            $fileProgress.width(`${Math.round((+i + 1) / processedFiles.length * 100)}%`);
            $uploadLabel.text(i18n('Uploading... ({0}%)', 0));
            $uploadProgress.width(0);
          });
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const percentComplete = Math.round((e.loaded / e.total) * 100);
              if (percentComplete === 100) $uploadLabel.text(i18n('Processing...'));
              else $uploadLabel.text(i18n('Uploading... ({0}%)', percentComplete));
              $uploadProgress.width(`${percentComplete}%`);
            }
          }, false);
          return xhr;
        },
      });
      await options.singleFileUploadCallback?.(file);
    }
    window.removeEventListener('beforeunload', onBeforeUnload);
    Notification.success(i18n('File uploaded successfully.'));
    if (options.pjax) {
      let params = '';
      if (options.type) params += `?d=${options.type}`;
      if (options.sidebar) params += `${params ? '&' : '?'}sidebar=true`;
      await pjax.request({ push: false, url: `${endpoint}${params || ''}` });
    }
  } catch (e) {
    console.error(e);
    Notification.error(i18n('File upload failed: {0}', e.toString()));
  } finally {
    await delay(500);
    dialog.close();
  }
}

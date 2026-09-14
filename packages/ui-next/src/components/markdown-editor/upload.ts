import { useCallback } from 'react';
import { useUserContext } from '../../context/page-data';
import { useBuildUrl } from '../../hooks/use-build-url';

const IMAGE_TYPE = /^image\/(png|jpg|jpeg|gif|webp)$/i;

const COMPRESS_THRESHOLD_BYTES = 1024 * 1024;
const COMPRESS_MAX_EDGE = 2000;
const COMPRESS_QUALITY = 0.8;

export function isUploadableImage(file: File): boolean {
  return IMAGE_TYPE.test(file.type);
}

function fileExtension(file: File): string {
  return IMAGE_TYPE.exec(file.type)?.[1].toLowerCase() || 'png';
}

function uploadFilename(file: File): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.${fileExtension(file)}`;
}

async function compressImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', COMPRESS_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  }
}

export function useUserFileUpload(): (files: File[]) => Promise<string[]> {
  const buildUrl = useBuildUrl();
  const { _id: userId } = useUserContext();

  return useCallback(async (files: File[]) => {
    const urls: string[] = [];
    for (const file of files) {
      const target = file.size > COMPRESS_THRESHOLD_BYTES ? await compressImage(file) : file;
      const filename = uploadFilename(target);
      const body = new FormData();
      body.append('filename', filename);
      body.append('file', target, filename);
      body.append('operation', 'upload_file');
      const response = await fetch(buildUrl('home_files'), { method: 'POST', body, credentials: 'same-origin' });
      if (!response.ok || response.url.includes('/login')) throw new Error(`Upload failed with HTTP ${response.status}`);
      urls.push(buildUrl('fs_download', { uid: String(userId), filename }));
    }
    return urls;
  }, [buildUrl, userId]);
}

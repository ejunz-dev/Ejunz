import { i18n } from '../../i18n';

const IMAGE_TYPE = /^image\/(png|jpg|jpeg|gif|webp)$/i;
const ANIMATED_IMAGE_TYPE = /^image\/gif$/i;
const UPLOAD_OPERATION = 'upload_file';

const COMPRESS_THRESHOLD_BYTES = 1024 * 1024;
const COMPRESS_MAX_EDGE = 2000;
const COMPRESS_QUALITY = 0.8;

export function isUploadableImage(file: File): boolean {
  return IMAGE_TYPE.test(file.type);
}

function fileExtension(file: File): string {
  return IMAGE_TYPE.exec(file.type)?.[1].toLowerCase() || 'png';
}

function imageStem(file: File): string {
  return file.name.replace(/\.[^./\\]*$/, '') || 'image';
}

export function defaultUploadFilename(file: File): string {
  if (!isUploadableImage(file)) return file.name;
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.${fileExtension(file)}`;
}

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || ANIMATED_IMAGE_TYPE.test(file.type)) return file;
  if (file.size <= COMPRESS_THRESHOLD_BYTES) return file;
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
    return new File([blob], `${imageStem(file)}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  }
}

export type UploadPhase = 'compressing' | 'uploading' | 'processing';

export interface UploadProgress {
  fileIndex: number;
  fileCount: number;
  filename: string;
  phase: UploadPhase;
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadedFile {
  file: File;
  filename: string;
  response: unknown;
}

export interface UploadOptions {
  type?: string;
  filename?: (file: File) => string;
  compress?: boolean;
  onProgress?: (progress: UploadProgress) => void;
  onFileUploaded?: (uploaded: UploadedFile) => void | Promise<void>;
}

interface ServerErrorBody {
  message: string;
  params?: Array<string | number>;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorBody(payload: unknown): ServerErrorBody | null {
  if (!payload || typeof payload !== 'object') return null;
  const { error } = payload as { error?: unknown };
  if (!error || typeof error !== 'object') return null;
  const { message, params } = error as { message?: unknown, params?: unknown };
  if (typeof message !== 'string' || !message) return null;
  const list = Array.isArray(params)
    ? params.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    : [];
  return { message, params: list.length ? list : undefined };
}

function uploadError(status: number, text: string): Error {
  const body = errorBody(parseJson(text));
  if (body) return new Error(i18n(body.message, ...(body.params || [])));
  return new Error(i18n('File upload failed: {0}', `HTTP ${status}`));
}

function postForm(endpoint: string, form: FormData, onSent: (loaded: number, total: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onSent(event.loaded, event.total);
    });
    xhr.addEventListener('load', () => {
      if ((xhr.responseURL || '').includes('/login')) {
        reject(new Error(i18n('Not logged in')));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(uploadError(xhr.status, xhr.responseText));
        return;
      }
      resolve(parseJson(xhr.responseText));
    });
    xhr.addEventListener('error', () => reject(new Error(i18n('Network error'))));
    xhr.addEventListener('abort', () => reject(new Error(i18n('Upload aborted'))));
    xhr.send(form);
  });
}

export async function uploadFiles(endpoint: string, files: File[], options: UploadOptions = {}): Promise<UploadedFile[]> {
  const {
    type, filename, compress = true, onProgress, onFileUploaded,
  } = options;
  const uploaded: UploadedFile[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const name = filename?.(file) || defaultUploadFilename(file);
    const emit = (phase: UploadPhase, loaded = 0, total = 0) => onProgress?.({
      fileIndex: index + 1,
      fileCount: files.length,
      filename: name,
      phase,
      loaded,
      total,
      percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
    });

    const compressible = compress
      && file.type.startsWith('image/')
      && !ANIMATED_IMAGE_TYPE.test(file.type)
      && file.size > COMPRESS_THRESHOLD_BYTES;
    if (compressible) emit('compressing');
    const target = compress ? await compressImage(file) : file;

    const form = new FormData();
    form.append('filename', name);
    form.append('file', target, name);
    if (type) form.append('type', type);
    form.append('operation', UPLOAD_OPERATION);

    emit('uploading');
    const response = await postForm(endpoint, form, (loaded, total) => {
      emit(loaded >= total ? 'processing' : 'uploading', loaded, total);
    });
    const result: UploadedFile = { file, filename: name, response };
    uploaded.push(result);
    await onFileUploaded?.(result);
  }
  return uploaded;
}

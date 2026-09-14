import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useBuildUrl } from '../../hooks/use-build-url';
import { i18n } from '../../i18n';
import Notification from '../notification';
import UploadProgressDialog, { type UploadDialogState } from './UploadProgressDialog';
import {
  isUploadableImage, uploadFiles,
  type UploadOptions, type UploadProgress, type UploadedFile,
} from './upload';

const DEFAULT_ENDPOINT = 'home_files';

export interface UseUploadFilesOptions {
  endpoint?: string | (() => string);
  type?: string;
  imagesOnly?: boolean;
  compress?: boolean;
  filename?: (file: File) => string;
  onFileUploaded?: (uploaded: UploadedFile) => void | Promise<void>;
  notify?: boolean;
}

export interface UseUploadFilesResult {
  upload: (files: File[] | FileList) => Promise<UploadedFile[]>;
  dialog: ReactElement | null;
  uploading: boolean;
}

function dialogState(progress: UploadProgress): UploadDialogState {
  let uploadLabel = i18n('Uploading... ({0}%)', progress.percent);
  if (progress.phase === 'compressing') uploadLabel = i18n('Compressing image...');
  else if (progress.phase === 'processing') uploadLabel = i18n('Processing...');
  return {
    fileLabel: `[${progress.fileIndex}/${progress.fileCount}] ${progress.filename}`,
    filePercent: Math.round((progress.fileIndex / progress.fileCount) * 100),
    uploadLabel,
    uploadPercent: progress.percent,
  };
}

export function useUploadFiles(options: UseUploadFilesOptions = {}): UseUploadFilesResult {
  const {
    endpoint = DEFAULT_ENDPOINT, type, imagesOnly = false,
    compress, filename, onFileUploaded, notify = true,
  } = options;
  const buildUrl = useBuildUrl();
  const [state, setState] = useState<UploadDialogState | null>(null);
  const runIdRef = useRef(0);

  const resolveEndpoint = useCallback(() => {
    const target = typeof endpoint === 'function' ? endpoint() : endpoint;
    if (target.startsWith('/') || /^[a-z]+:\/\//i.test(target)) return target;
    return buildUrl(target);
  }, [buildUrl, endpoint]);

  useEffect(() => {
    if (!state) return undefined;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [state]);

  const upload = useCallback(async (files: File[] | FileList): Promise<UploadedFile[]> => {
    const list = Array.from(files);
    if (!list.length) {
      if (notify) Notification.warn(i18n('No file selected.'));
      return [];
    }
    const selected = imagesOnly ? list.filter(isUploadableImage) : list;
    if (!selected.length) {
      if (notify) Notification.warn(i18n('Unsupported file type. Please upload an image (png, jpg, jpeg, gif).'));
      return [];
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const show = (progress: UploadProgress) => {
      if (runIdRef.current === runId) setState(dialogState(progress));
    };
    const stored: UploadedFile[] = [];
    const progressOptions: UploadOptions = {
      type,
      filename,
      compress,
      onProgress: show,
      onFileUploaded: async (uploaded) => {
        stored.push(uploaded);
        await onFileUploaded?.(uploaded);
      },
    };
    show({
      fileIndex: 1, fileCount: selected.length, filename: selected[0].name, phase: 'uploading', loaded: 0, total: 0, percent: 0,
    });
    try {
      const uploaded = await uploadFiles(resolveEndpoint(), selected, progressOptions);
      if (notify) Notification.success(i18n('File uploaded successfully.'));
      return uploaded;
    } catch (error) {
      if (notify) {
        Notification.error(i18n('File upload failed: {0}', error instanceof Error ? error.message : String(error)));
      }
      return stored;
    } finally {
      if (runIdRef.current === runId) setState(null);
    }
  }, [compress, filename, imagesOnly, notify, onFileUploaded, resolveEndpoint, type]);

  return {
    upload,
    uploading: state !== null,
    dialog: state
      ? <UploadProgressDialog title={i18n('Uploading files...')} {...state} />
      : null,
  };
}

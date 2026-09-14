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
  /**
   * Route name resolved through the route map, or an explicit path/URL, or a
   * getter returning either. Defaults to the `home_files` route.
   */
  endpoint?: string | (() => string);
  /** Extra `type` form field read by per-feature upload endpoints. */
  type?: string;
  /** Reject anything that is not an accepted image; defaults to false. */
  imagesOnly?: boolean;
  /** Re-encode images above 1 MB before upload; defaults to true. */
  compress?: boolean;
  /** Server-side storage name; defaults to a collision-resistant name per file. */
  filename?: (file: File) => string;
  /** Awaited after each file lands, with the file already stored on the server. */
  onFileUploaded?: (uploaded: UploadedFile) => void | Promise<void>;
  /** Show success and failure notifications; defaults to true. */
  notify?: boolean;
}

export interface UseUploadFilesResult {
  /** Uploads the given files and reports what was stored; failures are notified, not thrown. */
  upload: (files: File[] | FileList) => Promise<UploadedFile[]>;
  /** Progress dialog for the running upload; render it while `uploading` is true. */
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

/**
 * Uploads files through the shared progress dialog: filters the selection,
 * compresses oversized images, reports success and failure with notifications,
 * and returns whatever was stored so callers can build links themselves.
 * @param options Endpoint, filtering, naming, and notification behavior.
 */
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
      // Files stored before the failure stay usable; only the rest is lost.
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

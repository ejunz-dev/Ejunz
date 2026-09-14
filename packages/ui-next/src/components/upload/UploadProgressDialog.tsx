import { createPortal } from 'react-dom';

export interface UploadDialogState {
  /** Current file, shown as `[i/n] name`. */
  fileLabel: string;
  /** Percent of the whole batch, 0-100. */
  filePercent: number;
  /** Phase of the current file, already translated. */
  uploadLabel: string;
  /** Percent of the current file, 0-100. */
  uploadPercent: number;
}

export interface UploadProgressDialogProps extends UploadDialogState {
  title: string;
}

/**
 * Modal progress bars for a running upload: batch progress on top, current file
 * below. Uploads cannot be paused, so the dialog carries no actions.
 * @param props Dialog title, labels, and percentages.
 */
export default function UploadProgressDialog({
  title, fileLabel, filePercent, uploadLabel, uploadPercent,
}: UploadProgressDialogProps) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="uix-upload-backdrop">
      <div className="uix-upload-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <p className="uix-upload-dialog__title">{title}</p>
        <div className="uix-upload-dialog__label">{fileLabel}</div>
        <div className="uix-upload-bar">
          <div className="uix-upload-bar__meter" style={{ width: `${filePercent}%` }} />
        </div>
        <div className="uix-upload-dialog__label">{uploadLabel}</div>
        <div className="uix-upload-bar">
          <div className="uix-upload-bar__meter" style={{ width: `${uploadPercent}%` }} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

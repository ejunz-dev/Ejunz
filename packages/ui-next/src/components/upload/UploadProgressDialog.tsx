import { createPortal } from 'react-dom';

export interface UploadDialogState {
  fileLabel: string;
  filePercent: number;
  uploadLabel: string;
  uploadPercent: number;
}

export interface UploadProgressDialogProps extends UploadDialogState {
  title: string;
}

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

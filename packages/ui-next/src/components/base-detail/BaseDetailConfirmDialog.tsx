import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { i18n } from '../../i18n';

interface Props {
  nodeLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BaseDetailConfirmDialog({ nodeLabel, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, onConfirm]);

  return createPortal(
    <>
      <button type="button" className="bd-confirm-backdrop" onClick={onCancel} aria-label={i18n('Close')} />
      <div className="bd-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="bd-confirm-title" aria-describedby="bd-confirm-description">
        <h2 id="bd-confirm-title">{i18n('Confirm')}</h2>
        <p id="bd-confirm-description">{nodeLabel}</p>
        <div className="bd-confirm-dialog__actions">
          <button type="button" onClick={onCancel}>{i18n('Cancel')}</button>
          <button ref={confirmRef} type="button" className="is-primary" onClick={onConfirm}>{i18n('Confirm')}</button>
        </div>
      </div>
    </>,
    document.body,
  );
}

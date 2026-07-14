import React, { useEffect, useState } from 'react';
import { i18n } from 'vj/utils';
import type { BaseEditorDisplaySettings } from './types';

const DEFAULT_DISPLAY_SETTINGS: BaseEditorDisplaySettings = {
  showProblemCount: false,
  showNodeNumber: false,
  showNodeCardTimestamps: false,
};

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0 .33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export type BaseEditorDisplaySettingsPanelProps = {
  open: boolean;
  settings: BaseEditorDisplaySettings;
  onClose: () => void;
  onApply: (settings: BaseEditorDisplaySettings) => void;
};

export function BaseEditorDisplaySettingsPanel({
  open,
  settings,
  onClose,
  onApply,
}: BaseEditorDisplaySettingsPanelProps) {
  const [draft, setDraft] = useState<BaseEditorDisplaySettings>(settings);

  useEffect(() => {
    if (!open) return undefined;
    setDraft(settings);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, settings]);

  if (!open) return null;

  const handleApply = () => {
    onApply(draft);
  };

  return (
    <>
      <div
        className="roadmap-detail-settings__backdrop"
        onClick={onClose}
        aria-hidden
      />
      <div
        className="roadmap-detail-settings__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="base-editor-display-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="roadmap-detail-settings__header">
          <h2 id="base-editor-display-settings-title" className="roadmap-detail-settings__title">
            <SettingsIcon />
            {i18n('Base editor display settings title')}
          </h2>
          <button
            type="button"
            className="roadmap-detail-settings__close"
            onClick={onClose}
            aria-label={i18n('Close')}
          >
            ×
          </button>
        </div>
        <p className="roadmap-detail-settings__hint">
          {i18n('Base editor display settings hint')}
        </p>
        <div className="roadmap-detail-settings__list">
          <label className="roadmap-detail-settings__row">
            <div className="roadmap-detail-settings__row-text">
              <span className="roadmap-detail-settings__row-label">
                {i18n('Roadmap detail settings show problem count')}
              </span>
              <span className="roadmap-detail-settings__row-desc">
                {i18n('Roadmap detail settings show problem count hint')}
              </span>
            </div>
            <input
              type="checkbox"
              className="roadmap-detail-settings__toggle"
              checked={draft.showProblemCount}
              onChange={(e) => setDraft({
                ...DEFAULT_DISPLAY_SETTINGS,
                ...draft,
                showProblemCount: e.currentTarget.checked,
              })}
            />
          </label>
          <label className="roadmap-detail-settings__row">
            <div className="roadmap-detail-settings__row-text">
              <span className="roadmap-detail-settings__row-label">
                {i18n('Roadmap detail settings show node number')}
              </span>
              <span className="roadmap-detail-settings__row-desc">
                {i18n('Roadmap detail settings show node number hint')}
              </span>
            </div>
            <input
              type="checkbox"
              className="roadmap-detail-settings__toggle"
              checked={draft.showNodeNumber}
              onChange={(e) => setDraft({
                ...DEFAULT_DISPLAY_SETTINGS,
                ...draft,
                showNodeNumber: e.currentTarget.checked,
              })}
            />
          </label>
          <label className="roadmap-detail-settings__row">
            <div className="roadmap-detail-settings__row-text">
              <span className="roadmap-detail-settings__row-label">
                {i18n('Roadmap detail settings show node card timestamps')}
              </span>
              <span className="roadmap-detail-settings__row-desc">
                {i18n('Roadmap detail settings show node card timestamps hint')}
              </span>
            </div>
            <input
              type="checkbox"
              className="roadmap-detail-settings__toggle"
              checked={draft.showNodeCardTimestamps}
              onChange={(e) => setDraft({
                ...DEFAULT_DISPLAY_SETTINGS,
                ...draft,
                showNodeCardTimestamps: e.currentTarget.checked,
              })}
            />
          </label>
        </div>
        <div className="roadmap-detail-settings__actions">
          <button
            type="button"
            className="roadmap-detail-settings__btn"
            onClick={onClose}
          >
            {i18n('Cancel')}
          </button>
          <button
            type="button"
            className="roadmap-detail-settings__btn roadmap-detail-settings__btn--primary"
            onClick={handleApply}
          >
            {i18n('Apply')}
          </button>
        </div>
      </div>
    </>
  );
}

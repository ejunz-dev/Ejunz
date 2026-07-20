import React, { useEffect, useState } from 'react';
import { i18n } from 'vj/utils';
import {
  defaultBaseDetailDisplaySettings,
  type BaseDetailDisplaySettings,
} from './detail_display_settings';

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

export type BaseDetailSettingsPanelProps = {
  open: boolean;
  settings: BaseDetailDisplaySettings;
  saving?: boolean;
  onClose: () => void;
  onSave: (settings: BaseDetailDisplaySettings) => void | Promise<void>;
};

export function BaseDetailSettingsPanel({
  open,
  settings,
  saving = false,
  onClose,
  onSave,
}: BaseDetailSettingsPanelProps) {
  const [draft, setDraft] = useState<BaseDetailDisplaySettings>(settings);

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

  const handleSave = () => {
    void onSave(draft);
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
        aria-labelledby="roadmap-detail-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="roadmap-detail-settings__header">
          <h2 id="roadmap-detail-settings-title" className="roadmap-detail-settings__title">
            <SettingsIcon />
            {i18n('Roadmap detail settings title')}
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
          {i18n('Roadmap detail settings hint')}
        </p>
        <div className="roadmap-detail-settings__actions">
          <button
            type="button"
            className="roadmap-detail-settings__btn"
            disabled={saving}
            onClick={() => setDraft({
              ...draft,
              showProblemCount: true,
              showNodeNumber: true,
              showNodeCardTimestamps: true,
              showProblemTree: true,
              showProblemTags: true,
              showCardTags: true,
              showAiTutor: true,
              showExpandSaveIndicator: true,
              showToolbar: true,
            })}
          >
            {i18n('Select all')}
          </button>
          <button
            type="button"
            className="roadmap-detail-settings__btn"
            disabled={saving}
            onClick={() => setDraft({
              ...draft,
              showProblemCount: false,
              showNodeNumber: false,
              showNodeCardTimestamps: false,
              showProblemTree: false,
              showProblemTags: false,
              showCardTags: false,
              showAiTutor: false,
              showExpandSaveIndicator: false,
              showToolbar: false,
            })}
          >
            {i18n('Deselect all')}
          </button>
        </div>
        <div className="roadmap-detail-settings__actions" style={{ marginTop: 4 }}>
          <button
            type="button"
            className="roadmap-detail-settings__btn"
            disabled={saving}
            onClick={async () => {
              await onSave({
                ...draft,
                indicatorX: 320,
                indicatorY: 72,
                toolbarOpen: false,
                toolbarX: 320,
                toolbarY: 108,
                wsIndicatorX: 40,
                wsIndicatorY: 40,
                wsIndicatorOpen: true,
                cardDrawerWidth: 420,
                treeDrawerWidth: 320,
              });
            }}
          >
            {i18n('Reset positions to defaults')}
          </button>
        </div>
        <div className="roadmap-detail-settings__list" style={{ overflowY: 'auto', maxHeight: '60vh' }}>
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
              disabled={saving}
              onChange={(e) => setDraft({
                ...defaultBaseDetailDisplaySettings(),
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
              disabled={saving}
              onChange={(e) => setDraft({
                ...defaultBaseDetailDisplaySettings(),
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
              disabled={saving}
              onChange={(e) => setDraft({
                ...defaultBaseDetailDisplaySettings(),
                ...draft,
                showNodeCardTimestamps: e.currentTarget.checked,
              })}
            />
          </label>
          <label className="roadmap-detail-settings__row">
            <div className="roadmap-detail-settings__row-text">
              <span className="roadmap-detail-settings__row-label">
                {i18n('Show problem tree')}
              </span>
              <span className="roadmap-detail-settings__row-desc">
                {i18n('Show problems nested under cards in the tree view')}
              </span>
            </div>
            <input
              type="checkbox"
              className="roadmap-detail-settings__toggle"
              checked={draft.showProblemTree}
              disabled={saving}
              onChange={(e) => setDraft({
                ...defaultBaseDetailDisplaySettings(),
                ...draft,
                showProblemTree: e.currentTarget.checked,
              })}
            />
          </label>
          {draft.showProblemTree ? (
            <label className="roadmap-detail-settings__row" style={{ paddingLeft: 24, opacity: 0.85 }}>
              <div className="roadmap-detail-settings__row-text">
                <span className="roadmap-detail-settings__row-label">
                  {i18n('Show problem tags')}
                </span>
                <span className="roadmap-detail-settings__row-desc">
                  {i18n('Show problem tags hint')}
                </span>
              </div>
              <input
                type="checkbox"
                className="roadmap-detail-settings__toggle"
                checked={draft.showProblemTags}
                disabled={saving}
                onChange={(e) => setDraft({
                  ...defaultBaseDetailDisplaySettings(),
                  ...draft,
                  showProblemTags: e.currentTarget.checked,
                })}
              />
            </label>
          ) : null}
          <label className="roadmap-detail-settings__row">
            <div className="roadmap-detail-settings__row-text">
              <span className="roadmap-detail-settings__row-label">
                {i18n('Show card tags')}
              </span>
              <span className="roadmap-detail-settings__row-desc">
                {i18n('Show card tags hint')}
              </span>
            </div>
            <input
              type="checkbox"
              className="roadmap-detail-settings__toggle"
              checked={draft.showCardTags}
              disabled={saving}
              onChange={(e) => setDraft({
                ...defaultBaseDetailDisplaySettings(),
                ...draft,
                showCardTags: e.currentTarget.checked,
              })}
            />
          </label>
          <label className="roadmap-detail-settings__row">
            <div className="roadmap-detail-settings__row-text">
              <span className="roadmap-detail-settings__row-label">
                {i18n('Show AI tutor')}
              </span>
              <span className="roadmap-detail-settings__row-desc">
                {i18n('Show floating AI tutor entry at bottom right')}
              </span>
            </div>
            <input
              type="checkbox"
              className="roadmap-detail-settings__toggle"
              checked={draft.showAiTutor}
              disabled={saving}
              onChange={(e) => setDraft({
                ...defaultBaseDetailDisplaySettings(),
                ...draft,
                showAiTutor: e.currentTarget.checked,
              })}
            />
          </label>
          <label className="roadmap-detail-settings__row">
            <div className="roadmap-detail-settings__row-text">
              <span className="roadmap-detail-settings__row-label">
                {i18n('Show save status indicator')}
              </span>
              <span className="roadmap-detail-settings__row-desc">
                {i18n('Show tree expand state save indicator at top right')}
              </span>
            </div>
            <input
              type="checkbox"
              className="roadmap-detail-settings__toggle"
              checked={draft.showExpandSaveIndicator}
              disabled={saving}
              onChange={(e) => setDraft({
                ...defaultBaseDetailDisplaySettings(),
                ...draft,
                showExpandSaveIndicator: e.currentTarget.checked,
              })}
            />
          </label>
          <label className="roadmap-detail-settings__row">
            <div className="roadmap-detail-settings__row-text">
              <span className="roadmap-detail-settings__row-label">
                {i18n('Show toolbar')}
              </span>
              <span className="roadmap-detail-settings__row-desc">
                {i18n('Show floating toolbar with scroll, structure and search')}
              </span>
            </div>
            <input
              type="checkbox"
              className="roadmap-detail-settings__toggle"
              checked={draft.showToolbar}
              disabled={saving}
              onChange={(e) => setDraft({
                ...defaultBaseDetailDisplaySettings(),
                ...draft,
                showToolbar: e.currentTarget.checked,
              })}
            />
          </label>
        </div>
        <div className="roadmap-detail-settings__actions">
          <button
            type="button"
            className="roadmap-detail-settings__btn"
            onClick={onClose}
            disabled={saving}
          >
            {i18n('Cancel')}
          </button>
          <button
            type="button"
            className="roadmap-detail-settings__btn roadmap-detail-settings__btn--primary"
            onClick={handleSave}
            disabled={saving}
          >
            {i18n('Save')}
          </button>
        </div>
      </div>
    </>
  );
}

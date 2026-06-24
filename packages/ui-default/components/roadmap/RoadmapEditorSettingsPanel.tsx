import React, { useEffect, useState } from 'react';
import { i18n } from 'vj/utils';
import type { EditorThemeStyles } from 'vj/components/editor_workspace/theme';
import {
  defaultRoadmapDetailDisplaySettings,
  type RoadmapDetailDisplaySettings,
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

export function RoadmapSettingsRailIcon() {
  return <SettingsIcon />;
}

export function RoadmapEditorSettingsPanel({
  settings,
  themeStyles,
  onApply,
}: {
  settings: RoadmapDetailDisplaySettings;
  themeStyles: EditorThemeStyles;
  onApply: (next: RoadmapDetailDisplaySettings) => void;
}) {
  const [draft, setDraft] = useState<RoadmapDetailDisplaySettings>(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const dirty = draft.showProblemCount !== settings.showProblemCount
    || draft.showNodeNumber !== settings.showNodeNumber;

  return (
    <div className="roadmap-editor-settings">
      <p className="roadmap-editor-settings__hint" style={{ color: themeStyles.textSecondary }}>
        {i18n('Roadmap editor settings hint')}
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
              ...defaultRoadmapDetailDisplaySettings(),
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
              ...defaultRoadmapDetailDisplaySettings(),
              ...draft,
              showNodeNumber: e.currentTarget.checked,
            })}
          />
        </label>
      </div>
      <div className="roadmap-editor-settings__actions">
        <button
          type="button"
          className="roadmap-detail-settings__btn"
          disabled={!dirty}
          onClick={() => setDraft(settings)}
        >
          {i18n('Cancel')}
        </button>
        <button
          type="button"
          className="roadmap-detail-settings__btn roadmap-detail-settings__btn--primary"
          disabled={!dirty}
          onClick={() => onApply(draft)}
        >
          {i18n('Save')}
        </button>
      </div>
    </div>
  );
}

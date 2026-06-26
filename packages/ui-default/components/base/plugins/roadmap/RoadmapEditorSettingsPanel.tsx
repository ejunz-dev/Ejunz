import React, { useEffect, useState } from 'react';
import { i18n } from 'vj/utils';
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

export function RoadmapCanvasRailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="2.5" y="3" width="4.5" height="3" rx="0.5" />
      <rect x="9" y="3" width="4.5" height="3" rx="0.5" />
      <rect x="5.5" y="10" width="5" height="3" rx="0.5" />
      <path d="M4.75 6v2.5M11.25 6v2.5" />
    </svg>
  );
}

export function RoadmapSettingsRailIcon() {
  return <SettingsIcon />;
}

function installRoadmapSettingsPanelCss() {
  const styleId = 'base-roadmap-settings-css';
  if (document.getElementById(styleId)) return;
  const s = document.createElement('style');
  s.id = styleId;
  s.textContent = [
    '.roadmap-detail-settings__list{display:flex;flex-direction:column;gap:10px}',
    '.roadmap-detail-settings__row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid rgba(0,0,0,0.08);border-radius:8px;background:rgba(0,0,0,0.02)}',
    '.roadmap-detail-settings__row-text{display:flex;flex-direction:column;gap:4px;min-width:0}',
    '.roadmap-detail-settings__row-label{font-size:13px;font-weight:600;line-height:1.35}',
    '.roadmap-detail-settings__row-desc{font-size:12px;line-height:1.45;opacity:0.72}',
    '.roadmap-detail-settings__toggle{width:16px;height:16px;margin-top:2px;flex-shrink:0}',
    '.roadmap-detail-settings__actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:auto;padding-top:16px}',
    '.roadmap-detail-settings__btn{padding:6px 12px;border:1px solid rgba(0,0,0,0.15);border-radius:6px;background:transparent;font-size:13px;cursor:pointer}',
    '.roadmap-detail-settings__btn:disabled{opacity:0.45;cursor:not-allowed}',
    '.roadmap-detail-settings__btn--primary{border-color:#4135d6;background:#4135d6;color:#fff}',
    '.roadmap-editor-settings{display:flex;flex-direction:column;height:100%;min-height:0;padding:12px 14px;overflow-y:auto}',
    '.roadmap-editor-settings__hint{margin:0 0 12px;font-size:12px;line-height:1.5}',
    '.roadmap-editor-settings__actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:auto;padding-top:16px}',
  ].join('');
  document.head.appendChild(s);
}

export function RoadmapEditorSettingsPanel({
  settings,
  themeStyles,
  onApply,
}: {
  settings: RoadmapDetailDisplaySettings;
  themeStyles: Record<string, string>;
  onApply: (next: RoadmapDetailDisplaySettings) => void;
}) {
  const [draft, setDraft] = useState<RoadmapDetailDisplaySettings>(settings);

  useEffect(() => {
    installRoadmapSettingsPanelCss();
  }, []);

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
            <span className="roadmap-detail-settings__row-desc" style={{ color: themeStyles.textSecondary }}>
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
            <span className="roadmap-detail-settings__row-desc" style={{ color: themeStyles.textSecondary }}>
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

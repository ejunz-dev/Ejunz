import { useEffect, useState } from 'react';
import { i18n } from '../../i18n';
import {
  defaultBaseDetailDisplaySettings,
  type BaseDetailDisplaySettings,
} from './display-settings';

interface Props {
  open: boolean;
  settings: BaseDetailDisplaySettings;
  saving?: boolean;
  onClose: () => void;
  onSave: (settings: BaseDetailDisplaySettings) => void | Promise<void>;
}

type BooleanSettingKey = {
  [K in keyof BaseDetailDisplaySettings]: BaseDetailDisplaySettings[K] extends boolean ? K : never;
}[keyof BaseDetailDisplaySettings];

const rows: Array<{ key: BooleanSettingKey; label: string; description: string }> = [
  { key: 'showProblemCount', label: i18n('Roadmap detail settings show problem count'), description: i18n('Roadmap detail settings show problem count hint') },
  { key: 'showNodeNumber', label: i18n('Roadmap detail settings show node number'), description: i18n('Roadmap detail settings show node number hint') },
  { key: 'showNodeCardTimestamps', label: i18n('Roadmap detail settings show node card timestamps'), description: i18n('Roadmap detail settings show node card timestamps hint') },
  { key: 'showProblemTree', label: i18n('Show problem tree'), description: i18n('Show problems nested under cards in the tree view') },
  { key: 'showCardTags', label: i18n('Show card tags'), description: i18n('Show card tags hint') },
  { key: 'showAiTutor', label: i18n('Show AI tutor'), description: i18n('Show floating AI tutor entry at bottom right') },
  { key: 'showExpandSaveIndicator', label: i18n('Show save status indicator'), description: i18n('Show tree expand state save indicator at top right') },
  { key: 'showWsIndicator', label: i18n('Show WS connection indicator'), description: i18n('Show live collaboration connection status at top right') },
  { key: 'showToolbar', label: i18n('Show toolbar'), description: i18n('Show floating toolbar with scroll, structure and search') },
  { key: 'wsIndicatorOpen', label: i18n('Keep WS connection indicator open'), description: i18n('Keep the live collaboration viewer list expanded') },
];

export function BaseDetailSettingsDialog({ open, settings, saving = false, onClose, onSave }: Props) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    if (!open) return undefined;
    setDraft(settings);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
    };
  }, [onClose, open, settings, saving]);

  if (!open) return null;

  const update = (key: BooleanSettingKey, value: boolean) => setDraft((current) => ({ ...current, [key]: value }));
  const selectAll = () => setDraft((current) => ({
    ...rows.reduce((next, row) => ({ ...next, [row.key]: true }), current),
    showProblemTags: true,
  }));
  const deselectAll = () => setDraft((current) => ({
    ...rows.reduce((next, row) => ({ ...next, [row.key]: false }), current),
    showProblemTags: false,
  }));
  const resetPositions = () => setDraft((current) => ({
    ...current,
    indicatorX: 320,
    indicatorY: 72,
    toolbarOpen: false,
    toolbarX: 320,
    toolbarY: 108,
    cardDrawerWidth: 420,
    treeDrawerWidth: 320,
    wsIndicatorX: 40,
    wsIndicatorY: 40,
    wsIndicatorOpen: true,
  }));

  return (
    <div className="bd-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="bd-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="bd-settings-title">
        <header className="bd-settings-dialog__header">
          <h2 id="bd-settings-title">⚙ {i18n('Roadmap detail settings title')}</h2>
          <button type="button" className="bd-settings-dialog__close" onClick={onClose} disabled={saving} aria-label={i18n('Close')}>×</button>
        </header>
        <p className="bd-settings-dialog__hint">{i18n('Roadmap detail settings hint')}</p>
        <div className="bd-settings-dialog__actions">
          <button type="button" className="bd-settings-button" disabled={saving} onClick={selectAll}>{i18n('Select all')}</button>
          <button type="button" className="bd-settings-button" disabled={saving} onClick={deselectAll}>{i18n('Deselect all')}</button>
          <button type="button" className="bd-settings-button" disabled={saving} onClick={resetPositions}>{i18n('Reset positions to defaults')}</button>
        </div>
        <div className="bd-settings-dialog__list">
          {rows.map((row) => (
            <label className="bd-settings-dialog__row" key={row.key}>
              <span className="bd-settings-dialog__row-text">
                <span className="bd-settings-dialog__row-label">{row.label}</span>
                <span className="bd-settings-dialog__row-description">{row.description}</span>
              </span>
              <input type="checkbox" checked={draft[row.key]} disabled={saving} onChange={(event) => update(row.key, event.currentTarget.checked)} />
            </label>
          ))}
          {draft.showProblemTree ? (
            <label className="bd-settings-dialog__row bd-settings-dialog__row--nested">
              <span className="bd-settings-dialog__row-text">
                <span className="bd-settings-dialog__row-label">{i18n('Show problem tags')}</span>
                <span className="bd-settings-dialog__row-description">{i18n('Show problem tags hint')}</span>
              </span>
              <input type="checkbox" checked={draft.showProblemTags} disabled={saving} onChange={(event) => update('showProblemTags', event.currentTarget.checked)} />
            </label>
          ) : null}
        </div>
        <footer className="bd-settings-dialog__footer">
          <button type="button" className="bd-settings-button" onClick={onClose} disabled={saving}>{i18n('Cancel')}</button>
          <button type="button" className="bd-settings-button bd-settings-button--primary" onClick={() => void onSave(draft)} disabled={saving}>{saving ? i18n('Saving...') : i18n('Save')}</button>
        </footer>
      </section>
    </div>
  );
}

export { defaultBaseDetailDisplaySettings };

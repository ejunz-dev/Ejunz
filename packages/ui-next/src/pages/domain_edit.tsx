import { useMemo, useState } from 'react';
import { Button, Card } from '../components';
import { usePageData } from '../context/page-data';
import { i18n } from '../i18n';
import { DomainManageLayout } from './domain-manage-layout';
import './domain_edit.css';

const FLAG_HIDDEN = 1;
const FLAG_DISABLED = 2;
const FLAG_SECRET = 4;

interface Setting {
  family: string;
  key: string;
  name: string;
  desc?: string;
  type: string;
  subType?: string;
  range?: [string, string][] | Record<string, string> | null;
  value: unknown;
  flag?: number;
}

function optionsOf(range: Setting['range']): [string, string][] {
  if (Array.isArray(range)) return range.map((item) => [String(item[0]), String(item[1])]);
  if (range && typeof range === 'object') return Object.entries(range).map(([value, label]) => [value, String(label)]);
  return [];
}

function valueOf(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

function LanguageSetting({ setting, current }: { setting: Setting; current: Record<string, any> }) {
  const langMap = ((window as any).LANGS || {}) as Record<string, { display?: string }>;
  const prefixes = useMemo(() => new Set(Object.keys(langMap).filter((key) => key.includes('.')).map((key) => key.split('.')[0])), [langMap]);
  const options = useMemo(() => Object.keys(langMap).filter((key) => !prefixes.has(key)).map((key) => ({
    value: key,
    label: `${key.includes('.') ? `${langMap[key.split('.')[0]]?.display || key.split('.')[0]}/` : ''}${langMap[key]?.display || key}`,
  })), [langMap, prefixes]);
  const initial = String(current[setting.key] ?? setting.value ?? '').split(',').filter((key) => key && !prefixes.has(key));
  const [selected, setSelected] = useState(initial);
  const submitted = [...new Set([...selected, ...selected.filter((key) => key.includes('.')).map((key) => key.split('.')[0])])];
  return (
    <label className="uix-domain-edit__field">
      <span className="uix-domain-edit__label">{i18n(setting.name || setting.key)}</span>
      <select className="uix-domain-edit__input uix-domain-edit__langs" multiple value={selected} onChange={(event) => setSelected(Array.from(event.target.selectedOptions, (option) => option.value))} disabled={Boolean((setting.flag || 0) & FLAG_DISABLED)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <input type="hidden" name={setting.key} value={submitted.join(',')} />
      {setting.desc ? <span className="uix-domain-edit__help">{i18n(setting.desc)}</span> : null}
    </label>
  );
}

function EditSetting({ setting, current }: { setting: Setting; current: Record<string, any> }) {
  if (setting.key === 'langs') return <LanguageSetting setting={setting} current={current} />;
  const disabled = Boolean((setting.flag || 0) & FLAG_DISABLED);
  const secret = Boolean((setting.flag || 0) & FLAG_SECRET);
  const value = current[setting.key] == null ? setting.value : current[setting.key];
  const displayed = secret ? '' : valueOf(value);
  const label = i18n(setting.name || setting.key);
  const help = setting.desc ? <span className="uix-domain-edit__help">{i18n(setting.desc)}</span> : null;
  if (setting.type === 'boolean') {
    return (
      <div className="uix-domain-edit__field">
        <label className="uix-domain-edit__check"><input type="checkbox" name={setting.key} value="on" defaultChecked={Boolean(value)} disabled={disabled} />{label}</label>
        {help}
        {!disabled ? <input type="hidden" name={`booleanKeys.${setting.key}`} value="true" /> : null}
      </div>
    );
  }
  if (setting.type === 'select' || setting.type === 'radio' || setting.type === 'image_radio') {
    const options = optionsOf(setting.range);
    if (setting.type === 'select') {
      return (
        <label className="uix-domain-edit__field">
          <span className="uix-domain-edit__label">{label}</span>
          <select className="uix-domain-edit__input" name={setting.key} defaultValue={displayed} disabled={disabled}>
            {options.map(([option, text]) => <option key={option} value={option}>{i18n(text)}</option>)}
          </select>{help}
        </label>
      );
    }
    return (
      <fieldset className="uix-domain-edit__field uix-domain-edit__choices" disabled={disabled}>
        <legend className="uix-domain-edit__label">{label}</legend>
        {options.map(([option, text]) => <label key={option}><input type="radio" name={setting.key} value={option} defaultChecked={displayed === option} />{i18n(text)}</label>)}
        {help}
      </fieldset>
    );
  }
  if (setting.type === 'textarea' || setting.type === 'markdown' || setting.type === 'yaml') {
    return (
      <label className="uix-domain-edit__field">
        <span className="uix-domain-edit__label">{label}</span>
        <textarea className="uix-domain-edit__input uix-domain-edit__textarea" name={setting.key} defaultValue={displayed} disabled={disabled} placeholder={secret ? i18n('(Not changed)') : undefined} rows={setting.subType === 'yaml' ? 8 : 6} />
        {help}
      </label>
    );
  }
  const inputType = setting.type === 'password' ? 'password' : setting.type === 'number' || setting.type === 'float' ? 'number' : 'text';
  return (
    <label className="uix-domain-edit__field">
      <span className="uix-domain-edit__label">{label}</span>
      <input className="uix-domain-edit__input" name={setting.key} type={inputType} step={setting.type === 'float' ? 'any' : undefined} defaultValue={displayed} disabled={disabled} placeholder={secret ? i18n('(Not changed)') : undefined} />
      {help}
    </label>
  );
}

export default function DomainEdit() {
  const { args } = usePageData();
  const current = (args.current || {}) as Record<string, any>;
  const settings = Array.isArray(args.settings) ? args.settings as Setting[] : [];
  const families = new Map<string, Setting[]>();
  for (const setting of settings) {
    if ((setting.flag || 0) & FLAG_HIDDEN || setting.family === 'setting_storage') continue;
    if (!families.has(setting.family)) families.set(setting.family, []);
    families.get(setting.family)!.push(setting);
  }
  return (
    <DomainManageLayout>
      <div className="uix-domain-edit">
        <h1>{i18n('Edit Domain')}</h1>
        <form method="post" action={window.location.href}>
          {[...families.entries()].map(([family, values]) => (
            <Card key={family} title={i18n(family)}>
              <div className="uix-domain-edit__fields">
                {values.map((setting) => <EditSetting key={setting.key} setting={setting} current={current} />)}
              </div>
            </Card>
          ))}
          <div className="uix-domain-edit__submit"><Button type="submit" variant="primary">{i18n('Save All Changes')}</Button></div>
        </form>
      </div>
    </DomainManageLayout>
  );
}

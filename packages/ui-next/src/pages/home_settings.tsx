import { useMemo, useState, type FormEvent } from 'react';
import { Button, Card, Field } from '../components';
import { usePageData, useUserContext } from '../context/page-data';
import { useBuildUrl } from '../hooks/use-build-url';
import { i18n } from '../i18n';
import './home_settings.css';

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

function stringValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function optionsOf(range: Setting['range']): [string, string][] {
  if (Array.isArray(range)) return range.map((item) => [String(item[0]), String(item[1])]);
  if (range && typeof range === 'object') return Object.entries(range).map(([value, label]) => [value, String(label)]);
  return [];
}

function SettingControl({ setting, value }: { setting: Setting; value: unknown }) {
  const disabled = Boolean((setting.flag || 0) & FLAG_DISABLED);
  const secret = Boolean((setting.flag || 0) & FLAG_SECRET);
  const current = secret ? '' : stringValue(value);
  const label = i18n(setting.name || setting.key);
  const help = setting.desc ? <span className="uix-settings__help">{i18n(setting.desc)}</span> : null;

  if (setting.type === 'boolean') {
    return (
      <div className="uix-settings__field">
        <label className="uix-settings__check">
          <input type="checkbox" name={setting.key} value="on" defaultChecked={Boolean(value)} disabled={disabled} />
          <span>{label}</span>
        </label>
        {help}
        {!disabled ? <input type="hidden" name={`booleanKeys.${setting.key}`} value="true" /> : null}
      </div>
    );
  }

  if (setting.type === 'select' || setting.type === 'radio' || setting.type === 'image_radio') {
    const options = optionsOf(setting.range);
    if (setting.type === 'select') {
      return (
        <label className="uix-settings__field">
          <span className="uix-settings__label">{label}</span>
          <select className="uix-settings__input" name={setting.key} defaultValue={current} disabled={disabled}>
            {options.map(([option, text]) => <option key={option} value={option}>{i18n(text)}</option>)}
          </select>
          {help}
        </label>
      );
    }
    return (
      <fieldset className="uix-settings__field uix-settings__choices" disabled={disabled}>
        <legend className="uix-settings__label">{label}</legend>
        {options.map(([option, text]) => (
          <label key={option} className="uix-settings__choice">
            <input type="radio" name={setting.key} value={option} defaultChecked={current === option} />
            {setting.type === 'image_radio' && /^(\/|https?:)/.test(option) ? <img src={option} alt="" /> : null}
            <span>{i18n(text)}</span>
          </label>
        ))}
        {help}
      </fieldset>
    );
  }

  if (setting.type === 'textarea' || setting.type === 'markdown' || setting.type === 'yaml') {
    return (
      <label className="uix-settings__field">
        <span className="uix-settings__label">{label}</span>
        <textarea
          className="uix-settings__input uix-settings__textarea"
          name={setting.key}
          defaultValue={current}
          disabled={disabled}
          placeholder={secret ? i18n('(Not changed)') : undefined}
          rows={setting.subType === 'yaml' ? 8 : setting.type === 'markdown' ? 6 : 4}
        />
        {help}
      </label>
    );
  }

  const inputType = ['password', 'number', 'float'].includes(setting.type) ? (setting.type === 'float' ? 'number' : setting.type) : 'text';
  return (
    <label className="uix-settings__field">
      <span className="uix-settings__label">{label}</span>
      <input
        className="uix-settings__input"
        name={setting.key}
        type={inputType}
        step={setting.type === 'float' ? 'any' : undefined}
        defaultValue={current}
        disabled={disabled}
        placeholder={secret ? i18n('(Not changed)') : undefined}
      />
      {help}
    </label>
  );
}

function AvatarControls() {
  const user = useUserContext();
  const buildUrl = useBuildUrl();
  const [kind, setKind] = useState('gravatar');
  const [value, setValue] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const placeholder = kind === 'gravatar' ? 'Email address' : kind === 'github' ? 'Github username' : 'QQ ID';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body = kind === 'upload' ? new FormData() : new URLSearchParams({ avatar: `${kind}:${value}` });
      if (kind === 'upload') {
        if (!file) throw new Error(i18n('Please select a file.'));
        (body as FormData).append('file', file);
      }
      const response = await fetch(buildUrl('home_avatar'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: body instanceof URLSearchParams ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
        body,
      });
      if (!response.ok) throw new Error(i18n('Request failed'));
      window.location.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={i18n('Avatar')}>
      <p className="uix-settings__avatar-help">{i18n('You can also upload your avatar to Gravatar and it will be automatically updated here.')}</p>
      <div className="uix-settings__avatar-current">
        <img src={user.avatarUrl || user.avatar || '/img/avatar.png'} alt={user.uname || ''} width="96" height="96" />
      </div>
      <form className="uix-settings__avatar-form" onSubmit={(event) => void submit(event)}>
        <label className="uix-settings__field">
          <span className="uix-settings__label">{i18n('Avatar source')}</span>
          <select className="uix-settings__input" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="gravatar">{i18n('Gravatar')}</option>
            <option value="github">{i18n('Github')}</option>
            <option value="qq">{i18n('QQ')}</option>
            <option value="upload">{i18n('Upload')}</option>
          </select>
        </label>
        {kind === 'upload' ? (
          <label className="uix-settings__field">
            <span className="uix-settings__label">{i18n('Image file')}</span>
            <input className="uix-settings__input" type="file" accept=".jpg,.jpeg,.png" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          </label>
        ) : (
          <Field label={i18n('Avatar value')} value={value} placeholder={i18n(placeholder)} onChange={(event) => setValue(event.target.value)} />
        )}
        {error ? <p className="uix-settings__error" role="alert">{error}</p> : null}
        <Button type="submit" variant="primary" disabled={busy}>{busy ? i18n('Saving…') : i18n('Confirm')}</Button>
      </form>
    </Card>
  );
}

export default function HomeSettings() {
  const { args } = usePageData();
  const category = String(args.category || 'preference');
  const current = args.current || {};
  const settings = Array.isArray(args.settings) ? args.settings as Setting[] : [];
  const grouped = useMemo(() => {
    const families = new Map<string, Setting[]>();
    settings.forEach((setting) => {
      if ((setting.flag || 0) & FLAG_HIDDEN || setting.family === 'setting_storage') return;
      if (category === 'account' && setting.key === 'avatar') return;
      if (!families.has(setting.family)) families.set(setting.family, []);
      families.get(setting.family)!.push(setting);
    });
    return [...families.entries()];
  }, [category, settings]);

  return (
    <div className="uix-home-settings">
      {category === 'account' ? <AvatarControls /> : null}
      <form method="post" action={window.location.href} className="uix-settings__form">
        <input type="hidden" name="category" value={category} />
        {grouped.map(([family, familySettings]) => (
          <Card key={family} title={i18n(family)}>
            <div className="uix-settings__fields">
              {familySettings.map((setting) => {
                const value = current[setting.key] == null ? setting.value : current[setting.key];
                return <SettingControl key={setting.key} setting={setting} value={value} />;
              })}
            </div>
          </Card>
        ))}
        <div className="uix-settings__submit"><Button type="submit" variant="primary">{i18n('Save All Changes')}</Button></div>
      </form>
    </div>
  );
}

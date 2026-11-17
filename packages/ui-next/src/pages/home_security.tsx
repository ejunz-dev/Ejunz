import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startRegistration } from '@simplewebauthn/browser';
import {
  useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Button, Callout, Card, Field, Notification,
} from '../components';
import { usePageData, useUserContext } from '../context/page-data';
import { useBuildUrl } from '../hooks/use-build-url';
import { i18n } from '../i18n';
import './home_security.css';

interface Geoip {
  display?: string;
}

interface UserAgentInfo {
  os?: { name?: string };
  browser?: { name?: string; version?: string };
}

interface Session {
  _id: string;
  updateAt?: string | number;
  createAt?: string | number;
  createHost?: string;
  updateIp?: string;
  updateUa?: string;
  createUa?: string;
  updateUaInfo?: UserAgentInfo;
  updateGeoip?: Geoip;
  isCurrent?: boolean;
}

interface Authenticator {
  credentialID: string;
  name?: string;
  credentialType?: string;
  credentialDeviceType?: string;
  authenticatorAttachment?: 'platform' | 'cross-platform';
  regat?: number;
  fmt?: string;
}

type AuthnType = 'platform' | 'cross-platform';

type DialogState =
  | { kind: 'choose' }
  | { kind: 'tfa' }
  | { kind: 'authn'; credential: Record<string, unknown> }
  | null;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomBase32(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => BASE32[byte % BASE32.length]).join('');
}

function formatTime(value?: string | number): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

type GlyphKind = 'phone' | 'shield' | 'key' | 'desktop';

function Glyph({ kind }: { kind: GlyphKind }) {
  const props = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (kind) {
    case 'phone':
      return <svg {...props}><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></svg>;
    case 'shield':
      return <svg {...props}><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>;
    case 'key':
      return <svg {...props}><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 4h4v4" /></svg>;
    default:
      return <svg {...props}><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></svg>;
  }
}

function describeUserAgent(session: Session): { os: string; browser: string } {
  const info = session.updateUaInfo;
  if (info) {
    return {
      os: info.os?.name || '',
      browser: [info.browser?.name, info.browser?.version].filter(Boolean).join(' '),
    };
  }
  return { os: '', browser: session.updateUa || session.createUa || '' };
}

async function requestJson(url: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (data?.error) {
    const error = data.error;
    const message = Array.isArray(error.params)
      ? i18n(error.message, ...error.params)
      : error.message;
    throw new Error(message || i18n('Request failed'));
  }
  if (!response.ok) throw new Error(response.statusText || i18n('Request failed'));
  return data;
}

function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function reloadWithNotice(message: string) {
  Notification.success(message);
  window.setTimeout(() => window.location.reload(), 1200);
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

function Modal({ title, onClose, children, footer }: ModalProps) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="uix-modal__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="uix-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="uix-modal__header">
          <h2 className="uix-modal__title">{title}</h2>
          <button type="button" className="uix-modal__close" onClick={onClose} aria-label={i18n('Close')}>×</button>
        </header>
        <div className="uix-modal__body">{children}</div>
        {footer ? <footer className="uix-modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

function TfaDialog({ uname, url, onClose }: { uname: string; url: string; onClose: () => void }) {
  const [secret] = useState(() => randomBase32(13));
  const [revealed, setRevealed] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const uri = `otpauth://totp/Ejunz:${uname}?secret=${secret}&issuer=Ejunz`;

  useEffect(() => {
    let cancelled = false;
    void import('qrcode').then((QRCode) => {
      if (cancelled || !canvasRef.current) return;
      return QRCode.toCanvas(canvasRef.current, uri);
    }).catch((failure) => {
      if (!cancelled) setError(errorMessage(failure));
    });
    return () => { cancelled = true; };
  }, [uri]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!code.trim()) {
      setError(i18n('6-Digit Code'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await requestJson(url, { operation: 'enable_tfa', code: code.trim(), secret });
      reloadWithNotice(i18n('Successfully enabled.'));
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={i18n('Two Factor Authentication')}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{i18n('Cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => formRef.current?.requestSubmit()}>
            {busy ? i18n('Saving…') : i18n('Confirm')}
          </Button>
        </>
      )}
    >
      <form ref={formRef} className="uix-security__tfa" onSubmit={(event) => void submit(event)}>
        <p className="uix-security__muted">{i18n('Please use your two factor authentication app to scan the qrcode below:')}</p>
        <div className="uix-security__qrcode">
          <canvas ref={canvasRef} />
        </div>
        <button type="button" className="uix-security__secret" onClick={() => setRevealed(true)}>
          {revealed ? secret : i18n('Click to show secret')}
        </button>
        <Field
          label={i18n('6-Digit Code')}
          name="tfa_code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="one-time-code"
          inputMode="numeric"
          autoFocus
        />
        {error ? <Callout type="error">{error}</Callout> : null}
      </form>
    </Modal>
  );
}

function AuthnNameDialog({
  credential, url, onClose,
}: { credential: Record<string, unknown>; url: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError(i18n('Please enter a name'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await requestJson(url, { operation: 'enable_authn', name: name.trim(), result: credential });
      reloadWithNotice(i18n('Successfully enabled.'));
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={i18n('Add Authenticator')}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{i18n('Cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => formRef.current?.requestSubmit()}>
            {busy ? i18n('Saving…') : i18n('Confirm')}
          </Button>
        </>
      )}
    >
      <form ref={formRef} className="uix-security__dialog-form" onSubmit={(event) => void submit(event)}>
        <Field
          label={i18n('Name')}
          name="webauthn_name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          autoFocus
        />
        {error ? <Callout type="error">{error}</Callout> : null}
      </form>
    </Modal>
  );
}

interface ChooseAuthDialogProps {
  onClose: () => void;
  onPickTfa: () => void;
  onPickAuthn: (type: AuthnType) => void;
}

function ChooseAuthDialog({ onClose, onPickTfa, onPickAuthn }: ChooseAuthDialogProps) {
  const [platformAvailable, setPlatformAvailable] = useState<boolean | null>(null);
  const webAuthnSupported = window.isSecureContext && browserSupportsWebAuthn();

  useEffect(() => {
    if (!webAuthnSupported) return;
    let cancelled = false;
    void platformAuthenticatorIsAvailable()
      .then((available) => { if (!cancelled) setPlatformAvailable(available); })
      .catch(() => { if (!cancelled) setPlatformAvailable(false); });
    return () => { cancelled = true; };
  }, [webAuthnSupported]);

  return (
    <Modal title={i18n('Choose Authenticator Type')} onClose={onClose}>
      <ul className="uix-security__auth-options">
        <li>
          <button type="button" className="uix-security__auth-option" onClick={onPickTfa}>
            <span className="uix-security__auth-icon"><Glyph kind="phone" /></span>
            <span>{i18n('Two Factor Authentication')}</span>
          </button>
        </li>
        {!webAuthnSupported ? (
          <li>
            <span className="uix-security__auth-option is-disabled">
              <span className="uix-security__auth-icon"><Glyph kind="shield" /></span>
              <span>
                {window.isSecureContext
                  ? i18n("Your browser doesn't support WebAuthn.")
                  : i18n('Webauthn is not available in insecure context.')}
              </span>
            </span>
          </li>
        ) : (
          <>
            <li>
              {platformAvailable ? (
                <button type="button" className="uix-security__auth-option" onClick={() => onPickAuthn('platform')}>
                  <span className="uix-security__auth-icon"><Glyph kind="shield" /></span>
                  <span>{i18n('Your Device')}</span>
                </button>
              ) : (
                <span className="uix-security__auth-option is-disabled">
                  <span className="uix-security__auth-icon"><Glyph kind="shield" /></span>
                  <span>{i18n("Your browser doesn't support platform authenticator.")}</span>
                </span>
              )}
            </li>
            <li>
              <button type="button" className="uix-security__auth-option" onClick={() => onPickAuthn('cross-platform')}>
                <span className="uix-security__auth-icon"><Glyph kind="key" /></span>
                <span>{i18n('Multi Platform Authenticator')}</span>
              </button>
            </li>
          </>
        )}
      </ul>
    </Modal>
  );
}

function AuthenticatorList({ authenticators, url }: { authenticators: Authenticator[]; url: string }) {
  if (!authenticators.length) {
    return <p className="uix-security__muted">{i18n('No authenticators have been added yet.')}</p>;
  }
  return (
    <ul className="uix-security__list">
      {authenticators.map((authenticator) => (
        <li className="uix-security__item" key={authenticator.credentialID}>
          <span className="uix-security__item-icon">
            <Glyph kind={authenticator.authenticatorAttachment === 'platform' ? 'shield' : 'key'} />
          </span>
          <div className="uix-security__item-body">
            <p className="uix-security__item-title">
              {authenticator.name || i18n('Authenticator')}
              <span className="uix-security__muted"> ({authenticator.credentialID.slice(0, 6)})</span>
            </p>
            {authenticator.fmt ? <p className="uix-security__muted">{i18n('Type')}: {authenticator.fmt}</p> : null}
            {authenticator.credentialDeviceType ? (
              <p className="uix-security__muted">{i18n('Device Type')}: {authenticator.credentialDeviceType}</p>
            ) : null}
            {authenticator.regat ? (
              <p className="uix-security__muted">{i18n('Registered at')}: {formatTime(authenticator.regat)}</p>
            ) : null}
          </div>
          <form method="post" action={url} className="uix-security__item-action">
            <input type="hidden" name="id" value={authenticator.credentialID} />
            <input type="hidden" name="operation" value="disable_authn" />
            <Button type="submit">{i18n('Remove')}</Button>
          </form>
        </li>
      ))}
    </ul>
  );
}

export default function HomeSecurity() {
  const { args } = usePageData();
  const user = useUserContext();
  const buildUrl = useBuildUrl();
  const url = buildUrl('home_security');

  const sessions = useMemo(
    () => (Array.isArray(args.sessions) ? args.sessions as Session[] : []),
    [args.sessions],
  );
  const authenticators = useMemo(
    () => (Array.isArray(args.authenticators) ? args.authenticators as Authenticator[] : []),
    [args.authenticators],
  );

  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const hasLocalMail = typeof user.mail === 'string' && user.mail.endsWith('.local');
  const currentPasswordLabel = args.sudoUid ? i18n("SuperUser's Password") : i18n('Current Password');
  const geoipProvider = typeof args.geoipProvider === 'string' ? args.geoipProvider : '';

  const closeDialog = () => setDialog(null);

  async function beginAuthn(type: AuthnType) {
    setDialog(null);
    setBusy(true);
    setError('');
    try {
      const authnInfo = await requestJson(url, { operation: 'register', type });
      if (!authnInfo.authOptions) throw new Error(i18n('Failed to fetch registration data.'));
      Notification.info(i18n('Please follow the instructions on your device to complete the verification.'));
      const credential = await startRegistration({ optionsJSON: authnInfo.authOptions });
      setDialog({ kind: 'authn', credential: credential as unknown as Record<string, unknown> });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function changeMail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const password = (form.elements.namedItem('password') as HTMLInputElement)?.value || '';
    const mail = (form.elements.namedItem('mail') as HTMLInputElement)?.value || '';
    if (!password) {
      (form.elements.namedItem('password') as HTMLInputElement)?.focus();
      return;
    }
    if (!mail) {
      (form.elements.namedItem('mail') as HTMLInputElement)?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await requestJson(url, { operation: 'change_mail', password, mail });
      reloadWithNotice(i18n('Successfully changed.'));
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <div className="uix-home-security">
      {hasLocalMail ? (
        <Callout type="warn">{i18n("You haven't set an email.")}</Callout>
      ) : null}

      {error ? <Callout type="error">{error}</Callout> : null}

      <div className="uix-security__grid">
        <Card title={i18n('Change Email')}>
          <form className="uix-security__form" method="post" action={url} onSubmit={(event) => void changeMail(event)}>
            <Field
              type="password"
              label={currentPasswordLabel}
              name="password"
              required
              autoComplete="current-password"
            />
            <Field
              type="text"
              label={i18n('Current Email')}
              name="currentEmail"
              defaultValue={user.mail || ''}
              disabled
            />
            <Field
              type="text"
              label={i18n('New Email')}
              name="mail"
              required
              autoComplete="email"
            />
            <div className="uix-security__actions">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? i18n('Saving…') : i18n('Change Email')}
              </Button>
            </div>
          </form>
        </Card>

        <Card title={i18n('Change Password')}>
          <form className="uix-security__form" method="post" action={url}>
            <input type="hidden" name="operation" value="change_password" />
            <Field
              type="password"
              label={currentPasswordLabel}
              name="current"
              required
              autoComplete="current-password"
            />
            <Field
              type="password"
              label={i18n('New Password')}
              name="password"
              required
              autoComplete="new-password"
            />
            <Field
              type="password"
              label={i18n('Repeat Password')}
              name="verifyPassword"
              required
              autoComplete="new-password"
            />
            <div className="uix-security__actions">
              <Button type="submit" variant="primary">{i18n('Change Password')}</Button>
            </div>
          </form>
        </Card>
      </div>

      <Card title={i18n('Authenticators')}>
        <div className="uix-security__card-tools">
          <Button variant="primary" onClick={() => setDialog({ kind: 'choose' })} disabled={busy}>
            ＋ {i18n('Add Authenticator')}
          </Button>
        </div>

        <ul className="uix-security__list">
          {user.tfa ? (
            <li className="uix-security__item">
              <span className="uix-security__item-icon"><Glyph kind="phone" /></span>
              <div className="uix-security__item-body">
                <p className="uix-security__item-title">
                  {i18n('Authenticator')}: {i18n('Two Factor Authentication')}
                </p>
              </div>
              <form method="post" action={url} className="uix-security__item-action">
                <input type="hidden" name="operation" value="disable_tfa" />
                <Button type="submit">{i18n('Remove')}</Button>
              </form>
            </li>
          ) : null}
        </ul>

        <AuthenticatorList authenticators={authenticators} url={url} />

        {!user.tfa && !authenticators.length ? (
          <p className="uix-security__muted">{i18n('Two-factor authentication is not enabled.')}</p>
        ) : null}
      </Card>

      <Card title={i18n('Active Sessions')}>
        <ul className="uix-security__list">
          {sessions.map((session) => {
            const ua = describeUserAgent(session);
            const location = session.updateGeoip?.display || session.updateIp || '';
            return (
              <li className="uix-security__item" key={session._id}>
                <span className="uix-security__item-icon"><Glyph kind="desktop" /></span>
                <div className="uix-security__item-body">
                  <p className="uix-security__item-title">
                    {i18n('Last Update At')}: {formatTime(session.updateAt)}
                    {session.isCurrent ? (
                      <span className="uix-security__current"> ✓ {i18n('This is the current session')}</span>
                    ) : null}
                  </p>
                  {session.createHost ? <p className="uix-security__muted">{i18n('Hostname')}: {session.createHost}</p> : null}
                  {location ? <p className="uix-security__muted">{i18n('Location')}: {location}</p> : null}
                  {ua.os ? <p className="uix-security__muted">{i18n('Operating System')}: {ua.os}</p> : null}
                  {ua.browser ? <p className="uix-security__muted">{i18n('Browser')}: {ua.browser}</p> : null}
                </div>
                {!session.isCurrent ? (
                  <form method="post" action={url} className="uix-security__item-action">
                    <input type="hidden" name="operation" value="delete_token" />
                    <input type="hidden" name="tokenDigest" value={session._id} />
                    <Button type="submit">{i18n('Logout This Session')}</Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>

        {!sessions.length ? <p className="uix-security__muted">{i18n('No active sessions.')}</p> : null}

        <div className="uix-security__sessions-footer">
          <form method="post" action={url}>
            <input type="hidden" name="operation" value="delete_all_tokens" />
            <Button type="submit" variant="primary">{i18n('Logout All Sessions')}</Button>
          </form>
          {geoipProvider ? (
            <p
              className="uix-security__muted"
              // Server-provided geoip attribution may contain markup.
              dangerouslySetInnerHTML={{ __html: geoipProvider }}
            />
          ) : null}
        </div>
      </Card>

      {dialog?.kind === 'choose' ? (
        <ChooseAuthDialog
          onClose={closeDialog}
          onPickTfa={() => setDialog({ kind: 'tfa' })}
          onPickAuthn={(type) => void beginAuthn(type)}
        />
      ) : null}

      {dialog?.kind === 'tfa' ? (
        <TfaDialog uname={user.uname || ''} url={url} onClose={closeDialog} />
      ) : null}

      {dialog?.kind === 'authn' ? (
        <AuthnNameDialog credential={dialog.credential} url={url} onClose={closeDialog} />
      ) : null}
    </div>
  );
}

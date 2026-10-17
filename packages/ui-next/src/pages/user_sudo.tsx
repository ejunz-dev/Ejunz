import { useRef, useState } from 'react';
import { Button, Callout, Card } from '../components';
import { useBuildUrl } from '../hooks/use-build-url';
import { useUserContext } from '../context/page-data';
import { i18n } from '../i18n';
import './user_sudo.css';

type SudoMethod = 'password' | 'tfa' | 'authn';

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) throw new Error(data?.error || response.statusText || i18n('Request failed'));
  return data;
}

export default function UserSudo() {
  const user = useUserContext();
  const buildUrl = useBuildUrl();
  const formRef = useRef<HTMLFormElement>(null);
  const challengeRef = useRef<HTMLInputElement>(null);
  const authnVerifiedRef = useRef(false);
  const [method, setMethod] = useState<SudoMethod>(user.authn ? 'authn' : user.tfa ? 'tfa' : 'password');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submitWebAuthn() {
    setBusy(true);
    setError('');
    try {
      if (!window.isSecureContext || !('credentials' in navigator)) {
        throw new Error(i18n('Your browser does not support WebAuthn or you are not in secure context.'));
      }
      const authnInfo = await fetchJson(buildUrl('user_webauthn'));
      if (!authnInfo.authOptions) throw new Error(i18n('Failed to fetch registration data.'));
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const result = await startAuthentication({ optionsJSON: authnInfo.authOptions });
      await fetchJson(buildUrl('user_webauthn'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result }),
      });
      if (challengeRef.current) challengeRef.current.value = authnInfo.authOptions.challenge;
      authnVerifiedRef.current = true;
      formRef.current?.requestSubmit();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  }

  return (
    <div className="uix-user-sudo">
      <Card title={i18n('Confirm Access')}>
        {error ? <Callout type="error">{error}</Callout> : null}
        <form
          ref={formRef}
          method="post"
          action={buildUrl('user_sudo')}
          onSubmit={(event) => {
            if (method === 'authn' && !authnVerifiedRef.current) {
              event.preventDefault();
              if (!busy) void submitWebAuthn();
            }
          }}
        >
          <input ref={challengeRef} type="hidden" name="authnChallenge" value="" readOnly />
          {method === 'password' ? (
            <label className="uix-user-sudo__field">
              <span>{i18n('Password')}</span>
              <input type="password" name="password" autoComplete="current-password" autoFocus />
            </label>
          ) : null}
          {method === 'tfa' ? (
            <label className="uix-user-sudo__field">
              <span>{i18n('Two Factor Authentication Code')}</span>
              <input type="number" name="tfa" autoComplete="one-time-code" autoFocus />
            </label>
          ) : null}
          <div className="uix-user-sudo__submit">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? i18n('Verifying…') : method === 'authn' ? i18n('Use Authenticator') : i18n('Confirm')}
            </Button>
          </div>
        </form>
        <div className="uix-user-sudo__tip">
          <p><strong>Tip:</strong> {i18n('You are entering sudo mode.')}</p>
          <p>{i18n("After a sudo-protected action, you'll only need to re-authenticate after an hour of inactivity.")}</p>
        </div>
        {user.authn || user.tfa ? (
          <div className="uix-user-sudo__methods">
            <strong>{i18n('Or use other methods:')}</strong>
            <div>
              {user.authn && method !== 'authn' ? <button type="button" onClick={() => { setError(''); setMethod('authn'); }}>{i18n('Use Authenticator')}</button> : null}
              {user.tfa && method !== 'tfa' ? <button type="button" onClick={() => { setError(''); setMethod('tfa'); }}>{i18n('Use TFA Code')}</button> : null}
              {method !== 'password' ? <button type="button" onClick={() => { setError(''); setMethod('password'); }}>{i18n('Use Password')}</button> : null}
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

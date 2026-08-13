import { useRef, useState } from 'react';
import { usePageData } from '../context/page-data';
import { useBuildUrl } from '../hooks/use-build-url';
import { Button, Callout, Card, Field } from '../components';
import './login.css';

async function fetchJSON(input: string, init?: RequestInit) {
  const res = await fetch(input, init);
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || data?.error) throw new Error(data?.error || res.statusText || 'Request failed');
  return data;
}

// Same ceremony as the legacy user_verify page: fetch options, run the
// authenticator, exchange the result for a login challenge.
async function verifyWebauthn(uname: string): Promise<string> {
  if (!window.isSecureContext || !('credentials' in navigator)) {
    throw new Error('Your browser does not support WebAuthn or you are not in a secure context.');
  }
  const info = await fetchJSON(`/user/webauthn?uname=${encodeURIComponent(uname)}`);
  if (!info.authOptions) throw new Error('Failed to fetch registration data.');
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const result = await startAuthentication({ optionsJSON: info.authOptions });
  await fetchJSON('/user/webauthn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  });
  return info.authOptions.challenge;
}

export default function UserLogin() {
  const { url } = usePageData();
  const buildUrl = useBuildUrl();
  const query = new URLSearchParams((url || '').split('?')[1] || '');
  const redirect = query.get('redirect') || '';

  const formRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState<'credentials' | 'verify'>('credentials');
  const [methods, setMethods] = useState({ authn: false, tfa: false });
  const [tfaCode, setTfaCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setField = (name: string, value: string) => {
    const el = formRef.current?.elements.namedItem(name) as HTMLInputElement | null;
    if (el) el.value = value;
  };
  const getUname = () => (
    (formRef.current?.elements.namedItem('uname') as HTMLInputElement | null)?.value || ''
  );
  const submit = () => formRef.current?.submit();

  async function runWebauthn() {
    setBusy(true);
    setError('');
    try {
      const challenge = await verifyWebauthn(getUname());
      setField('authnChallenge', challenge);
      submit();
    } catch (e: any) {
      setError(e?.message || String(e));
      setBusy(false);
    }
  }

  function submitTfa() {
    if (!tfaCode) return;
    setField('tfa', tfaCode);
    submit();
  }

  // Final submission is always the native form POST (same as legacy);
  // JS only probes 2FA state and fills the hidden tfa/authnChallenge fields.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (step === 'verify') {
      if (methods.tfa && tfaCode) submitTfa();
      else if (methods.authn) await runWebauthn();
      return;
    }
    const uname = getUname();
    if (!uname) return;
    setBusy(true);
    setError('');
    try {
      const { authn, tfa } = await fetchJSON(`/user/tfa?q=${encodeURIComponent(uname)}`);
      if (authn || tfa) {
        setMethods({ authn: !!authn, tfa: !!tfa });
        setStep('verify');
        setBusy(false);
        if (authn && !tfa) await runWebauthn();
      } else {
        submit();
      }
    } catch (err: any) {
      setError(err?.message || String(err));
      setBusy(false);
    }
  }

  return (
    <div className="uix-auth">
      <Card title="Login">
        {error ? <Callout type="error">{error}</Callout> : null}
        <form method="POST" ref={formRef} onSubmit={handleSubmit}>
          {/* Keep credential fields mounted so the native submit always includes them */}
          <div className="uix-auth__fields" style={step === 'verify' ? { display: 'none' } : undefined}>
            <Field label="Username" name="uname" type="text" autoFocus required />
            <Field label="Password" name="password" type="password" required />
            <label className="uix-auth__remember">
              <input type="checkbox" name="rememberme" />
              <span>Remember me</span>
            </label>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Please wait…' : 'Login'}
            </Button>
            <a className="uix-muted" href={buildUrl('user_lostpass')}>Forgot password or username?</a>
          </div>
          <div className="uix-auth__fields" style={step === 'credentials' ? { display: 'none' } : undefined}>
            <Callout type="info" title="Two Factor Authentication">
              Your account has two factor authentication enabled. Please verify to continue.
            </Callout>
            {methods.authn ? (
              <Button onClick={runWebauthn} disabled={busy}>
                {busy ? 'Verifying…' : 'Use Authenticator'}
              </Button>
            ) : null}
            {methods.tfa ? (
              <>
                <Field
                  label="6-Digit Code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={tfaCode}
                  onChange={(e) => setTfaCode(e.target.value)}
                  autoFocus={!methods.authn}
                />
                <Button onClick={submitTfa} disabled={!tfaCode}>Use TFA Code</Button>
              </>
            ) : null}
          </div>
          <input type="hidden" name="tfa" defaultValue="" />
          <input type="hidden" name="authnChallenge" defaultValue="" />
          {redirect ? <input type="hidden" name="redirect" value={redirect} /> : null}
        </form>
      </Card>
    </div>
  );
}

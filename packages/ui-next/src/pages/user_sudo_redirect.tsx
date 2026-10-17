import { useEffect, useMemo, useRef } from 'react';
import { usePageData } from '../context/page-data';
import { i18n } from '../i18n';
import './user_sudo.css';

function flattenFields(value: unknown, prefix = ''): [string, string][] {
  if (!value || typeof value !== 'object') return prefix ? [[prefix, String(value ?? '')]] : [];
  if (Array.isArray(value)) return value.flatMap((item) => flattenFields(item, prefix));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => (
    flattenFields(item, prefix ? `${prefix}.${key}` : key)
  ));
}

function safeAction(target: unknown): string {
  if (typeof target !== 'string' || !target) return '/';
  try {
    const url = new URL(target, window.location.href);
    if (url.origin !== window.location.origin) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

export default function UserSudoRedirect() {
  const { args } = usePageData();
  const formRef = useRef<HTMLFormElement>(null);
  const method = String(args.method || 'post').toLowerCase() === 'get' ? 'get' : 'post';
  const action = safeAction(args.redirect);
  const fields = useMemo(() => flattenFields(args.args), [args.args]);

  useEffect(() => {
    formRef.current?.requestSubmit();
  }, []);

  return (
    <div className="uix-user-sudo uix-user-sudo--redirect">
      <div className="uix-user-sudo__content">
        <h1>{i18n('Confirm Access')}</h1>
        <p>{i18n('Redirecting, please wait...')}</p>
        <form ref={formRef} method={method} action={action}>
          {fields.map(([name, value], index) => <input key={`${name}-${index}`} type="hidden" name={name} value={value} />)}
          <button type="submit" className="uix-user-sudo__fallback">{i18n('Continue')}</button>
        </form>
      </div>
    </div>
  );
}

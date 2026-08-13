import type { PageDefinition } from '../dom/types';

const text = (value: unknown) => String(value ?? '');

function escapeHtml(value: unknown): string {
  return text(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export const login: PageDefinition = {
  render(ctx) {
    const query = new URLSearchParams(ctx.page.url.split('?')[1] || '');
    const redirect = query.get('redirect') || '';
    return `<div class="uinp-auth"><h1 class="uinp-auth__title">Login</h1><div data-ej-login-error></div><form method="POST" class="uinp-auth__form" data-ej-login-form><div data-ej-credentials><label class="ej-web-field"><span class="ej-web-field__label">Username</span><input class="ej-web-field__input" type="text" autofocus required name="uname" /></label><label class="ej-web-field"><span class="ej-web-field__label">Password</span><input class="ej-web-field__input" type="password" required name="password" /></label><label class="uinp-inline"><input type="checkbox" name="rememberme" /><span>Remember me</span></label><button class="ej-web-button ej-web-button--primary uinp-auth__submit" type="submit">Login</button><a class="uinp-muted" href="${ctx.escape(ctx.buildUrl('user_lostpass'))}">Forgot password or username?</a></div><div data-ej-verify style="display:none"><div class="ej-web-callout ej-web-callout--info"><span class="ej-web-callout__icon" aria-hidden="true">ℹ</span><div class="ej-web-callout__body"><p class="ej-web-callout__title">Two Factor Authentication</p><div class="ej-web-callout__content">Your account has two factor authentication enabled. Please verify to continue.</div></div></div><input data-ej-tfa-code class="ej-web-field__input" type="text" inputmode="numeric" placeholder="6-Digit Code" /><button data-ej-tfa class="ej-web-button ej-web-button--primary" type="button">Use TFA Code</button><button data-ej-authn class="ej-web-button" type="button">Use Authenticator</button></div><input type="hidden" name="tfa" value="" /><input type="hidden" name="authnChallenge" value="" />${redirect ? `<input type="hidden" name="redirect" value="${ctx.escape(redirect)}" />` : ''}</form></div>`;
  },
  mount(root) {
    const form = root.querySelector<HTMLFormElement>('[data-ej-login-form]');
    if (!form) return;
    const username = () => (form.elements.namedItem('uname') as HTMLInputElement | null)?.value || '';
    const verify = root.querySelector<HTMLElement>('[data-ej-verify]');
    const credentials = root.querySelector<HTMLElement>('[data-ej-credentials]');
    const error = root.querySelector<HTMLElement>('[data-ej-login-error]');
    const tfa = root.querySelector<HTMLInputElement>('[data-ej-tfa-code]');
    const setError = (value: unknown) => { if (error) error.innerHTML = value ? `<div class="ej-web-callout ej-web-callout--error">${escapeHtml(value)}</div>` : ''; };
    const onSubmit = async (event: SubmitEvent) => {
      event.preventDefault();
      setError('');
      try {
        const response = await fetch(`/user/tfa?q=${encodeURIComponent(username())}`);
        const data = await response.json();
        if (!data.authn && !data.tfa) return form.submit();
        if (credentials) credentials.style.display = 'none';
        if (verify) verify.style.display = '';
      } catch (e) {
        setError(e instanceof Error ? e.message : e);
      }
    };
    const submitTfa = () => {
      const hidden = form.elements.namedItem('tfa') as HTMLInputElement | null;
      if (hidden && tfa?.value) hidden.value = tfa.value;
      if (tfa?.value) form.submit();
    };
    const onTfa = () => submitTfa();
    form.addEventListener('submit', onSubmit);
    root.querySelector('[data-ej-tfa]')?.addEventListener('click', onTfa);
    return () => {
      form.removeEventListener('submit', onSubmit);
      root.querySelector('[data-ej-tfa]')?.removeEventListener('click', onTfa);
    };
  },
};

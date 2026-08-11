export function createSwitch(host, options = {}) {
  if (!host) throw new Error('createSwitch(host) requires a host element');
  const el = document.createElement('button');
  el.type = 'button';
  el.setAttribute('role', 'switch');
  el.innerHTML = '<span class="ej-switch__thumb"></span>';

  const apply = () => {
    const checked = Boolean(options.checked);
    el.className = ['ej-switch', checked ? 'is-on' : ''].filter(Boolean).join(' ');
    el.setAttribute('aria-checked', String(checked));
    el.disabled = Boolean(options.disabled);
  };

  el.addEventListener('click', () => {
    if (options.disabled) return;
    options.checked = !options.checked;
    apply();
    if (typeof options.onChange === 'function') options.onChange(Boolean(options.checked));
  });

  apply();
  host.appendChild(el);
  return {
    el,
    update(patch) { Object.assign(options, patch || {}); apply(); },
    destroy() { el.remove(); },
  };
}

export default createSwitch;

/**
 * Ejunz Web button
 * @param {HTMLElement} host
 * @param {{ label?: string, variant?: 'primary'|'secondary'|'outline'|'ghost', disabled?: boolean, onClick?: Function }} [options]
 */
export function createWebButton(host, options = {}) {
  if (!host) throw new Error('createWebButton(host) requires a host element');

  const el = document.createElement('button');
  el.type = 'button';

  const apply = (next = {}) => {
    const variant = next.variant || options.variant || 'primary';
    const label = next.label ?? options.label ?? 'Button';
    const disabled = next.disabled ?? options.disabled ?? false;
    el.className = `ej-web-button ej-web-button--${variant}`;
    el.disabled = Boolean(disabled);
    el.textContent = String(label);
  };

  const handleClick = (event) => {
    if (typeof options.onClick === 'function') options.onClick(event);
  };

  apply(options);
  el.addEventListener('click', handleClick);
  host.appendChild(el);

  return {
    el,
    update(patch) {
      Object.assign(options, patch || {});
      apply(options);
    },
    destroy() {
      el.removeEventListener('click', handleClick);
      el.remove();
    },
  };
}

export default createWebButton;

/**
 * JavaScript writing style — factory that mounts into a host element.
 * @param {HTMLElement} host
 * @param {{
 *   label?: string,
 *   variant?: 'primary'|'secondary'|'ghost',
 *   disabled?: boolean,
 *   onClick?: (event: MouseEvent) => void,
 * }} [options]
 * @returns {{ el: HTMLButtonElement, update: Function, destroy: Function }}
 */
export function createButton(host, options = {}) {
  if (!host) throw new Error('createButton(host) requires a host element');

  const el = document.createElement('button');
  el.type = 'button';

  const apply = (next = {}) => {
    const variant = next.variant || options.variant || 'primary';
    const label = next.label ?? options.label ?? 'Button';
    const disabled = next.disabled ?? options.disabled ?? false;
    el.className = `ej-button ej-button--${variant}`;
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

export default createButton;

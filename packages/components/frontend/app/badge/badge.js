/**
 * @param {HTMLElement} host
 * @param {{ label?: string, tone?: 'accent'|'neutral'|'danger' }} [options]
 */
export function createBadge(host, options = {}) {
  if (!host) throw new Error('createBadge(host) requires a host element');
  const el = document.createElement('span');

  const apply = (next = {}) => {
    const tone = next.tone || options.tone || 'accent';
    const label = next.label ?? options.label ?? 'Badge';
    el.className = tone === 'accent' ? 'ej-badge' : `ej-badge ej-badge--${tone}`;
    el.textContent = String(label);
  };

  apply(options);
  host.appendChild(el);
  return {
    el,
    update(patch) {
      Object.assign(options, patch || {});
      apply(options);
    },
    destroy() { el.remove(); },
  };
}

export default createBadge;

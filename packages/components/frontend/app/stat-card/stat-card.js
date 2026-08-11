export function createStatCard(host, options = {}) {
  if (!host) throw new Error('createStatCard(host) requires a host element');
  const el = document.createElement('div');
  el.className = 'ej-stat';
  el.innerHTML = '<div class="ej-stat__label"></div><div class="ej-stat__value"></div>';
  const apply = (next = {}) => {
    el.querySelector('.ej-stat__label').textContent = String(next.label ?? options.label ?? '');
    const value = el.querySelector('.ej-stat__value');
    value.textContent = String(next.value ?? options.value ?? '');
    const accent = next.accent ?? options.accent;
    value.style.color = accent || '';
  };
  apply(options);
  host.appendChild(el);
  return {
    el,
    update(patch) { Object.assign(options, patch || {}); apply(options); },
    destroy() { el.remove(); },
  };
}

export default createStatCard;

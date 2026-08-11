export function createEmptyState(host, options = {}) {
  if (!host) throw new Error('createEmptyState(host) requires a host element');
  const el = document.createElement('div');
  el.className = 'ej-empty';
  const icon = document.createElement('span');
  icon.className = 'ej-empty__icon';
  icon.textContent = '—';
  const label = document.createElement('span');
  const apply = (next = {}) => {
    label.textContent = String(next.text ?? options.text ?? '暂无数据');
  };
  apply(options);
  el.append(icon, label);
  host.appendChild(el);
  return {
    el,
    update(patch) { Object.assign(options, patch || {}); apply(options); },
    destroy() { el.remove(); },
  };
}

export default createEmptyState;

export function createListRow(host, options = {}) {
  if (!host) throw new Error('createListRow(host) requires a host element');
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'ej-list-row';

  const apply = () => {
    const title = options.title || 'Item';
    el.innerHTML = `
      <span class="ej-list-row__avatar"></span>
      <span class="ej-list-row__main">
        <span class="ej-list-row__title"></span>
        <span class="ej-list-row__desc"></span>
        <span class="ej-list-row__meta"></span>
      </span>
      <span class="ej-list-row__chevron">›</span>
    `;
    el.querySelector('.ej-list-row__avatar').textContent = options.avatarText || title.charAt(0).toUpperCase();
    el.querySelector('.ej-list-row__title').textContent = title;
    const desc = el.querySelector('.ej-list-row__desc');
    const meta = el.querySelector('.ej-list-row__meta');
    desc.textContent = options.description || '';
    desc.hidden = !options.description;
    meta.textContent = options.meta || '';
    meta.hidden = !options.meta;
  };

  el.addEventListener('click', () => {
    if (typeof options.onClick === 'function') options.onClick();
  });
  apply();
  host.appendChild(el);
  return {
    el,
    update(patch) { Object.assign(options, patch || {}); apply(); },
    destroy() { el.remove(); },
  };
}

export default createListRow;

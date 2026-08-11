export function createBottomNav(host, options = {}) {
  if (!host) throw new Error('createBottomNav(host) requires a host element');
  const el = document.createElement('nav');
  let onResize = null;

  const isCompact = () => typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 640;

  const render = () => {
    const items = options.items || [];
    const current = options.current || items[0]?.key || '';
    const compact = isCompact();
    el.className = ['ej-bottom-nav', compact ? 'ej-bottom-nav--compact' : ''].filter(Boolean).join(' ');
    el.replaceChildren();
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = ['ej-bottom-nav__item', item.key === current ? 'is-active' : ''].filter(Boolean).join(' ');
      btn.innerHTML = `<span class="ej-bottom-nav__icon"></span>${compact ? '' : '<span class="ej-bottom-nav__label"></span>'}`;
      btn.querySelector('.ej-bottom-nav__icon').textContent = item.icon || '';
      const label = btn.querySelector('.ej-bottom-nav__label');
      if (label) label.textContent = item.label || '';
      btn.addEventListener('click', () => {
        options.current = item.key;
        if (typeof options.onChange === 'function') options.onChange(item.key);
        render();
      });
      el.appendChild(btn);
    }
  };

  render();
  if (typeof window !== 'undefined') {
    onResize = () => render();
    window.addEventListener('resize', onResize);
  }
  host.appendChild(el);
  return {
    el,
    update(patch) { Object.assign(options, patch || {}); render(); },
    destroy() {
      if (onResize && typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      el.remove();
    },
  };
}

export default createBottomNav;

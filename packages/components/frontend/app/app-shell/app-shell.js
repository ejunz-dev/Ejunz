export function createAppShell(host, options = {}) {
  if (!host) throw new Error('createAppShell(host) requires a host element');
  const el = document.createElement('div');
  const body = document.createElement('div');
  body.dataset.slot = 'body';

  const render = () => {
    const minimal = Boolean(options.minimal);
    const bottomNav = Boolean(options.bottomNav);
    el.className = ['ej-shell', bottomNav ? 'ej-shell--bottom-nav' : ''].filter(Boolean).join(' ');
    el.replaceChildren();
    if (!minimal) {
      const top = document.createElement('div');
      top.className = 'ej-shell__topbar';
      top.innerHTML = `
        <div>
          <span class="ej-shell__eyebrow"></span>
          <span class="ej-shell__title"></span>
        </div>
        <span class="ej-shell__dot" aria-hidden="true"></span>
      `;
      top.querySelector('.ej-shell__eyebrow').textContent = options.eyebrow || 'EJUNZ UI';
      top.querySelector('.ej-shell__title').textContent = options.title || '组件库';
      el.appendChild(top);
      if (options.metaLeft || options.metaRight) {
        const meta = document.createElement('div');
        meta.className = 'ej-shell__meta';
        meta.innerHTML = '<span></span><span></span>';
        meta.children[0].textContent = options.metaLeft || '';
        meta.children[1].textContent = options.metaRight || '';
        el.appendChild(meta);
      }
    }
    el.appendChild(body);
  };

  render();
  host.appendChild(el);
  return {
    el,
    body,
    update(patch) {
      Object.assign(options, patch || {});
      const currentBody = body;
      render();
      if (!el.contains(currentBody)) el.appendChild(currentBody);
    },
    destroy() { el.remove(); },
  };
}

export default createAppShell;

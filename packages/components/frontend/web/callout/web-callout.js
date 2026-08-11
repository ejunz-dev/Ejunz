/**
 * Ejunz Web Callout.
 * @param {HTMLElement} host
 * @param {{ type?: 'info'|'warn'|'error', title?: string, body?: string }} [options]
 */
export function createWebCallout(host, options = {}) {
  if (!host) throw new Error('createWebCallout(host) requires a host element');

  const icons = { info: 'ℹ', warn: '⚠', error: '✕' };
  const el = document.createElement('div');

  const apply = (next = {}) => {
    const type = next.type || options.type || 'info';
    const title = next.title ?? options.title ?? '';
    const body = next.body ?? options.body ?? '';
    el.className = `ej-web-callout ej-web-callout--${type}`;
    el.innerHTML = `
      <span class="ej-web-callout__icon" aria-hidden="true"></span>
      <div class="ej-web-callout__body">
        ${title ? '<p class="ej-web-callout__title"></p>' : ''}
        <div class="ej-web-callout__content"></div>
      </div>`;
    el.querySelector('.ej-web-callout__icon').textContent = icons[type] || icons.info;
    const titleEl = el.querySelector('.ej-web-callout__title');
    if (titleEl) titleEl.textContent = title;
    el.querySelector('.ej-web-callout__content').textContent = body;
  };

  apply(options);
  host.appendChild(el);

  return {
    el,
    update(patch) {
      Object.assign(options, patch || {});
      apply(options);
    },
    destroy() {
      el.remove();
    },
  };
}

export default createWebCallout;

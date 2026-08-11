/**
 * @param {HTMLElement} host
 * @param {{ title?: string, body?: string }} [options]
 */
export function createCard(host, options = {}) {
  if (!host) throw new Error('createCard(host) requires a host element');
  const el = document.createElement('article');
  el.className = 'ej-card';
  const titleEl = document.createElement('h3');
  titleEl.className = 'ej-card__title';
  const bodyEl = document.createElement('div');
  bodyEl.className = 'ej-card__body';

  const apply = (next = {}) => {
    const title = next.title ?? options.title ?? '';
    const body = next.body ?? options.body ?? '';
    titleEl.textContent = String(title);
    bodyEl.textContent = String(body);
    titleEl.hidden = !title;
  };

  apply(options);
  el.append(titleEl, bodyEl);
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

export default createCard;

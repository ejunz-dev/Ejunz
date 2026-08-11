/**
 * Ejunz Web Card
 * @param {HTMLElement} host
 * @param {{ title?: string, description?: string, href?: string }} [options]
 */
export function createWebCard(host, options = {}) {
  if (!host) throw new Error('createWebCard(host) requires a host element');

  let el = null;

  const apply = (next = {}) => {
    const title = next.title ?? options.title ?? 'Card';
    const description = next.description ?? options.description ?? '';
    const href = next.href ?? options.href;
    const tag = href ? 'a' : 'div';
    if (!el || el.tagName.toLowerCase() !== tag) {
      const prev = el;
      el = document.createElement(tag);
      if (prev) prev.replaceWith(el);
      else host.appendChild(el);
    }
    el.className = ['ej-web-card', href ? 'ej-web-card--link' : ''].filter(Boolean).join(' ');
    el.setAttribute('data-card', 'true');
    if (href) el.setAttribute('href', href);
    else el.removeAttribute('href');
    el.innerHTML = `<h3 class="ej-web-card__title"></h3>${description ? '<p class="ej-web-card__desc"></p>' : ''}`;
    el.querySelector('.ej-web-card__title').textContent = title;
    const desc = el.querySelector('.ej-web-card__desc');
    if (desc) desc.textContent = description;
  };

  apply(options);

  return {
    el,
    update(patch) {
      Object.assign(options, patch || {});
      apply(options);
    },
    destroy() {
      el?.remove();
      el = null;
    },
  };
}

export default createWebCard;

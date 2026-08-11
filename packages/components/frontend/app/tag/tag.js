export function createTag(host, options = {}) {
  if (!host) throw new Error('createTag(host) requires a host element');
  const el = document.createElement('span');
  const apply = (next = {}) => {
    const tone = next.tone || options.tone || 'accent';
    el.className = tone === 'accent' ? 'ej-tag' : `ej-tag ej-tag--${tone}`;
    el.textContent = String(next.label ?? options.label ?? 'Tag');
  };
  apply(options);
  host.appendChild(el);
  return {
    el,
    update(patch) { Object.assign(options, patch || {}); apply(options); },
    destroy() { el.remove(); },
  };
}

export default createTag;

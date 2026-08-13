import type { PageDefinition } from '../dom/types';

export const homepage: PageDefinition = {
  render: (ctx) => `<div><div>homepage</div><p>${ctx.link(ctx.buildUrl('basedomain'), 'basedomain')}</p></div>`,
};

export const basedomain: PageDefinition = {
  render: (ctx) => `<div><div>basedomain</div><p>${ctx.link(ctx.buildUrl('homepage'), 'homepage')}</p></div>`,
};

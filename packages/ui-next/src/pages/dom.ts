import type { PageDefinition } from '../dom/types';

export const basedomain: PageDefinition = {
  render: (ctx) => `<div><div>basedomain</div><p>${ctx.link(ctx.buildUrl('homepage'), 'homepage')}</p></div>`,
};

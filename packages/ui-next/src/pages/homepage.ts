import type { DomRenderContext, PageDefinition } from '../dom/types';

type Udict = Record<string, { uname?: string }>;

const text = (value: unknown) => String(value ?? '');
const formatTime = (value: unknown) => {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(+date) ? '' : date.toLocaleString();
};
const userName = (udict: Udict, uid?: number) => uid == null ? '' : udict[String(uid)]?.uname || `#${uid}`;

function card(ctx: DomRenderContext, title: string, body: string, description = '') {
  return `<section class="ej-web-card"><div class="ej-web-card__header"><h2 class="ej-web-card__title">${ctx.escape(title)}</h2>${description ? `<p class="ej-web-card__description">${description}</p>` : ''}</div><div class="ej-web-card__body">${body}</div></section>`;
}

function listItem(ctx: DomRenderContext, title: unknown, url: string, meta: unknown) {
  return `<li class="ej-web-list__item">${ctx.link(url, `<span class="ej-web-list__title">${ctx.escape(title)}</span>`)}<span class="ej-web-list__meta">${ctx.escape(meta)}</span></li>`;
}

function list(items: string[]) {
  return `<ul class="ej-web-list">${items.join('')}</ul>`;
}

function accessGate(ctx: DomRenderContext, payload: any, content: string) {
  if (payload?.needLogin) {
    return `<div class="uinp-gate"><p class="uinp-muted">Please login to view</p>${ctx.link(ctx.buildUrl('user_login'), 'Login', { class: 'ej-web-button ej-web-button--primary' })}</div>`;
  }
  if (payload?.needJoinDomain) {
    return `<div class="uinp-gate"><p class="uinp-muted">Please join the domain to view</p>${ctx.link(ctx.buildUrl('domain_join'), 'Join Domain', { class: 'ej-web-button ej-web-button--primary' })}</div>`;
  }
  return content;
}

function statTriple(ctx: DomRenderContext, value: any) {
  const parts = [value?.nodes ?? 0, value?.cards ?? 0, value?.problems ?? 0];
  const colors = ['#60a5fa', '#4ade80', '#fbbf24'];
  return `<span class="uinp-triple">${parts.map((part, i) => `${i ? '<span class="uinp-muted"> / </span>' : ''}<span style="color:${colors[i]}">${ctx.escape(part)}</span>`).join('')}</span>`;
}

function ranking(ctx: DomRenderContext, title: string, payload: any, udict: Udict) {
  const rows = payload?.rows;
  if (!Array.isArray(rows) || !rows.length) return '';
  return card(ctx, title, `<div class="uinp-rank uinp-rank--head uinp-muted"><span>User</span><span style="text-align:center">N / C / P</span><span style="text-align:right">Rating</span></div>${rows.map((row: any) => {
    const rating = Number(row.rating ?? 1);
    const color = rating > 1 ? '#4ade80' : rating < 1 ? '#f87171' : 'inherit';
    return `<div class="uinp-rank"><span class="uinp-rank__user"><span class="uinp-muted">${row.rank != null ? `${ctx.escape(row.rank)}. ` : ''}</span>${ctx.escape(userName(udict, row.uid))}</span><span style="text-align:center">${statTriple(ctx, row)}</span><span style="text-align:right;font-weight:600;color:${color}">${rating.toFixed(2)}</span></div>`;
  }).join('')}`);
}

function groupNodes(value: unknown): [string, any[]][] {
  if (!value || typeof value !== 'object') return [];
  const group = (items: any[]) => {
    const groups = new Map<string, any[]>();
    for (const node of items) {
      const key = text(node?.content || 'Other');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(node);
    }
    return [...groups.entries()];
  };
  if (Array.isArray(value)) return group(value);
  const entries = Object.entries(value as Record<string, any>);
  if (entries.length && entries.every(([, item]) => Array.isArray(item))) return entries as [string, any[]][];
  return group(entries.map(([, item]) => item));
}

function renderSection(ctx: DomRenderContext, name: string, payload: unknown, udict: Udict): string {
  if (name === 'bulletin') return '';
  if (name === 'error') return card(ctx, 'Section failed to load', `<div class="ej-web-callout ej-web-callout--warning">${ctx.escape(payload)}</div>`);
  if (name === 'base') {
    const items = Array.isArray(payload) ? payload.map((item: any) => listItem(ctx, item.title || 'Untitled', ctx.buildUrl('base_detail', { docId: item.docId }), formatTime(item.updateAt))) : [];
    return items.length ? card(ctx, 'Recent Bases', list(items)) : '';
  }
  if (name === 'agent') {
    const items = Array.isArray(payload) ? payload.map((item: any) => listItem(ctx, item.title || 'Untitled', ctx.buildUrl('agent_detail', { aid: item.aid }), formatTime(item.updateAt))) : [];
    return items.length ? card(ctx, 'Agent', list(items)) : '';
  }
  if (name === 'checkin' && payload) {
    const data = payload as any;
    const body = `<div class="uinp-checkin"><span class="uinp-stat"><a href="${ctx.escape(data.learnUrl || '#')}"><strong>${ctx.escape(data.learnDays ?? 0)}</strong></a><span class="uinp-muted"> days</span></span>${data.learnTodayDone ? '<span class="uinp-ok">Checked in</span>' : `<span class="uinp-muted">${ctx.escape(data.learnTodayRemaining)} more cards to go</span>`}</div>`;
    return card(ctx, 'Check-in Days', accessGate(ctx, payload, body), data.userUname ? ctx.escape(data.userUname) : '');
  }
  if (name === 'today_domain_stats' && payload) {
    const data = payload as any;
    const body = `<div class="uinp-kv"><span>Content contribution</span>${statTriple(ctx, data.contribution)}</div><div class="uinp-kv"><span>Learning consumption</span>${statTriple(ctx, data.consumption)}</div><div class="uinp-muted" style="font-size:0.75rem">Nodes / Cards / Problems</div>`;
    return card(ctx, "Today's domain activity", accessGate(ctx, payload, body), data.date ? `UTC ${ctx.escape(data.date)}` : '');
  }
  if (name === 'discussion') {
    const docs = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];
    if (!docs.length) return '';
    const items = docs.map((item: any) => listItem(ctx, item.title || 'Untitled', ctx.buildUrl('discussion_detail', { did: item.docId }), `${item.nReply != null ? `${item.nReply} replies · ` : ''}${userName(udict, item.owner)}`));
    return card(ctx, 'Discussion', `${list(items)}<div style="margin-top:0.5rem">${ctx.link(ctx.buildUrl('discussion_main'), 'More →', { class: 'uinp-muted' })}</div>`);
  }
  if (name === 'contribution_ranking') return ranking(ctx, 'Contribution ranking', payload, udict);
  if (name === 'consumption_ranking') return ranking(ctx, 'Consumption ranking', payload, udict);
  if (name === 'discussion_nodes') {
    const groups = groupNodes(payload);
    if (!groups.length) return '';
    const body = groups.map(([category, nodes]) => `<div class="uinp-nodegroup"><div class="uinp-nodegroup__title">${ctx.escape(category)}</div><div class="uinp-chips">${nodes.map((node: any) => ctx.link(ctx.buildUrl('discussion_node', { type: 'node', name: node.docId }), ctx.escape(node.docId), { class: 'ej-web-tag' })).join('')}</div></div>`).join('');
    return card(ctx, 'Discussion Nodes', body);
  }
  return '';
}

export const homepage: PageDefinition = {
  render(ctx) {
    const columns = Array.isArray(ctx.args.contents) ? ctx.args.contents : [];
    const udict = (ctx.args.udict || {}) as Udict;
    const domain = (ctx.args.domain || {}) as { bulletin?: string };
    const bulletin = domain.bulletin ? card(ctx, 'Bulletin', `<div class="uinp-bulletin">${ctx.escape(domain.bulletin)}</div>`) : '';
    const columnsHtml = columns.map((column: any) => `<div class="uinp-home__column" style="grid-column:span ${Number(column.width) || 12}">${(column.sections || []).map(([name, payload]: [string, unknown]) => renderSection(ctx, name, payload, udict)).join('')}</div>`).join('');
    return `<div class="uinp-home">${bulletin}<div class="uinp-home__columns">${columnsHtml}</div></div>`;
  },
};

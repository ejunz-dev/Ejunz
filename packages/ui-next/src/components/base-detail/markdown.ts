import MarkdownIt from 'markdown-it';
import Anchor from 'markdown-it-anchor';
import Footnote from 'markdown-it-footnote';
import Mark from 'markdown-it-mark';
import MergeCells from 'markdown-it-merge-cells';
import TOC from 'markdown-it-table-of-contents';
import Imsize from 'markdown-it-imsize';
import { FilterCSS } from 'cssfilter';
import { escapeAttrValue, FilterXSS, safeAttrValue } from 'xss';

let renderer: MarkdownIt | null = null;

const whitelistClasses = new Set([
  'roadmap-text-btn',
  'roadmap-text-btn--auto',
  'roadmap-text-btn--align-left',
  'roadmap-text-btn--align-right',
  'typo',
]);

const cssFilter = new FilterCSS({
  whiteList: {
    'font-size': true,
    'font-family': true,
    'text-align': true,
    'text-indent': true,
    'margin-left': true,
    'margin-right': true,
    padding: true,
    height: true,
    width: true,
    color: true,
  },
});

const xss = new FilterXSS({
  whiteList: {
    a: ['target', 'href', 'title'],
    abbr: ['title'],
    audio: ['controls', 'loop', 'preload', 'src'],
    blockquote: ['cite', 'class'],
    br: [],
    code: ['class'],
    col: ['align', 'valign', 'span', 'width'],
    colgroup: ['align', 'valign', 'span', 'width'],
    del: ['datetime'],
    div: ['id', 'class'],
    em: [],
    h1: ['id'],
    h2: ['id', 'class'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
    hr: [],
    img: ['src', 'alt', 'title', 'width', 'height'],
    li: [],
    mark: [],
    ol: [],
    p: ['align', 'style'],
    pre: [],
    s: [],
    section: [],
    span: ['class', 'style'],
    strong: ['id'],
    sub: [],
    sup: [],
    table: ['width', 'border', 'align', 'valign'],
    tbody: ['align', 'valign'],
    td: ['width', 'rowspan', 'colspan', 'align', 'valign', 'bgcolor'],
    tfoot: ['align', 'valign'],
    th: ['width', 'rowspan', 'colspan', 'align', 'valign'],
    thead: ['align', 'valign'],
    tr: ['rowspan', 'align', 'valign'],
    ul: [],
    video: ['controls', 'loop', 'preload', 'src', 'height', 'width'],
  },
  css: cssFilter,
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style'],
  safeAttrValue(tag, name, value) {
    if (name === 'id') return escapeAttrValue(`xss-id-${value}`);
    if (name === 'class') return value.split(' ').filter((item) => whitelistClasses.has(item) || item.startsWith('language-')).join(' ');
    return safeAttrValue(tag, name, value, cssFilter);
  },
});

function roadmapButton(md: MarkdownIt) {
  md.renderer.rules.roadmap_btn = (tokens, index) => {
    const token = tokens[index];
    const href = md.utils.escapeHtml(token.attrGet('href') || '');
    const label = md.utils.escapeHtml(token.content || '');
    const target = /^https?:\/\//i.test(token.attrGet('href') || '') ? ' target="_blank" rel="noreferrer"' : '';
    return `<span class="roadmap-text-btn"><a href="${href}"${target}>${label}</a></span>`;
  };
  md.inline.ruler.before('link', 'roadmap_btn', (state, silent) => {
    const match = /^@button\[((?:\\.|[^\[\]\\])+)]\(([^)\s]+)\)/.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const token = state.push('roadmap_btn', 'span', 0);
      token.content = match[1].replace(/\\([\\[\]])/g, '$1');
      token.attrPush(['href', match[2].trim()]);
    }
    state.pos += match[0].length;
    return true;
  });
}

function getRenderer(): MarkdownIt {
  if (renderer) return renderer;
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: true });
  md.linkify.tlds('.py', false);
  md.linkify.tlds('.zip', false);
  md.linkify.tlds('.mov', false);
  md.use(Footnote).use(Mark).use(Imsize).use(Anchor).use(TOC).use(MergeCells).use(roadmapButton);
  md.core.ruler.after('linkify', 'xss', (state) => {
    for (const token of state.tokens) {
      if (token.type === 'html_block') token.content = xss.process(token.content);
      if (token.type === 'inline') {
        for (const child of token.children || []) {
          if (child.type === 'html_inline') child.content = xss.process(child.content);
        }
      }
    }
  });
  renderer = md;
  return md;
}

export function renderMarkdown(markdown: string): string {
  const value = String(markdown || '').trim();
  return value ? getRenderer().render(value) : '';
}

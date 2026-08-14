import MarkdownIt from 'markdown-it';
import Anchor from 'markdown-it-anchor';
import Footnote from 'markdown-it-footnote';
import Mark from 'markdown-it-mark';
import MergeCells from 'markdown-it-merge-cells';
import TOC from 'markdown-it-table-of-contents';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { FilterCSS } from 'cssfilter';
import { escapeAttrValue, FilterXSS, safeAttrValue } from 'xss';

let renderer: MarkdownIt | null = null;

function imageSizePlugin(md: MarkdownIt) {
  md.inline.ruler.before('image', 'image_size', (state, silent) => {
    const source = state.src.slice(state.pos);
    const match = /^!\[([^\]]*)\]\((\S+?)(?:\s+=([\d%]*)(?:x([\d%]*))?)?\)/.exec(source);
    if (!match) return false;
    if (!silent) {
      const token = state.push('image', 'img', 0);
      token.attrs = [['src', match[2]], ['alt', match[1]]];
      token.children = [];
      if (match[3]) token.attrPush(['width', match[3]]);
      if (match[4]) token.attrPush(['height', match[4]]);
    }
    state.pos += match[0].length;
    return true;
  });
}

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
    embed: ['src', 'type', 'width', 'height'],
    br: [],
    code: ['class'],
    col: ['align', 'valign', 'span', 'width'],
    colgroup: ['align', 'valign', 'span', 'width'],
    del: ['datetime'],
    div: ['id', 'class'],
    em: [],
    iframe: ['src', 'title', 'width', 'height', 'allow', 'allowfullscreen', 'frameborder', 'scrolling'],
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
    object: ['data', 'type', 'width', 'height'],
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
    param: ['name', 'value'],
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

function katexPlugin(md: MarkdownIt) {
  const isValidDelimiter = (source: string, position: number, end: number) => {
    const previous = position > 0 ? source.charCodeAt(position - 1) : -1;
    const next = position + 1 <= end ? source.charCodeAt(position + 1) : -1;
    return {
      canOpen: next !== 9,
      canClose: previous !== 9 && !(next >= 48 && next <= 57),
    };
  };

  const findClosing = (source: string, start: number, delimiter: string) => {
    let end = start;
    while ((end = source.indexOf(delimiter, end)) !== -1) {
      let backslashes = 0;
      for (let cursor = end - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) backslashes += 1;
      if (backslashes % 2 === 0) return end;
      end += delimiter.length;
    }
    return -1;
  };

  md.inline.ruler.before('escape', 'math_inline_tex', (state, silent) => {
    const source = state.src.slice(state.pos);
    const environment = /^\\begin\\{(equation|align|alignat|gather|CD)\\*?\\}/.exec(source);
    const delimiter = source.startsWith('\\(') ? { open: '\\(', close: '\\)', display: false }
      : source.startsWith('\\[') ? { open: '\\[', close: '\\]', display: true }
        : environment ? { open: environment[0], close: `\\end{${environment[1]}}`, display: true }
          : null;
    if (!delimiter) return false;
    const start = state.pos + delimiter.open.length;
    const end = findClosing(state.src, start, delimiter.close);
    if (end < 0 || end === start) return false;
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = state.src.slice(start, end);
      token.meta = { displayMode: delimiter.display };
    }
    state.pos = end + delimiter.close.length;
    return true;
  });

  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 36) return false;
    const start = state.pos + 1;
    const open = isValidDelimiter(state.src, state.pos, state.posMax);
    if (!open.canOpen) return false;
    let end = findClosing(state.src, start, '$');
    if (end === start || end < 0 || !isValidDelimiter(state.src, end, state.posMax).canClose) return false;
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = state.src.slice(start, end);
      token.meta = { displayMode: false };
    }
    state.pos = end + 1;
    return true;
  });

  md.block.ruler.after('blockquote', 'math_block_tex', (state, startLine, endLine, silent) => {
    const lineStart = state.bMarks[startLine] + state.tShift[startLine];
    const lineEnd = state.eMarks[startLine];
    const first = state.src.slice(lineStart, lineEnd).trim();
    const bracket = first.startsWith('\\[');
    const environment = /^\\begin\\{(equation|align|alignat|gather|CD)\\}/.exec(first);
    if (!bracket && !environment) return false;
    if (silent) return true;
    const open = bracket ? '\\[' : environment![0];
    const close = bracket ? '\\]' : `\\end{${environment![1]}}`;
    let nextLine = startLine;
    let content = first.slice(open.length);
    if (content.trim().endsWith(close)) {
      content = content.trim().slice(0, -close.length);
    } else {
      let found = false;
      while (++nextLine < endLine) {
        const nextStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const nextEnd = state.eMarks[nextLine];
        const line = state.src.slice(nextStart, nextEnd);
        if (line.trim().endsWith(close)) {
          content += `\\n${line.trim().slice(0, -close.length)}`;
          found = true;
          break;
        }
        content += `\\n${line}`;
      }
      if (!found) return false;
    }
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = content.trim();
    state.line = nextLine + 1;
    return true;
  });

  md.block.ruler.after('math_block_tex', 'math_block', (state, startLine, endLine, silent) => {
    const lineStart = state.bMarks[startLine] + state.tShift[startLine];
    const lineEnd = state.eMarks[startLine];
    if (state.src.slice(lineStart, lineStart + 2) !== '$$') return false;
    if (silent) return true;
    let nextLine = startLine;
    let content = state.src.slice(lineStart + 2, lineEnd);
    if (content.trim().endsWith('$$')) {
      content = content.trim().slice(0, -2);
    } else {
      let found = false;
      while (++nextLine < endLine) {
        const nextStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const nextEnd = state.eMarks[nextLine];
        const line = state.src.slice(nextStart, nextEnd);
        if (line.trim().endsWith('$$')) {
          content += `\\n${line.trim().slice(0, -2)}`;
          found = true;
          break;
        }
        content += `\\n${line}`;
      }
      if (!found) return false;
    }
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = content.trim();
    state.line = nextLine + 1;
    return true;
  });

  const render = (source: string, displayMode: boolean) => {
    try {
      return katex.renderToString(source.replace(/\\def\{\\([a-zA-Z0-9]+)\}/g, '\\def\\$1'), { displayMode, throwOnError: false, strict: 'ignore' });
    } catch {
      return `<code class="katex-error">${md.utils.escapeHtml(source)}</code>`;
    }
  };
  md.renderer.rules.math_inline = (tokens, index) => render(tokens[index].content, !!tokens[index].meta?.displayMode);
  md.renderer.rules.math_block = (tokens, index) => `${render(tokens[index].content, true)}\n`;
}

function mediaPlugin(md: MarkdownIt) {
  const embedPattern = /^@\[([a-zA-Z][\w-]*)\]\(([^)]*)\)/;
  const supported = new Set(['youtube', 'vimeo', 'vine', 'prezi', 'bilibili', 'youku', 'msoffice', 'pdf', 'video', 'url']);

  const youtubeId = (value: string) => {
    const match = value.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^?&#/]+)/i);
    return match?.[1] || value;
  };
  const mediaUrl = (service: string, source: string) => {
    const value = source.trim();
    if (service === 'youtube') return `https://www.youtube.com/embed/${encodeURIComponent(youtubeId(value))}`;
    if (service === 'vimeo') return `https://player.vimeo.com/video/${encodeURIComponent(value.split('/').pop() || value)}`;
    if (service === 'vine') return `https://vine.co/v/${encodeURIComponent(value)}/embed/simple`;
    if (service === 'prezi') return `https://prezi.com/embed/${encodeURIComponent(value.replace(/^https?:\/\/prezi\.com\//, '').replace(/\/$/, ''))}/`;
    if (service === 'bilibili') return `https://player.bilibili.com/player.html?${/^BV/i.test(value) ? 'bvid' : 'aid'}=${encodeURIComponent(value.replace(/^https?:\/\/[^/]+\//, '').split('?')[0])}`;
    if (service === 'youku') return `https://player.youku.com/embed/${encodeURIComponent(value)}`;
    if (service === 'msoffice') return `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(value)}`;
    return value;
  };

  md.renderer.rules.media_embed = (tokens, index) => {
    const token = tokens[index];
    const service = token.attrGet('service') || '';
    const source = token.attrGet('src') || '';
    const escapedSource = md.utils.escapeHtml(source);
    if (service === 'pdf') return `<object class="bd-markdown__media bd-markdown__media--pdf" data="${escapedSource}" type="application/pdf"><embed src="${escapedSource}" type="application/pdf" /></object>`;
    if (service === 'video' || service === 'url') return `<video class="bd-markdown__media" controls><source src="${escapedSource}"></video>`;
    if (supported.has(service)) return `<iframe class="bd-markdown__media bd-markdown__media--embed" src="${md.utils.escapeHtml(mediaUrl(service, source))}" title="${md.utils.escapeHtml(service)} embed" loading="lazy" allowfullscreen></iframe>`;
    return `<span data-media-service="${md.utils.escapeHtml(service)}">${escapedSource}</span>`;
  };

  md.inline.ruler.before('link', 'media_embed', (state, silent) => {
    const match = embedPattern.exec(state.src.slice(state.pos));
    if (!match) return false;
    const service = match[1].toLowerCase();
    if (!supported.has(service)) return false;
    if (!silent) {
      const token = state.push('media_embed', 'iframe', 0);
      token.attrPush(['service', service]);
      token.attrPush(['src', match[2].trim()]);
    }
    state.pos += match[0].length;
    return true;
  });
}

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
  md.use(Footnote).use(Mark).use(imageSizePlugin).use(Anchor).use(TOC).use(MergeCells).use(katexPlugin).use(mediaPlugin).use(roadmapButton);
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

function normalizeLatexDelimiters(value: string): string {
  return value
    .replace(/\\begin\{(equation|align|alignat|gather|CD)(\*)?\}([\s\S]*?)\\end\{\1\2\}/g, (_match, _name, _star, body: string) => `$$${body}$$`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${body}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`);
}

export function renderMarkdown(markdown: string, inline = false): string {
  const value = normalizeLatexDelimiters(String(markdown || '').trim());
  if (!value) return '';
  return inline ? getRenderer().renderInline(value) : getRenderer().render(value);
}

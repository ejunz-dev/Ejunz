import type MarkdownIt from 'markdown-it';

/** Inline button link: @button[Label](url) or @button[Label](url){left,16} */
const BUTTON_REGEX = /^@button\[((?:\\.|[^\[\]\\])+)\]\(([^)\s]+)\)(?:\{([^}]+)\})?/;

export type RoadmapButtonAlign = 'left' | 'center' | 'right';

export interface RoadmapButtonOptions {
  auto: boolean;
  align: RoadmapButtonAlign;
  offset?: number;
}

export function parseRoadmapButtonOptions(raw?: string): RoadmapButtonOptions {
  if (!raw?.trim()) {
    return { auto: false, align: 'center' };
  }

  let align: RoadmapButtonAlign = 'center';
  let offset: number | undefined;
  let sawAlign = false;
  let explicitAuto = false;

  for (const part of raw.split(',').map((segment) => segment.trim()).filter(Boolean)) {
    const colon = part.match(/^(left|right|center)(?::(\d+(?:\.\d+)?))?$/i);
    if (colon) {
      align = colon[1].toLowerCase() as RoadmapButtonAlign;
      sawAlign = true;
      if (colon[2] != null) offset = parseFloat(colon[2]);
      continue;
    }
    const lower = part.toLowerCase();
    if (lower === 'left' || lower === 'right' || lower === 'center') {
      align = lower;
      sawAlign = true;
      continue;
    }
    if (lower === 'auto') {
      explicitAuto = true;
      continue;
    }
    const num = Number(part);
    if (!Number.isNaN(num) && num >= 0) offset = num;
  }

  return {
    auto: sawAlign || explicitAuto,
    align,
    offset,
  };
}

function unescapeLabel(raw: string): string {
  return raw.replace(/\\([\\[\]])/g, '$1');
}

function roadmapButtonClassName(options: RoadmapButtonOptions): string {
  const classes = ['roadmap-text-btn'];
  if (options.auto) classes.push('roadmap-text-btn--auto');
  if (options.auto && options.align !== 'center') {
    classes.push(`roadmap-text-btn--align-${options.align}`);
  }
  return classes.join(' ');
}

function roadmapButtonInlineStyle(options: RoadmapButtonOptions): string {
  if (!options.auto || options.align === 'center') return '';
  const inset = options.offset ?? 0;
  if (options.align === 'left') {
    return ` style="margin-left:${inset}px;margin-right:auto"`;
  }
  return ` style="margin-left:auto;margin-right:${inset}px"`;
}

export function RoadmapButton(md: MarkdownIt) {
  md.renderer.rules.roadmap_btn = (tokens, idx) => {
    const href = md.utils.escapeHtml(tokens[idx].attrGet('href') || '');
    const label = md.utils.escapeHtml(tokens[idx].content || '');
    const external = /^https?:\/\//i.test(tokens[idx].attrGet('href') || '');
    const target = external ? ' target="_blank"' : '';
    const options = parseRoadmapButtonOptions(tokens[idx].attrGet('options') || undefined);
    const className = roadmapButtonClassName(options);
    const styleAttr = roadmapButtonInlineStyle(options);
    return `<span class="${className}"${styleAttr}><a href="${href}"${target}>${label}</a></span>`;
  };

  md.inline.ruler.before('link', 'roadmap_btn', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x40/* @ */) return false;
    const match = BUTTON_REGEX.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const token = state.push('roadmap_btn', 'span', 0);
      token.content = unescapeLabel(match[1]);
      token.attrPush(['href', match[2].trim()]);
      if (match[3]) token.attrPush(['options', match[3].trim()]);
      token.markup = '@button';
      token.level = state.level;
    }
    state.pos += match[0].length;
    return true;
  });
}

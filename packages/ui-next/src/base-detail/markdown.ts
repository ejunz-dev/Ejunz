// Lightweight safe markdown → HTML renderer for card content.
// Output is escaped before inline markup is applied, so raw HTML never passes through.

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s"]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  out = out.replace(/\[([^\]]+)\]\(([^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

export function renderMarkdown(source: unknown): string {
  const md = String(source ?? '');
  if (!md.trim()) return '';
  const lines = md.split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let inCode = false;
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (/^\s*```/.test(line)) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      html.push('<hr>');
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const ulItem = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ulItem) {
      flushParagraph();
      if (list !== 'ul') {
        flushList();
        html.push('<ul>');
        list = 'ul';
      }
      html.push(`<li>${inline(ulItem[1])}</li>`);
      continue;
    }
    const olItem = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (olItem) {
      flushParagraph();
      if (list !== 'ol') {
        flushList();
        html.push('<ol>');
        list = 'ol';
      }
      html.push(`<li>${inline(olItem[1])}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join('\n');
}

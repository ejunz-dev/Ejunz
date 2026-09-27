import katex from 'katex';
import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import { useEffect, useMemo, useRef } from 'react';
import 'katex/dist/katex.min.css';
import css from './MarkdownText.module.css';

const markdown = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true,
});

interface BlockState {
    src: string;
    bMarks: number[];
    tShift: number[];
    eMarks: number[];
    line: number;
    push(type: string, tag: string, nesting: number): { block: boolean; content: string; map?: [number, number] };
}

interface InlineState {
    src: string;
    pos: number;
    max: number;
    push(type: string, tag: string, nesting: number): { content: string };
}

markdown.block.ruler.before('fence', 'math_block', ((state: BlockState, startLine: number, endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const end = state.eMarks[startLine];
    if (state.src.slice(start, end).trim() !== '$$') return false;
    if (silent) return true;
    let line = startLine + 1;
    const content: string[] = [];
    while (line < endLine) {
        const lineStart = state.bMarks[line] + state.tShift[line];
        const lineEnd = state.eMarks[line];
        if (state.src.slice(lineStart, lineEnd).trim() === '$$') {
            const token = state.push('math_block', 'math', 0);
            token.block = true;
            token.content = content.join('\n');
            token.map = [startLine, line + 1];
            state.line = line + 1;
            return true;
        }
        content.push(state.src.slice(lineStart, lineEnd));
        line += 1;
    }
    return false;
}) as any);

markdown.inline.ruler.before('escape', 'math_inline', ((state: InlineState, silent: boolean) => {
    if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$' || (state.pos > 0 && state.src[state.pos - 1] === '\\')) return false;
    let end = state.pos + 1;
    while (end < state.max) {
        if (state.src[end] === '$' && state.src[end - 1] !== '\\') break;
        end += 1;
    }
    if (end >= state.max || end === state.pos + 1 || silent) return false;
    const token = state.push('math_inline', 'math', 0);
    token.content = state.src.slice(state.pos + 1, end);
    state.pos = end + 1;
    return true;
}) as any);

markdown.renderer.rules.math_block = (tokens, index) => katex.renderToString(tokens[index].content, { displayMode: true, throwOnError: false });
markdown.renderer.rules.math_inline = (tokens, index) => katex.renderToString(tokens[index].content, { displayMode: false, throwOnError: false });
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const language = token.info.trim().split(/\s+/, 1)[0] ?? '';
    const label = markdown.utils.escapeHtml(language);
    const code = markdown.utils.escapeHtml(token.content);
    return `<div class="eja-mdCode"><div class="eja-mdCodeBanner"><span>${label}</span></div><pre><code${language ? ` class="language-${label}"` : ''}>${code}</code></pre></div>`;
};

const codeLanguages = ['javascript', 'typescript', 'tsx', 'jsx', 'python', 'json', 'bash', 'shellscript', 'html', 'css', 'markdown', 'yaml', 'sql'];
const languageAliases: Record<string, string> = { js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'shellscript', yml: 'yaml', md: 'markdown' };
let highlighterPromise: ReturnType<typeof createHighlighter> | null = null;

function getHighlighter() {
    highlighterPromise ??= createHighlighter({ themes: ['github-dark'], langs: codeLanguages });
    return highlighterPromise;
}

function installCopyButtons(root: HTMLDivElement): HTMLButtonElement[] {
    return [...root.querySelectorAll<HTMLDivElement>('.eja-mdCode')].map((block) => {
        const pre = block.querySelector('pre');
        const banner = block.querySelector('.eja-mdCodeBanner');
        if (!pre || !banner) return null;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'eja-codeCopy';
        button.textContent = '复制';
        button.addEventListener('click', () => {
            const value = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
            if (!navigator.clipboard) return;
            void navigator.clipboard.writeText(value).then(() => {
                button.textContent = '已复制';
                window.setTimeout(() => { button.textContent = '复制'; }, 1200);
            }).catch(() => {});
        });
        banner.appendChild(button);
        return button;
    }).filter((button): button is HTMLButtonElement => button !== null);
}

export function MarkdownText({ text }: { text: string }) {
    const html = useMemo(() => markdown.render(text), [text]);
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return undefined;
        let disposed = false;
        const highlight = async () => {
            const blocks = [...root.querySelectorAll<HTMLPreElement>('pre')]
                .map((pre) => ({ pre, code: pre.querySelector('code') }))
                .filter((item): item is { pre: HTMLPreElement; code: HTMLElement } => item.code !== null);
            const candidates = blocks.filter(({ code }) => code.className.includes('language-'));
            if (candidates.length) {
                try {
                    const highlighter = await getHighlighter();
                    for (const { pre, code } of candidates) {
                        if (disposed) return;
                        const rawLanguage = code.className.match(/language-([\w-]+)/)?.[1]?.toLowerCase();
                        const language = rawLanguage === undefined ? undefined : languageAliases[rawLanguage] ?? rawLanguage;
                        if (!language || !highlighter.getLoadedLanguages().includes(language)) continue;
                        const rendered = highlighter.codeToHtml(code.textContent ?? '', { lang: language, theme: 'github-dark' });
                        const template = document.createElement('template');
                        template.innerHTML = rendered;
                        const replacement = template.content.firstElementChild;
                        if (replacement) pre.replaceWith(replacement);
                    }
                } catch { }
            }
            if (!disposed) {
                const buttons = installCopyButtons(root);
                root.dataset.codeReady = 'true';
                root.dataset.codeButtonCount = String(buttons.length);
            }
        };
        void highlight();
        return () => {
            disposed = true;
            root.querySelectorAll('.eja-codeCopy').forEach((button) => button.remove());
        };
    }, [html]);
    return <div ref={rootRef} className={`${css.markdown} eja-markdown`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function PlainText({ text }: { text: string }) {
    return <span className="eja-plainText">{text}</span>;
}

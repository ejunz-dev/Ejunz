import MarkdownIt from 'markdown-it';
import Anchor from 'markdown-it-anchor';
import Footnote from 'markdown-it-footnote';
import Mark from 'markdown-it-mark';
import MergeCells from 'markdown-it-merge-cells';
import TOC from 'markdown-it-table-of-contents';
import Imsize from '../../backendlib/markdown-it-imsize';
import { Media } from '../../backendlib/markdown-it-media';
import { xssProtector } from '../../backendlib/markdown-it-xss';
import { RoadmapButton } from './markdown-it-roadmap-button';

let renderer: MarkdownIt | null = null;

function getRoadmapMarkdownRenderer(): MarkdownIt {
  if (renderer) return renderer;
  const mdit = new MarkdownIt({
    html: true,
    linkify: true,
  });
  mdit.linkify.tlds('.py', false);
  mdit.linkify.tlds('.zip', false);
  mdit.linkify.tlds('.mov', false);
  mdit.use(Media);
  mdit.use(Footnote);
  mdit.use(Mark);
  mdit.use(Imsize);
  mdit.use(Anchor);
  mdit.use(TOC);
  mdit.use(MergeCells);
  mdit.use(RoadmapButton);
  mdit.use(xssProtector);
  renderer = mdit;
  return mdit;
}

/** Client-side markdown render — same plugin stack as md-editor (mdeditor.ts), including @button on roadmap pages. */
export function renderRoadmapMarkdown(text: string): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  return getRoadmapMarkdownRenderer().render(trimmed);
}

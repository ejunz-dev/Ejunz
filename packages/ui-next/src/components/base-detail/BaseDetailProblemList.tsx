import { useEffect, useState } from 'react';
import { i18n } from '../../i18n';
import { renderMarkdown } from './markdown';
import type { BaseDetailProblem } from './types';

interface Props {
  problems: BaseDetailProblem[];
  selectedProblemId?: string | null;
  onSelectProblem?: (pid: string) => void;
}

type RevealState = {
  answer?: boolean;
  answers?: Set<number>;
  flip?: boolean;
  blanks?: Set<number>;
};

function kind(problem: BaseDetailProblem): string {
  return String(problem.type || 'single');
}

function title(problem: BaseDetailProblem, index: number): string {
  return String(problem.title || problem.stem || problem.faceA || `${i18n('Problem')} ${index + 1}`).replace(/<[^>]+>/g, '').slice(0, 100);
}

function optionLabel(index: number): string {
  return `${String.fromCharCode(65 + index)}.`;
}

function Markdown({ value, inline = false }: { value?: unknown; inline?: boolean }) {
  const html = renderMarkdown(String(value || ''));
  return <span className={inline ? 'bd-problem__markdown bd-problem__markdown--inline' : 'bd-problem__markdown'} dangerouslySetInnerHTML={{ __html: html }} />;
}

function ProblemItem({ problem, index, selected, onSelect }: { problem: BaseDetailProblem; index: number; selected: boolean; onSelect?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [reveal, setReveal] = useState<RevealState>({});
  const type = kind(problem);
  const options = Array.isArray(problem.options) ? problem.options : [];
  const answers = Array.isArray(problem.answers) ? problem.answers : [];
  const correct = typeof problem.answer === 'number' ? [problem.answer] : Array.isArray(problem.answer) ? problem.answer : [];

  useEffect(() => {
    setExpanded(false);
    setReveal({});
  }, [problem.pid]);

  const renderStem = () => {
    if (type === 'flip') return <Markdown value={reveal.flip ? problem.faceB : problem.faceA} />;
    if (type === 'fill_blank') {
      const segments = String(problem.stem || '').split('___');
      const revealed = reveal.blanks || new Set<number>();
      return <div className="bd-problem__stem">{segments.map((segment, segmentIndex) => <span key={segmentIndex}><Markdown value={segment} inline />{segmentIndex < segments.length - 1 ? <button type="button" className={`bd-problem__blank${revealed.has(segmentIndex) ? ' is-revealed' : ''}`} onClick={() => { const next = new Set(revealed); if (next.has(segmentIndex)) next.delete(segmentIndex); else next.add(segmentIndex); setReveal({ ...reveal, blanks: next }); }}>{revealed.has(segmentIndex) ? answers[segmentIndex] || '—' : '___'}</button> : null}</span>)}</div>;
    }
    return <Markdown value={problem.stem} />;
  };

  return (
    <article className={`bd-problem${expanded ? ' is-expanded' : ''}${selected ? ' is-selected' : ''}`}>
      <button type="button" className="bd-problem__head" aria-expanded={expanded} onClick={() => { onSelect?.(); setExpanded((value) => !value); }}>
        <span className="bd-problem__kind">{i18n(`Problem kind ${type.replace('_', ' ')}`)}</span>
        <span className="bd-problem__title">{title(problem, index)}</span>
        <span aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? (
        <div className="bd-problem__body">
          {renderStem()}
          {(type === 'single' || type === 'multi' || type === 'true_false') ? (
            <div className="bd-problem__options">
              {(type === 'true_false' ? [i18n('Correct'), i18n('Incorrect')] : options).map((option, optionIndex) => <div className="bd-problem__option" key={optionIndex}><b>{optionLabel(optionIndex)}</b><Markdown value={option} inline /></div>)}
            </div>
          ) : null}
          {type === 'flip' ? <button type="button" className="bd-problem__reveal" onClick={() => setReveal({ ...reveal, flip: !reveal.flip })}>{reveal.flip ? i18n('Roadmap drawer problem reveal back') : i18n('Roadmap drawer problem tap reveal answer')}</button> : null}
          {(type === 'single' || type === 'multi' || type === 'true_false') ? (
            <div className="bd-problem__answers"><strong>{i18n('Correct Answer')}</strong>{correct.map((answerIndex) => <button type="button" className="bd-problem__reveal" key={answerIndex} onClick={() => setReveal({ ...reveal, answer: !reveal.answer })}>{reveal.answer ? <><b>{optionLabel(answerIndex)}</b> <Markdown value={type === 'true_false' ? (answerIndex === 1 ? i18n('Correct') : i18n('Incorrect')) : options[answerIndex]} inline /></> : i18n('Roadmap drawer problem tap reveal answer')}</button>)}</div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function BaseDetailProblemList({ problems, selectedProblemId, onSelectProblem }: Props) {
  if (!problems.length) return <p className="bd-muted">{i18n('Roadmap drawer problems empty')}</p>;
  return <div className="bd-problem-list">{problems.map((problem, index) => <ProblemItem key={String(problem.pid || index)} problem={problem} index={index} selected={selectedProblemId === String(problem.pid || `problem-${index}`)} onSelect={() => onSelectProblem?.(String(problem.pid || `problem-${index}`))} />)}</div>;
}

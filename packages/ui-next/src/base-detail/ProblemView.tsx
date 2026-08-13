import React from 'react';
import { renderMarkdown } from './markdown';
import type { BaseDetailProblem } from './types';

const KIND_LABELS: Record<string, string> = {
  single: 'Single Choice',
  multi: 'Multiple Choice',
  true_false: 'True / False',
  flip: 'Flip Card',
  fill_blank: 'Fill in the Blank',
  matching: 'Matching',
  super_flip: 'Super Flip',
  chain: 'Chain',
  ai_eval: 'AI Evaluation',
};

function Md({ source, className }: { source: unknown; className?: string }) {
  const html = renderMarkdown(source);
  if (!html) return null;
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function answerText(problem: BaseDetailProblem): string {
  const { answer } = problem;
  if (answer == null) return '';
  if (Array.isArray(answer)) return answer.map(String).join(', ');
  if (typeof answer === 'boolean') return answer ? 'True' : 'False';
  return String(answer);
}

export function ProblemView({ problem, index }: { problem: BaseDetailProblem; index: number }) {
  const kind = String(problem.type || 'single');
  const label = KIND_LABELS[kind] || kind;
  const answer = answerText(problem);
  return (
    <div className="ej-bd-problem" data-kind={kind}>
      <div className="ej-bd-problem__head">
        <span className="ej-bd-problem__index">#{index + 1}</span>
        <span className="ej-bd-problem__kind">{label}</span>
        {(problem.tags || []).map((tag) => (
          <span key={tag} className="ej-web-tag">{tag}</span>
        ))}
      </div>
      <Md source={problem.stem} className="ej-bd-problem__stem ej-bd-md" />
      {Array.isArray(problem.options) && problem.options.length ? (
        <ul className="ej-bd-problem__options">
          {problem.options.map((option, i) => (
            <li key={i}>
              <span className="ej-bd-problem__option-key">{String.fromCharCode(65 + i)}.</span>
              <Md source={option} className="ej-bd-md" />
            </li>
          ))}
        </ul>
      ) : null}
      {kind === 'flip' || kind === 'super_flip' ? (
        <div className="ej-bd-problem__flip">
          <div><span className="ej-bd-muted">A</span><Md source={problem.faceA} className="ej-bd-md" /></div>
          <div><span className="ej-bd-muted">B</span><Md source={problem.faceB} className="ej-bd-md" /></div>
          {problem.hint ? <div><span className="ej-bd-muted">Hint</span><Md source={problem.hint} className="ej-bd-md" /></div> : null}
        </div>
      ) : null}
      {kind === 'fill_blank' && Array.isArray(problem.answers) && problem.answers.length ? (
        <p className="ej-bd-problem__answer"><span className="ej-bd-muted">Answers: </span>{problem.answers.join(' / ')}</p>
      ) : null}
      {kind === 'matching' && Array.isArray(problem.columns) ? (
        <div className="ej-bd-problem__matching">
          {problem.columns.map((column, i) => (
            <div key={i} className="ej-bd-problem__matching-col">
              <strong>{problem.headers?.[i] || `Column ${i + 1}`}</strong>
              <ul>{(column || []).map((item, j) => <li key={j}>{item}</li>)}</ul>
            </div>
          ))}
        </div>
      ) : null}
      {kind === 'chain' && Array.isArray(problem.rows) ? (
        <ol className="ej-bd-problem__chain">
          {problem.rows.map((row, i) => (
            <li key={i}><span className="ej-bd-muted">{row.rowType || ''}</span> {row.content || ''}</li>
          ))}
        </ol>
      ) : null}
      {answer && kind !== 'fill_blank' ? (
        <p className="ej-bd-problem__answer"><span className="ej-bd-muted">Answer: </span>{answer}</p>
      ) : null}
      <Md source={problem.analysis} className="ej-bd-problem__analysis ej-bd-md" />
    </div>
  );
}

export function ProblemList({ problems }: { problems?: BaseDetailProblem[] }) {
  if (!problems?.length) return null;
  return (
    <div className="ej-bd-problems">
      {problems.map((problem, index) => (
        <ProblemView key={problem.pid || index} problem={problem} index={index} />
      ))}
    </div>
  );
}
